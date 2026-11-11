import { sourceEnv } from "./config";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { normalizeSessionName } from "../../src/chat/model";
import { generateTitle } from "../../src/settings/gateway";
import { envPaths } from "../../src/settings/paths";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";

/** The real gateways of the source environment (read only): the first message gets a short topic title. */
describe.runIf(LIVE)("session title (live gateway)", () => {
  it("the_first_message_gets_a_topic_title_not_its_own_words", async () => {
    const agentDir = sourceEnv.agentDir;
    const paths = envPaths({ env: { OMO_CODING_AGENT_DIR: agentDir }, agentDir, omoPath: "/unused", secrets: [] }, homedir());
    const first = "как поднять nginx реверс прокси на два сайта на одном серваке? ответь одним предложением";
    const title = await generateTitle(paths, first);
    expect(title).toBeDefined();
    expect(normalizeSessionName(title as string)).not.toBe(normalizeSessionName(first));
    expect((title as string).split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(title).not.toMatch(/\n/);
  }, 60_000);
});
