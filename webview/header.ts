import { button, el, type Post } from "./dom";
import { icon } from "./icons";

export type HeaderOptions = {
  /** Opens the sessions popover under the given icon. */
  onOpenSessions?: (anchor: HTMLElement) => void;
  onOpenDeferred?: (anchor: HTMLElement) => void;
};

const RENAME_HINT = "Нажми, чтобы переименовать";
/** How long a pin toggled here is shown without the host's confirmation. */
const PIN_WAIT_MS = 2_000;

/** The tab header: the session title (click to rename) and the pin / sessions / new icons (the settings are in the «/» menu). */
export class Header {
  private readonly title: HTMLElement;
  private readonly editor: HTMLElement;
  private readonly field: HTMLInputElement;
  private readonly pin: HTMLButtonElement;
  private readonly deferredCount = el("span", { class: "deferred-count", "data-role": "deferred-count" });
  private readonly deferred: HTMLButtonElement;
  /** The tab's word on whether its session is pinned. */
  private pinned = false;
  /** A pin toggled here, shown until the tab agrees or PIN_WAIT_MS pass. */
  private optimistic: { durableId: string; pinned: boolean; timer: ReturnType<typeof setTimeout> } | undefined;
  private current = "";
  /** The name just sent for rename, shown until the host answers. */
  private pending: string | undefined;
  private durableId: string | undefined;

  constructor(
    root: HTMLElement,
    private readonly post: Post,
    private readonly options: HeaderOptions = {},
  ) {
    this.title = el("div", { class: "title", "data-role": "title", role: "button", tabindex: "0", title: RENAME_HINT });
    this.title.addEventListener("click", () => this.startEditing());
    this.title.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.startEditing();
      }
    });
    this.field = el("input", { type: "text", "data-role": "title-input", "aria-label": "Название сессии" });
    this.field.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.field.addEventListener("blur", () => this.stopEditing());
    this.editor = el("div", { class: "title-edit" }, this.field, el("span", { class: "hint" }, "Enter — сохранить · Esc — отмена"));
    this.editor.hidden = true;

    this.pin = button(icon("pin"), { class: "icon-btn", "data-role": "pin", title: "Закрепить сессию", "aria-pressed": "false" }, () => this.togglePin());
    const sessions = button(icon("sessions"), { class: "icon-btn", "data-role": "sessions", title: "Сессии проекта" }, () => this.options.onOpenSessions?.(sessions));
    this.deferred = button(icon("inbox"), { class: "icon-btn deferred-button", "data-role": "deferred", title: "Отложенные", "aria-label": "Отложенные" }, () => this.options.onOpenDeferred?.(this.deferred));
    this.deferredCount.hidden = true;
    this.deferred.append(this.deferredCount);
    const create = button(icon("newSession"), { class: "icon-btn", "data-role": "new", title: "Новая сессия" }, () => this.post({ type: "newSession" }));

    root.classList.add("header");
    root.replaceChildren(el("div", { class: "title-wrap" }, this.title, this.editor), el("div", { class: "icons" }, this.pin, this.deferred, sessions, create));
  }

  setDeferredCount(count: number): void {
    this.deferredCount.textContent = String(count);
    this.deferredCount.hidden = count === 0;
    this.deferred.setAttribute("aria-label", count > 0 ? `Отложенные: ${count}` : "Отложенные");
  }

  /** `pinned` is the tab's flag from the host, the one source of truth for this session's pin. */
  update(title: string, durableId?: string, pinned: boolean = false): void {
    this.current = title;
    this.durableId = durableId;
    this.pinned = pinned;
    if (this.optimistic !== undefined && (this.optimistic.durableId !== durableId || this.optimistic.pinned === pinned)) this.dropOptimistic();
    this.renderTitle();
    this.renderPin();
  }

  /** A pin toggled here shows at once, before the host confirms it. */
  private setPinned(durableId: string, pinned: boolean): void {
    if (durableId !== this.durableId) return;
    this.dropOptimistic();
    const timer = setTimeout(() => {
      this.optimistic = undefined;
      this.renderPin();
    }, PIN_WAIT_MS);
    this.optimistic = { durableId, pinned, timer };
    this.renderPin();
  }

  private dropOptimistic(): void {
    if (this.optimistic !== undefined) clearTimeout(this.optimistic.timer);
    this.optimistic = undefined;
  }

  private shownPinned(): boolean {
    return this.optimistic?.pinned ?? this.pinned;
  }

  private renderPin(): void {
    const pinned = this.durableId !== undefined && this.shownPinned();
    this.pin.disabled = this.durableId === undefined;
    this.pin.classList.toggle("on", pinned);
    this.pin.setAttribute("aria-pressed", String(pinned));
  }

  /** The host's answer to a rename; a failed one restores the old title and says why on hover. */
  renamed(ok: boolean, reason?: string): void {
    if (ok && this.pending !== undefined) this.current = this.pending; // no flash back before the next state
    this.pending = undefined;
    this.renderTitle();
    this.title.setAttribute("title", ok ? RENAME_HINT : (reason ?? "Не удалось переименовать"));
  }

  private renderTitle(): void {
    this.title.textContent = this.pending ?? this.current;
  }

  private startEditing(): void {
    this.field.value = this.pending ?? this.current;
    this.title.hidden = true;
    this.editor.hidden = false;
    this.field.focus();
    this.field.select();
  }

  private stopEditing(): void {
    this.editor.hidden = true;
    this.title.hidden = false;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.stopEditing();
      this.title.focus(); // the field is gone; keep keyboard focus in the header
      return;
    }
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const name = this.field.value.trim();
    this.stopEditing();
    this.title.focus();
    if (name === "" || name === (this.pending ?? this.current)) return;
    this.pending = name;
    this.renderTitle();
    this.post({ type: "rename", name });
  }

  private togglePin(): void {
    const durableId = this.durableId;
    if (durableId === undefined) return;
    const pinned = !this.shownPinned();
    this.post({ type: "pin", durableId, pinned });
    this.setPinned(durableId, pinned);
  }
}
