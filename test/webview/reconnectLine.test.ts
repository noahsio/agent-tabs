// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { ReconnectingMessage, WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";

const FAILURE = "Не удалось открыть сессию: omo host exited (code 1, signal null) before it was ready";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;
let current: ChatState;

function show(patch: Partial<ChatState> = {}): void {
  current = { ...current, ...patch };
  view.update({ type: "state", state: current, tab: { modelMode: "auto", durableId: "s1" }, reconnectable: true });
}

function waiting(overrides: Partial<Extract<ReconnectingMessage, { active: true }>> = {}): ReconnectingMessage {
  return {
    type: "reconnecting",
    active: true,
    error: FAILURE,
    attempt: 2,
    waitMs: 5_000,
    capped: false,
    target: { host: "/Users/me/.omo", session: "/tmp/s/2026_abc.jsonl" },
    ...overrides,
  };
}

const line = (): HTMLElement => root.querySelector('[data-role="reconnect-line"]') as HTMLElement;
const lineText = (): string => (root.querySelector('[data-role="reconnect-text"]') as HTMLElement).textContent ?? "";
const progress = (): string => (root.querySelector('[data-role="reconnect-progress"]') as HTMLElement).textContent ?? "";
const banner = (): HTMLElement => root.querySelector('[data-role="banner"]') as HTMLElement;
const modal = (): HTMLElement => root.querySelector('[data-role="reconnect-details"]') as HTMLElement;
const detail = (role: string): HTMLElement => root.querySelector(`[data-role="${role}"]`) as HTMLElement;
const click = (role: string): void => (root.querySelector(`[data-role="${role}"]`) as HTMLElement).click();

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  current = initialState();
  show();
});

