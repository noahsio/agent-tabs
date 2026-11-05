// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";
import { text, type } from "../helpers/composer";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

function role(name: string, scope: ParentNode = root): HTMLElement {
  return scope.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

function input(): HTMLElement {
  return root.querySelector(".input") as HTMLElement;
}

function shown(): string[] {
  return [...root.querySelectorAll<HTMLElement>("[data-popover]")].filter((pop) => !pop.hidden).map((pop) => pop.dataset["popover"] as string);
}

function actions(): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-popover="actions"] [data-row]')].filter((row) => !row.hidden);
}

function action(label: string): HTMLElement {
  const row = actions().find((candidate) => candidate.textContent?.startsWith(label));
  if (row === undefined) throw new Error(`no action «${label}»`);
  return row;
}

function openActions(): void {
  role("slash").click();
}

function key(target: EventTarget, name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function send(text: string): void {
  type(input(), text);
  key(input(), "Enter");
}

const sent = (): string[] => posted.flatMap((message) => (message.type === "send" ? [message.text] : []));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  view.update({ type: "state", state: initialState(), tab: { modelMode: "auto", sessionPath: "/s/a.jsonl", durableId: "d1" }, reconnectable: true });
});

afterEach(() => {
  key(document, "Escape");
});

describe("«/» button: the actions menu", () => {
  it("lists_the_actions_and_toggles_with_the_keyboard_on_the_first_one", () => {
    openActions();
    expect(shown()).toEqual(["actions"]);
    expect(text(input())).toBe(""); // no «/» typed: that is the command list's entry point
    expect(actions().map((row) => row.textContent)).toEqual([
      "Довести до концаАгент сам составит план, выполнит его и проверит результат, прежде чем закончить ulw",
      "Команда агентовЗадача делится на части, которые параллельно делают несколько агентов на подходящих моделях mass ulw",
      "Настройки",
    ]);
    // Two lines: the plain title, then the dim explanation with the keyword as a small tag at its end.
    const first = actions()[0] as HTMLElement;
    expect(first.querySelector(".name")?.textContent).toBe("Довести до конца");
    expect(first.querySelector(".desc")?.textContent).toContain("Агент сам составит план");
    expect(first.querySelector(".desc .tag")?.textContent).toBe("ulw");
    expect(role("action-settings").hidden).toBe(false);

    expect(document.activeElement).toBe(actions()[0]);
    key(actions()[0] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(actions()[1]);
    key(actions()[1] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(role("action-settings"));
    key(actions()[2] as HTMLElement, "ArrowUp");
    key(actions()[1] as HTMLElement, "ArrowUp");
    key(actions()[0] as HTMLElement, "ArrowUp"); // stays on the first
    expect(document.activeElement).toBe(actions()[0]);
    key(document, "Escape");
    expect(shown()).toEqual([]);
    expect(document.activeElement).toBe(input());
  });

  it("settings_sits_under_a_separator_line", () => {
    openActions();
    const settings = role("action-settings");
    expect(settings.textContent).toBe("Настройки");
    expect(settings.previousElementSibling?.getAttribute("role")).toBe("separator");
  });

  it("hovering_a_row_makes_it_the_active_one", () => {
    openActions();
    expect(document.activeElement).toBe(actions()[0]);
    (actions()[2] as HTMLElement).dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.activeElement).toBe(actions()[2]);
    key(actions()[2] as HTMLElement, "ArrowUp"); // the keyboard goes on from the hovered row
    expect(document.activeElement).toBe(actions()[1]);
  });

  it("a_mode_toggle_stays_on_for_every_message_and_shows_as_a_chip", () => {
    const chip = (): HTMLElement => role("mode-chip");
    expect(chip().hidden).toBe(true);

    openActions();
    action("Довести до конца").click();
    expect(shown()).toEqual([]);
    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toContain("Довести до конца");
    expect(chip().textContent).not.toContain("ulw");
    openActions();
    expect(action("Довести до конца").getAttribute("aria-checked")).toBe("true");
    expect(action("Команда агентов").getAttribute("aria-checked")).toBe("false");
    action("Команда агентов").click(); // one mode at a time
    expect(chip().textContent).toContain("Команда агентов");

    send("почини кэш");
    send("и проверь");
    expect(sent()).toEqual(["mass ulw почини кэш", "mass ulw и проверь"]); // sticky
    expect(chip().hidden).toBe(false);

    openActions();
    action("Довести до конца").click();
    openActions();
    action("Довести до конца").click(); // the active one flips off
    expect(chip().hidden).toBe(true);

    openActions();
    action("Довести до конца").click();
    chip().click(); // the chip drops it
    expect(chip().hidden).toBe(true);
    send("просто");
    expect(sent().at(-1)).toBe("просто");
  });
});
