import type { CommandRow } from "../src/sessions/controller";
import { MODE_INFO } from "./composer";
import { el } from "./dom";
import type { TextField } from "./inputField";
import type { PopoverContent } from "./popover";
import { HIDDEN_COMMANDS } from "./slashCatalog";

/** `title` and `detail` give a mode row its two-line plain-language face; `key` is still what is filtered and inserted. */
type Item = { key: string; description: string; insert: string; title?: string; detail?: string };

const MODES: Item[] = [
  { key: "ulw", description: "", insert: "ulw", ...MODE_INFO.ulw },
  { key: "mass ulw", description: "", insert: "mass ulw", ...MODE_INFO["mass ulw"] },
];

/** A «/token» at the very start of the input. */
const LEADING_TOKEN = /^\/\S*/;
/** The whole input is one «/token» still being typed. */
const TYPING_TOKEN = /^\/\S*$/;

export type SlashMenuHost = {
  input: TextField;
  show: () => void;
  hide: () => void;
};

/** Skill rows are named «skill:<name>» (live get_commands); their canonical invocation is «$<name>» (rpc.md get_commands, skills.md). */
function commandItem(command: CommandRow): Item {
  const key = command.syntax === "dollar" ? `$${command.name.replace(/^skill:/, "")}` : `/${command.name}`;
  return { key, description: command.description ?? "", insert: key };
}

/**
 * The menu a «/» typed in the input opens: ulw modes, then every skill and every OmO command but the hidden ones
 * (the window's list, else slashCatalog's), one compact row each. The input keeps the focus; the menu filters on the «/token» typed at its start.
 */
export class SlashMenu implements PopoverContent {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private commands: CommandRow[] = [];
  private hiddenNames: ReadonlySet<string> = HIDDEN_COMMANDS;
  private items: Item[] = [];
  private selected = 0;

  constructor(private readonly host: SlashMenuHost) {
    this.list = el("div", { class: "pop-list", role: "listbox", "aria-label": "Команды и навыки" });
    this.element = el("div", { class: "pop pop-slash", "data-popover": "slash" }, el("h4", {}, "Команды и навыки"), this.list);
  }

  setCommands(commands: CommandRow[] | undefined): void {
    const next = commands ?? [];
    if (next === this.commands) return; // state arrives on every streamed delta, the list only when it changed
    if (JSON.stringify(next) === JSON.stringify(this.commands)) {
      this.commands = next;
      return;
    }
    this.commands = next;
    if (!this.element.hidden) this.refresh();
  }

  /** The window's hidden commands (absent: the built-in list). */
  setHidden(names: readonly string[] | undefined): void {
    const next = names === undefined ? HIDDEN_COMMANDS : new Set(names);
    if (next.size === this.hiddenNames.size && [...next].every((name) => this.hiddenNames.has(name))) return;
    this.hiddenNames = next;
    if (!this.element.hidden) this.refresh();
  }

  /** Every edit of the input: a lone «/token» opens and filters the menu, anything else closes it. */
  onInput(): void {
    if (!TYPING_TOKEN.test(this.host.input.value)) {
      if (!this.element.hidden) this.host.hide();
      return;
    }
    this.selected = 0;
    if (this.element.hidden) this.host.show();
    this.refresh();
  }

  /** Keys typed in the input while the menu is open; true when the menu took the key. */
  onKey(event: KeyboardEvent): boolean {
    if (this.element.hidden || event.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + (event.key === "ArrowDown" ? 1 : -1)));
      this.render();
      this.list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
      return true;
    }
    if ((event.key !== "Enter" && event.key !== "Tab") || event.shiftKey) return false;
    const item = this.items[this.selected];
    if (item === undefined) return false;
    event.preventDefault();
    this.insert(item);
    return true;
  }

  private filter(): string {
    return (LEADING_TOKEN.exec(this.host.input.value)?.[0] ?? "/").slice(1);
  }

  /** Modes, skills, then the commands (hidden ones never), matching the typed filter. */
  private matching(): Item[] {
    const query = this.filter().toLowerCase();
    const skills = this.commands.filter((command) => command.source === "skill");
    const commands = this.commands.filter((command) => command.source !== "skill" && !this.hiddenNames.has(command.name));
    return [...MODES, ...skills.map(commandItem), ...commands.map(commandItem)].filter((item) => item.key.replace(/^[/$]/, "").toLowerCase().includes(query));
  }

  /** Recomputes the rows; with commands loaded and nothing matching, the menu steps aside. */
  private refresh(): void {
    this.items = this.matching();
    if (this.items.length === 0 && this.commands.length > 0) {
      this.host.hide();
      return;
    }
    this.render();
  }

  private render(): void {
    this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
    const rows = this.items.map((item, index) => this.row(item, index));
    if (this.commands.length === 0) rows.push(el("div", { class: "crow muted", "data-role": "slash-unavailable" }, "Команды OmO недоступны"));
    this.list.replaceChildren(...rows);
  }

  /** The pointer selects like ↑/↓ do: one highlighted row, the one Enter would pick. */
  private select(index: number): void {
    if (index === this.selected) return;
    this.selected = index;
    this.list.querySelectorAll<HTMLElement>("[data-row]").forEach((row, at) => {
      row.classList.toggle("sel", at === index);
      row.setAttribute("aria-selected", String(at === index));
    });
  }

  /** The token only; the description is its tooltip. */
  private row(item: Item, index: number): HTMLElement {
    const selected = index === this.selected;
    const row = el(
      "div",
      { class: "crow", "data-row": "", role: "option", "aria-selected": String(selected), ...(item.description !== "" ? { title: item.description } : {}) },
      el("span", { class: "k", "data-role": "slash-key" }, item.title ?? item.key),
    );
    if (item.detail !== undefined) {
      row.classList.add("two-line");
      row.append(el("span", { class: "d" }, `${item.detail} `, el("span", { class: "tag" }, item.key)));
    }
    row.classList.toggle("sel", selected);
    row.addEventListener("mouseenter", () => this.select(index));
    row.addEventListener("mousedown", (event) => event.preventDefault()); // the input keeps the focus
    row.addEventListener("click", () => this.insert(item));
    return row;
  }

  /** Replaces the leading «/token» (if any) with the pick, caret at the end. */
  private insert(item: Item): void {
    const input = this.host.input;
    const rest = input.value.replace(LEADING_TOKEN, "").replace(/^ +/, "");
    input.value = `${item.insert} ${rest}`;
    this.host.hide();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.element.dispatchEvent(new Event("input", { bubbles: true })); // the composer catches up with the new text
  }
}
