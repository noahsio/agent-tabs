// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { StateMessage, WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";

let root: HTMLElement;
let view: ChatView;

const TOOL: Block = { kind: "tool", id: "t1", name: "bash", summary: "ls -la", args: {}, input: "ls -la", output: "file.txt", truncated: false, state: "ok" };

function show(state: Partial<ChatState> = { blocks: [TOOL] }): void {
  const message: StateMessage = { type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "auto" }, reconnectable: true };
  view.update(message);
}

/** The tool step's header: its text is what opens and closes the step. */
function header(): HTMLElement {
  return root.querySelector('[data-block="t1"] summary') as HTMLElement;
}

function open(): boolean {
  return (root.querySelector('[data-block="t1"] details.tool-details') as HTMLDetailsElement).open;
}

function input(): HTMLElement {
  return root.querySelector(".input") as HTMLElement;
}

/** A person's click: the press, then the click the browser sends after the release. `to` makes it a drag. */
function clickOn(target: HTMLElement, from = { x: 10, y: 10 }, to = from): MouseEvent {
  const common = { bubbles: true, cancelable: true, button: 0 };
  target.dispatchEvent(new MouseEvent("mousedown", { ...common, clientX: from.x, clientY: from.y }));
  const click = new MouseEvent("click", { ...common, clientX: to.x, clientY: to.y });
  target.dispatchEvent(click);
  return click;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  const posted: WebviewMessage[] = [];
  view = new ChatView(root, (message) => posted.push(message));
  show();
  window.dispatchEvent(new Event("focus")); // every test states where the focus stands itself
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the click that brings the tab back into focus", () => {
  it("only_focuses_and_the_next_click_acts", () => {
    const before = open();
    window.dispatchEvent(new Event("blur"));

    const first = clickOn(header());
    expect(first.defaultPrevented).toBe(true);
    expect(open()).toBe(before);

    const second = clickOn(header());
    expect(second.defaultPrevented).toBe(false);
    expect(open()).toBe(!before);
  });

  it("a_hidden_tab_coming_back_is_the_same_as_a_blurred_one", () => {
    const before = open();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(clickOn(header()).defaultPrevented).toBe(true);
    expect(open()).toBe(before);
  });

  it("still_puts_the_caret_in_the_composer", () => {
    window.dispatchEvent(new Event("blur"));

    expect(clickOn(input()).defaultPrevented).toBe(false);
    // and the press in the text spent the one swallow: the click after it acts
    expect(clickOn(header()).defaultPrevented).toBe(false);
  });

  it("does_not_swallow_the_end_of_a_selection_drag", () => {
    window.dispatchEvent(new Event("blur"));

    const dragged = clickOn(header(), { x: 10, y: 10 }, { x: 240, y: 90 });
    expect(dragged.defaultPrevented).toBe(false);
  });

  it("a_click_long_after_the_focus_came_back_is_an_ordinary_click", () => {
    const before = open();
    vi.useFakeTimers({ toFake: ["Date"] });
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus")); // Cmd+Tab, not a click
    vi.setSystemTime(Date.now() + 1_000);

    expect(clickOn(header()).defaultPrevented).toBe(false);
    expect(open()).toBe(!before);
  });
});
