import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/rewind/edits";
import { buildFork, buildSessionFork, forkDraft, forkFileName, forkTitle, readSessionHeader, writeFork, writeSessionFork } from "../../src/rewind/fork";

const HEADER: Entry = { type: "session", version: 3, id: "orig-id", timestamp: "2026-11-04T09:00:00.000Z", cwd: "/p" };
const NOW = new Date("2026-11-04T10:11:12.345Z");

const user = (id: string, parentId: string, text: string, clientMessageId: string): Entry => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-11-04T09:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text }], clientMessageId, timestamp: 1 },
});

const ENTRIES: Entry[] = [
  { type: "custom", customType: "repository-identity", id: "m0", parentId: null, data: { x: 1 } },
  user("u1", "m0", "first", "c1"),
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1 } } },
  user("u2", "a1", "second", "c2"),
  { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "ok2" }] } },
  user("u3", "a1", "branch", "c3"),
];

describe("rewind fork", () => {
  it("fork_file_is_the_parent_chain_under_a_new_header", () => {
    const { text, chain } = buildFork(HEADER, ENTRIES, "u2", "new-id", NOW, "/s/orig.jsonl");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ ...HEADER, id: "new-id", timestamp: NOW.toISOString(), parentSession: "/s/orig.jsonl" });
    expect(lines.slice(1).map((entry) => entry.id)).toEqual(["m0", "u1", "a1"]);
    expect(lines[3]).toEqual(ENTRIES.find((entry) => entry["id"] === "a1"));
    expect(chain.map((entry) => entry["id"])).toEqual(["m0", "u1", "a1"]);
  });

  it("fork_at_the_first_message_keeps_only_setup_entries", () => {
    const { text } = buildFork(HEADER, ENTRIES, "u1", "new-id", NOW, "/s/orig.jsonl");
    expect(text.trimEnd().split("\n").slice(1).map((line) => JSON.parse(line).id)).toEqual(["m0"]);
    expect(forkDraft(ENTRIES[1] as Entry).text).toBe("first");
  });

  it("fork_from_an_abandoned_branch_takes_its_own_ancestors", () => {
    const { text } = buildFork(HEADER, ENTRIES, "u3", "new-id", NOW, "/s/orig.jsonl");
    expect(text.trimEnd().split("\n").slice(1).map((line) => JSON.parse(line).id)).toEqual(["m0", "u1", "a1"]);
  });

  it("fork_draft_takes_text_and_images_of_the_entry", () => {
    const entryWith = (content: unknown): Entry => ({ type: "message", id: "u", parentId: null, message: { role: "user", content } });
    expect(
      forkDraft(entryWith([{ type: "text", text: "Fix " }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "it" }])),
    ).toEqual({ text: "Fix it", images: [{ data: "AAAA", mimeType: "image/png" }] });
    expect(forkDraft(entryWith("plain"))).toEqual({ text: "plain", images: [] });
    const many = Array.from({ length: 7 }, () => ({ type: "image", data: "AAAA", mimeType: "image/png" }));
    expect(forkDraft(entryWith(many)).images).toHaveLength(5);
    expect(forkDraft(entryWith([{ type: "image", data: "A".repeat(5_242_881), mimeType: "image/png" }, { type: "image", mimeType: "image/png" }])).images).toEqual([]);
  });

  it("session_fork_keeps_the_leaf_and_only_its_branch", () => {
    const ids = (leaf: string): string[] =>
      buildSessionFork(HEADER, ENTRIES, leaf, "new-id", NOW, "/s/orig.jsonl").text.trimEnd().split("\n").slice(1).map((line) => JSON.parse(line).id);
    expect(ids("a2")).toEqual(["m0", "u1", "a1", "u2", "a2"]);
    expect(ids("u3")).toEqual(["m0", "u1", "a1", "u3"]);
    expect(() => buildSessionFork(HEADER, ENTRIES, "missing", "new-id", NOW, "/s/orig.jsonl")).toThrow();
  });

  it("write_session_fork_copies_the_source_lines_verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tabs-fork-"));
    const source = join(dir, "2026-11-04T09-00-00-000Z_orig-id.jsonl");
    const raw = [HEADER, ...ENTRIES].map((entry) => JSON.stringify(entry));
    writeFileSync(source, raw.join("\n") + "\n");
    const result = await writeSessionFork(source, "a2", NOW);
    expect(dirname(result.sessionPath)).toBe(dir);
    expect(statSync(result.sessionPath).mode & 0o777).toBe(0o600);
    const lines = readFileSync(result.sessionPath, "utf8").trimEnd().split("\n");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: "session", id: result.sessionUuid, parentSession: source });
    expect(lines.slice(1)).toEqual(raw.slice(1, 6));
    expect(result.chain.map((entry) => entry["id"])).toEqual(["m0", "u1", "a1", "u2", "a2"]);
  });

  it("fork_file_name_is_like_omo", () => {
    expect(forkFileName("abc", NOW)).toBe("2026-11-04T10-11-12-345Z_abc.jsonl");
  });

  it("write_fork_is_atomic_and_private", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tabs-fork-"));
    const source = join(dir, "2026-11-04T09-00-00-000Z_orig-id.jsonl");
    writeFileSync(source, [HEADER, ...ENTRIES].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    expect(await readSessionHeader(source)).toEqual(HEADER);
    const result = await writeFork(source, "u2", NOW);
    expect(dirname(result.sessionPath)).toBe(dir);
    expect(basename(result.sessionPath)).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[0-9a-f-]{36}\.jsonl$/);
    expect(basename(result.sessionPath)).toContain(result.sessionUuid);
    expect(statSync(result.sessionPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const lines = readFileSync(result.sessionPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "session", id: result.sessionUuid, parentSession: source, cwd: "/p" });
    expect(result.draft).toEqual({ text: "second", images: [] });
    expect(result.chain.map((entry) => entry["id"])).toEqual(["m0", "u1", "a1"]);
  });

  it("selecting_a_non_user_entry_throws", async () => {
    expect(() => buildFork(HEADER, ENTRIES, "a1", "new-id", NOW, "/s/orig.jsonl")).toThrow();
    expect(() => buildFork(HEADER, ENTRIES, "missing", "new-id", NOW, "/s/orig.jsonl")).toThrow();
    const dir = mkdtempSync(join(tmpdir(), "agent-tabs-fork-"));
    writeFileSync(join(dir, "bad.jsonl"), `${JSON.stringify({ type: "message" })}\n`);
    await expect(readSessionHeader(join(dir, "bad.jsonl"))).rejects.toThrow();
  });

  it("fork_lines_are_the_source_files_bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tabs-fork-"));
    const source = join(dir, "2026-11-04T09-00-00-000Z_orig-id.jsonl");
    const raw = [
      JSON.stringify(HEADER),
      '{"type": "custom",  "customType":"repository-identity","id":"m0","parentId":null,"data":{"b":2,"a":1}}',
      '{"id":"u1","type":"message","parentId":"m0","message":{"role":"user","content":[{"type":"text","text":"\\u0041 first"}],"clientMessageId":"c1"}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input":1.50}}}',
      '{"type":"message","id":"u2","parentId":"a1","message":{"role":"user","content":[{"type":"text","text":"second"}],"clientMessageId":"c2"}}',
      '{"type":"message","id":"torn","parentId":"u2"',
    ];
    writeFileSync(source, raw.join("\n") + "\n");
    const result = await writeFork(source, "u2", NOW);
    const lines = readFileSync(result.sessionPath, "utf8").split("\n");
    expect(lines.slice(1, 4)).toEqual(raw.slice(1, 4)); // verbatim, spacing and key order included
    expect(lines[4]).toBe("");
    expect(result.draft.text).toBe("second");
    await expect(writeFork(source, "missing", NOW)).rejects.toThrow();
  });
});

