// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { parseDeferredHostMessage, type DeferredItem, type WebviewMessage } from "../../src/panel/protocol";
import { DeferredPopover } from "../../webview/deferredPopover";
import { ChatView } from "../../webview/render";

const question: DeferredItem = { kind: "question", id: "q", sessionPath: "/agent/sessions/q.jsonl", sessionTitle: "Проект",
  createdAt: 1, deferredAt: 2, questions: [{ header: "Хранилище", question: "Куда записать?", options: [{ label: "Файл" }, { label: "База" }], multiSelect: true }],
  decided: "Выбрал файл" };
const approval: DeferredItem = { kind: "approval", id: "g", sessionTitle: "Другая сессия", createdAt: 3, deferredAt: 4, command: "rm <script>report</script> ".repeat(30) };
let popover: DeferredPopover;
let posted: WebviewMessage[];

function click(label: string): void {
  const control = [...popover.element.querySelectorAll("button")].find((button) => button.textContent === label);
  expect(control, label).toBeDefined();
  control?.click();
}

beforeEach(() => {
  document.body.replaceChildren();
  posted = [];
  popover = new DeferredPopover((message) => posted.push(message));
  document.body.append(popover.element);
});

describe("DeferredPopover", () => {
  // Seen live (2026-11-11): a card with two questions, the first scrolled out of sight; answering the visible one gave
  // «Ответьте на каждый вопрос» and nothing could be sent. One answer is enough; the rest go as «без ответа».
  it("answering_one_of_two_questions_sends_it_and_marks_the_other_unanswered", () => {
    const two: DeferredItem = { ...question, decided: undefined, questions: [
      { header: "Диск", question: "Удалить образы?", options: [{ label: "Удалить" }, { label: "Не трогать" }], multiSelect: false },
      { header: "Выкладка", question: "Закрыть прошлую?", options: [{ label: "Закрыть" }, { label: "Зайду сам" }], multiSelect: false },
    ] };
    popover.update({ type: "deferred", items: [two] });
    click("Ответить");
    expect(posted).toEqual([]); // nothing chosen at all: nothing to send
    expect(popover.element.textContent).toContain("хотя бы на один вопрос");
    click("Закрыть");
    click("Ответить");
    expect(posted).toEqual([{ type: "answerDeferredQuestion", id: "q", answers: ["без ответа — реши сам", "Закрыть"] }]);
  });

  it("shows_this_windows_projects_and_keeps_other_projects_behind_one_line_grouped_by_project", () => {
    const counts: number[] = [];
    popover = new DeferredPopover((message) => posted.push(message), (count) => counts.push(count));
    document.body.replaceChildren(popover.element);
    // a tab in the home dir holds that dir, not every project below it; a tab's own session is its own whatever the folder
    const message = parseDeferredHostMessage({ type: "deferred", here: ["/work", "/home"], sessions: ["s-open"], items: [
      { ...question, cwd: "/work" },
      { ...approval, cwd: "/home/elsewhere/shop" },
      { ...approval, id: "g2", cwd: "/home/elsewhere/bank" },
      { ...approval, id: "g3" },
      { ...approval, id: "g4", cwd: "/home/moved", session: "s-open", deferredAt: 1 },
    ] });
    if (message?.type !== "deferred") throw new Error("Missing inbox message");
    popover.update(message);
    const visible = (): string[] => [...popover.element.querySelectorAll<HTMLElement>("[data-deferred-id]")]
      .filter((row) => row.closest("[hidden]") === null).map((row) => row.dataset["deferredId"] as string);
    expect(visible()).toEqual(["g3", "q", "g4"]); // a row with no known project stays in sight
    expect(counts.at(-1)).toBe(3);
    click("В других проектах: 2");
    expect(visible()).toEqual(["g3", "q", "g4", "g2", "g"]);
    expect([...popover.element.querySelectorAll(".deferred-project")].map((head) => head.textContent)).toEqual(["bank", "shop"]);
    expect(popover.element.querySelector(".deferred-project")?.getAttribute("title")).toBe("/home/elsewhere/bank");
    expect(counts.at(-1)).toBe(3);
  });

  it("shows the missing consent beside a proposal handed to the person", () => {
    const message = parseDeferredHostMessage({ type: "deferred", items: [{ ...approval, command: "git checkout feature", coordination: "Хранилище (22222222) не ответил. Молчание не означает согласие." }] });
    if (message?.type !== "deferred") throw new Error("Missing inbox message");
    popover.update(message);
    expect(popover.element.textContent).toContain("Хранилище (22222222) не ответил");
    expect(popover.element.textContent).toContain("git checkout feature");
    click("Разрешить");
    expect(posted.at(-1)).toEqual({ type: "answerDeferredApproval", id: "g", decision: "allow-once" });
  });

  it("refreshes_on_open_and_renders_sorted_plain_text_rows", () => {
    popover.opened();
    expect(posted).toEqual([{ type: "listDeferred" }]);
    popover.update({ type: "deferred", items: [question, approval] });
    expect([...popover.element.querySelectorAll("[data-deferred-id]")].map((row) => row.getAttribute("data-deferred-id"))).toEqual(["g", "q"]);
    expect(popover.element.textContent).toContain("Выбрал файл");
    expect(popover.element.textContent).toContain("Проект");
    expect(popover.element.querySelector("script")).toBeNull();
    expect(popover.element.querySelector("details")?.open).toBe(false);
  });

  it("combines_multi_choices_with_custom_words_and_keeps_the_row_until_confirmed", () => {
    popover.update({ type: "deferred", items: [question] });
    click("Файл");
    click("База");
    const custom = popover.element.querySelector("textarea") as HTMLTextAreaElement;
    custom.value = "С шифрованием";
    custom.dispatchEvent(new Event("input"));
    click("Ответить");
    expect(posted).toEqual([{ type: "answerDeferredQuestion", id: "q", answers: ["Файл, База; С шифрованием"] }]);
    expect(popover.element.querySelector('[data-deferred-id="q"]')).not.toBeNull();
    popover.result({ type: "deferredResult", kind: "question", id: "q", ok: false, reason: "Нет связи" });
    expect(popover.element.textContent).toContain("Нет связи");
    expect((popover.element.querySelector("textarea") as HTMLTextAreaElement).value).toBe("С шифрованием");
    click("Ответить");
    popover.result({ type: "deferredResult", kind: "question", id: "q", ok: true });
    expect(popover.element.querySelector('[data-deferred-id="q"]')).toBeNull();
  });

  it("honors_single_select_and_submits_each_complete_question_in_answer_all", () => {
    const second: DeferredItem = { ...question, id: "q2", questions: question.questions.map((prompt) => ({ ...prompt, multiSelect: false })) };
    popover.update({ type: "deferred", items: [question, second] });
    const rows = popover.element.querySelectorAll('[data-deferred-kind="question"]');
    for (const row of rows) {
      const options = row.querySelectorAll<HTMLButtonElement>('[data-role="deferred-option"]');
      options[0]?.click();
      options[1]?.click();
    }
    click("Ответить на все");
    expect(posted).toContainEqual({ type: "answerDeferredQuestion", id: "q", answers: ["Файл, База"] });
    expect(posted).toContainEqual({ type: "answerDeferredQuestion", id: "q2", answers: ["База"] });
  });

  it("sends_dismiss_and_approval_decisions_with_optional_deny_words", () => {
    popover.update({ type: "deferred", items: [question, approval] });
    click("Убрать");
    expect(posted.at(-1)).toEqual({ type: "dismissDeferredQuestion", id: "q" });
    const words = popover.element.querySelector<HTMLTextAreaElement>('[data-role="deferred-reason"]');
    if (words === null) throw new Error("Missing deny words input");
    words.value = "  Уже не нужно  ";
    click("Запретить");
    expect(posted.at(-1)).toEqual({ type: "answerDeferredApproval", id: "g", decision: "deny", message: "Уже не нужно" });
    popover.result({ type: "deferredResult", kind: "approval", id: "g", ok: false, reason: "Повторите" });
    click("Разрешить");
    expect(posted.at(-1)).toEqual({ type: "answerDeferredApproval", id: "g", decision: "allow-once" });
  });

  it("retains_unsent_delivery_with_a_refresh_action_after_reload", () => {
    popover.update({ type: "deferred", items: [], deliveries: [{ kind: "approval", id: "g", text: "Запрет команды", createdAt: 5, reason: "Нет связи" }] });
    expect(popover.element.textContent).toContain("Нет связи");
    click("Повторить доставку");
    expect(posted.at(-1)).toEqual({ type: "listDeferred" });
  });

  it("refreshes_agent_decisions_without_losing_the_persons_draft_or_focus", () => {
    popover.update({ type: "deferred", items: [{ ...question, decided: "" }] });
    const custom = popover.element.querySelector("textarea") as HTMLTextAreaElement;
    custom.value = "Мой вариант";
    custom.focus();
    popover.update({ type: "deferred", items: [{ ...question, sessionTitle: "Новое имя", decided: "Решил позже" }] });
    expect(popover.element.textContent).toContain("Новое имя");
    expect(popover.element.textContent).toContain("Решил позже");
    expect(document.activeElement).toBe(custom);
    expect(custom.value).toBe("Мой вариант");
  });
});

