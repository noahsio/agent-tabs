import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeferredQuestions, findSessionPath } from "../../src/deferred/questions";
import { DEFER_QUESTION_COMMENT } from "../../src/panel/protocol";
import { encodeCwd } from "../../src/sessions/history";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { agent: string; file: string } {
  const root = mkdtempSync("/tmp/at-deferred-");
  roots.push(root);
  const agent = join(root, "agent");
  const dir = join(agent, "sessions", encodeCwd("/work"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-11-08_session-1.jsonl");
  writeFileSync(file, "");
  append(file, { type: "session", id: "session-1", cwd: "/work" }, message("user", "Название из запроса"));
  return { agent, file };
}

function append(file: string, ...entries: unknown[]): void {
  appendFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  utimesSync(file, NOW / 1000, NOW / 1000);
}

function message(role: string, content: unknown): unknown {
  return { type: "message", timestamp: new Date(NOW - 120_000).toISOString(), message: { role, content } };
}

function question(id: string, name: string = "ask_user_question"): unknown {
  return message("assistant", [{ type: "toolCall", id, name, arguments: { questions: [
    { header: "Хранилище", question: "Где хранить?", options: [{ label: "В файле" }, { label: "В базе" }], multiSelect: true },
  ] } }]);
}

function settlement(id: string, status: string): unknown {
  return { type: "custom", customType: "ask-user:settlement", timestamp: new Date(NOW - 60_000).toISOString(), data: { requestId: id, status } };
}

describe("DeferredQuestions", () => {
  it("finds_timeouts_and_comment_deferrals_but_not_normal_answers", async () => {
    const { agent, file } = fixture();
    append(file, question("timeout"), settlement("timeout", "timed_out"), message("assistant", [{ type: "thinking", thinking: "not text" }]),
      message("assistant", [{ type: "text", text: "Решил использовать файл. ".repeat(30) }]),
      question("comment", "request_user_input"), settlement("comment", "comment-submitted"),
      { type: "message", message: { role: "toolResult", toolCallId: "comment", content: [{ type: "text", text: DEFER_QUESTION_COMMENT }] } },
      question("normal"), settlement("normal", "answered"),
      { type: "message", message: { role: "toolResult", toolCallId: "normal", details: { answer: "В базе" } } },
      { type: "session_info", name: "Проект" });
    const items = await new DeferredQuestions(agent).scan(NOW);
    expect(items.map((item) => item.id).sort()).toEqual(["comment", "timeout"]);
    expect(items.find((item) => item.id === "timeout")).toMatchObject({
      sessionPath: file, sessionTitle: "Проект", createdAt: NOW - 120_000, deferredAt: NOW - 60_000,
      decided: "Решил использовать файл. ".repeat(30).slice(0, 300),
      questions: [{ header: "Хранилище", question: "Где хранить?", options: [{ label: "В файле" }, { label: "В базе" }], multiSelect: true }],
    });
  });

  it("reads_appended_bytes_and_keeps_partial_utf8_records_until_complete", async () => {
    const { agent, file } = fixture();
    append(file, question("q"), settlement("q", "comment-submitted"));
    const scanner = new DeferredQuestions(agent);
    expect(await scanner.scan(NOW)).toEqual([]);
    const result = Buffer.from(JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "q", details: { comment: DEFER_QUESTION_COMMENT } } }) + "\n");
    const split = result.indexOf(Buffer.from("Ч")) + 1;
    appendFileSync(file, result.subarray(0, split));
    expect(await scanner.scan(NOW)).toEqual([]);
    appendFileSync(file, result.subarray(split));
    append(file, message("assistant", "Сам выбрал файл"));
    expect((await scanner.scan(NOW))[0]).toMatchObject({ id: "q", decided: "Сам выбрал файл", sessionTitle: "Название из запроса" });
    // Rewriting an already consumed prefix must not change the cached question.
    const bytes = readFileSync(file, "utf8");
    writeFileSync(file, bytes.replace("Где хранить?", "Что хранить?"));
    append(file, { type: "session_info", name: "Новое имя" });
    expect((await scanner.scan(NOW))[0]).toMatchObject({ sessionTitle: "Новое имя", questions: [expect.objectContaining({ question: "Где хранить?" })] });
  });

  it("filters_seven_day_window_and_saved_answers_across_instances", async () => {
    const { agent, file } = fixture();
    append(file, question("q"), settlement("q", "timed_out"));
    const scanner = new DeferredQuestions(agent);
    expect(await scanner.scan(NOW + 7 * 86400_000 + 1)).toEqual([]);
    expect((await scanner.scan(NOW)).map((item) => item.id)).toEqual(["q"]);
    await scanner.markAnswered("q", "В файле", NOW);
    expect(await new DeferredQuestions(agent).scan(NOW)).toEqual([]);
    await scanner.markAnswered("dismissed", "", NOW + 1);
    const stored = JSON.parse(readFileSync(join(agent, "agent-tabs", "deferred.json"), "utf8"));
    expect(stored.questions).toEqual({ q: { at: NOW, text: "В файле" }, dismissed: { at: NOW + 1, text: "" } });
    expect(JSON.parse(readFileSync(join(agent, "agent-tabs", "deferred.json.bak-agent-tabs"), "utf8")).questions.q.text).toBe("В файле");
  });

  it("resolves_durable_ids_across_projects_and_ignores_non_journals", async () => {
    const { agent, file } = fixture();
    expect(await findSessionPath(agent, "session-1")).toBe(file);
    expect(await findSessionPath(agent, "../../outside")).toBeUndefined();
    expect(await findSessionPath(agent, "session-10")).toBeUndefined();
  });
});
