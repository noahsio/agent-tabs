// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { StateMessage, WebviewMessage } from "../../src/panel/protocol";
import { Composer } from "../../webview/composer";
import { text, type as typeInto } from "../helpers/composer";

const NOW = new Date("2026-11-04T12:00:00Z").getTime();
const STOP_WAIT_MS = 8_000;
const SILENT_MS = 180_000;

let app: HTMLElement;
let posted: WebviewMessage[];
let composer: Composer;

function show(state: Partial<ChatState> = {}, extra: Partial<StateMessage> = {}): void {
  composer.update({ type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "auto" }, reconnectable: true, ...extra });
}

function role(name: string): HTMLElement {
  return app.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

/** The wedge line as the person sees it, or undefined while it is not there. */
function line(): string | undefined {
  return role("wedge").hidden ? undefined : (role("wedge-text").textContent ?? "");
}

function actions(): string[] {
  return ["unwedge", "wedge-cancel"].filter((name) => !role(name).hidden);
}

function knob(name: "send" | "stop"): HTMLButtonElement {
  return role(name) as HTMLButtonElement;
}

/** Every unwedge the composer asked for by itself. */
function autos(): WebviewMessage[] {
  return posted.filter((message) => message.type === "unwedge" && message.auto === true);
}

function type(text: string): void {
  typeInto(app.querySelector(".input") as HTMLElement, text);
}

function reply(text: string): Block {
  return { kind: "assistant", id: `a-${text}`, text, thinking: "", streaming: true };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  document.body.innerHTML = '<div id="app"><footer id="composer"></footer></div>';
  app = document.getElementById("app") as HTMLElement;
  posted = [];
  composer = new Composer(document.getElementById("composer") as HTMLElement, (message) => posted.push(message), { dropZone: app });
  show();
});

afterEach(() => {
  composer.dispose();
  vi.useRealTimers();
});

