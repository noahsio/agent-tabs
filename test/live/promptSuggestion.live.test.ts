import { sourceEnv } from "./config";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Block } from "../../src/chat/model";
import { recentConversation } from "../../src/chat/suggestion";
import { generateSuggestion } from "../../src/settings/gateway";
import { envPaths } from "../../src/settings/paths";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";

/** The real gateways of the source environment (read only): after a reply that offers a next step, a short next message. */
describe.runIf(LIVE)("next-message guess (live gateway)", () => {
  it("a_reply_that_offers_a_step_gets_a_short_message_from_the_person_not_the_agent", async () => {
    const agentDir = sourceEnv.agentDir;
    const paths = envPaths({ env: { OMO_CODING_AGENT_DIR: agentDir }, agentDir, omoPath: "/unused", secrets: [] }, homedir());
    const blocks: Block[] = [
      { kind: "user", id: "u1", text: "почини падающие тесты в auth модуле" },
      { kind: "assistant", id: "a1", text: "Починил: токен истекал из-за часового пояса. Все 48 тестов зелёные. Закоммитить и запушить?", thinking: "", streaming: false },
    ];
    const suggestion = await generateSuggestion(paths, recentConversation(blocks) as string);
    expect(suggestion).toBeDefined();
    expect(suggestion).not.toMatch(/\n/);
    expect((suggestion as string).split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(suggestion).toMatch(/[а-яё]/i); // the person's language
  }, 60_000);
});
