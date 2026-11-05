// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRow, ChatState } from "../../src/chat/model";
import { applyFrame, initialState } from "../../src/chat/reducer";
import type { SessionItem, StateMessage, WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";
import { type as typeInto } from "../helpers/composer";

const NOW = new Date("2026-11-03T20:00:00Z").getTime();
const MINUTE = 60_000;

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

function show(state: Partial<ChatState> = {}, extra: Partial<StateMessage> = {}): void {
  view.update({ type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "auto", durableId: "d1" }, reconnectable: true, ...extra });
}

function role(name: string, scope: ParentNode = root): HTMLElement {
  return scope.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

function input(): HTMLElement {
  return root.querySelector(".input") as HTMLElement;
}

/** The popovers currently shown. */
function shown(): string[] {
  return [...root.querySelectorAll<HTMLElement>("[data-popover]")].filter((pop) => !pop.hidden).map((pop) => pop.dataset["popover"] as string);
}

function popover(name: string): HTMLElement {
  return root.querySelector(`[data-popover="${name}"]`) as HTMLElement;
}

function key(target: EventTarget, name: string, modifiers: { altKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function session(title: string, minutesAgo: number, extra: Partial<SessionItem> = {}): SessionItem {
  return {
    sessionPath: `/s/${title}.jsonl`,
    durableId: `id-${title}`,
    title,
    updatedAt: NOW - minutesAgo * MINUTE,
    running: false,
    pinned: false,
    archived: false,
    current: false,
    ...extra,
  };
}

const SESSIONS: SessionItem[] = [
  session("Кэш каталога: TTL и фоллбек", 0.2, { current: true }),
  session("Миграция пулов на v2", 12, { running: true }),
  session("Ревью NodeProxy", 3 * 60),
  session("Почему падает InstanceManagerTests", 2 * 24 * 60),
];

function rows(name: string): HTMLElement[] {
  return [...popover(name).querySelectorAll<HTMLElement>("[data-row]")];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  show();
});

afterEach(() => {
  key(document, "Escape"); // every view's Popovers listens on the document: a popover left open would take the next test's Esc
  vi.useRealTimers();
});

describe("popovers", () => {
  it("only_one_popover_open", () => {
    expect(shown()).toEqual([]);
    role("agents-pill").click();
    expect(shown()).toEqual(["agents"]);
    role("model-pill").click();
    expect(shown()).toEqual(["model"]);
    role("sessions").click();
    expect(shown()).toEqual(["sessions"]);
    expect(posted).toContainEqual({ type: "listSessions" });
    role("slash").click();
    expect(shown()).toEqual(["actions"]);
    role("slash").click(); // the trigger toggles
    expect(shown()).toEqual([]);
    typeInto(input(), "/"); // a typed «/» opens the command list
    expect(shown()).toEqual(["slash"]);
    expect(root.querySelector('[data-role="agents"]')).toBeNull(); // the old agents strip is gone
  });

  it("escape_closes_and_refocuses_input", () => {
    role("model-pill").click();
    expect(shown()).toEqual(["model"]);
    expect(key(document, "Escape").defaultPrevented).toBe(true);
    expect(shown()).toEqual([]);
    expect(document.activeElement).toBe(input());

    role("sessions").click();
    expect(document.activeElement).toBe(role("sessions-search"));
    key(role("sessions-search"), "Escape");
    expect(shown()).toEqual([]);
    expect(document.activeElement).toBe(input());

    role("agents-pill").click();
    popover("agents").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(shown()).toEqual(["agents"]); // a click inside keeps it
    root.querySelector("main")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(shown()).toEqual([]);
  });

  it("sessions_search_filters", () => {
    role("sessions").click();
    view.sessions(SESSIONS);
    const all = rows("sessions");
    expect(all.map((row) => role("session-title", row).textContent)).toEqual(SESSIONS.map((item) => item.title));
    expect(all.map((row) => role("session-time", row).textContent)).toEqual(["сейчас", "12 мин", "3 ч", "2 д"]);
    expect(all[0]?.classList.contains("sel")).toBe(true);
    expect(all[1]?.textContent).toContain("● работает");
    expect(all[2]?.textContent).not.toContain("● работает");

    type(role("sessions-search") as HTMLInputElement, "РЕВЬЮ");
    expect(rows("sessions").map((row) => role("session-title", row).textContent)).toEqual(["Ревью NodeProxy"]);
    type(role("sessions-search") as HTMLInputElement, "");
    expect(rows("sessions")).toHaveLength(4);

    key(role("sessions-search"), "ArrowDown");
    key(role("sessions-search"), "ArrowDown");
    expect(rows("sessions")[2]?.getAttribute("aria-selected")).toBe("true");
    key(role("sessions-search"), "ArrowUp");
    key(role("sessions-search"), "Enter");
    expect(posted.at(-1)).toEqual({ type: "openSession", sessionPath: "/s/Миграция пулов на v2.jsonl" });
    expect(shown()).toEqual([]);

    role("sessions").click();
    (rows("sessions")[3] as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "openSession", sessionPath: "/s/Почему падает InstanceManagerTests.jsonl" });
  });

  it("session_rename_inline", () => {
    role("sessions").click();
    view.sessions(SESSIONS);
    const row = rows("sessions")[2] as HTMLElement;
    role("session-rename", row).click();
    const field = role("session-rename-input", popover("sessions")) as HTMLInputElement;
    expect(field.value).toBe("Ревью NodeProxy");
    expect(document.activeElement).toBe(field);

    field.value = "Другое";
    key(field, "Escape");
    expect(shown()).toEqual(["sessions"]); // Esc leaves the rename, not the list
    expect(role("session-rename-input", popover("sessions"))).toBeNull();
    expect(role("session-title", rows("sessions")[2] as HTMLElement).textContent).toBe("Ревью NodeProxy");

    role("session-rename", rows("sessions")[2] as HTMLElement).click();
    const again = role("session-rename-input", popover("sessions")) as HTMLInputElement;
    again.value = "  Ревью прокси  ";
    view.sessions(SESSIONS); // a list arriving mid-rename keeps the draft
    const kept = role("session-rename-input", popover("sessions")) as HTMLInputElement;
    expect(kept.value).toBe("  Ревью прокси  ");
    expect(document.activeElement).toBe(kept);
    key(kept, "Enter");
    expect(posted.at(-1)).toEqual({ type: "rename", sessionPath: "/s/Ревью NodeProxy.jsonl", name: "Ревью прокси" });
    expect(role("session-title", rows("sessions")[2] as HTMLElement).textContent).toBe("Ревью прокси");
    expect(posted.filter((message) => message.type === "openSession")).toEqual([]);

    view.renamed(true);
    expect(posted.at(-1)).toEqual({ type: "listSessions" }); // the list is reloaded from the host
  });

  it("the_pencil_renames_in_the_list_and_never_opens_that_session", () => {
    role("sessions").click();
    view.sessions(SESSIONS);
    const opened = (): WebviewMessage[] => posted.filter((message) => message.type === "openSession");

    const pencil = role("session-rename", rows("sessions")[2] as HTMLElement);
    pencil.focus();
    key(pencil, "Enter"); // the browser turns Enter (and Space) on a focused button into a click
    pencil.click();
    const field = role("session-rename-input", popover("sessions")) as HTMLInputElement;
    expect(document.activeElement).toBe(field);

    // A press elsewhere on the row being renamed keeps the field; the click after it opens nothing.
    const slot = rows("sessions")[2]?.querySelector(".t") as HTMLElement;
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    slot.dispatchEvent(press);
    if (!press.defaultPrevented) field.dispatchEvent(new FocusEvent("blur")); // what the browser does next
    slot.click();
    expect(role("session-rename-input", popover("sessions"))).toBe(field);
    expect(opened()).toEqual([]);
    expect(shown()).toEqual(["sessions"]);

    field.value = "Ревью прокси";
    key(field, "Enter");
    expect(posted.at(-1)).toEqual({ type: "rename", sessionPath: "/s/Ревью NodeProxy.jsonl", name: "Ревью прокси" });
    const again = role("session-rename", rows("sessions")[3] as HTMLElement);
    again.focus();
    key(again, " ");
    again.click();
    expect(role("session-rename-input", popover("sessions"))).not.toBeNull();
    expect(opened()).toEqual([]);
    expect(shown()).toEqual(["sessions"]);
  });

  it("a_draft_tab_heads_the_list_as_the_selected_row_renamed_in_place_and_never_archived", () => {
    const others = SESSIONS.map((item) => ({ ...item, current: false })); // a draft is no saved session: the host marks none
    show({}, { tab: { modelMode: "auto", draft: true } });
    role("sessions").click();
    view.sessions(others);
    const draft = rows("sessions")[0] as HTMLElement;
    expect(rows("sessions")).toHaveLength(others.length + 1);
    expect(role("session-title", draft).textContent).toBe("Новая сессия");
    expect(role("session-time", draft).textContent).toBe("сейчас");
    expect(draft.classList.contains("sel")).toBe(true);
    expect(draft.getAttribute("aria-selected")).toBe("true");
    expect(role("session-archive", draft)).toBeNull();
    expect(role("session-unarchive", draft)).toBeNull();

    show({ title: "Моя задача" }, { tab: { modelMode: "auto", draft: true } }); // the draft's pending name, from the host
    expect(role("session-title", rows("sessions")[0] as HTMLElement).textContent).toBe("Моя задача");

    role("session-rename", rows("sessions")[0] as HTMLElement).click();
    const field = role("session-rename-input", popover("sessions")) as HTMLInputElement;
    expect(field.value).toBe("Моя задача");
    field.value = "Другая задача";
    key(field, "Enter");
    expect(posted.at(-1)).toEqual({ type: "rename", name: "Другая задача" }); // no path: this tab's own (pending) name
    expect(role("session-title", rows("sessions")[0] as HTMLElement).textContent).toBe("Другая задача");

    (rows("sessions")[0] as HTMLElement).click(); // the tab the person is already in: the list just closes
    expect(posted.filter((message) => message.type === "openSession")).toEqual([]);
    expect(shown()).toEqual([]);

    show({ title: "Другая задача" }, { tab: { modelMode: "auto", sessionPath: "/s/new.jsonl", durableId: "d9" } }); // the session now exists
    role("sessions").click();
    view.sessions(others);
    expect(rows("sessions")).toHaveLength(others.length);
  });

  it("session_rows_swap_the_time_for_rename_and_archive_in_one_slot", () => {
    role("sessions").click();
    view.sessions(SESSIONS);
    for (const row of rows("sessions")) {
      const slot = row.querySelector(".t") as HTMLElement;
      expect(role("session-time", slot)).not.toBeNull();
      const actions = role("session-actions", slot);
      expect([...actions.querySelectorAll("button")].map((button) => button.dataset["role"])).toEqual(["session-rename", "session-archive"]);
      expect(actions.querySelector(".icon-pencil")).not.toBeNull();
      expect(actions.querySelector(".icon-archive")).not.toBeNull();
      expect(role("session-pin", row)).toBeNull(); // pinning lives in the header only
    }
  });

  it("tab_from_the_search_reaches_a_rows_rename_then_archive_and_the_actions_replace_the_time", () => {
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(join(__dirname, "../../webview/style.css"), "utf8"); // the real cascade
    document.head.append(sheet);
    try {
      role("sessions").click();
      view.sessions(SESSIONS);
      const pop = popover("sessions");
      const hiddenByStyle = (element: Element): boolean => {
        const style = getComputedStyle(element);
        return style.visibility === "hidden" || style.display === "none";
      };
      /** What Tab walks through: enabled controls the style does not hide (visibility is inherited). */
      const tabbable = (): HTMLElement[] => [...pop.querySelectorAll<HTMLElement>("input, button")].filter((control) => !(control as HTMLButtonElement).disabled && !hiddenByStyle(control));
      const tab = (): void => {
        const order = tabbable();
        order[order.indexOf(document.activeElement as HTMLElement) + 1]?.focus();
      };
      const row = rows("sessions")[0] as HTMLElement;
      let restyles = 0;
      const opacity = (name: string): string => {
        document.body.dataset["restyle"] = String(++restyles); // jsdom keeps computed styles across a focus change until the DOM mutates
        return getComputedStyle(role(name, row)).opacity;
      };
      expect([opacity("session-actions"), opacity("session-time")]).toEqual(["0", "1"]); // at rest: the time

      expect(document.activeElement).toBe(role("sessions-search"));
      tab();
      expect(document.activeElement).toBe(role("session-rename", row));
      expect([opacity("session-actions"), opacity("session-time")]).toEqual(["1", "0"]); // focus swaps them in place
      tab();
      expect(document.activeElement).toBe(role("session-archive", row));
      key(document.activeElement as HTMLElement, "Enter");
      (document.activeElement as HTMLElement).click(); // Enter on a button clicks it
      expect(posted.at(-1)).toEqual({ type: "archive", durableId: "id-Кэш каталога: TTL и фоллбек", archived: true });
    } finally {
      sheet.remove();
    }
  });

  it("archive_hides_a_session_and_the_archive_row_shows_and_restores_it", () => {
    role("sessions").click();
    view.sessions(SESSIONS);
    expect(role("sessions-archive-toggle", popover("sessions"))).toBeNull(); // nothing archived: no row
    role("session-archive", rows("sessions")[0] as HTMLElement).click(); // the current tab's session may go too
    role("session-archive", rows("sessions")[1] as HTMLElement).click();
    expect(posted.slice(-2)).toEqual([
      { type: "archive", durableId: "id-Кэш каталога: TTL и фоллбек", archived: true },
      { type: "archive", durableId: "id-Ревью NodeProxy", archived: true },
    ]);
    expect(posted.filter((message) => message.type === "openSession")).toEqual([]);
    expect(shown()).toEqual(["sessions"]);
    const titles = (): string[] => rows("sessions").map((row) => role("session-title", row).textContent ?? "");
    expect(titles()).toEqual(["Миграция пулов на v2", "Почему падает InstanceManagerTests"]);
    const toggle = role("sessions-archive-toggle", popover("sessions"));
    expect(toggle.textContent).toBe("Показать архив (2)");

    toggle.click();
    expect(shown()).toEqual(["sessions"]);
    expect(titles()).toEqual(["Миграция пулов на v2", "Почему падает InstanceManagerTests", "Кэш каталога: TTL и фоллбек", "Ревью NodeProxy"]);
    expect(role("sessions-archive-toggle", popover("sessions")).textContent).toBe("Скрыть архив (2)");
    const archivedRow = rows("sessions")[3] as HTMLElement;
    expect(archivedRow.classList.contains("archived")).toBe(true);
    expect(role("session-archive", archivedRow)).toBeNull();
    expect(role("session-unarchive", archivedRow).querySelector(".icon-unarchive")).not.toBeNull();

    role("session-unarchive", archivedRow).click();
    expect(posted.at(-1)).toEqual({ type: "archive", durableId: "id-Ревью NodeProxy", archived: false });
    expect(role("sessions-archive-toggle", popover("sessions")).textContent).toBe("Скрыть архив (1)");
    role("sessions-archive-toggle", popover("sessions")).click();
    expect(titles()).toEqual(["Миграция пулов на v2", "Ревью NodeProxy", "Почему падает InstanceManagerTests"]);
  });

  it("the_hosts_archive_marks_hide_rows_and_keyboard_skips_them", () => {
    role("sessions").click();
    view.sessions(SESSIONS.map((item, index) => ({ ...item, archived: index === 1 })));
    expect(rows("sessions")).toHaveLength(3);
    expect(role("sessions-archive-toggle", popover("sessions")).textContent).toBe("Показать архив (1)");
    key(role("sessions-search"), "ArrowDown");
    key(role("sessions-search"), "Enter");
    expect(posted.at(-1)).toEqual({ type: "openSession", sessionPath: "/s/Ревью NodeProxy.jsonl" });
  });

  it("sessions_have_no_open_here_label_and_pinned_ones_carry_an_icon", () => {
    role("sessions").click();
    view.sessions([session("Эта", 1, { current: true, pinned: true }), session("Соседняя вкладка", 5), session("Закрытая", 9)]);
    expect(popover("sessions").textContent).not.toContain("открыта здесь");
    const marks = rows("sessions").map((row) => role("session-pinned", row) !== null);
    expect(marks).toEqual([true, false, false]);
    expect(role("session-pinned", rows("sessions")[0]!)?.querySelector("svg")).not.toBeNull();
  });

  it("titles_are_text_not_markup", () => {
    role("sessions").click();
    view.sessions([session("<img src=x onerror=alert(1)>", 1)]);
    expect(popover("sessions").querySelector("img")).toBeNull();
    expect(role("session-title", popover("sessions")).textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("agent_map_shows_the_session_and_its_agents_and_opens_an_agents_output", () => {
    const agents: AgentRow[] = [
      { id: "task:1", taskId: "t-1", label: "Поиск", status: "done", startedAt: NOW - 200_000, endedAt: NOW - 75_000, tokens: 58_100 },
      { id: "task:2", taskId: "t-2", label: "Правка CatalogService.swift", status: "running", startedAt: NOW - 102_000, tokens: 200_800 },
      { id: "task:3", taskId: "t-3", label: "Прогон тестов", status: "waiting" },
      { id: "task:4", taskId: "t-4", label: "Ревью", status: "error", startedAt: NOW - 50_000, endedAt: NOW - 9_000, tokens: 850 },
    ];
    const opus = { provider: "gw-anthropic", id: "claude-opus-5-5" };
    show({ agents, title: "Кэш каталога", model: opus, contextTokens: 754_900, running: true }, { models: [{ ...opus, name: "Opus 5.5" }] });
    role("agents-pill").click();
    expect(shown()).toEqual(["agents"]);
    const map = popover("agents");
    expect(map.getAttribute("aria-modal")).toBe("true");
    expect(role("agent-map-title", map).textContent).toBe("Карта агентов");
    expect(role("agent-map-subtitle", map).textContent).toBe("4 агента · нажмите на агента, чтобы открыть подробности");
    expect(role("agent-map-root-title", map).textContent).toBe("Кэш каталога");
    expect(role("agent-map-root-meta", map).textContent).toBe("Opus 5.5 · 754,9 тыс. токенов в контексте");

    const cards = (): HTMLElement[] => rows("agents");
    const meta = (card: HTMLElement): string | undefined => role("agent-meta", card)?.textContent ?? undefined;
    // Running first, then the newest.
    expect(cards().map((card) => role("agent-label", card).textContent)).toEqual(["Правка CatalogService.swift", "Ревью", "Поиск", "Прогон тестов"]);
    expect(cards().map((card) => card.dataset["status"])).toEqual(["running", "error", "done", "waiting"]);
    expect(cards().map(meta)).toEqual(["1 мин 42 с · 200,8 тыс. токенов", "41 с · 850 токенов", "2 мин 5 с · 58,1 тыс. токенов", undefined]);

    vi.advanceTimersByTime(1000);
    expect(meta(cards()[0] as HTMLElement)).toBe("1 мин 43 с · 200,8 тыс. токенов");

    (cards()[0] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    expect(posted.at(-1)).toEqual({ type: "agentCancel", taskId: "t-2" });
    expect(shown()).toEqual(["agents"]); // ⌥-click stops it and the map stays

    (cards()[2] as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "agentDetails", taskId: "t-1" }); // the raw OmO task_id, not the row id
    expect(shown()).toEqual(["agents"]); // the details open over the map
    key(document.activeElement as HTMLElement, "Escape"); // the details
    key(document.activeElement as HTMLElement, "Escape"); // the map
    expect(shown()).toEqual([]);
    expect(document.activeElement).toBe(input());
    expect(vi.getTimerCount()).toBe(0); // no ticking once closed

    show({ agents: [] });
    role("agents-pill").click();
    expect(cards()).toHaveLength(0);
    expect(popover("agents").textContent).toContain("Субагентов пока нет");
    expect(vi.getTimerCount()).toBe(0); // nothing running, nothing ticks
  });

  it("agent_cards_name_the_model_each_agent_ran_on_from_a_real_task_snapshot", () => {
    const frame = JSON.parse(readFileSync(join(__dirname, "../fixtures/task_updated.json"), "utf8"));
    const { agents } = applyFrame(initialState(), frame);
    const catalog = [{ provider: "gw-openai", id: "gpt-6-astra", name: "GPT 6 Astra" }]; // Opus is not in it: its id stands in
    show({ agents }, { models: catalog });
    role("agents-pill").click();
    const meta = rows("agents").map((card) => [role("agent-label", card).textContent, role("agent-meta", card)?.textContent]);
    expect(meta).toEqual([
      ["test-quick", "GPT 6 Astra · 39 с · 68,7 тыс. токенов"],
      ["test-explore", "claude-opus-5-5 · 29 с · 55,2 тыс. токенов"],
    ]);
  });

  it("agent_map_closes_by_esc_the_cross_and_the_backdrop_and_gives_the_input_back", () => {
    show({ agents: [{ id: "task:1", taskId: "t-1", label: "Поиск", status: "done" }] });
    for (const close of [
      (): void => void key(document, "Escape"),
      (): void => role("agent-map-close", popover("agents")).click(),
      (): void => popover("agents").click(), // the dimmed backdrop itself
    ]) {
      role("agents-pill").click();
      expect(shown()).toEqual(["agents"]);
      (role("agent-map-panel", popover("agents"))).click(); // a click on the panel keeps it
      expect(shown()).toEqual(["agents"]);
      close();
      expect(shown()).toEqual([]);
      expect(document.activeElement).toBe(input());
    }
    expect(posted.filter((message) => message.type === "agentOutput")).toEqual([]);
  });

  it("model_rows_show_a_name_and_a_muted_description_with_the_choice_checked", () => {
    const opus = { provider: "gw-anthropic", id: "claude-opus-5-5" };
    const models = [
      { ...opus, name: "Opus 5.5" },
      { provider: "gw-openai", id: "gpt-6-astra", name: "GPT 6 Astra" },
      { provider: "local", id: "llama" },
      { provider: "gw-anthropic", id: "claude-haiku-5-5", name: "Haiku 5.5" },
    ];
    show({ autoModel: opus, model: opus }, { models });
    role("model-pill").click();
    const pop = popover("model");
    expect([...pop.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual(["Выбор модели"]);
    const describe = (row: Element): [string, string] => [row.querySelector(".name")?.textContent ?? "", row.querySelector(".desc")?.textContent ?? ""];
    const auto = role("model-auto", pop);
    expect(describe(auto)).toEqual(["Auto", "Модель по ролям: Opus 5.5"]);
    expect(auto.querySelector(".check")).not.toBeNull();
    const checked = (): string[] => [...pop.querySelectorAll<HTMLElement>('[aria-checked="true"]')].map((row) => row.dataset["model"] ?? "auto");
    expect(checked()).toEqual(["auto"]);
    expect([...pop.querySelectorAll<HTMLElement>("[data-model]")].map(describe)).toEqual([
      ["Opus 5.5", "Claude · через шлюз"],
      ["Haiku 5.5", "Claude · через шлюз"],
      ["GPT 6 Astra", "GPT · через шлюз"],
      ["llama", "local"],
    ]);
    expect(pop.querySelectorAll(".check")).toHaveLength(1);
    expect(pop.textContent).toContain("Субагенты всегда идут по ролям из omo.jsonc");

    (pop.querySelector('[data-model="gw-openai/gpt-6-astra"]') as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "setModel", model: { provider: "gw-openai", id: "gpt-6-astra" } });
    expect(shown()).toEqual([]);

    show({ model: { provider: "gw-openai", id: "gpt-6-astra" } }, { models, tab: { modelMode: "manual", durableId: "d1" } });
    role("model-pill").click();
    expect(checked()).toEqual(["gw-openai/gpt-6-astra"]);
    expect(describe(role("model-auto", popover("model")))).toEqual(["Auto", "Модель по ролям из omo.jsonc"]);
    role("model-auto", popover("model")).click();
    expect(posted.at(-1)).toEqual({ type: "setModel", model: "auto" });
  });

  it("model_list_is_the_scroll_container_and_the_power_footer_sits_outside_it", () => {
    const models = Array.from({ length: 30 }, (_, index) => ({ provider: "gw-openai", id: `m${index}`, name: `Model ${index}` }));
    show({ model: models[0] }, { models, thinkingLevels: ["low", "medium", "high"] });
    role("model-pill").click();
    const pop = popover("model");
    const list = role("model-list", pop);
    const foot = role("model-foot", pop);
    expect(list.querySelectorAll("[data-model]").length).toBe(30);
    expect(list.querySelector('[data-role="effort-label"]')).toBeNull();
    expect(list.querySelector(".note")).toBeNull();
    expect(foot.contains(role("effort-label", pop))).toBe(true);
    expect(foot.querySelector(".note")?.textContent).toContain("Субагенты всегда идут по ролям из omo.jsonc");
    expect(list.contains(foot)).toBe(false);
    expect(foot.parentElement).toBe(pop);
    const css = readFileSync(join(__dirname, "../../webview/style.css"), "utf8");
    expect(css).toMatch(/\.pop-model \{[^}]*max-height: 50vh;/);
    expect(css).toMatch(/\.pop-model \.model-list \{[^}]*overflow-y: auto;/);
  });

  it("model_picker_and_slash_menu_span_the_composer_and_open_above_it", () => {
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    root.getBoundingClientRect = () => rect(0, 0, 900, 700);
    (root.querySelector(".composer-box") as HTMLElement).getBoundingClientRect = () => rect(60, 580, 780, 100);
    role("model-pill").click();
    const style = popover("model").style;
    expect([style.left, style.width, style.bottom, style.top]).toEqual(["60px", "780px", "126px", ""]);
    typeInto(input(), "/");
    const slash = popover("slash").style;
    expect([slash.left, slash.width, slash.bottom, slash.top]).toEqual(["60px", "780px", "126px", ""]); // the same edges
    key(input(), "Escape");
    role("slash").click(); // the «/» button's menu
    expect(shown()).toEqual(["actions"]);
    const actions = popover("actions").style;
    expect([actions.left, actions.width, actions.bottom, actions.top]).toEqual(["60px", "780px", "126px", ""]); // the model picker's edges too
  });

  it("effort_slider_shows_the_level_and_posts_on_click_and_arrows", () => {
    show({ thinkingLevel: "medium" }, { thinkingLevels: ["low", "medium", "high", "xhigh"] });
    role("model-pill").click();
    const pop = popover("model");
    const slider = (): HTMLElement => pop.querySelector('[role="slider"]') as HTMLElement;
    const filled = (): string[] => [...slider().querySelectorAll<HTMLElement>("[data-level].on")].map((step) => step.dataset["level"] as string);
    expect(role("effort-label", pop).textContent).toBe("Мощность (medium)");
    expect([slider().getAttribute("aria-valuenow"), slider().getAttribute("aria-valuemax"), slider().getAttribute("aria-valuetext")]).toEqual(["1", "3", "medium"]);
    expect(filled()).toEqual(["low", "medium"]);
    expect(slider().querySelector(".cur")?.getAttribute("data-level")).toBe("medium");

    (slider().querySelector('[data-level="high"]') as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "setThinking", level: "high" });
    expect(shown()).toEqual(["model"]);
    expect(role("effort-label", pop).textContent).toBe("Мощность (high)");
    expect(filled()).toEqual(["low", "medium", "high"]);

    slider().focus();
    expect(key(slider(), "ArrowLeft").defaultPrevented).toBe(true);
    expect(posted.at(-1)).toEqual({ type: "setThinking", level: "medium" });
    expect(document.activeElement).toBe(slider()); // the rebuilt slider keeps the keyboard
    key(slider(), "ArrowRight");
    key(slider(), "ArrowRight");
    expect(posted.at(-1)).toEqual({ type: "setThinking", level: "xhigh" });
    const count = posted.length;
    key(slider(), "ArrowRight"); // already the last level
    expect(posted).toHaveLength(count);

    show({ thinkingLevel: "xhigh" }, { thinkingLevels: [] });
    expect(slider()).toBeNull();
    expect(pop.textContent).not.toContain("Мощность");
  });

  /** The symptom: a model OmO reports one level for got «Мощность (off)» over a track whose knob could not move. */
  it("a_model_with_one_level_says_so_instead_of_offering_a_dead_slider", () => {
    show({ thinkingLevel: "off" }, { thinkingLevels: ["off"] });
    role("model-pill").click();
    const pop = popover("model");
    expect(pop.querySelector('[role="slider"]')).toBeNull();
    expect(role("effort-label", pop).textContent).toBe("Мощность");
    expect(role("effort-only", pop).textContent).toBe("эта модель не размышляет");

    show({ thinkingLevel: "high" }, { thinkingLevels: ["high"] }); // one level that is not «off» is named, not denied
    expect(role("effort-only", pop).textContent).toBe("только «high»");
    expect(pop.querySelector('[role="slider"]')).toBeNull();

    show({ thinkingLevel: "off" }, { thinkingLevels: ["off", "low"] }); // two is a choice again
    expect(pop.querySelector('[role="slider"]')).not.toBeNull();
    expect(role("effort-label", pop).textContent).toBe("Мощность (off)");
  });

  it("selection_returns_focus_to_the_input", () => {
    const opus = { provider: "gw-anthropic", id: "claude-opus-5-5" };
    const models = [{ ...opus, name: "Opus 5.5" }];
    show({ agents: [{ id: "task:1", taskId: "1", label: "Поиск", status: "done" }] }, { models });

    role("model-pill").click();
    (popover("model").querySelector("[data-model]") as HTMLElement).click();
    expect(shown()).toEqual([]);
    expect(document.activeElement).toBe(input());

    role("sessions").click();
    view.sessions(SESSIONS);
    (rows("sessions")[1] as HTMLElement).click();
    expect(shown()).toEqual([]);
    expect(document.activeElement).toBe(input());
  });

  it("blur_of_the_rename_field_keeps_the_next_click_alive", () => {
    role("sessions").click();
    view.sessions(SESSIONS);
    role("session-rename", rows("sessions")[2] as HTMLElement).click();
    const field = role("session-rename-input", popover("sessions")) as HTMLInputElement;
    const other = rows("sessions")[1] as HTMLElement;

    field.dispatchEvent(new FocusEvent("blur")); // the mousedown on another row blurs the field
    expect(role("session-rename-input", popover("sessions"))).toBeNull();
    expect(other.isConnected).toBe(true); // the row under the pointer is not rebuilt, so its click still lands
    other.click();
    expect(posted.at(-1)).toEqual({ type: "openSession", sessionPath: "/s/Миграция пулов на v2.jsonl" });
    expect(role("session-title", rows("sessions")[2] as HTMLElement)).not.toBeNull();
  });

  it("alt_click_cancels_only_running_agents", () => {
    show({
      agents: [
        { id: "task:1", taskId: "1", label: "Идёт", status: "running", startedAt: NOW - 1000 },
        { id: "task:2", taskId: "2", label: "Готов", status: "done" },
      ],
    });
    role("agents-pill").click();
    (rows("agents")[1] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    expect(posted.filter((message) => message.type === "agentCancel")).toEqual([]);
  });

  it("dag_rows_have_no_output_and_no_cancel", () => {
    show({ agents: [{ id: "dag:r1:n1", label: "build", status: "running", startedAt: NOW - 1000 }] });
    role("agents-pill").click();
    const [row] = rows("agents") as [HTMLElement];
    row.click();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    expect(posted.filter((message) => message.type === "agentOutput" || message.type === "agentCancel")).toEqual([]);
    expect(shown()).toEqual(["agents"]);
  });

  it("effort_slider_shows_the_actual_level_after_the_next_state", () => {
    show({ thinkingLevel: "high" }, { thinkingLevels: ["low", "high", "xhigh"] });
    role("model-pill").click();
    (popover("model").querySelector('[data-level="xhigh"]') as HTMLElement).click();
    const level = (): string | null | undefined => popover("model").querySelector('[role="slider"]')?.getAttribute("aria-valuetext");
    expect(level()).toBe("xhigh"); // at once, before the host answers
    show({ thinkingLevel: "high", error: "Thinking level xhigh is not supported" }, { thinkingLevels: ["low", "high", "xhigh"] }); // the host refused
    expect(level()).toBe("high");
    expect(role("banner").hidden).toBe(false);
  });
});
