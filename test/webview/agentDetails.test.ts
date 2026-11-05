// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRow, ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { AgentDetails, AgentDetailsMessage, StateMessage, WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";

const NOW = new Date("2026-11-03T20:00:00Z").getTime();
const OPUS = { provider: "gw-anthropic", id: "claude-opus-5-5" };
const MODELS = [{ ...OPUS, name: "Opus 5.5" }];

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

function show(agents: AgentRow[], state: Partial<ChatState> = {}): void {
  const message: StateMessage = { type: "state", state: { ...initialState(), agents, ...state }, tab: { modelMode: "auto", durableId: "d1" }, reconnectable: true, models: MODELS };
  view.update(message);
}

function role(name: string, scope: ParentNode = root): HTMLElement {
  return scope.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

/** The popovers currently shown. */
function shown(): string[] {
  return [...root.querySelectorAll<HTMLElement>("[data-popover]")].filter((pop) => !pop.hidden).map((pop) => pop.dataset["popover"] as string);
}

function details(): HTMLElement {
  return role("agent-details");
}

function cards(): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-popover="agents"] [data-row]')];
}

function card(label: string): HTMLElement {
  return cards().find((candidate) => role("agent-label", candidate).textContent === label) as HTMLElement;
}

function requests(): WebviewMessage[] {
  return posted.filter((message) => message.type === "agentDetails");
}

function reply(message: { taskId: string } & (({ ok: true } & AgentDetails) | { ok: false; reason: string })): void {
  const answer: AgentDetailsMessage = { type: "agentDetails", ...message };
  view.agentDetails(answer);
}

function escape(target: EventTarget = document.activeElement ?? document): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function openMap(): void {
  role("agents-pill").click();
  expect(shown()).toEqual(["agents"]);
}

const DONE: AgentRow = {
  id: "task:1",
  taskId: "t-1",
  label: "Поиск",
  role: "explore",
  model: "gw-anthropic/claude-opus-5-5",
  status: "done",
  startedAt: NOW - 200_000,
  endedAt: NOW - 75_000,
  tokens: 58_100,
};
const RUNNING: AgentRow = { id: "task:2", taskId: "t-2", label: "Правка", status: "running", startedAt: NOW - 10_000, tokens: 1_000 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
});

afterEach(() => {
  escape(document);
  escape(document); // the details, then the map: a view's document listeners outlive the test
  vi.useRealTimers();
});

