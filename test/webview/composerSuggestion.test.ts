// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import { Composer } from "../../webview/composer";
import { text, type as typeInto } from "../helpers/composer";

let composer: Composer;

function show(state: Partial<ChatState> = {}): void {
  composer.update({ type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "auto" }, reconnectable: true });
}

function input(): HTMLElement {
  return document.querySelector(".input") as HTMLElement;
}

function press(key: string, init: KeyboardEventInit = {}): boolean {
  return input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><footer id="composer"></footer></div>';
  const posted: WebviewMessage[] = [];
  composer = new Composer(document.getElementById("composer") as HTMLElement, (message) => posted.push(message));
});

describe("the next-message guess in the composer", () => {
  it("shows_greyed_in_the_empty_field_and_tab_puts_it_in_as_text", () => {
    show({ suggestion: "Закоммить и запушь" });
    expect(input().dataset["placeholder"]).toBe("Закоммить и запушь");
    expect(input().classList.contains("suggesting")).toBe(true);
    expect(press("Tab")).toBe(false); // taken: focus stays in the field
    expect(text(input())).toBe("Закоммить и запушь");
    expect(input().classList.contains("suggesting")).toBe(false);
  });

  it("right_arrow_takes_it_too_but_not_with_a_modifier", () => {
    show({ suggestion: "дальше" });
    expect(press("ArrowRight", { shiftKey: true })).toBe(true);
    expect(text(input())).toBe("");
    press("ArrowRight");
    expect(text(input())).toBe("дальше");
  });

  it("typing_over_it_dismisses_it_for_good", () => {
    show({ suggestion: "дальше" });
    typeInto(input(), "своё");
    typeInto(input(), "");
    show({ suggestion: "дальше" }); // the same guess on the next state stays gone
    expect(input().classList.contains("suggesting")).toBe(false);
    expect(press("Tab")).toBe(true);
    expect(text(input())).toBe("");
  });

  it("is_not_shown_while_the_agent_works", () => {
    show({ suggestion: "дальше", running: true });
    expect(input().classList.contains("suggesting")).toBe(false);
    expect(input().dataset["placeholder"]).not.toBe("дальше");
  });
});
