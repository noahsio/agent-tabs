import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeCwd, listPastSessions, type SummaryCache } from "../../src/sessions/history";

function makeAgentDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "agent-tabs-hist-")));
}

function writeSession(agentDir: string, cwd: string, id: string, lines: unknown[], mtimeSec?: number): string {
  const dir = join(agentDir, "sessions", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-11-03T10-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-11-03T10:00:00.000Z", cwd };
  writeFileSync(file, [header, ...lines].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

const userMsg = (text: unknown) => ({ type: "message", message: { role: "user", content: text } });

describe("history", () => {
  it("encodes_cwd_like_omo", () => {
    expect(encodeCwd("/tmp/omo-probe/proj")).toBe("--tmp-omo-probe-proj--");
  });

  it("title_prefers_session_name", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    writeSession(dir, realpathSync(cwd), "id-1", [
      userMsg([{ type: "text", text: "hello" }]),
      { type: "session_info", name: "First" },
      { type: "session_info", name: "Last" },
    ]);
    const [session] = await listPastSessions(dir, cwd);
    expect(session?.title).toBe("Last");
    expect(session?.durableId).toBe("id-1");
  });

  it("title_falls_back_to_first_user_message", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    const real = realpathSync(cwd);
    writeSession(dir, real, "a", [userMsg([{ type: "text", text: "  " + "x".repeat(80) }])]);
    writeSession(dir, real, "b", [userMsg("plain string")]);
    writeSession(dir, real, "c", [userMsg([{ type: "image", data: "QUJD", mimeType: "image/png" }])]); // a picture, no words
    const byId = Object.fromEntries((await listPastSessions(dir, cwd)).map((s) => [s.durableId, s.title]));
    expect(byId["a"]).toBe("x".repeat(60));
    expect(byId["b"]).toBe("plain string");
    expect(byId["c"]).toBe("Без названия");
  });

  it("sessions_without_a_user_message_are_not_listed", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    const real = realpathSync(cwd);
    writeSession(dir, real, "empty", []);
    writeSession(dir, real, "named", [{ type: "session_info", name: "Пустая" }, { type: "message", message: { role: "assistant", content: "hi" } }]);
    writeSession(dir, real, "used", [userMsg("привет")]);
    expect((await listPastSessions(dir, cwd)).map((session) => session.durableId)).toEqual(["used"]);
  });

  it("lists_sessions_for_both_path_spellings", async () => {
    const dir = makeAgentDir();
    const real = join(dir, "real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link);
    writeSession(dir, real, "r", [userMsg("r")]);
    writeSession(dir, link, "l", [userMsg("l")]);
    const ids = (await listPastSessions(dir, link)).map((s) => s.durableId).sort();
    expect(ids).toEqual(["l", "r"]);
  });

  it("skips_malformed_lines", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    writeSession(dir, realpathSync(cwd), "m", ["{not json", { type: "session_info", name: "Ok" }, "[1,2", userMsg("x")]);
    expect((await listPastSessions(dir, cwd)).map((s) => s.title)).toEqual(["Ok"]);
  });

  it("crlf_file_parses", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    const sessionDir = join(dir, "sessions", encodeCwd(realpathSync(cwd)));
    mkdirSync(sessionDir, { recursive: true });
    const header = JSON.stringify({ type: "session", version: 3, id: "crlf" });
    const info = JSON.stringify({ type: "session_info", name: "Windows" });
    const user = JSON.stringify(userMsg("x"));
    writeFileSync(join(sessionDir, "2026-11-03T10-00-00-000Z_crlf.jsonl"), `${header}\r\n${info}\r\n${user}\r\n`);
    const [session] = await listPastSessions(dir, cwd);
    expect(session).toMatchObject({ durableId: "crlf", title: "Windows" });
  });

  it("lone_cr_does_not_split_line", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    writeSession(dir, realpathSync(cwd), "cr", [
      '{"type":"session_info","name":"bad\r{"type":"session_info","name":"split"}',
      userMsg("from user"),
    ]);
    expect((await listPastSessions(dir, cwd))[0]?.title).toBe("from user");
  });

  it("sorted_newest_first", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    const real = realpathSync(cwd);
    const at = (iso: string) => ({ type: "message", timestamp: iso, message: { role: "user", content: "x" } });
    writeSession(dir, real, "old", [at("2026-11-03T10:01:00.000Z")]);
    writeSession(dir, real, "new", [at("2026-11-03T10:02:00.000Z")]);
    const list = await listPastSessions(dir, cwd);
    expect(list.map((s) => s.durableId)).toEqual(["new", "old"]);
    expect(list[0]?.updatedAt).toBe(Date.parse("2026-11-03T10:02:00.000Z"));
  });

  it("returns_empty_when_no_sessions_dir", async () => {
    expect(await listPastSessions(makeAgentDir(), "/nonexistent/x")).toEqual([]);
  });

  it("summaries_are_reused_while_a_file_keeps_its_mtime_and_size", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    const cache: SummaryCache = new Map();
    writeSession(dir, realpathSync(cwd), "id-1", [userMsg("x"), { type: "session_info", name: "AAAA" }], 1_800_000_000);
    expect((await listPastSessions(dir, cwd, cache))[0]?.title).toBe("AAAA");

    // Same size, same mtime: not read again (the cached title stays).
    writeSession(dir, realpathSync(cwd), "id-1", [userMsg("x"), { type: "session_info", name: "BBBB" }], 1_800_000_000);
    expect((await listPastSessions(dir, cwd, cache))[0]?.title).toBe("AAAA");

    // A rename appends to the file: it is read again.
    writeSession(dir, realpathSync(cwd), "id-1", [userMsg("x"), { type: "session_info", name: "BBBB" }, { type: "session_info", name: "Новое" }], 1_800_000_000);
    expect((await listPastSessions(dir, cwd, cache))[0]?.title).toBe("Новое");
    expect(cache.size).toBe(1); // one summary per file
  });

  it("a_deleted_session_leaves_the_cache", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    const cache: SummaryCache = new Map();
    const file = writeSession(dir, realpathSync(cwd), "id-1", []);
    await listPastSessions(dir, cwd, cache);
    expect(cache.size).toBe(1);
    rmSync(file);
    expect(await listPastSessions(dir, cwd, cache)).toEqual([]);
    expect(cache.size).toBe(0);
  });
});

