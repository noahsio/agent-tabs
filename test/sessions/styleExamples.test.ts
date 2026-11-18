import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectStyleExamples, replyPairs, styleExamples } from "../../src/sessions/styleExamples";

const line = (role: string, content: unknown): string => JSON.stringify({ type: "message", id: Math.random().toString(36), message: { role, content } });
const journal = (...lines: string[]): string => [JSON.stringify({ type: "session", id: "s" }), ...lines].join("\n");

describe("replyPairs", () => {
  it("pairs_each_short_reply_with_the_end_of_the_agent_text_it_answered", () => {
    const text = journal(
      line("user", "почини тесты"),
      line("assistant", [{ type: "text", text: "Починил.\nЗапушить?" }]),
      line("user", [{ type: "text", text: "[картинка 1] да пушь" }]),
      line("assistant", [{ type: "toolCall", name: "bash" }]),
      line("assistant", [{ type: "text", text: `${"слово ".repeat(60)}Задеплоить?` }]),
      line("user", "+"),
    );
    const pairs = replyPairs(text);
    expect(pairs.map((pair) => pair.user)).toEqual(["да пушь", "+"]);
    expect(pairs[0]?.agent).toBe("Починил. Запушить?");
    expect(pairs[1]?.agent).toHaveLength(120); // only the reply's end
    expect(pairs[1]?.agent.endsWith("слово Задеплоить?")).toBe(true);
  });

  it("leaves_out_long_messages_notices_card_answers_and_anything_that_looks_like_a_secret", () => {
    const reply = (agent: string, user: string): string[] => [line("assistant", [{ type: "text", text: agent }]), line("user", user)];
    const text = journal(
      ...reply("Готово.", "a".repeat(151)),
      ...reply("Готово.", "<omo-senpi-task>wake</omo-senpi-task>"),
      ...reply("Режим?", "[Answer to question q1] Локально"),
      ...reply("Вот ключ: sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "ок"),
      ...reply("Готово.", "дай пароль от панели"),
      ...reply("Готово.", "[картинка 2]"),
      ...reply("Готово.", "ок дальше"),
    );
    expect(replyPairs(text)).toEqual([{ agent: "Готово.", user: "ок дальше" }]);
  });
});

describe("styleExamples", () => {
  it("tags_the_pairs_and_is_undefined_without_any", () => {
    expect(styleExamples([{ agent: "Запушить?", user: "да" }])).toBe("<style_examples>\n<example>\n<agent>…Запушить?</agent>\n<user>да</user>\n</example>\n</style_examples>");
    expect(styleExamples([])).toBeUndefined();
  });
});

describe("projectStyleExamples", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const session = (name: string, minutesAgo: number, ...replies: string[]): string => {
    const file = join(dir, name);
    writeFileSync(file, journal(...replies.flatMap((reply) => [line("assistant", [{ type: "text", text: `Готово (${name}).` }]), line("user", reply)])));
    const at = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(file, at, at);
    return file;
  };

  it("reads_the_projects_other_sessions_newest_last_keeps_twelve_and_never_its_own", async () => {
    dir = mkdtempSync(join(tmpdir(), "style-"));
    const own = session("own.jsonl", 0, "своё");
    session("old.jsonl", 30, ...Array.from({ length: 10 }, (_, index) => `старый ${index}`));
    session("new.jsonl", 5, "новый 1", "новый 2", "новый 3");
    const examples = (await projectStyleExamples(own)) as string;
    expect(examples.match(/<user>/g)).toHaveLength(12);
    expect(examples).not.toContain("своё");
    expect(examples).not.toContain("старый 0");
    expect(examples.indexOf("старый 9")).toBeLessThan(examples.indexOf("новый 1"));
    expect(examples.trimEnd().endsWith("<user>новый 3</user>\n</example>\n</style_examples>")).toBe(true);
  });

  it("reads_again_only_after_ten_minutes", async () => {
    dir = mkdtempSync(join(tmpdir(), "style-"));
    const own = session("own.jsonl", 0);
    session("a.jsonl", 5, "первый");
    const now = Date.now();
    expect(await projectStyleExamples(own, now)).toContain("первый");
    session("b.jsonl", 1, "второй");
    expect(await projectStyleExamples(own, now + 60_000)).not.toContain("второй");
    expect(await projectStyleExamples(own, now + 11 * 60_000)).toContain("второй");
  });
});
