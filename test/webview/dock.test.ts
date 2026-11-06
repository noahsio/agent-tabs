// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRow, Block, ChatState, Dialog } from "../../src/chat/model";
import { applyEntries, initialState } from "../../src/chat/reducer";
import type { PendingView } from "../../src/guard/admin";
import type { WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";
import { text } from "../helpers/composer";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;
let current: ChatState;

const REQUEST: PendingView = {
  id: "abc123abc123",
  session: "s1",
  cwd: "/work/proj",
  tool: "bash",
  command: "git push origin main",
  reasons: ["отправка в git"],
  decider: { model: "claude-haiku", decision: "ask", reason: "push в общую ветку main, нужен человек", ms: 1200 },
  createdAt: "2026-11-04T10:00:00.000Z",
};

function show(patch: Partial<ChatState>): void {
  current = { ...current, ...patch };
  view.update({ type: "state", state: current, tab: { modelMode: "auto", durableId: "s1" }, reconnectable: true });
}

function blocks(...ids: string[]): void {
  const list: Block[] = ids.map((id) => ({ kind: "assistant", id, text: id, thinking: "", streaming: false }));
  show({ blocks: list });
}

const panel = (): HTMLElement | null => root.querySelector(".ask");
const composerBox = (): HTMLElement => root.querySelector(".composer-box") as HTMLElement;
const rows = (): string[] => [...root.querySelectorAll(".ask .opt")].map((row) => (row.querySelector(".lbl")?.textContent ?? "").trim());
const focusedRow = (): number => [...root.querySelectorAll(".ask .opt")].findIndex((row) => row.classList.contains("on"));
const field = (): HTMLInputElement => root.querySelector('[data-role="ask-field"]') as HTMLInputElement;
const answers = (): WebviewMessage[] => posted.filter((message) => message.type === "guardAnswer" || message.type === "answer");

/** A key pressed a moment later (past the guard against keystrokes meant for the composer), where the focus is. */
function key(name: string, target: Element | null = document.activeElement, later = 600): void {
  vi.setSystemTime(Date.now() + later);
  const at = target === null || target === document.body ? (panel() as HTMLElement) : target;
  at.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

function type(text: string): void {
  const input = field();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The feed's timeline rows in order: a block's id, or `guard:<id>` for a guard row. */
function timeline(): string[] {
  return [...root.querySelectorAll<HTMLElement>(".timeline > .turn > *")].map(
    (row) => row.dataset["block"] ?? `row:${row.querySelector<HTMLElement>("[data-guard]")?.dataset["guard"] ?? row.textContent}`,
  );
}

const indicator = (): HTMLElement => root.querySelector('[data-role="indicator"]') as HTMLElement;

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  current = initialState();
  show({});
});

describe("docked approval", () => {
  it("the_panel_takes_the_composers_place_and_gives_the_draft_back_intact", async () => {
    view.draft({ type: "draft", text: "черновик ответа", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=", name: "shot.png" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = root.querySelector<HTMLElement>("footer .input") as HTMLElement;
    const thumbs = (root.querySelector('[data-role="thumbs"]') as HTMLElement).children.length;
    expect(thumbs).toBe(1);
    input.focus();

    view.guardRequest(REQUEST, false);
    expect(composerBox().hidden).toBe(true);
    expect(panel()).not.toBeNull();
    expect(panel()?.closest("footer")).toBe(composerBox().parentElement); // the composer's own slot
    // the person was in the composer: the panel does not take the focus, and nothing typed reaches a hidden input
    expect(document.activeElement).toBe(document.body);
    expect(panel()?.querySelector(".away")?.textContent).toBe("Tab — к решению");

    view.guardResolved(REQUEST.id, "allow", "telegram");
    expect(panel()).toBeNull();
    expect(composerBox().hidden).toBe(false);
    expect(text(input)).toBe("черновик ответа");
    expect((root.querySelector('[data-role="thumbs"]') as HTMLElement).children.length).toBe(thumbs);
    expect(document.activeElement).toBe(input);
  });

  it("the_approval_shows_the_call_its_reason_the_decider_and_three_numbered_options", () => {
    view.guardRequest(REQUEST, false);
    const ask = panel() as HTMLElement;
    expect(ask.querySelector(".ask-title")?.textContent).toBe("Разрешить команду?");
    expect(ask.querySelector(".tool")?.textContent).toBe("Bash");
    expect(ask.querySelector(".who")?.textContent).toBe("главный агент");
    expect(ask.querySelector(".cmd")?.textContent).toBe("git push origin main");
    expect([...ask.querySelectorAll(".meta")].map((meta) => meta.textContent)).toEqual([
      "Причина: отправка в git",
      "Решатель (claude-haiku): спросить — push в общую ветку main, нужен человек",
    ]);
    expect(rows()).toEqual(["Разрешить один раз", "Запретить", "Запретить и сказать агенту, что сделать иначе…"]);
    expect([...ask.querySelectorAll(".opt .n")].map((number) => number.textContent)).toEqual(["1", "2", "3"]);
    expect(focusedRow()).toBe(0);
    expect(ask.querySelector(".hint")?.textContent).toBe("↑↓ выбрать · Enter подтвердить · Esc запретить");
  });

  it("arrows_move_the_selection_and_enter_answers_once", () => {
    view.guardRequest(REQUEST, false);
    key("ArrowDown");
    expect(focusedRow()).toBe(1);
    key("ArrowDown");
    key("ArrowDown");
    expect(focusedRow()).toBe(2); // stops at the last row
    key("ArrowUp");
    key("Enter");
    key("Enter");
    key("1");
    expect(answers()).toEqual([{ type: "guardAnswer", id: REQUEST.id, decision: "deny" }]);
  });

  it("a_digit_answers_at_once_and_esc_denies", () => {
    view.guardRequest(REQUEST, false);
    key("1");
    view.guardRequest({ ...REQUEST, id: "second000000" }, false);
    view.guardResolved(REQUEST.id, "allow", "agent-tabs");
    key("Escape");
    expect(answers()).toEqual([
      { type: "guardAnswer", id: REQUEST.id, decision: "allow-once" },
      { type: "guardAnswer", id: "second000000", decision: "deny" },
    ]);
  });

  it("deny_and_tell_the_agent_opens_a_field_whose_text_goes_with_the_deny", () => {
    view.guardRequest(REQUEST, false);
    key("3");
    expect(document.activeElement).toBe(field());
    expect(root.querySelector(".ask .hint")?.textContent).toBe("Enter запретить и отправить · Esc назад к вариантам");
    type("сначала прогони npm test");
    key("Escape"); // back to the list, nothing sent
    expect(answers()).toEqual([]);
    expect(field()).toBeNull();
    key("3");
    expect(field().value).toBe(""); // a new start
    key("Enter"); // blank: nothing to say
    expect(answers()).toEqual([]);
    type("  сначала прогони npm test, пушь только если всё зелёное ");
    key("Enter");
    expect(answers()).toEqual([{ type: "guardAnswer", id: REQUEST.id, decision: "deny", message: "сначала прогони npm test, пушь только если всё зелёное" }]);
    expect(field().maxLength).toBe(2000);
  });

  it("a_failed_answer_unlocks_the_panel_and_says_why", () => {
    view.guardRequest(REQUEST, false);
    key("2");
    expect(panel()?.classList.contains("sending")).toBe(true);
    view.guardAnswerFailed(REQUEST.id, "служба защиты не приняла ответ");
    expect(panel()?.querySelector(".ask-error")?.textContent).toBe("служба защиты не приняла ответ");
    key("2");
    expect(answers()).toHaveLength(2);
  });

  it("the_answer_leaves_one_line_at_the_call_saying_who_decided", () => {
    blocks("a1");
    view.guardRequest(REQUEST, false);
    blocks("a1", "a2");
    key("3");
    type("сначала тесты");
    key("Enter");
    view.guardResolved(REQUEST.id, "deny", "agent-tabs", "сначала тесты");
    expect(timeline()).toEqual(["a1", `row:${REQUEST.id}`, "a2"]);
    const line = root.querySelector(`.timeline [data-guard="${REQUEST.id}"]`) as HTMLElement;
    expect(line.querySelector(".tool-name")?.textContent).toBe("Bash");
    expect(line.querySelector(".mono")?.textContent).toBe("git push origin main");
    expect(line.querySelector(".verdict")?.textContent).toBe("Запрещено · вы");
    expect(line.querySelector(".quote")?.textContent).toBe("сначала тесты");
    expect(line.classList.contains("error")).toBe(true);
  });

  it("an_answer_from_elsewhere_names_where_and_when", () => {
    view.guardRequest(REQUEST, false);
    view.guardResolved(REQUEST.id, "deny", "telegram");
    const verdict = root.querySelector(`.timeline [data-guard="${REQUEST.id}"] .verdict`)?.textContent ?? "";
    expect(verdict).toMatch(/^Запрещено · Telegram · \d\d:\d\d$/);
    view.guardRequest({ ...REQUEST, id: "allowed00000" }, false);
    view.guardResolved("allowed00000", "allow", "cli");
    expect(root.querySelector('.timeline [data-guard="allowed00000"] .verdict')?.textContent).toMatch(/^Разрешено один раз · терминал · \d\d:\d\d$/);
  });

  it("a_request_the_service_no_longer_has_closes_without_a_verdict", () => {
    view.guardRequest(REQUEST, false);
    view.guardClosed(REQUEST.id);
    expect(panel()).toBeNull();
    expect(root.querySelector(`.timeline [data-guard="${REQUEST.id}"]`)?.textContent).toContain("запрос больше не ждёт ответа");
  });

  it("a_request_we_could_not_attribute_says_so_and_waits_until_opened_here", () => {
    blocks("a1");
    view.guardRequest(REQUEST, true);
    expect(panel()).toBeNull();
    expect(composerBox().hidden).toBe(false);
    const notice = root.querySelector(`.timeline [data-guard="${REQUEST.id}"]`) as HTMLElement;
    expect(notice.textContent).toBe("Ждёт решения: сессию определить не удалось, /work/proj · Открыть");
    (notice.querySelector('[data-role="open-elsewhere"]') as HTMLButtonElement).click();
    expect(panel()?.textContent).toContain("Не эта вкладка: сессию определить не удалось, /work/proj");
    expect(panel()?.querySelector(".who")?.textContent).toBe("сессия не определена");
    key("1");
    view.guardResolved(REQUEST.id, "allow", "agent-tabs");
    expect(panel()).toBeNull();
    expect(timeline()).toEqual(["a1", `row:${REQUEST.id}`]);
    expect(root.querySelector(`.timeline [data-guard="${REQUEST.id}"] .verdict`)?.textContent).toBe("Разрешено один раз · вы · сессия не определена");
  });

  it("a_request_whose_owning_tab_is_closed_names_the_session_it_belongs_to", () => {
    blocks("a1");
    view.guardRequest(REQUEST, true, "01a1a820-96ed-7252-9a77-a73ed56ebf85");
    const notice = root.querySelector(`.timeline [data-guard="${REQUEST.id}"]`) as HTMLElement;
    expect(notice.textContent).toBe("Ждёт решения: сессия 01a1a820 (её вкладка не открыта), /work/proj · Открыть");
    (notice.querySelector('[data-role="open-elsewhere"]') as HTMLButtonElement).click();
    expect(panel()?.textContent).toContain("Не эта вкладка: сессия 01a1a820 (её вкладка не открыта), /work/proj");
    expect(panel()?.querySelector(".who")?.textContent).toBe("сессия 01a1a820");
    key("1");
    view.guardResolved(REQUEST.id, "allow", "agent-tabs");
    expect(root.querySelector(`.timeline [data-guard="${REQUEST.id}"] .verdict`)?.textContent).toBe("Разрешено один раз · вы · сессия 01a1a820");
  });

  it("another_sessions_offer_leaves_nothing_behind_when_it_is_decided_elsewhere", () => {
    blocks("a1");
    view.guardRequest(REQUEST, true);
    expect(root.querySelector(`.timeline [data-guard="${REQUEST.id}"]`)).not.toBeNull();
    view.guardResolved(REQUEST.id, "allow", "agent-tabs");
    expect(root.querySelector(`.timeline [data-guard="${REQUEST.id}"]`)).toBeNull(); // this chat decided nothing
    expect(timeline()).toEqual(["a1"]);
  });

  it("another_sessions_offer_the_service_lost_leaves_nothing_behind", () => {
    blocks("a1");
    view.guardRequest(REQUEST, true);
    view.guardClosed(REQUEST.id);
    expect(timeline()).toEqual(["a1"]);
  });

  it("who_decided_is_read_from_the_decision_not_from_this_tabs_click", () => {
    view.guardRequest(REQUEST, false);
    key("1"); // this tab sent an answer…
    view.guardResolved(REQUEST.id, "deny", "telegram"); // …but the service says Telegram got there first
    expect(root.querySelector(`.timeline [data-guard="${REQUEST.id}"] .verdict`)?.textContent).toMatch(/^Запрещено · Telegram · \d\d:\d\d$/);
  });

  it("keys_right_after_the_panel_shows_decide_nothing", () => {
    view.guardRequest(REQUEST, false);
    key("1", null, 100);
    key("Enter", null, 100);
    key("Escape", null, 100);
    expect(answers()).toEqual([]);
    key("2", null, 600);
    expect(answers()).toEqual([{ type: "guardAnswer", id: REQUEST.id, decision: "deny" }]);
  });

  it("a_prompt_that_comes_while_the_person_types_waits_for_tab", () => {
    const input = root.querySelector<HTMLElement>("footer .input") as HTMLElement;
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    input.blur();
    view.guardRequest(REQUEST, false);
    expect(document.activeElement).toBe(document.body); // typed 0 ms ago: no focus taken
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(panel());
  });

  it("keys_on_a_summary_or_button_inside_the_panel_are_theirs", () => {
    view.guardRequest({ ...REQUEST, tool: "eval", command: "ls", code: "await tool.bash('ls');" }, false);
    const summary = root.querySelector(".ask summary") as HTMLElement;
    key("Enter", summary);
    key("1", summary);
    expect(answers()).toEqual([]);
  });

  it("stop_stays_reachable_in_the_panel_while_a_turn_runs", () => {
    view.guardRequest(REQUEST, false);
    expect(root.querySelector('[data-role="ask-stop"]')).toBeNull();
    show({ running: true });
    (root.querySelector('[data-role="ask-stop"]') as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "stop" });
  });

  it("an_eval_lists_its_commands_collapsed_and_keeps_its_code_apart", () => {
    const command = ["git fetch origin", "git rebase origin/main", "npm ci", "npm test -- --run", "npm run build", "rsync -az dist/ stage:/srv/", "ssh stage restart", "curl -fsS stage/health"].join("\n");
    const code = 'const steps = ["git fetch origin"];\nfor (const step of steps) await tool.bash(step);';
    view.guardRequest({ ...REQUEST, tool: "eval", command, code }, false);
    const ask = panel() as HTMLElement;
    expect(ask.querySelector(".tool")?.textContent).toBe("eval");
    expect(ask.querySelector(".lead")?.textContent).toBe("Код запустит 8 команд:");
    const pre = ask.querySelector(".cmd") as HTMLElement;
    expect(pre.classList.contains("collapsed")).toBe(true);
    const toggle = ask.querySelector('[data-role="command-toggle"]') as HTMLButtonElement;
    expect(toggle.textContent).toBe("Показать все 8");
    toggle.click();
    expect(pre.classList.contains("collapsed")).toBe(false);
    const details = ask.querySelector<HTMLDetailsElement>('details[data-role="eval-code"]') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Код eval (2 строки)");
    expect(details.querySelector("pre")?.textContent).toBe(code);
  });

  it("a_subagents_request_names_the_subagent_and_its_model", () => {
    const agent: AgentRow = { id: "t1", label: "explore", status: "running", model: "gw-anthropic/claude-haiku-5-5", childSession: "child-1" };
    show({ agents: [agent] });
    view.guardRequest({ ...REQUEST, session: "child-1" }, false);
    expect(panel()?.querySelector(".who")?.textContent).toBe("explore · claude-haiku-5-5");
  });

  it("the_feed_says_it_waits_for_a_decision_instead_of_thinking", () => {
    show({ running: true, activity: "thinking" });
    expect(indicator().textContent).toBe("Думаю…");
    view.guardRequest(REQUEST, false);
    expect(indicator().hidden).toBe(false);
    expect(indicator().classList.contains("waiting")).toBe(true);
    expect(indicator().textContent).toBe("Ждёт вашего решения");
    view.guardResolved(REQUEST.id, "allow", "telegram");
    expect(indicator().classList.contains("waiting")).toBe(false);
    expect(indicator().textContent).toBe("Думаю…");
  });

  it("several_waiting_prompts_share_one_panel_with_a_counter_oldest_first", () => {
    view.guardRequest(REQUEST, false);
    view.guardRequest({ ...REQUEST, id: "second000000", command: "git push --tags" }, false);
    show({ dialogs: [{ id: "c1", method: "confirm", title: "Удалить кэш?" }] });
    const count = (): string => root.querySelector('[data-role="ask-count"]')?.textContent ?? "";
    expect(count()).toBe("‹1 из 3›");
    expect(panel()?.querySelector(".cmd")?.textContent).toBe("git push origin main");
    expect(panel()?.querySelector(".hint")?.textContent).toContain("←→ другой запрос");
    key("ArrowRight");
    expect(count()).toBe("‹2 из 3›");
    expect(panel()?.querySelector(".cmd")?.textContent).toBe("git push --tags");
    key("ArrowRight");
    expect(panel()?.querySelector(".ask-title")?.textContent).toBe("Удалить кэш?");
    expect(indicator().textContent).toBe("Ждёт вашего ответа");
    key("ArrowRight");
    expect(count()).toBe("‹1 из 3›"); // round
    view.guardResolved(REQUEST.id, "allow", "telegram");
    expect(count()).toBe("‹1 из 2›");
    expect(panel()?.querySelector(".cmd")?.textContent).toBe("git push --tags");
    view.guardResolved("second000000", "allow", "telegram");
    expect(root.querySelector('[data-role="ask-count"]')).toBeNull();
  });

  it("a_repeated_request_is_shown_once_and_a_silent_service_says_so_in_the_panel", () => {
    view.guardRequest(REQUEST, false);
    view.guardRequest(REQUEST, false);
    expect(root.querySelector('[data-role="ask-count"]')).toBeNull();
    view.guardSilent(true);
    expect(panel()?.querySelector(".ask-silent")?.textContent).toBe("Служба защиты не отвечает");
  });

  it("no_model_or_agent_text_is_parsed_as_html", () => {
    view.guardRequest({ ...REQUEST, command: '<img src=x onerror="alert(1)">', reasons: ["<b>bold</b>"] }, false);
    expect(panel()?.querySelector("img")).toBeNull();
    expect(panel()?.querySelector(".cmd")?.textContent).toBe('<img src=x onerror="alert(1)">');
  });
});

describe("decider line", () => {
  it("a_decider_verdict_is_one_quiet_line_with_the_command_and_time", () => {
    blocks("a1");
    view.guardStep({ id: "d1", tool: "bash", command: "git status", decider: { model: "gw/haiku", decision: "allow", reason: "read only", ms: 1400 }, at: "2026-11-04T10:00:00.000Z" });
    blocks("a1", "a2");
    expect(timeline()).toEqual(["a1", "row:d1", "a2"]);
    const step = root.querySelector('[data-guard="d1"]') as HTMLElement;
    expect(step.textContent).toBe("Решатель разрешил · git status · 1,4 с");
    expect(step.classList.contains("decider")).toBe(true);
    expect(step.classList.contains("no")).toBe(false);
    expect(step.title).toBe("gw/haiku: read only");
    view.guardStep({ id: "d2", tool: "bash", command: "rm -rf node_modules", decider: { decision: "deny", reason: "wipe", ms: 1100 }, at: "2026-11-04T10:00:00.000Z" });
    const deny = root.querySelector('[data-guard="d2"]') as HTMLElement;
    expect(deny.textContent).toBe("Решатель запретил · rm -rf node_modules · 1,1 с");
    expect(deny.classList.contains("no")).toBe(true);
  });

  it("a_decider_line_of_another_session_names_whose_it_was", () => {
    const step = { tool: "bash", command: "git push -f", decider: { decision: "deny" as const, reason: "force", ms: 300 }, at: "2026-11-04T10:00:00.000Z" };
    view.guardStep({ ...step, id: "d3", cwd: "/other/proj" });
    expect((root.querySelector('[data-guard="d3"]') as HTMLElement).textContent).toContain("сессию определить не удалось, /other/proj");
    view.guardStep({ ...step, id: "d4", cwd: "/other/proj", owner: "01a1a820-96ed-7252-9a77-a73ed56ebf85" });
    expect((root.querySelector('[data-guard="d4"]') as HTMLElement).textContent).toContain("сессия 01a1a820 (её вкладка не открыта), /other/proj");
  });
});

describe("docked questions", () => {
  const dialogs = (...list: Dialog[]): void => show({ dialogs: list });

  /** The host's state after OmO took the answer: the dialog is gone. */
  const answered = (): void => show({ dialogs: [] });

  const resultText = (): string[] => [...root.querySelectorAll(".timeline .ask-result .verdict")].map((verdict) => verdict.textContent ?? "");

  it("select_answers_with_a_digit_and_leaves_its_answer_in_the_feed", () => {
    dialogs({ id: "s1", method: "select", title: "Куда отправить коммиты?", options: ["main", "release/1.4", "Новая ветка"] });
    expect(panel()?.querySelector(".ask-title")?.textContent).toBe("Куда отправить коммиты?");
    expect(rows()).toEqual(["main", "release/1.4", "Новая ветка"]);
    expect(indicator().textContent).toBe("Ждёт вашего ответа");
    key("2");
    expect(answers()).toEqual([{ type: "answer", dialogId: "s1", answer: { value: "release/1.4" } }]);
    answered();
    expect(panel()).toBeNull();
    expect(resultText()).toEqual([]); // the line waits for the host's word that OmO took it
    view.answerResult("s1", "applied");
    expect(resultText()).toEqual(["Ответ: release/1.4"]);
  });

  it("a_dialog_omo_already_closed_leaves_no_answer_line", () => {
    dialogs({ id: "s1", method: "select", title: "Куда?", options: ["a", "b"] });
    key("1");
    answered();
    view.answerResult("s1", "closed");
    expect(resultText()).toEqual([]);
  });

  it("confirm_says_yes_on_enter_and_no_on_esc", () => {
    dialogs({ id: "c1", method: "confirm", title: "Удалить 3 снапшота?", message: "Это нельзя отменить." }, { id: "c2", method: "confirm", title: "И ещё один?" });
    expect(rows()).toEqual(["Да", "Нет"]);
    expect(panel()?.querySelector(".question-text")?.textContent).toBe("Это нельзя отменить.");
    key("Enter");
    show({ dialogs: [{ id: "c2", method: "confirm", title: "И ещё один?" }] });
    key("Escape");
    expect(answers()).toEqual([
      { type: "answer", dialogId: "c1", answer: { confirmed: true } },
      { type: "answer", dialogId: "c2", answer: { confirmed: false } },
    ]);
  });

  it("editor_opens_with_its_prefill", () => {
    dialogs({ id: "e1", method: "editor", title: "Правка", prefill: "Line 1\nLine 2" });
    expect(field().value).toBe("Line 1\nLine 2");
    key("Enter"); // a new line in an editor, not a send
    expect(answers()).toEqual([]);
  });

  it("input_focuses_its_field_and_enter_sends_it", () => {
    dialogs({ id: "i1", method: "input", title: "Как назвать новую ветку?", placeholder: "fix/…" });
    expect(document.activeElement).toBe(field());
    expect(field().placeholder).toBe("fix/…");
    type("fix/catalog-empty-list");
    key("Enter");
    expect(answers()).toEqual([{ type: "answer", dialogId: "i1", answer: { value: "fix/catalog-empty-list" } }]);
  });

  it("a_streamed_state_leaves_the_field_being_typed_in_alone", () => {
    dialogs({ id: "i1", method: "input", title: "Имя ветки" });
    const before = field();
    type("fix/cat");
    show({ running: true, activity: "thinking" });
    show({ blocks: [{ kind: "assistant", id: "a9", text: "…", thinking: "", streaming: true }] });
    expect(field()).toBe(before);
    expect(field().value).toBe("fix/cat");
    expect(document.activeElement).toBe(before);
  });

  it("a_failed_dialog_answer_unlocks_on_the_hosts_word", () => {
    dialogs({ id: "s1", method: "select", title: "Куда?", options: ["a", "b"] });
    key("1");
    expect(panel()?.classList.contains("sending")).toBe(true);
    show({ error: "omo: boom" }); // an error alone proves nothing about this answer
    expect(panel()?.classList.contains("sending")).toBe(true);
    view.answerResult("s1", "failed");
    expect(panel()?.classList.contains("sending")).toBe(false);
    key("2");
    expect(answers()).toHaveLength(2);
  });

  const CACHE = {
    id: "q1",
    header: "Кэш",
    question: "Как хранить кэш каталога после смены ноды?",
    options: [
      { label: "TTL и запасной кэш", description: "Отдавать сохранённый список до 10 минут" },
      { label: "Только на диске", description: "Список живёт до перезапуска" },
      { label: "Без кэша" },
    ],
    multiSelect: false,
  };
  const CHECKS = {
    id: "q2",
    header: "Проверки",
    question: "Какие проверки добавить?",
    options: [{ label: "Юнит-тесты" }, { label: "Интеграционные" }, { label: "Линтер" }],
    multiSelect: true,
  };

  it("a_single_question_lists_its_options_with_descriptions_and_other", () => {
    dialogs({ id: "q", method: "question", title: CACHE.question, questions: [CACHE] });
    const ask = panel() as HTMLElement;
    expect(ask.querySelector(".ask-title")?.textContent).toBe("Вопрос агента");
    expect(ask.querySelector(".tool")?.textContent).toBe("Кэш");
    expect(ask.querySelector(".question-text")?.textContent).toBe("Как хранить кэш каталога после смены ноды?");
    expect([...ask.querySelectorAll(".opt .desc")].map((desc) => desc.textContent)).toEqual(["Отдавать сохранённый список до 10 минут", "Список живёт до перезапуска"]);
    expect(rows().at(-1)).toBe("Другое…");
    expect(ask.querySelector(".hint")?.textContent).toBe("Enter — ответить · ↑↓ или 1–4 выбрать · Esc отменить");
    key("ArrowDown");
    key("Enter");
    expect(answers()).toEqual([{ type: "answer", dialogId: "q", answer: { answers: { q1: { selected: ["Только на диске"] } } } }]);
    answered();
    view.answerResult("q", "applied");
    expect(resultText()).toEqual([]); // an answered question leaves the card in the feed, not a line saying the same
  });

  it("a_non_blocking_question_shows_beside_a_usable_composer_and_no_spinner", () => {
    // waitForAnswer:false → the turn ended; the tab is idle. The card is visible and declinable, but it does not take
    // the composer's place and raises no «Ждёт…» spinner — the person answers it or just sends a message.
    show({ running: false, dialogs: [{ id: "q", method: "question", title: CACHE.question, questions: [CACHE], blocking: false }] });
    expect(panel()?.querySelector(".question-text")?.textContent).toBe("Как хранить кэш каталога после смены ноды?");
    expect(composerBox().hidden).toBe(false); // composer stays usable
    expect(indicator().hidden).toBe(true); // no spinner: the turn is over
    key("1"); // the card still answers
    expect(answers()).toEqual([{ type: "answer", dialogId: "q", answer: { answers: { q1: { selected: ["TTL и запасной кэш"] } } } }]);
  });

  it("a_non_blocking_question_can_be_declined_from_its_card", () => {
    show({ running: false, dialogs: [{ id: "q", method: "question", title: CACHE.question, questions: [CACHE], blocking: false }] });
    key("Escape");
    expect(answers()).toEqual([{ type: "answer", dialogId: "q", answer: { cancelled: true } }]);
  });

  it("other_sends_the_persons_own_words_as_text", () => {
    dialogs({ id: "q", method: "question", title: CACHE.question, questions: [CACHE] });
    key("4");
    type("кэш в памяти на 5 минут");
    key("Enter");
    expect(answers()).toEqual([{ type: "answer", dialogId: "q", answer: { answers: { q1: { selected: [], text: "кэш в памяти на 5 минут" } } } }]);
  });

  it("multi_select_ticks_with_space_and_digits_and_other_adds_text", () => {
    dialogs({ id: "q", method: "question", title: CHECKS.question, questions: [CHECKS] });
    expect(root.querySelector<HTMLButtonElement>(".ask .foot button.primary")?.disabled).toBe(true); // nothing to say yet
    expect(panel()?.querySelector(".plural")?.textContent).toBe("можно несколько");
    key(" "); // ticks the focused first row
    key("3");
    key("2");
    key("2"); // unticks again
    key("4");
    type("snapshot-тест");
    key("Enter"); // the field closes; «Другое» stays ticked with its text
    expect(answers()).toEqual([]);
    expect([...root.querySelectorAll(".ask .box.on")]).toHaveLength(3);
    key("Enter");
    expect(answers()).toEqual([{ type: "answer", dialogId: "q", answer: { answers: { q2: { selected: ["Юнит-тесты", "Линтер"], text: "snapshot-тест" } } } }]);
  });

  it("a_set_of_questions_goes_one_by_one_and_out_as_one_answer", () => {
    dialogs({ id: "q", method: "question", title: CACHE.question, questions: [CACHE, CHECKS] });
    const ask = (): HTMLElement => panel() as HTMLElement;
    expect(ask().querySelector(".ask-title")?.textContent).toBe("Вопросы агента");
    expect(ask().querySelector(".who")?.textContent).toBe("Вопрос 1 из 2");
    expect([...ask().querySelectorAll(".qtab")].map((tab) => tab.textContent)).toEqual(["Кэш", "Проверки"]);
    expect([...ask().querySelectorAll(".foot button")].map((button) => button.textContent)).toEqual(["Далее"]);
    key("1"); // a single-select question moves on once answered
    expect(ask().querySelector(".who")?.textContent).toBe("Вопрос 2 из 2");
    expect(ask().querySelector(".qtab")?.querySelector("svg")).not.toBeNull(); // the answered one keeps its check
    expect([...ask().querySelectorAll(".foot button")].map((button) => button.textContent)).toEqual(["Назад", "Ответить"]);
    expect(ask().querySelector<HTMLButtonElement>(".foot button.primary")?.disabled).toBe(false); // the first is answered
    expect(ask().querySelector(".hint")?.textContent).toBe("Пробел отметить · Enter ответить · ← к вопросу 1");
    key("ArrowLeft");
    expect(ask().querySelector(".who")?.textContent).toBe("Вопрос 1 из 2");
    key("ArrowRight");
    key("1");
    key("3");
    ([...ask().querySelectorAll<HTMLButtonElement>(".foot button")].find((button) => button.textContent === "Ответить") as HTMLButtonElement).click();
    expect(answers()).toEqual([
      { type: "answer", dialogId: "q", answer: { answers: { q1: { selected: ["TTL и запасной кэш"] }, q2: { selected: ["Юнит-тесты", "Линтер"] } } } },
    ]);
    answered();
    view.answerResult("q", "applied");
    expect(resultText()).toEqual([]); // likewise for a set: the card carries both questions and both answers
  });

  /**
   * The whole way round, as the person sees it: the question is asked, answered here, and OmO's record of the answer
   * comes back in the journal. One card in the feed — the question, the options, their descriptions and what was
   * picked — and nothing of OmO's own wording, nor a second line saying the same thing.
   */
  it("an_answered_question_leaves_one_card_in_the_feed_and_no_protocol_text", () => {
    const ID = "toolu_01Ch";
    const asked = [
      { type: "message", id: "e1", message: { role: "user", content: "почини каталог", clientMessageId: "c1", timestamp: 1 } },
      {
        type: "message",
        id: "e2",
        message: { role: "assistant", content: [{ type: "toolCall", id: ID, name: "ask_user_question", arguments: { questions: [CACHE], waitForAnswer: false } }], timestamp: 2 },
      },
    ];
    show({ blocks: applyEntries(initialState(), asked).blocks });
    dialogs({ id: ID, method: "question", title: CACHE.question, questions: [CACHE] });
    key("2");
    expect(answers()).toEqual([{ type: "answer", dialogId: ID, answer: { answers: { q1: { selected: ["Только на диске"] } } } }]);
    answered();
    view.answerResult(ID, "applied");
    expect(resultText()).toEqual([]);

    const answer = { type: "message", id: "e4", message: { role: "user", content: [{ type: "text", text: `[Answer to question ${ID}]\nКэш: Только на диске` }], timestamp: 4 } };
    show({ blocks: applyEntries(initialState(), [...asked, answer]).blocks });
    const cards = [...root.querySelectorAll(".timeline .answer")];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.querySelector(".question-text")?.textContent).toBe("Как хранить кэш каталога после смены ноды?");
    expect([...(cards[0] as HTMLElement).querySelectorAll(".opt.chosen .lbl")].map((label) => label.childNodes[0]?.textContent)).toEqual(["Только на диске"]);
    expect([...(cards[0] as HTMLElement).querySelectorAll(".desc")].map((desc) => desc.textContent)).toEqual([
      "Отдавать сохранённый список до 10 минут",
      "Список живёт до перезапуска",
    ]);
    const timeline = root.querySelector(".timeline")?.textContent ?? "";
    expect(timeline).not.toContain("Answer to question");
    expect(timeline).not.toContain(ID);
  });

  it("esc_cancels_a_question", () => {
    dialogs({ id: "q", method: "question", title: CACHE.question, questions: [CACHE] });
    key("Escape");
    expect(answers()).toEqual([{ type: "answer", dialogId: "q", answer: { cancelled: true } }]);
  });
});