describe("history_order_time", () => {
  const stamped = (role: string, iso: string) => ({ type: "message", timestamp: iso, message: { role, content: "x" } });

  it("updated_at_is_the_last_message_time_not_the_file_mtime", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    const real = realpathSync(cwd);
    writeSession(dir, real, "old", [stamped("user", "2026-11-03T10:05:00.000Z"), stamped("assistant", "2026-11-03T10:06:00.000Z")], 4_000_000_000);
    writeSession(dir, real, "new", [{ type: "message", message: { role: "user", content: "x", timestamp: Date.parse("2026-11-03T12:00:00.000Z") } }], 1);
    const sessions = await listPastSessions(dir, cwd);
    expect(sessions.map((s) => s.durableId)).toEqual(["new", "old"]); // mtime says the opposite
    expect(sessions[1]?.updatedAt).toBe(Date.parse("2026-11-03T10:06:00.000Z"));
  });

  it("touching_the_file_without_a_message_does_not_move_the_chat_but_a_new_message_does", async () => {
    const dir = makeAgentDir();
    const cwd = join(dir, "proj");
    mkdirSync(cwd);
    const real = realpathSync(cwd);
    const cache: SummaryCache = new Map();
    const a = writeSession(dir, real, "a", [stamped("user", "2026-11-03T10:05:00.000Z")]);
    writeSession(dir, real, "b", [stamped("user", "2026-11-03T11:00:00.000Z")]);
    expect((await listPastSessions(dir, cwd, cache)).map((s) => s.durableId)).toEqual(["b", "a"]);
    appendFileSync(a, JSON.stringify({ type: "session_info", name: "renamed" }) + "\n"); // attach/rename-like write, no message
    utimesSync(a, 4_000_000_000, 4_000_000_000);
    expect((await listPastSessions(dir, cwd, cache)).map((s) => s.durableId)).toEqual(["b", "a"]);
    appendFileSync(a, JSON.stringify(stamped("assistant", "2026-11-03T13:00:00.000Z")) + "\n");
    expect((await listPastSessions(dir, cwd, cache)).map((s) => s.durableId)).toEqual(["a", "b"]);
  });
});
