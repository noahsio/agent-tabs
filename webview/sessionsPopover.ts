import type { SessionItem } from "../src/panel/protocol";
import { button, el, type Post } from "./dom";
import { icon } from "./icons";
import type { PopoverContent } from "./popover";

const MINUTE = 60_000;
/** The path of the draft's row: a draft has no session file yet. */
const DRAFT_PATH = "";

/** «сейчас», «12 мин», «3 ч», «2 д». */
export function relativeTime(then: number, now: number): string {
  const minutes = Math.floor((now - then) / MINUTE);
  if (minutes < 1) return "сейчас";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return `${Math.floor(hours / 24)} д`;
}

/** The project's sessions under the clock icon: search, open, rename in place, archive. */
export class SessionsPopover implements PopoverContent {
  readonly element: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly deferred: HTMLButtonElement;
  private items: SessionItem[] = [];
  /** Index into the filtered rows. */
  private selected = 0;
  /** The session being renamed in the list, by path. */
  private renaming: string | undefined;
  /** True while rows are rebuilt: a field that loses focus by being replaced has not been left. */
  private rendering = false;
  /** Archived sessions are listed (after the others) only while this is on. */
  private showArchived = false;
  /** This tab's title while it is a draft: the host lists saved sessions only, so the draft gets its own first row. */
  private draft: string | undefined;

  constructor(
    private readonly post: Post,
    private readonly close: () => void,
    openDeferred?: (anchor: HTMLElement) => void,
  ) {
    this.deferred = button("Отложенные", { class: "mrow", "data-role": "sessions-deferred" }, () => openDeferred?.(this.deferred));
    this.search = el("input", { type: "text", class: "search-field", "data-role": "sessions-search", placeholder: "Поиск по сессиям…", "aria-label": "Поиск по сессиям" });
    this.search.addEventListener("input", () => {
      this.selected = 0;
      this.render();
    });
    this.search.addEventListener("keydown", (event) => this.onSearchKey(event));
    this.list = el("div", { class: "pop-list", role: "listbox", "aria-label": "Сессии проекта" });
    this.element = el(
      "div",
      { class: "pop pop-sessions", "data-popover": "sessions", role: "dialog", "aria-label": "Сессии проекта" },
      this.deferred,
      el("label", { class: "search" }, icon("search"), this.search),
      this.list,
    );
  }

  setDeferredCount(count: number): void {
    this.deferred.textContent = count > 0 ? `Отложенные (${count})` : "Отложенные";
  }

  opened(): void {
    this.post({ type: "listSessions" });
    this.search.value = "";
    this.selected = Math.max(0, this.filtered().findIndex((item) => item.current));
    this.render();
    this.search.focus();
  }

  closed(): void {
    this.renaming = undefined;
  }

  /** A fresh list from the host. */
  update(items: SessionItem[]): void {
    this.items = items;
    this.render();
  }

  /** This tab's title while it has no session yet, else undefined. */
  setDraft(title: string | undefined): void {
    if (title === this.draft) return;
    this.draft = title;
    if (!this.element.hidden) this.render();
  }

  /** The host answered a rename: reload the list, the name may differ from what was typed. */
  renamed(): void {
    if (!this.element.hidden) this.post({ type: "listSessions" });
  }

  private matching(): SessionItem[] {
    const query = this.search.value.trim().toLowerCase();
    const items = this.draft === undefined ? this.items : [this.draftItem(this.draft), ...this.items];
    return query === "" ? items : items.filter((item) => item.title.toLowerCase().includes(query));
  }

  /** The draft as a row: current, updated now, nothing to archive. */
  private draftItem(title: string): SessionItem {
    return { sessionPath: DRAFT_PATH, durableId: "", title, updatedAt: Date.now(), running: false, pinned: false, archived: false, current: true };
  }

  /** The rows shown, in order: the active sessions, then the archived ones while the archive is open. */
  private filtered(): SessionItem[] {
    const matching = this.matching();
    const active = matching.filter((item) => !item.archived);
    return this.showArchived ? [...active, ...matching.filter((item) => item.archived)] : active;
  }

  private render(): void {
    const rows = this.filtered();
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
    const now = Date.now();
    const editing = this.renameInput(); // a list that arrives mid-rename keeps the draft and the caret
    const draft = editing === null ? undefined : { value: editing.value, focused: document.activeElement === editing };
    const nodes = rows.map((item, index) => this.row(item, index === this.selected, now));
    const archived = this.matching().filter((item) => item.archived).length;
    if (archived > 0) nodes.splice(rows.length - (this.showArchived ? archived : 0), 0, this.archiveToggle(archived)); // heads the archived rows
    this.rendering = true;
    this.list.replaceChildren(...nodes);
    this.rendering = false;
    if (rows.length === 0) this.list.prepend(el("div", { class: "pop-empty" }, this.items.length === 0 ? "Сессий пока нет" : "Ничего не найдено"));
    const field = this.renameInput();
    if (field === null || draft === undefined) return;
    field.value = draft.value;
    if (draft.focused) field.focus();
  }

  private renameInput(): HTMLInputElement | null {
    return this.list.querySelector<HTMLInputElement>('[data-role="session-rename-input"]');
  }

