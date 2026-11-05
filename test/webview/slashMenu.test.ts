// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { CommandRow } from "../../src/sessions/controller";
import type { WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";
import { text, type } from "../helpers/composer";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

const COMMANDS: CommandRow[] = [
  { name: "reflect", description: "Reflect on past mistakes", source: "extension", syntax: "slash" },
  { name: "resume", description: "Продолжить прошлую сессию проекта", source: "extension", syntax: "slash" },
  { name: "handoff", description: "Hand off to a new session", source: "extension", syntax: "slash" },
  { name: "goal", source: "extension", syntax: "slash" },
  { name: "help", description: "Show help", source: "extension", syntax: "slash" }, // TUI-only: hidden
  { name: "reasoning", source: "extension", syntax: "slash" }, // the model popover covers it: hidden
  { name: "reload-rules", source: "extension", syntax: "slash" },
  { name: "review-work", source: "extension", syntax: "slash" },
  { name: "release-checklist", description: "Чек-лист релиза", source: "prompt", syntax: "slash" },
  { name: "skill:receiving-code-review", description: "Принять ревью", source: "skill", syntax: "dollar" }, // as get_commands names skills
];

function show(commands?: CommandRow[]): void {
  view.update({ type: "state", state: initialState(), tab: { modelMode: "auto" }, reconnectable: true, ...(commands !== undefined ? { commands } : {}) });
}

function input(): HTMLElement {
  return root.querySelector(".input") as HTMLElement;
}

function menu(): HTMLElement {
  return root.querySelector('[data-popover="slash"]') as HTMLElement;
}

function typeInput(value: string): void {
  type(input(), value);
  caretEnd();
}

/** Puts the caret at the end of the typed text, where a person's would be. */
function caretEnd(): void {
  const node = input().lastChild;
  const selection = window.getSelection() as Selection;
  const range = document.createRange();
  if (node === null) range.selectNodeContents(input());
  else range.setStart(node, node.nodeType === Node.TEXT_NODE ? (node as Text).length : 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function caretOffset(): number {
  return (window.getSelection() as Selection).focusOffset;
}

function press(name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  input().dispatchEvent(event);
  return event;
}

/** Group headings and the commands under them, in order. */
function outline(): string[] {
  return [...menu().querySelectorAll<HTMLElement>("h4, [data-row], [data-role='slash-unavailable']")].map((node) =>
    node.tagName === "H4" ? `# ${node.textContent}` : (node.querySelector("[data-role='slash-key']")?.textContent ?? node.textContent ?? ""),
  );
}

/** The row's tooltip (its description), or null without one. */
function tooltip(key: string): string | null | undefined {
  const row = [...menu().querySelectorAll<HTMLElement>("[data-row]")].find((node) => node.querySelector("[data-role='slash-key']")?.textContent === key);
  return row?.getAttribute("title");
}

function selected(): string | null | undefined {
  return menu().querySelector("[data-row][aria-selected='true'] [data-role='slash-key']")?.textContent;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  show(COMMANDS);
});

describe("slash menu", () => {
  it("hovering_a_row_makes_it_the_one_selected", () => {
    input().focus();
    typeInput("/re");
    const rows = [...menu().querySelectorAll<HTMLElement>("[data-row]")];
    expect(selected()).toBe(rows[0]?.querySelector("[data-role='slash-key']")?.textContent);
    rows[2]?.dispatchEvent(new MouseEvent("mouseenter"));
    expect(selected()).toBe(rows[2]?.querySelector("[data-role='slash-key']")?.textContent);
    expect(menu().querySelectorAll("[data-row].sel")).toHaveLength(1);
    press("Enter"); // the keyboard picks up where the pointer left
    expect(text(input())).toBe(`${rows[2]?.querySelector("[data-role='slash-key']")?.textContent} `);
  });

  it("slash_menu_keyboard_insert", () => {
    input().focus();
    typeInput("/");
    expect(menu().hidden).toBe(false);
    // Everything there is, under one heading: modes, every skill, every command but the hidden ones; tokens only.
    expect(outline()).toEqual([
      "# Команды и навыки",
      "Довести до конца",
      "Команда агентов",
      "$receiving-code-review",
      "/reflect",
      "/resume",
      "/handoff",
      "/goal",
      "/review-work",
      "/release-checklist",
    ]);
    expect(menu().querySelectorAll(".v")).toHaveLength(0); // no description column
    expect(tooltip("/handoff")).toBe("Hand off to a new session"); // the description is the row's tooltip
    const modeRow = menu().querySelector("[data-row]") as HTMLElement; // a mode row: plain title, dim explanation, keyword tag
    expect(modeRow.querySelector(".d")?.textContent).toBe("Агент сам составит план, выполнит его и проверит результат, прежде чем закончить ulw");
    expect(modeRow.querySelector(".d .tag")?.textContent).toBe("ulw");
    expect(tooltip("/goal")).toBeNull(); // none from OmO, none made up

    typeInput("/ha");
    expect(outline()).toEqual(["# Команды и навыки", "/handoff"]);

    // Hidden ones never show, even when typed.
    typeInput("/RE");
    expect(outline()).toEqual(["# Команды и навыки", "$receiving-code-review", "/reflect", "/resume", "/review-work", "/release-checklist"]);
    expect(selected()).toBe("$receiving-code-review");
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowUp");
    expect(selected()).toBe("/resume");
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(text(input())).toBe("/resume ");
    expect(caretOffset()).toBe("/resume ".length);
    expect(menu().hidden).toBe(true);
    expect(posted.filter((message) => message.type === "send")).toEqual([]);

    for (const hidden of ["/help", "/reasoning", "/reload-rules"]) {
      typeInput(hidden);
      expect(menu().hidden || !outline().includes(hidden)).toBe(true);
    }

    typeInput("/ul");
    expect(outline()).toEqual(["# Команды и навыки", "Довести до конца", "Команда агентов"]);
    press("ArrowDown");
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(text(input())).toBe("mass ulw ");

    typeInput("/re");
    typeInput("/re x"); // the token ended
    expect(menu().hidden).toBe(true);
    typeInput("/re");
    press("Escape");
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(text(input())).toBe("/re");

    typeInput("/zzz");
    expect(menu().hidden).toBe(true); // nothing matches: no empty box
    press("Enter"); // nothing to insert: the message goes as typed
    expect(posted.filter((message) => message.type === "send")).toEqual([{ type: "send", id: expect.any(String), text: "/zzz", mode: "auto" }]);
  });

  it("slash_menu_without_commands", () => {
    show(undefined);
    typeInput("/");
    expect(menu().hidden).toBe(false);
    expect(outline()).toEqual(["# Команды и навыки", "Довести до конца", "Команда агентов", "Команды OmO недоступны"]);
    expect(menu().querySelector("[data-role='slash-unavailable']")?.classList.contains("muted")).toBe(true);
    expect([...menu().querySelectorAll("[data-row]")].map((row) => row.querySelector("[data-role='slash-key']")?.textContent)).toEqual(["Довести до конца", "Команда агентов"]);

    show([]);
    expect(outline()).toEqual(["# Команды и навыки", "Довести до конца", "Команда агентов", "Команды OmO недоступны"]);
  });

  it("skill_inserted_with_dollar", () => {
    typeInput("/rec");
    expect(outline()).toEqual(["# Команды и навыки", "$receiving-code-review"]); // the canonical «$name», not «$skill:name»
    (menu().querySelector("[data-row]") as HTMLElement).click();
    expect(text(input())).toBe("$receiving-code-review ");
    expect(menu().hidden).toBe(true);
  });

  it("the_slash_button_opens_the_actions_menu_not_the_command_list", () => {
    type(input(), "почини кэш");
    (root.querySelector('[data-role="slash"]') as HTMLButtonElement).click();
    expect(menu().hidden).toBe(true);
    expect(text(input())).toBe("почини кэш"); // nothing typed for the person
    expect((root.querySelector('[data-popover="actions"]') as HTMLElement).hidden).toBe(false);
  });
});
