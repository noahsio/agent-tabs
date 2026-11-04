import type { RewindPreviewMessage, RewoundMessage } from "../src/panel/protocol";
import type { RewindAction, RewindItem } from "../src/rewind/plan";
import { button, el, type Post } from "./dom";

const GROUPS: { action: RewindAction; heading: string }[] = [
  { action: "restore", heading: "вернётся" },
  { action: "delete", heading: "будет удалён" },
  { action: "skip", heading: "не откатить" },
];
const CHANGED = "изменён после агента — откат затрёт эти изменения";
const UNCHECKED = "не проверено";
const NOTHING = "Агент не менял файлы после этого сообщения";

/**
 * The confirmation before a rewind (and a fork-and-rewind): what returns, what is deleted, what cannot be rewound and
 * what the rewind would overwrite. A modal over the tab: Esc and the backdrop cancel; nothing happens until «Откатить».
 */
export class RewindConfirm {
  readonly element: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly error: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === "Tab") {
      this.trapTab(event);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };
  private target: { blockId: string; fork: boolean } | undefined;
  /** The plan the person sees: «Откатить» sends its fingerprint, so only this plan can be applied. */
  private fingerprint: string | undefined;
  /** Whether the shown plan has anything to do (files to change, or a fork). */
  private confirmable = false;
  private readonly panel: HTMLElement;
  private returnFocus: () => void = () => undefined;

  constructor(private readonly post: Post) {
    this.title = el("h2", { "data-role": "rewind-title", id: "rewind-title" });
    this.body = el("div", { class: "rc-body", "data-role": "rewind-items" });
    this.error = el("p", { class: "error", role: "alert" });
    this.confirmButton = button("Откатить", { "data-role": "rewind-confirm" }, () => this.confirm());
    this.cancelButton = button("Отмена", { class: "secondary", "data-role": "rewind-cancel" }, () => this.close());
    const panel = (this.panel = el(
      "div",
      { class: "rewind-confirm" },
      this.title,
      this.body,
      this.error,
      el("div", { class: "rc-actions" }, this.confirmButton, this.cancelButton),
    ));
    this.element = el(
      "div",
      { class: "rewind-confirm-backdrop", "data-role": "rewind-confirm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "rewind-title" },
      panel,
    );
    this.element.hidden = true;
    this.element.addEventListener("click", (event) => {
      if (event.target === this.element) this.close(); // the dimmed backdrop, not the panel
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Waits for the preview of this message: only the buttons until then, «Откатить» disabled. */
  open(blockId: string, fork: boolean, returnFocus: () => void = () => undefined): void {
    this.target = { blockId, fork };
    this.fingerprint = undefined;
    this.confirmable = false;
    this.returnFocus = returnFocus;
    this.title.textContent = "";
    this.body.replaceChildren();
    this.setError(undefined);
    this.confirmButton.disabled = true;
    if (!this.isOpen) {
      document.addEventListener("keydown", this.onKey, true);
      this.element.hidden = false;
    }
    this.cancelButton.focus();
  }

  /** The host's preview; one for another message (or mode) is dropped. */
  preview(message: RewindPreviewMessage): void {
    if (!this.matches(message.blockId) || message.fork !== this.target?.fork) return;
    if (!message.ok) {
      this.setError(message.reason);
      this.fingerprint = undefined;
      this.confirmable = false;
      this.confirmButton.disabled = true;
      return;
    }
    this.setError(undefined);
    this.fingerprint = message.fingerprint;
    this.title.textContent = `Откатить код к сообщению «${message.excerpt}»?`;
    const groups = GROUPS.map(({ action, heading }) => {
      const items = message.items.filter((item) => item.action === action);
      if (items.length === 0) return undefined;
      return el("section", { class: "rc-group", "data-group": action }, el("h3", {}, heading), el("ul", {}, ...items.map((item) => this.row(item))));
    }).filter((group): group is HTMLElement => group !== undefined);
    this.body.replaceChildren(...(groups.length > 0 ? groups : [el("p", { class: "rc-muted" }, NOTHING)]));
    this.confirmable = message.fork || message.items.some((item) => item.action !== "skip");
    this.confirmButton.disabled = !this.confirmable;
  }

  /** The host's answer to «Откатить»: done closes, a failure stays open with its reason. */
  rewound(message: RewoundMessage): void {
    if (!this.matches(message.blockId)) return;
    if (message.ok) {
      this.close();
      return;
    }
    this.setError(message.reason);
    this.confirmButton.disabled = !this.confirmable;
  }

  close(): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    this.target = undefined;
    document.removeEventListener("keydown", this.onKey, true);
    this.returnFocus();
  }

  private confirm(): void {
    const target = this.target;
    const fingerprint = this.fingerprint;
    if (target === undefined || fingerprint === undefined) return;
    this.setError(undefined);
    this.confirmButton.disabled = true;
    this.post({ type: "rewind", blockId: target.blockId, fork: target.fork, fingerprint });
  }

  /** Tab and Shift+Tab cycle through the dialog's own controls. */
  private trapTab(event: KeyboardEvent): void {
    const focusable = [...this.panel.querySelectorAll<HTMLElement>("button, [href], input, textarea, select, [tabindex]")].filter(
      (element) => !(element as HTMLButtonElement).disabled && !element.hidden && element.getAttribute("tabindex") !== "-1",
    );
    if (focusable.length === 0) return;
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : at < 0 || at === focusable.length - 1 ? 0 : at + 1;
    event.preventDefault();
    focusable[next]?.focus();
  }

  private matches(blockId: string): boolean {
    return this.isOpen && this.target?.blockId === blockId;
  }

  private row(item: RewindItem): HTMLElement {
    const notes = [item.reason, item.changed === "yes" ? CHANGED : item.changed === "unknown" ? UNCHECKED : undefined].filter(
      (note): note is string => note !== undefined,
    );
    return el(
      "li",
      { class: `rc-row${item.changed === "yes" ? " changed" : ""}`, "data-path": item.path },
      el("span", { class: "rc-path" }, item.path),
      ...notes.map((note) => el("span", { class: "rc-note" }, note)),
    );
  }

  private setError(reason: string | undefined): void {
    this.error.textContent = reason ?? "";
    this.error.hidden = reason === undefined;
  }
}
