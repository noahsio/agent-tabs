import { describe, expect, it } from "vitest";
import { untitledName, type Block } from "../../src/chat/model";

const user = (text: string, extra: Partial<Extract<Block, { kind: "user" }>> = {}): Block => ({ kind: "user", id: text, text, ...extra });

describe("untitledName", () => {
  it("is_the_first_message_with_words_as_a_name", () => {
    expect(untitledName([])).toBeUndefined();
    expect(untitledName([user("  "), user("Почини\n  вход"), user("второе")])).toBe("Почини вход");
    expect(untitledName([user("x".repeat(100))])).toBe("x".repeat(60));
  });

  it("skips_answer_cards", () => {
    expect(untitledName([user("[Answer to question t1]", { answer: { questionId: "t1", questions: [] } }), user("дальше")])).toBe("дальше");
  });
});
