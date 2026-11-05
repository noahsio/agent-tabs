// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import type { LadderView } from "../../src/sessions/ladder";
import { Composer } from "../../webview/composer";

let app: HTMLElement;
let posted: WebviewMessage[];
let composer: Composer;

function role(name: string): HTMLElement {
  return app.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

/** The ladder's line as the person sees it, or undefined while it is not there. */
function line(): string | undefined {
  return role("ladder").hidden ? undefined : (role("ladder-text").textContent ?? "");
}

function actions(): string[] {
  return ["ladder-stop", "ladder-back"].filter((name) => !role(name).hidden);
}

function walking(view: Partial<Extract<LadderView, { state: "walking" }>> = {}): void {
  composer.ladder({ state: "walking", rung: 4, total: 5, label: "GPT 6.1 Sol", ...view });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><footer id="composer"></footer></div>';
  app = document.getElementById("app") as HTMLElement;
  posted = [];
  composer = new Composer(document.getElementById("composer") as HTMLElement, (message) => posted.push(message), { dropZone: app });
  composer.update({ type: "state", state: initialState(), tab: { modelMode: "auto" }, reconnectable: true });
});

describe("the ladder's line in the composer", () => {
  it("there_is_no_line_until_the_ladder_walks", () => {
    expect(line()).toBeUndefined();
    expect(actions()).toEqual([]);
  });

  it("the_walk_names_the_step_it_is_on_and_the_model_it_went_to", () => {
    walking({ rung: 2, total: 4, label: "GPT 6.1 Sol" });
    expect(line()).toBe("Ступенька 2 из 4 · GPT 6.1 Sol");
    walking();
    expect(line()).toBe("Ступенька 4 из 5 · GPT 6.1 Sol");
  });

  it("the_walk_can_be_interrupted", () => {
    walking();
    expect(actions()).toEqual(["ladder-stop"]);
    expect(role("ladder-stop").textContent).toBe("Прервать");
    role("ladder-stop").click();
    expect(posted).toContainEqual({ type: "ladderInterrupt" });
    expect(line()).toBeUndefined(); // the line goes at once; the host confirms with its own null
  });

  it("once_it_has_settled_one_click_goes_back_to_the_model_it_started_on", () => {
    composer.ladder({ state: "settled", model: "GPT 6.1 Sol", back: { provider: "gw-anthropic", id: "claude-opus-5-5", label: "Opus 5.5" } });
    expect(line()).toBe("Сессия осталась на GPT 6.1 Sol");
    expect(actions()).toEqual(["ladder-back"]);
    expect(role("ladder-back").textContent).toBe("вернуться на Opus 5.5");
    role("ladder-back").click();
    expect(posted).toContainEqual({ type: "setModel", model: { provider: "gw-anthropic", id: "claude-opus-5-5" } });
    expect(line()).toBeUndefined();
  });

  it("the_host_takes_the_line_away", () => {
    walking();
    composer.ladder(null);
    expect(line()).toBeUndefined();
    expect(actions()).toEqual([]);
  });

  it("a_state_update_leaves_the_line_alone", () => {
    walking();
    composer.update({ type: "state", state: { ...initialState(), running: true }, tab: { modelMode: "auto" }, reconnectable: true });
    expect(line()).toBe("Ступенька 4 из 5 · GPT 6.1 Sol");
  });

  it("the_line_survives_the_tab_being_disposed_of_without_throwing", () => {
    walking();
    composer.dispose();
    expect(line()).toBe("Ступенька 4 из 5 · GPT 6.1 Sol");
  });
});
