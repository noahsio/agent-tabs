// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { StateMessage, WebviewMessage } from "../../src/panel/protocol";
import { Composer } from "../../webview/composer";

const NOW = new Date("2026-11-04T12:00:00Z").getTime();
const STOP_WAIT_MS = 5_000;
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
  it("is_absent_while_a_turn_runs_normally_and_nothing_is_ever_unloaded_by_itself", () => {
    show({ running: true });
    expect(line()).toBeUndefined();
    vi.advanceTimersByTime(SILENT_MS - 1_000);
    expect(line()).toBeUndefined();
    vi.advanceTimersByTime(2_000);
    expect(line()).toBe("От модели нет ответа 3 мин"); // it offers, and only offers
    expect(posted.filter((message) => message.type === "unwedge")).toEqual([]);
  });

  it("offers_to_unwedge_five_seconds_after_stop_went_unanswered", () => {
    show({ running: true });
    role("stop").click();
    expect(posted.at(-1)).toEqual({ type: "stop" });

    vi.advanceTimersByTime(STOP_WAIT_MS - 1);
    expect(line()).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(line()).toBe("Агент не отвечает на «Стоп». Снять зависание?");
    expect(actions()).toEqual(["unwedge", "wedge-cancel"]);

    (role("unwedge") as HTMLButtonElement).click();
    expect(posted.at(-1)).toEqual({ type: "unwedge" });
    expect(line()).toBe("Снимаю зависание…");
    expect(actions()).toEqual([]); // nothing to press while it runs

    composer.unwedged({ type: "unwedged", outcome: "unloaded" });
    expect(line()).toBe("Сессия перезапущена");
  });

  it("a_refusal_is_shown_as_it_came", () => {
    show({ running: true });
    role("stop").click();
    vi.advanceTimersByTime(STOP_WAIT_MS);
    (role("unwedge") as HTMLButtonElement).click();

    composer.unwedged({ type: "unwedged", outcome: "refused", reason: "Дочерние задачи ещё работают" });
    expect(line()).toBe("Дочерние задачи ещё работают");
    expect(actions()).toEqual([]);
  });

  it("cancel_puts_the_line_away_and_the_stop_that_raised_it_does_not_raise_it_again", () => {
    show({ running: true });
    role("stop").click();
    vi.advanceTimersByTime(STOP_WAIT_MS);
    expect(line()).toBe("Агент не отвечает на «Стоп». Снять зависание?");

    (role("wedge-cancel") as HTMLButtonElement).click();
    expect(line()).toBeUndefined();
    vi.advanceTimersByTime(STOP_WAIT_MS * 10);
    expect(line()).toBeUndefined();

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
    role("stop").click();
    vi.advanceTimersByTime(STOP_WAIT_MS);
    expect(line()).toBe("Агент не отвечает на «Стоп». Снять зависание?");

    show({ running: false });
    expect(line()).toBeUndefined();

    show({ running: true }); // a new turn starts clean: no stop of its own to answer
    vi.advanceTimersByTime(STOP_WAIT_MS * 2);
    expect(line()).toBeUndefined();
  });

  it("never_offers_while_no_turn_runs", () => {
    vi.advanceTimersByTime(SILENT_MS * 2);
    expect(line()).toBeUndefined();
    expect(posted.filter((message) => message.type === "unwedge")).toEqual([]);
  });
});
