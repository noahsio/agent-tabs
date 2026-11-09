import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { DeferredInbox, type DeliverySession } from "../../src/deferred/inbox";
import { DeferredStore } from "../../src/deferred/store";
import type { DeferredView } from "../../src/guard/admin";
import type { DeferredHostMessage } from "../../src/panel/protocol";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { agentDir: string; sessionPath: string } {
  const agentDir = mkdtempSync("/tmp/at-inbox-");
  roots.push(agentDir);
  const dir = join(agentDir, "sessions", "--work--");
  mkdirSync(dir, { recursive: true });
  const sessionPath = join(dir, "2026_session-1.jsonl");
  writeFileSync(sessionPath, [
    { type: "session", id: "session-1", cwd: "/work" },
    { type: "session_info", name: "Проект" },
    { type: "message", message: { role: "user", content: "Сделай" } },
    { type: "message", timestamp: new Date(NOW - 120_000).toISOString(), message: { role: "assistant", content: [
      { type: "toolCall", id: "q", name: "ask_user_question", arguments: { questions: [{ header: "Место", question: "Где хранить?", options: [{ label: "Файл" }], multiSelect: false }] } },
    ] } },
    { type: "custom", customType: "ask-user:settlement", timestamp: new Date(NOW - 60_000).toISOString(), data: { requestId: "q", status: "timed_out" } },
    { type: "message", message: { role: "assistant", content: "Использовал файл" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  utimesSync(sessionPath, NOW / 1000, NOW / 1000);
  return { agentDir, sessionPath };
}

type InboxDeps = ConstructorParameters<typeof DeferredInbox>[1];

function setup(open: boolean = true): {
  inbox: DeferredInbox; store: DeferredStore; agentDir: string; sessionPath: string; published: DeferredHostMessage[];
  session: DeliverySession; send: ReturnType<typeof vi.fn<DeliverySession["send"]>>;
  attach: Mock<InboxDeps["attach"]>; answer: ReturnType<typeof vi.fn>; log: Mock<InboxDeps["log"]>;
  connect: Mock<InboxDeps["connect"]>; guardItems: DeferredView[];
} {
  const { agentDir, sessionPath } = fixture();
  const send = vi.fn<DeliverySession["send"]>().mockResolvedValue(true);
  const session: DeliverySession = { send, release: vi.fn().mockResolvedValue(undefined) };
  const attach = vi.fn().mockResolvedValue(session);
  const guardItems: DeferredView[] = [{ id: "g", session: "session-1", cwd: "/work", tool: "bash", command: "rm report", reasons: [], createdAt: new Date(NOW - 30_000).toISOString(), deferredAt: new Date(NOW).toISOString() }];
  const answer = vi.fn().mockImplementation(async () => { guardItems.splice(0); });
  const connect = vi.fn().mockResolvedValue({ deferred: async () => guardItems.slice(), answer, close: vi.fn() });
  const published: DeferredHostMessage[] = [];
  const log = vi.fn();
  const store = new DeferredStore(agentDir);
  const inbox = new DeferredInbox(agentDir, { now: () => NOW, protectionOn: async () => true, connect,
    open: (file) => open && file === sessionPath ? session : undefined, attach, publish: (message) => published.push(message), log });
  return { inbox, store, agentDir, sessionPath, published, session, send, attach, answer, log, connect, guardItems };
}

describe("DeferredInbox", () => {
  it("names_the_project_of_each_item_so_a_window_can_tell_its_own", async () => {
    const fixture = setup(false);
    await fixture.inbox.refresh();
    expect(fixture.published).toContainEqual(expect.objectContaining({ type: "deferred", items: expect.arrayContaining([
      expect.objectContaining({ kind: "question", id: "q", cwd: "/work" }),
      expect.objectContaining({ kind: "approval", id: "g", cwd: "/work" }),
    ]) }));
  });

  it("explains a coordination proposal and leaves its answer delivery to the service", async () => {
    const fixture = setup(false);
    Object.assign(fixture.guardItems[0]!, { coordinationId: "proposal-1", sessionLabel: "Проект (session-)", reasons: ["Хранилище (22222222) не ответил; молчание не означает согласие"] });
    await fixture.inbox.refresh();
    expect(fixture.published).toContainEqual(expect.objectContaining({ type: "deferred", items: expect.arrayContaining([
      expect.objectContaining({ kind: "approval", sessionTitle: "Проект (session-)", coordination: "Хранилище (22222222) не ответил; молчание не означает согласие" }),
    ]) }));
    await fixture.inbox.answer({ type: "answerDeferredApproval", id: "g", decision: "allow-once" });
    expect(fixture.answer).toHaveBeenCalledWith("g", "allow-once", undefined);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.store.read().outbox).toEqual({});
    expect(fixture.published).toContainEqual({ type: "deferredResult", kind: "approval", id: "g", ok: true });
  });

  it("persists_a_question_and_outbox_before_sending_to_the_open_tab", async () => {
    const fixture = setup();
    await fixture.inbox.refresh();
    fixture.send.mockImplementation(async (text, mode, images, id) => {
      const data = JSON.parse(readFileSync(join(fixture.agentDir, "agent-tabs", "deferred.json"), "utf8"));
      expect(data.questions.q.text).toBe("Файл");
      expect(data.outbox["deferred-question-q"]).toMatchObject({ kind: "question", sessionPath: fixture.sessionPath, text, clientMessageId: id, createdAt: NOW });
      expect(mode).toBe("auto");
      expect(images).toEqual([]);
      expect(id).toBe("deferred-question-q");
      return true;
    });
    await fixture.inbox.answer({ type: "answerDeferredQuestion", id: "q", answers: ["Файл"] });
    const time = new Date(NOW - 120_000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    expect(fixture.send.mock.calls[0]?.[0]).toBe(`Ответ на отложенный вопрос от ${time} «Где хранить?»: Файл. Тогда ты продолжил сам: «Использовал файл» — сверь допущение и поправь, что изменилось.`);
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.store.read().outbox).toEqual({});
    expect(fixture.published).toContainEqual({ type: "deferredResult", kind: "question", id: "q", ok: true });
    await fixture.inbox.answer({ type: "answerDeferredQuestion", id: "q", answers: ["Другое"] });
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it("does_not_write_or_send_when_guard_rejects_and_only_enqueues_after_success", async () => {
    const fixture = setup(false);
    await fixture.inbox.refresh();
    fixture.answer.mockRejectedValueOnce(new Error("Запрос уже отвечен"));
    await fixture.inbox.answer({ type: "answerDeferredApproval", id: "g", decision: "allow-once" });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.store.read().outbox).toEqual({});
    expect(fixture.published).toContainEqual({ type: "deferredResult", kind: "approval", id: "g", ok: false, reason: "Запрос уже отвечен" });
    fixture.answer.mockImplementationOnce(async () => {
      expect(fixture.store.read().outbox).toEqual({});
      expect(fixture.send).not.toHaveBeenCalled();
    });
    fixture.send.mockImplementationOnce(async (text, _mode, _images, clientMessageId) => {
      expect(fixture.store.read().outbox["deferred-approval-g"]).toMatchObject({ text, clientMessageId, sessionId: "session-1" });
      return true;
    });
    await fixture.inbox.answer({ type: "answerDeferredApproval", id: "g", decision: "allow-once" });
    expect(fixture.attach).toHaveBeenCalledWith(fixture.sessionPath);
    expect(fixture.send).toHaveBeenCalledWith("Человек разрешил отложенную команду (#g): `rm report` — выполни её сейчас, если она ещё нужна.", "auto", [], "deferred-approval-g");
    expect(fixture.session.release).toHaveBeenCalledOnce();
  });

  it("keeps_failed_delivery_for_restart_and_retries_with_the_same_admission_id", async () => {
    const fixture = setup(false);
    await fixture.inbox.refresh();
    fixture.send.mockResolvedValueOnce(false);
    await fixture.inbox.answer({ type: "answerDeferredApproval", id: "g", decision: "deny", message: "Не нужно" });
    expect(fixture.store.read().outbox["deferred-approval-g"]?.text).toBe("Человек запретил отложенную команду (#g): `rm report` — Не нужно");
    expect(fixture.session.release).toHaveBeenCalledOnce();
    const restarted = new DeferredInbox(fixture.agentDir, { now: () => NOW, protectionOn: async () => false, connect: fixture.connect,
      open: () => undefined, attach: fixture.attach, publish: (message) => fixture.published.push(message), log: fixture.log });
    await restarted.refresh();
    expect(fixture.send.mock.calls.map((call) => call[3])).toEqual(["deferred-approval-g", "deferred-approval-g"]);
    expect(fixture.store.read().outbox).toEqual({});
    expect(fixture.answer).toHaveBeenCalledOnce();
  });

  it("expires_old_outbox_records_and_logs_without_opening_the_session", async () => {
    const fixture = setup();
    fixture.store.enqueue({ kind: "approval", sessionId: "session-1", text: "Старое", clientMessageId: "deferred-approval-old", createdAt: NOW - 7 * 86400_000 - 1 });
    await fixture.inbox.refresh();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.store.read().outbox).toEqual({});
    expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining("deferred-approval-old"));
  });

  it("refreshes_external_guard_decisions_without_sending_and_silences_unreachable_guard", async () => {
    const fixture = setup();
    await fixture.inbox.refresh();
    fixture.guardItems.splice(0);
    await fixture.inbox.refresh();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.published.at(-1)).toMatchObject({ type: "deferred", items: [expect.objectContaining({ id: "q" })] });
    fixture.connect.mockRejectedValue(new Error("Нет сокета"));
    await fixture.inbox.refresh();
    expect(fixture.published.at(-1)).not.toHaveProperty("error");
  });

  it("dismisses_without_delivery_and_rejects_wrong_answer_count", async () => {
    const fixture = setup();
    await fixture.inbox.refresh();
    await fixture.inbox.answer({ type: "answerDeferredQuestion", id: "q", answers: ["Один", "Два"] });
    expect(fixture.store.read().questions).toEqual({});
    await fixture.inbox.answer({ type: "dismissDeferredQuestion", id: "q" });
    expect(fixture.store.read().questions.q).toEqual({ at: NOW, text: "" });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("rescans_journals_at_most_once_a_minute_but_always_retries_the_outbox", async () => {
    const fixture = setup(false);
    let now = NOW;
    const inbox = new DeferredInbox(fixture.agentDir, { now: () => now, protectionOn: async () => false, connect: fixture.connect,
      open: () => undefined, attach: fixture.attach, publish: (message) => fixture.published.push(message), log: fixture.log });
    await inbox.refresh();
    appendFileSync(fixture.sessionPath, JSON.stringify({ type: "session_info", name: "Новое имя" }) + "\n");
    fixture.send.mockRejectedValueOnce(new Error("Соединение потеряно"));
    await inbox.answer({ type: "answerDeferredQuestion", id: "q", answers: ["Файл"] });
    expect(fixture.session.release).toHaveBeenCalledOnce();
    expect(fixture.store.read().outbox["deferred-question-q"]).toBeDefined();
    await inbox.refresh();
    expect(fixture.send.mock.calls.map((call) => call[3])).toEqual(["deferred-question-q", "deferred-question-q"]);
    expect(fixture.store.read().outbox).toEqual({});
    // Another question appended inside the minute is only visible at the next permitted scan.
    appendFileSync(fixture.sessionPath, [
      { type: "message", timestamp: NOW, message: { role: "assistant", content: [
        { type: "toolCall", id: "q2", name: "request_user_input", arguments: { questions: [{ question: "Как?", options: [] }] } },
      ] } },
      { type: "custom", customType: "ask-user:settlement", timestamp: NOW, data: { requestId: "q2", status: "timed_out" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    now += 59_999;
    await inbox.refresh();
    expect(fixture.published.at(-1)).toMatchObject({ items: [] });
    now++;
    await inbox.refresh();
    expect(fixture.published.at(-1)).toMatchObject({ items: [{ id: "q2", sessionTitle: "Новое имя" }] });
    await inbox.answer({ type: "answerDeferredQuestion", id: "q2", answers: ["Так"] });
    expect(fixture.send.mock.calls.at(-1)?.[0]).toMatch(/«Как\?»: Так\.$/);
  });
});