/**
 * An answered question's card forks at the message whose turn asked it (the reducer's `forkFrom`), because OmO writes
 * its `ask-user:settlement` before the answer: a session cut at the answer still holds a question marked settled and
 * is never asked again (measured — see test/live/answeredQuestion.live.test.ts). Cutting at the message that led to it
 * leaves the agent to reach the question itself, which is the only way back to answering it differently.
 */
describe("a fork from an answered question", () => {
  const ASKED: Entry[] = [
    { type: "custom", customType: "repository-identity", id: "m0", parentId: null, data: { x: 1 } },
    user("u1", "m0", "почини каталог", "c1"),
    {
      type: "message",
      id: "q1",
      parentId: "u1",
      message: { role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "ask_user_question", arguments: { questions: [] } }] },
    },
    { type: "custom", customType: "ask-user:question", id: "k1", parentId: "q1", data: { requestId: "toolu_1", headers: ["Кэш"] } },
    { type: "custom", customType: "ask-user:settlement", id: "k2", parentId: "k1", data: { requestId: "toolu_1", status: "answered" } },
    user("a1", "k2", "[Answer to question toolu_1]\nКэш: Без кэша", "c2"),
  ];

  it("cutting_at_the_answer_would_keep_a_question_omo_has_already_settled", () => {
    const { text } = buildFork(HEADER, ASKED, "a1", "new-id", NOW, "/s/orig.jsonl");
    const kinds = text.trimEnd().split("\n").slice(1).map((line) => JSON.parse(line).customType ?? JSON.parse(line).type);
    expect(kinds).toContain("ask-user:settlement"); // why the card forks at the message before instead
  });

  it("cutting_at_the_message_that_led_to_it_leaves_neither_the_question_nor_the_answer", () => {
    const { text } = buildFork(HEADER, ASKED, "u1", "new-id", NOW, "/s/orig.jsonl");
    const lines = text.trimEnd().split("\n").slice(1);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["m0"]);
    expect(text).not.toContain("ask_user_question");
    expect(text).not.toContain("Answer to question");
    expect(forkDraft(ASKED[1] as Entry).text).toBe("почини каталог"); // their own words in the fork's composer
  });
});

describe("forkTitle", () => {
  it("marks_a_first_fork_and_numbers_the_next_ones", () => {
    expect(forkTitle("Починить вход")).toBe("Починить вход (fork)");
    expect(forkTitle("Починить вход (fork)")).toBe("Починить вход (fork 2)");
    expect(forkTitle("Починить вход (fork 2)")).toBe("Починить вход (fork 3)");
    expect(forkTitle("Починить вход (fork 9)")).toBe("Починить вход (fork 10)");
  });

  it("an_untitled_source_is_a_new_session", () => {
    expect(forkTitle("")).toBe("Новая сессия (fork)");
    expect(forkTitle("   ")).toBe("Новая сессия (fork)");
  });

  it("only_a_trailing_mark_counts", () => {
    expect(forkTitle("(fork) в начале")).toBe("(fork) в начале (fork)");
    expect(forkTitle("  Задача (fork)  ")).toBe("Задача (fork 2)");
  });
});
