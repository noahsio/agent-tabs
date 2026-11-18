import { describe, expect, it } from "vitest";
import type { Block } from "../../src/chat/model";
import { inPersonsCase, recentConversation, withStyleExamples } from "../../src/chat/suggestion";

const user = (id: string, text: string): Block => ({ kind: "user", id, text });
const reply = (id: string, text: string): Block => ({ kind: "assistant", id, text, thinking: "", streaming: false });
const tool = (id: string): Block => ({ kind: "tool", id, name: "bash", summary: "ls", args: {}, input: "ls -la", output: "secret listing", truncated: false, state: "ok" });

describe("recentConversation", () => {
  it("tags_the_persons_messages_and_the_replies_in_order_without_tool_steps", () => {
    const blocks = [user("u1", "почини тесты"), reply("a1", "Смотрю."), tool("t1"), reply("a2", "Починил, всё зелёное."), user("u2", "а линтер?"), reply("a3", "Тоже чисто.")];
    expect(recentConversation(blocks)).toBe(
      "<conversation>\n<user>\nпочини тесты\n</user>\n<assistant>\nСмотрю.\n\nПочинил, всё зелёное.\n</assistant>\n<user>\nа линтер?\n</user>\n<assistant>\nТоже чисто.\n</assistant>\n</conversation>",
    );
  });

  it("is_undefined_until_a_reply_answers_a_message", () => {
    expect(recentConversation([])).toBeUndefined();
    expect(recentConversation([user("u1", "привет")])).toBeUndefined();
    expect(recentConversation([reply("a1", "Здравствуйте")])).toBeUndefined();
    expect(recentConversation([user("u1", "привет"), reply("a1", "Здравствуйте"), tool("t1")])).toBeDefined();
  });

  it("keeps_the_end_of_the_newest_reply_and_cuts_older_messages_shorter_then_drops_the_oldest", () => {
    const old = Array.from({ length: 12 }, (_, index) => [user(`u${index}`, `вопрос ${index} ${"x".repeat(2_000)}`), reply(`a${index}`, `ответ ${index} ${"y".repeat(2_000)}`)]).flat();
    const text = recentConversation([...old, user("last", "и что теперь?"), reply("final", `${"z".repeat(5_000)} Задеплоить?`)]) as string;
    expect(text).toContain(`<assistant>\n…${"z".repeat(3_988)} Задеплоить?\n</assistant>\n</conversation>`);
    expect(text).toContain(`<user>\nвопрос 11 ${"x".repeat(1_190)}…\n</user>`);
    expect(text).not.toContain("вопрос 0 ");
    expect(text.length).toBeLessThan(12_000 + 1_000);
  });
});

describe("inPersonsCase", () => {
  it("starts_lower_case_when_the_person_mostly_does_and_keeps_it_otherwise", () => {
    const casual = [user("u1", "почини тесты"), user("u2", "[картинка 1] а че нет"), user("u3", "Глянь лог")];
    expect(inPersonsCase("Да, сделай", casual)).toBe("да, сделай");
    const formal = [user("u1", "Почини тесты"), user("u2", "Глянь лог"), user("u3", "ок")];
    expect(inPersonsCase("Да, сделай", formal)).toBe("Да, сделай");
    expect(inPersonsCase("Да", [])).toBe("Да");
  });
});

describe("withStyleExamples", () => {
  it("puts_the_examples_before_the_conversation_and_leaves_it_alone_without_them", () => {
    expect(withStyleExamples("<conversation>…</conversation>", "<style_examples>…</style_examples>")).toBe("<style_examples>…</style_examples>\n<conversation>…</conversation>");
    expect(withStyleExamples("<conversation>…</conversation>", undefined)).toBe("<conversation>…</conversation>");
  });
});