describe("agent details modal", () => {
  it("a_click_on_a_card_opens_the_details_over_the_map_with_meta_task_and_markdown_result", () => {
    show([DONE]);
    openMap();
    card("Поиск").click();

    expect(requests()).toEqual([{ type: "agentDetails", taskId: "t-1" }]);
    expect(posted.filter((message) => message.type === "agentOutput")).toEqual([]); // no .log document any more
    expect(shown()).toEqual(["agents"]); // the map stays underneath
    expect(details().hidden).toBe(false);
    expect(details().getAttribute("role")).toBe("dialog");
    expect(details().contains(document.activeElement)).toBe(true);
    expect(role("agent-details-title", details()).textContent).toBe("Поиск");
    expect(role("agent-details-panel", details()).dataset["status"]).toBe("done");
    expect(role("agent-details-meta", details()).textContent).toBe("Opus 5.5 · 2 мин 5 с · 58,1 тыс. токенов · explore");

    reply({ taskId: "t-1", ok: true, prompt: "Найти, где читается кэш", result: "**готово** <img src=x onerror=alert(1)>", transcript: "assistant: ищу\ntool: grep", status: "done" });
    expect(role("agent-details-task", details()).textContent).toBe("Найти, где читается кэш");
    const result = role("agent-details-result", details());
    expect(result.querySelector("strong")?.textContent).toBe("готово");
    expect(result.querySelector("img")).toBeNull(); // raw HTML stays text, as in the feed
    const log = role("agent-details-log", details()) as HTMLDetailsElement;
    expect(log.open).toBe(false);
    expect(log.querySelector("pre")?.textContent).toBe("assistant: ищу\ntool: grep");

    expect(role("agent-details-stop", details()).hidden).toBe(true); // it is not running
    expect(role("agent-details-copy", details()).hidden).toBe(false);
    role("agent-details-file", details()).click();
    expect(posted.at(-1)).toEqual({ type: "agentOutput", taskId: "t-1" }); // the old document is still one click away
  });

  it("a_long_task_is_clamped_until_show_all", () => {
    show([DONE]);
    openMap();
    card("Поиск").click();
    reply({ taskId: "t-1", ok: true, prompt: "строка\n".repeat(12), status: "done" });
    const task = role("agent-details-task", details());
    const more = role("agent-details-more", details());
    expect(task.classList.contains("clamped")).toBe(true);
    expect(more.hidden).toBe(false);
    more.click();
    expect(task.classList.contains("clamped")).toBe(false);
    expect(more.hidden).toBe(true);
  });

  it("copy_puts_the_result_on_the_clipboard_and_is_hidden_without_one", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show([DONE]);
    openMap();
    card("Поиск").click();
    expect(role("agent-details-copy", details()).hidden).toBe(true); // nothing yet
    reply({ taskId: "t-1", ok: true, result: "итог", status: "done" });
    role("agent-details-copy", details()).click();
    expect(writeText).toHaveBeenCalledWith("итог");
  });

  it("stop_shows_only_while_running_and_details_refresh_at_most_every_3_s_until_the_agent_finishes", () => {
    show([RUNNING]);
    openMap();
    card("Правка").click();
    expect(requests()).toHaveLength(1);
    expect(role("agent-details-result", details()).textContent).toBe("Агент ещё работает…");
    const stop = role("agent-details-stop", details());
    expect(stop.hidden).toBe(false);
    stop.click();
    expect(posted.at(-1)).toEqual({ type: "agentCancel", taskId: "t-2" });
    expect(details().hidden).toBe(false); // stopping keeps the details open

    vi.advanceTimersByTime(3000);
    expect(requests()).toHaveLength(1); // the first answer is still in flight: no second request on top
    reply({ taskId: "t-2", ok: true, transcript: "assistant: шаг 1", status: "running" });
    expect(role("agent-details-result", details()).textContent).toBe("Агент ещё работает…");
    vi.advanceTimersByTime(3000);
    expect(requests()).toHaveLength(2); // every 3 s
    reply({ taskId: "t-2", ok: true, transcript: "assistant: шаг 2", status: "running" });

    for (let tokens = 2_000; tokens < 12_000; tokens += 1_000) show([{ ...RUNNING, tokens }]); // tokens stream in
    expect(requests()).toHaveLength(2); // left to the timer
    vi.advanceTimersByTime(2_999);
    expect(requests()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(requests()).toHaveLength(3);
    reply({ taskId: "t-2", ok: true, transcript: "assistant: шаг 3", status: "running" });

    vi.advanceTimersByTime(1_000);
    show([{ ...RUNNING, tokens: 13_000, status: "done", endedAt: NOW }]); // finished: one last read for the result, at once
    expect(requests()).toHaveLength(4);
    reply({ taskId: "t-2", ok: true, result: "сделано", status: "done" });
    expect(role("agent-details-result", details()).textContent?.trim()).toBe("сделано");
    expect(role("agent-details-stop", details()).hidden).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(requests()).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0); // nothing runs: no refresh timer, no map ticker
  });

  it("a_lost_answer_is_given_up_after_6_s_and_asked_again", () => {
    show([RUNNING]);
    openMap();
    card("Правка").click();
    vi.advanceTimersByTime(3000);
    expect(requests()).toHaveLength(1); // still waiting
    vi.advanceTimersByTime(3000);
    expect(requests()).toHaveLength(2); // 2 × 3 s without an answer: asked again
  });

  it("a_hidden_webview_does_not_poll", () => {
    show([RUNNING]);
    openMap();
    card("Правка").click();
    reply({ taskId: "t-2", ok: true, status: "running" });
    const visibility = (hidden: boolean): void => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      visibility(true);
      vi.advanceTimersByTime(30_000);
      expect(requests()).toHaveLength(1);
      visibility(false);
      vi.advanceTimersByTime(3000);
      expect(requests()).toHaveLength(2);
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });

  it("an_agent_gone_from_the_list_stops_the_refresh_and_says_so", () => {
    show([RUNNING]);
    openMap();
    card("Правка").click();
    reply({ taskId: "t-2", ok: true, status: "running" });
    show([]);
    const gone = role("agent-details-gone", details());
    expect(gone.hidden).toBe(false);
    expect(gone.textContent).toBe("Агент больше не в списке");
    expect(role("agent-details-stop", details()).hidden).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(requests()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closing_stops_the_refresh", () => {
    show([RUNNING]);
    openMap();
    card("Правка").click();
    reply({ taskId: "t-2", ok: true, status: "running" });
    escape();
    expect(details().hidden).toBe(true);
    vi.advanceTimersByTime(10_000);
    show([{ ...RUNNING, tokens: 9_000 }]);
    expect(requests()).toHaveLength(1);
    escape(); // the map
    expect(shown()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an_answer_for_another_agent_is_ignored", () => {
    show([DONE, RUNNING]);
    openMap();
    card("Поиск").click();
    reply({ taskId: "t-2", ok: true, result: "чужое", status: "running" });
    expect(role("agent-details-result", details()).textContent).not.toContain("чужое");
  });

  it("esc_the_cross_and_the_backdrop_return_to_the_map_with_focus_on_the_card", () => {
    show([DONE]);
    for (const close of [(): void => void escape(), (): void => role("agent-details-close", details()).click(), (): void => details().click()]) {
      openMap();
      card("Поиск").click();
      role("agent-details-panel", details()).click(); // a click on the panel keeps it
      expect(details().hidden).toBe(false);
      show([{ ...DONE, tokens: 60_000 }]); // the cards are rebuilt while it is open
      close();
      expect(details().hidden).toBe(true);
      expect(shown()).toEqual(["agents"]);
      expect(document.activeElement).toBe(card("Поиск"));
      escape(); // now the map itself
      expect(shown()).toEqual([]);
      expect(document.activeElement).toBe(root.querySelector(".input"));
      show([DONE]);
    }
  });

  it("closing_the_map_closes_the_details_too", () => {
    show([DONE]);
    openMap();
    card("Поиск").click();
    role("agents-pill").click(); // toggles the map away
    expect(shown()).toEqual([]);
    expect(details().hidden).toBe(true);
  });

  it("a_dag_node_opens_the_details_with_a_note_and_asks_for_nothing", () => {
    show([{ id: "dag:r1:n1", label: "build", model: "gw-anthropic/claude-opus-5-5", status: "running", startedAt: NOW - 5_000 }]);
    openMap();
    card("build").click();
    expect(details().hidden).toBe(false);
    expect(role("agent-details-title", details()).textContent).toBe("build");
    expect(role("agent-details-meta", details()).textContent).toBe("Opus 5.5 · 5 с");
    expect(details().textContent).toContain("У узла графа нет отдельного журнала");
    expect(role("agent-details-stop", details()).hidden).toBe(true);
    expect(role("agent-details-file", details()).hidden).toBe(true);
    card("build").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    vi.advanceTimersByTime(10_000);
    expect(posted.filter((message) => message.type === "agentDetails" || message.type === "agentOutput" || message.type === "agentCancel")).toEqual([]);
  });

  it("errors_show_inside_the_modal", () => {
    show([DONE, { ...RUNNING, id: "task:3", taskId: "t-3", label: "Ревью", status: "error", endedAt: NOW }]);
    openMap();
    card("Поиск").click();
    reply({ taskId: "t-1", ok: false, reason: "Task not found." });
    const failure = role("agent-details-failure", details());
    expect(failure.hidden).toBe(false);
    expect(failure.textContent).toBe("Не удалось получить данные агента: Task not found.");

    escape();
    card("Ревью").click();
    expect(role("agent-details-failure", details()).hidden).toBe(true); // a fresh agent starts clean
    reply({ taskId: "t-3", ok: true, error: "rate limit", status: "error" });
    const error = role("agent-details-error", details());
    expect(error.textContent).toBe("rate limit");
    expect(error.classList.contains("error")).toBe(true);
  });
});