describe("the reconnect line over the composer", () => {
  it("stands_directly_over_the_composer_box_and_not_at_the_top_of_the_tab", () => {
    view.reconnecting(waiting());
    const footer = line().parentElement as HTMLElement;
    const children = [...footer.children];
    expect(children.indexOf(line())).toBe(children.indexOf(root.querySelector(".composer-box") as HTMLElement) - 1);
    expect(banner().contains(line())).toBe(false);
  });

  it("a_connection_failure_shows_here_with_a_countdown_while_the_banner_stays_empty", () => {
    expect(line().hidden).toBe(true);
    view.reconnecting(waiting());

    expect(line().hidden).toBe(false);
    expect(lineText()).toBe(FAILURE);
    expect(progress()).toBe("Повтор через 5 с · попытка 2");
    expect(banner().hidden).toBe(true); // the state carries no error: nothing up there
    expect(root.querySelector('[data-role="reconnect-spin"]')).not.toBeNull();
  });

  it("the_countdown_runs_down_by_itself_and_then_says_the_attempt_is_running", () => {
    view.reconnecting(waiting({ waitMs: 3_000 }));
    expect(progress()).toContain("через 3 с");
    vi.advanceTimersByTime(1_000);
    expect(progress()).toContain("через 2 с");
    vi.advanceTimersByTime(2_000);
    expect(progress()).toContain("через 0 с");

    view.reconnecting(waiting({ attempt: 3, waitMs: undefined }));
    expect(progress()).toBe("Переподключаюсь… · попытка 3");
  });

  it("a_capped_pause_says_it_is_still_trying", () => {
    view.reconnecting(waiting({ attempt: 7, waitMs: 30_000, capped: true }));
    expect(progress()).toBe("Повтор через 30 с · попытка 7 · всё ещё пробую");
  });

  /** The person's own case: a file another copy of the host holds. The line stays quiet, and stops promising. */
  it("a_line_that_gave_up_says_so_quietly_and_offers_no_button_that_cannot_work", () => {
    const text = "Файл сессии держит другая копия хоста OmO (pid 46960) — она ещё работает.";
    view.reconnecting(waiting({ error: text, attempt: 6, waitMs: undefined, givenUp: true }));

    expect(line().hidden).toBe(false);
    expect(banner().hidden).toBe(true); // never the red banner at the top
    expect(lineText()).toBe(text);
    expect(progress()).toBe("Попыток: 6");
    expect(line().dataset["phase"]).toBe("held"); // the spinner stands still: nothing is in flight
    expect((root.querySelector('[data-role="reconnect-now"]') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('[data-role="reconnect-more"]') as HTMLElement).hidden).toBe(false);
  });

  /** The holder is working, so the extension would not stop it: the one thing a click CAN do is offered. */
  it("a_line_that_refused_to_stop_the_holder_offers_the_stop_with_the_facts_beside_it", () => {
    const text = `Файл сессии держит другая копия хоста OmO (pid 46960): в этой среде ещё идут задачи (1). Сама её не останавливаю — клиентов 0, незакрытых задач 1, журналы молчат 0 мин, CPU 42 %.`;
    view.reconnecting(waiting({ error: text, attempt: 6, waitMs: undefined, givenUp: true, offerStop: true }));

    expect(line().hidden).toBe(false);
    expect(banner().hidden).toBe(true);
    expect(lineText()).toBe(text); // the facts they decide on are the line itself
    expect((root.querySelector('[data-role="reconnect-stop"]') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('[data-role="reconnect-now"]') as HTMLElement).hidden).toBe(true); // retrying still cannot help

    click("reconnect-stop");
    expect(posted).toEqual([{ type: "stopHolder" }]);
  });

  it("no_stop_is_offered_while_the_retry_is_still_running_or_when_it_was_refused_for_good", () => {
    view.reconnecting(waiting());
    expect((root.querySelector('[data-role="reconnect-stop"]') as HTMLElement).hidden).toBe(true);

    view.reconnecting(waiting({ attempt: 6, waitMs: undefined, givenUp: true }));
    expect((root.querySelector('[data-role="reconnect-stop"]') as HTMLElement).hidden).toBe(true);

    view.reconnecting({ type: "reconnecting", active: false });
    expect((root.querySelector('[data-role="reconnect-stop"]') as HTMLElement).hidden).toBe(true);
  });

  it("the_modal_of_a_line_that_offers_the_stop_says_so_and_asks_the_host", () => {
    view.reconnecting(waiting({ error: "держит pid 46960", attempt: 6, waitMs: undefined, givenUp: true, offerStop: true }));
    click("reconnect-more");
    expect(detail("reconnect-attempts").textContent).toContain("путь освободит только остановка той копии");
    expect((root.querySelector('[data-role="reconnect-details-stop"]') as HTMLElement).hidden).toBe(false);

    click("reconnect-details-stop");
    expect(posted).toEqual([{ type: "stopHolder" }]);
    expect(modal().hidden).toBe(true);
  });

  it("the_modal_of_a_line_that_gave_up_says_it_stopped_instead_of_counting_down", () => {
    view.reconnecting(waiting({ error: "держит другая копия", attempt: 6, waitMs: undefined, givenUp: true }));
    click("reconnect-more");
    expect(modal().hidden).toBe(false);
    expect(detail("reconnect-attempts").textContent).toContain("Больше не пробую");
  });

  it("a_retry_that_succeeds_clears_the_line", () => {
    view.reconnecting(waiting());
    view.reconnecting({ type: "reconnecting", active: false });
    expect(line().hidden).toBe(true);
    expect(lineText()).toBe("");
    expect(progress()).toBe("");
  });

  it("повторить_сейчас_asks_the_host_without_the_person_hunting_for_a_banner", () => {
    view.reconnecting(waiting());
    click("reconnect-now");
    expect(posted).toEqual([{ type: "reconnect" }]);
  });

  it("the_whole_failure_waits_in_the_modal_the_agent_card_uses", () => {
    view.reconnecting(waiting());
    expect(modal().hidden).toBe(true);

    click("reconnect-text"); // the line itself opens it
    expect(modal().hidden).toBe(false);
    expect(modal().classList.contains("agent-details-backdrop")).toBe(true);
    expect(modal().querySelector(".agent-details")).not.toBeNull();
    expect(detail("reconnect-error").textContent).toBe(FAILURE);
    expect(detail("reconnect-where").textContent).toContain("/Users/me/.omo");
    expect(detail("reconnect-where").textContent).toContain("/tmp/s/2026_abc.jsonl");
    expect(detail("reconnect-attempts").textContent).toContain("Автоматических попыток: 2");
    expect(detail("reconnect-attempts").textContent).toContain("Следующая через 5 с");
    expect(root.querySelector('[data-role="reconnect-copy"]')).not.toBeNull();
  });

  it("the_open_modal_follows_the_next_attempt_and_its_retry_button_asks_the_host", () => {
    view.reconnecting(waiting());
    click("reconnect-more");
    view.reconnecting(waiting({ attempt: 3, waitMs: undefined }));
    expect(detail("reconnect-attempts").textContent).toContain("Автоматических попыток: 3");
    expect(detail("reconnect-attempts").textContent).toContain("Попытка идёт сейчас");

    click("reconnect-retry");
    expect(posted).toEqual([{ type: "reconnect" }]);
    expect(modal().hidden).toBe(true);
  });
});
