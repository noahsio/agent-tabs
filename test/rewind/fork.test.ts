import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/rewind/edits";
import { buildFork, forkDraft, forkFileName, forkTitle, readSessionHeader, writeFork } from "../../src/rewind/fork";

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
