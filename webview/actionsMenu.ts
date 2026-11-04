import { MODE_INFO, type NextMode } from "./composer";
import { el } from "./dom";
import type { PopoverContent } from "./popover";

export type ActionsMenuHost = {
  mode: () => NextMode | undefined;
  setMode: (mode: NextMode | undefined) => void;
  /** Opens the settings modal on its first section. */
  openSettings: () => void;
  /** Closes the menu and gives the focus back to the input. */
  done: () => void;
};

const MODES: NextMode[] = ["ulw", "mass ulw"];

/**
 * The «/» button's menu: the mode toggles and, under a line, «Настройки» (the other actions live in the header and the pills). Commands and skills are not here: they are typed
 * after «/» in the input (SlashMenu).
 */
export class ActionsMenu implements PopoverContent {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly host: ActionsMenuHost) {
    this.list = el("div", { class: "pop-list", role: "menu", "aria-label": "Действия" });
    this.list.addEventListener("keydown", (event) => this.onKey(event));
    this.element = el("div", { class: "pop pop-actions", "data-popover": "actions" }, this.list);
  }

  /** Rebuilt on every open: the toggles show the current mode. */
  opened(): void {
    const toggles = MODES.map((mode) => {
      const on = this.host.mode() === mode;
      const row = this.row(mode, { role: "menuitemcheckbox", "aria-checked": String(on) }, () => {
        this.host.done();
        this.host.setMode(on ? undefined : mode);
      });
      if (on) row.append(el("span", { class: "check", "aria-hidden": "true" }, "✓"));
      return row;
    });
    const settings = el("button", { type: "button", class: "mrow", "data-row": "", role: "menuitem", "data-role": "action-settings" }, "Настройки");
    settings.addEventListener("click", () => {
      this.host.done();
      this.host.openSettings();
    });
    settings.addEventListener("mouseenter", () => settings.focus());
    this.list.replaceChildren(...toggles, el("div", { class: "menu-sep", role: "separator" }), settings);
    this.rows()[0]?.focus();
  }

  /** Two lines: the plain title, then a dimmer explanation ending in the keyword as a small tag. */
  private row(mode: NextMode, attributes: Record<string, string>, onClick: () => void): HTMLButtonElement {
    const info = MODE_INFO[mode];
    const row = el(
      "button",
      { type: "button", class: "mrow", "data-row": "", ...attributes },
      el("span", { class: "mtext" }, el("span", { class: "name" }, info.title), el("span", { class: "desc wrap" }, `${info.detail} `, el("span", { class: "tag" }, mode))),
    );
    row.addEventListener("click", onClick);
    row.addEventListener("mouseenter", () => row.focus()); // the pointer and ↑/↓ move one active row
    return row;
  }

  private rows(): HTMLButtonElement[] {
    return [...this.list.querySelectorAll<HTMLButtonElement>("[data-row]")].filter((row) => !row.hidden);
  }

  /** ↑/↓ move between the rows; Enter and Space are the buttons' own. */
  private onKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = this.rows();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }
}