describe("Inbox navigation", () => {
  it("keeps the composer usable while the quiet coordination line updates", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = new ChatView(root, (message) => posted.push(message));
    view.coordination(["Ожидаем Хранилище (22222222): добавить проверку"]);
    const line = root.querySelector<HTMLElement>('[data-role="coordination"]');
    expect(line?.hidden).toBe(false);
    expect(line?.textContent).toContain("Хранилище (22222222)");
    expect(root.querySelector("footer")?.textContent).toContain("добавить проверку");
    expect(root.querySelector<HTMLElement>("footer")?.hidden).toBe(false);
    view.coordination([]);
    expect(line?.hidden).toBe(true);
  });

  it("opens_from_the_header_and_sessions_entry_and_hides_the_zero_badge", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = new ChatView(root, (message) => posted.push(message));
    const badge = root.querySelector<HTMLElement>('[data-role="deferred-count"]');
    expect(badge?.hidden).toBe(true);
    view.deferred({ type: "deferred", items: [question] });
    expect(badge?.textContent).toBe("1");
    expect(badge?.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-role="deferred"]')?.click();
    expect(root.querySelector<HTMLElement>('[data-popover="deferred"]')?.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-role="sessions"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-role="sessions-deferred"]')?.click();
    expect(root.querySelector<HTMLElement>('[data-popover="deferred"]')?.hidden).toBe(false);
    expect(posted.filter((message) => message.type === "listDeferred")).toHaveLength(2);
    view.deferredResult({ type: "deferredResult", kind: "question", id: "q", ok: true });
    expect(badge?.hidden).toBe(true);
  });
});