describe("the wedge line under the composer", () => {
  it("silence_alone_is_only_ever_offered_never_acted_on", () => {
    show({ running: true });
    expect(line()).toBeUndefined();
    vi.advanceTimersByTime(SILENT_MS - 1_000);
    expect(line()).toBeUndefined();
    vi.advanceTimersByTime(2_000);
    expect(line()).toBe("От модели нет ответа 3 мин"); // it offers, and only offers: the agent may be thinking
    expect(actions()).toEqual(["unwedge", "wedge-cancel"]);
    expect(posted.filter((message) => message.type === "unwedge")).toEqual([]);

    (role("unwedge") as HTMLButtonElement).click(); // and the person's click is a plain one, never the automatic kind
    expect(posted.at(-1)).toEqual({ type: "unwedge" });
  });

  /**
   * Seen live: the main turn waited on a working subagent, the feed stayed still, and after 3 minutes the tab offered
   * «Снять зависание» for a session that was fine. While a tool or a subagent runs the model owes nothing yet.
   */
  it("a_running_subagent_or_tool_is_not_silence", () => {
    const agent = { id: "t1", role: "deep-low", description: "x", status: "running" } as unknown as ChatState["agents"][number];
    show({ running: true, agents: [agent] });
    vi.advanceTimersByTime(SILENT_MS * 3);
    expect(line()).toBeUndefined();

    const tool = { kind: "tool", id: "b1", name: "bash", summary: "sleep", args: {}, state: "running" } as unknown as Block;
    show({ running: true, blocks: [tool] });
    vi.advanceTimersByTime(SILENT_MS * 3);
    expect(line()).toBeUndefined();

    // once nothing is in flight, the silence counts from then
    show({ running: true, blocks: [{ ...tool, state: "ok" } as Block] });
    vi.advanceTimersByTime(SILENT_MS - 1_000);
    expect(line()).toBeUndefined();
    vi.advanceTimersByTime(2_000);
    expect(line()).toBe("От модели нет ответа 3 мин");
  });

  it("stop_still_restarts_a_turn_whose_subagent_runs", () => {
    const agent = { id: "t1", role: "deep-low", description: "x", status: "running" } as unknown as ChatState["agents"][number];
    show({ running: true, agents: [agent] });
    composer.noteStop();
    vi.advanceTimersByTime(STOP_WAIT_MS);
    expect(autos()).toHaveLength(1);
  });

  it("restarts_the_session_by_itself_when_stop_goes_unanswered", () => {
    show({ running: true });
    role("stop").click();
    expect(posted.at(-1)).toEqual({ type: "stop" });

    vi.advanceTimersByTime(STOP_WAIT_MS - 1);
    expect(line()).toBeUndefined();
    expect(autos()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(autos()).toEqual([{ type: "unwedge", auto: true }]);
    expect(line()).toBe("Перезапускаю сессию…");
    expect(actions()).toEqual([]); // it was done, not asked

    vi.advanceTimersByTime(STOP_WAIT_MS * 10); // once per «Стоп», however long the turn stays wedged
    expect(autos().length).toBe(1);

    composer.unwedged({ type: "unwedged", auto: true, outcome: "unloaded" });
    expect(line()).toBeUndefined(); // the feed carries the word on it
  });

  it("the_buttons_rest_while_it_restarts_and_the_typed_message_waits", () => {
    show({ running: true });
    type("а теперь по-другому");
    expect(knob("send").disabled).toBe(false);
    expect(knob("stop").disabled).toBe(false);

    role("stop").click();
    vi.advanceTimersByTime(STOP_WAIT_MS);
    expect(knob("send").disabled).toBe(true);
    expect(knob("stop").disabled).toBe(true);

    composer.unwedged({ type: "unwedged", auto: true, outcome: "unloaded" });
    expect(knob("send").disabled).toBe(false);
    expect(knob("stop").disabled).toBe(false);
    expect(text(app.querySelector(".input") as HTMLElement)).toBe("а теперь по-другому");
  });

  it("a_second_wedged_stop_within_the_cooldown_is_offered_instead_of_done", () => {
    show({ running: true });
    role("stop").click();
    vi.advanceTimersByTime(STOP_WAIT_MS);

    composer.unwedged({ type: "unwedged", auto: true, outcome: "cooldown" });
    expect(line()).toBe("Перезапуск уже был — агент снова не отвечает на «Стоп». Снять зависание?");
    expect(actions()).toEqual(["unwedge", "wedge-cancel"]);
    expect(knob("stop").disabled).toBe(false);

    vi.advanceTimersByTime(SILENT_MS * 2); // and it never asks for another by itself
    expect(autos().length).toBe(1);

    (role("unwedge") as HTMLButtonElement).click();
    expect(posted.at(-1)).toEqual({ type: "unwedge" });
    expect(line()).toBe("Снимаю зависание…");
  });

  it("a_restart_the_host_refused_shows_the_reason_with_the_manual_way_out_and_is_not_tried_again", () => {
    show({ running: true });
    role("stop").click();
    vi.advanceTimersByTime(STOP_WAIT_MS);

    composer.unwedged({ type: "unwedged", auto: true, outcome: "refused", reason: "Дочерние задачи ещё работают: 2 задачи" });
    expect(line()).toBe("Дочерние задачи ещё работают: 2 задачи. Снять зависание?");
    expect(actions()).toEqual(["unwedge", "wedge-cancel"]);

    vi.advanceTimersByTime(SILENT_MS * 2);
    expect(autos().length).toBe(1);
  });

  it("a_refusal_of_the_persons_own_click_is_shown_as_it_came", () => {
    show({ running: true });
    vi.advanceTimersByTime(SILENT_MS);
    (role("unwedge") as HTMLButtonElement).click();

    composer.unwedged({ type: "unwedged", outcome: "refused", reason: "Дочерние задачи ещё работают" });
    expect(line()).toBe("Дочерние задачи ещё работают");
    expect(actions()).toEqual([]);
  });

  it("cancel_puts_the_line_away_and_what_raised_it_does_not_raise_it_again", () => {
    show({ running: true });
    role("stop").click();
    vi.advanceTimersByTime(STOP_WAIT_MS);
    composer.unwedged({ type: "unwedged", auto: true, outcome: "cooldown" });

    (role("wedge-cancel") as HTMLButtonElement).click();
    expect(line()).toBeUndefined();
    vi.advanceTimersByTime(STOP_WAIT_MS * 10);
    expect(line()).toBeUndefined();
    expect(autos().length).toBe(1);

    vi.advanceTimersByTime(SILENT_MS); // silence does ask again, later
    expect(line()).toMatch(/^От модели нет ответа \d+ мин$/);
  });

  it("every_frame_for_the_session_resets_the_silence", () => {
    show({ running: true, blocks: [reply("думаю")] });
    for (let minute = 0; minute < 5; minute++) {
      vi.advanceTimersByTime(60_000);
      show({ running: true, blocks: [reply(`думаю ${minute}`)] });
      expect(line()).toBeUndefined();
    }
    vi.advanceTimersByTime(SILENT_MS);
    expect(line()).toBe("От модели нет ответа 3 мин");
  });

  it("goes_away_when_the_turn_ends", () => {
    show({ running: true });
    vi.advanceTimersByTime(SILENT_MS);
    expect(line()).toMatch(/^От модели нет ответа \d+ мин$/);

    show({ running: false });
    expect(line()).toBeUndefined();

    show({ running: true, blocks: [reply("снова")] }); // a new turn starts clean: no stop of its own to answer
    vi.advanceTimersByTime(STOP_WAIT_MS * 2);
    expect(line()).toBeUndefined();
    expect(autos()).toEqual([]);
  });

  it("never_offers_while_no_turn_runs", () => {
    vi.advanceTimersByTime(SILENT_MS * 2);
    expect(line()).toBeUndefined();
    expect(posted.filter((message) => message.type === "unwedge")).toEqual([]);
  });
});