  /** «Показать архив (N)» / «Скрыть архив (N)»: the muted row that opens and closes the archive. */
  private archiveToggle(count: number): HTMLElement {
    const toggle = button(`${this.showArchived ? "Скрыть" : "Показать"} архив (${count})`, { class: "archive-toggle", "data-role": "sessions-archive-toggle" }, () => {
      this.showArchived = !this.showArchived;
      this.render();
    });
    toggle.addEventListener("mousedown", (event) => event.preventDefault()); // the search field keeps the focus
    return toggle;
  }

  private row(item: SessionItem, selected: boolean, now: number): HTMLElement {
    const row = el("div", { class: "row", "data-row": "", role: "option", "aria-selected": String(selected), title: item.title });
    row.classList.toggle("sel", item.current);
    row.classList.toggle("active", selected);
    row.classList.toggle("archived", item.archived);
    // The row's own controls (rename, archive, the rename field) never open it, whatever listens first.
    row.addEventListener("click", (event) => {
      if (!(event.target instanceof Element && event.target.closest("button, input"))) this.openSession(item);
    });
    // While this row is being renamed, a press anywhere on it keeps the field (and its focus).
    row.addEventListener("mousedown", (event) => {
      if (this.renaming === item.sessionPath && !(event.target instanceof HTMLInputElement)) event.preventDefault();
    });

    const name = el("span", { class: "n" });
    if (item.pinned) name.append(el("span", { class: "pin-mark", "data-role": "session-pinned", title: "В избранном" }, icon("pin")));
    if (this.renaming === item.sessionPath) name.append(this.renameField(item));
    else name.append(el("span", { class: "n-text", "data-role": "session-title" }, item.title));
    if (item.running) name.append(el("span", { class: "badge" }, "● работает"));

    const rename = button(icon("pencil"), { class: "icon-btn mini", "data-role": "session-rename", title: "Переименовать", "aria-label": "Переименовать" }, () => this.startRename(item));
    const archive = item.sessionPath === DRAFT_PATH
      ? []
      : item.archived
      ? [button(icon("unarchive"), { class: "icon-btn mini", "data-role": "session-unarchive", title: "Вернуть из архива", "aria-label": "Вернуть из архива" }, () => this.setArchived(item, false))]
      : [button(icon("archive"), { class: "icon-btn mini", "data-role": "session-archive", title: "В архив", "aria-label": "В архив" }, () => this.setArchived(item, true))];
    // One slot: the time, and over it the actions that replace it on hover or focus.
    const time = el("span", { class: "time", "data-role": "session-time" }, relativeTime(item.updatedAt, now));
    row.append(name, el("span", { class: "t" }, time, el("span", { class: "acts", "data-role": "session-actions" }, rename, ...archive)));
    return row;
  }

  private renameField(item: SessionItem): HTMLInputElement {
    const field = el("input", { type: "text", class: "rename-field", "data-role": "session-rename-input", "aria-label": "Новое название" });
    field.value = item.title;
    field.addEventListener("blur", () => {
      if (this.rendering || this.renaming !== item.sessionPath) return;
      // Leaves the rename in place: rebuilding rows would detach the one under the pointer and swallow its click.
      this.renaming = undefined;
      field.replaceWith(el("span", { class: "n-text", "data-role": "session-title" }, item.title));
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation(); // leaves the rename, not the list
        this.stopRename(item.sessionPath, true);
        return;
      }
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const name = field.value.trim();
      if (name !== "" && name !== item.title && item.sessionPath === DRAFT_PATH) {
        this.post({ type: "rename", name }); // no path: this tab's own, kept by the host for the session it creates
        this.draft = name;
      } else if (name !== "" && name !== item.title) {
        this.post({ type: "rename", sessionPath: item.sessionPath, name });
        this.items = this.items.map((other) => (other.sessionPath === item.sessionPath ? { ...other, title: name } : other));
      }
      this.stopRename(item.sessionPath, true);
    });
    return field;
  }

  private startRename(item: SessionItem): void {
    this.renaming = item.sessionPath;
    this.render();
    this.renameInput()?.focus();
    this.renameInput()?.select();
  }

  private stopRename(sessionPath: string, refocus: boolean): void {
    if (this.renaming !== sessionPath) return; // already ended (blur after Enter/Esc)
    this.renaming = undefined;
    this.render();
    if (refocus) this.search.focus();
  }

  /** Shows at once; the host stores it and answers with the list. */
  private setArchived(item: SessionItem, archived: boolean): void {
    this.post({ type: "archive", durableId: item.durableId, archived });
    this.items = this.items.map((other) => (other.durableId === item.durableId ? { ...other, archived } : other));
    this.render();
  }

  private openSession(item: SessionItem): void {
    if (this.renaming !== undefined) return;
    if (item.sessionPath !== DRAFT_PATH) this.post({ type: "openSession", sessionPath: item.sessionPath }); // the draft is this tab
    this.close();
  }

  private onSearchKey(event: KeyboardEvent): void {
    const rows = this.filtered();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.selected = Math.max(0, Math.min(rows.length - 1, this.selected + (event.key === "ArrowDown" ? 1 : -1)));
      this.render();
      this.list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const item = rows[this.selected];
    if (item !== undefined) this.openSession(item);
  }
}
