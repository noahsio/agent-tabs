import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalFollower } from "../../src/sessions/journalFollow";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function journal(lines: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "at-follow-"));
  roots.push(root);
  const file = join(root, "2026_s1.jsonl");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

let clock = 1_000;
const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp: clock++ } });
const reply = (id: string, text: string) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: clock++ } });
const texts = (follower: JournalFollower): string[] =>
  follower.state.blocks.flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []));

describe("JournalFollower", () => {
  // A session another copy of the host holds can still be shown: its journal is on disk and grows as it works.
  it("shows_the_journal_and_follows_what_is_appended", async () => {
    const file = journal([{ type: "session", id: "s1", cwd: "/work" }, user("u1", "сделай"), reply("a1", "делаю")]);
    const follower = new JournalFollower(file);
    expect(await follower.update()).toBe(true);
    expect(texts(follower)).toEqual(["сделай", "делаю"]);

    expect(await follower.update()).toBe(false); // nothing new

    appendFileSync(file, JSON.stringify(reply("a2", "готово")) + "\n" + JSON.stringify(user("u2", "ещё")).slice(0, 20));
    expect(await follower.update()).toBe(true);
    expect(texts(follower)).toEqual(["сделай", "делаю", "готово"]); // a half-written line waits for its end

    appendFileSync(file, JSON.stringify(user("u2", "ещё")).slice(20) + "\n");
    expect(await follower.update()).toBe(true);
    expect(texts(follower)).toEqual(["сделай", "делаю", "готово", "ещё"]);
  });

  it("starts_a_long_journal_from_its_tail_on_a_whole_line", async () => {
    const lines: unknown[] = [{ type: "session", id: "s1", cwd: "/work" }];
    for (let index = 0; index < 400; index++) lines.push(user(`u${index}`, `сообщение ${index} ${"x".repeat(200)}`));
    const follower = new JournalFollower(journal(lines), 10_000);
    expect(await follower.update()).toBe(true);
    const shown = texts(follower);
    expect(shown.length).toBeGreaterThan(10);
    expect(shown.length).toBeLessThan(400);
    expect(shown.at(-1)).toMatch(/^сообщение 399 /);
    expect(shown.every((text) => text.startsWith("сообщение "))).toBe(true); // no torn first line
  });
});
