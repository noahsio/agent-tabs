import { modelsSource, readLiveKey, sourceEnv } from "./config";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { writeFork } from "../../src/rewind/fork";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const HAIKU = { provider: "gw-anthropic", id: "claude-haiku-5-5" };
async function waitFor(controller: SessionController, done: (state: ChatState) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(controller.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out; error=${controller.state.error ?? "-"}`);
}

/**
 * What OmO itself leaves behind for an answered `ask_user_question`, measured rather than assumed: the journal entries,
 * the plumbing text of an answer (a chosen option and free words), and — the question the card's fork hangs on — what a
 * session truncated right before the answer does when it is opened again.
 */
describe.runIf(LIVE)("answered questions in OmO's own journal (live omo, scratch agent dir, haiku only)", () => {
  const root = LIVE ? realpathSync(mkdtempSync("/tmp/agent-tabs-live-answer-")) : "";
  const agentDir = join(root, "agent");
  const project = join(root, "proj");
  let manager: DaemonManager;

  beforeAll(() => {
    chmodSync(root, 0o700);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    copyFileSync(modelsSource, join(agentDir, "models.json"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: HAIKU.provider, defaultModel: HAIKU.id, permissionPreset: "full-access" }));
    mkdirSync(join(project, ".omo"), { recursive: true });
    writeFileSync(join(project, ".omo", "omo.jsonc"), JSON.stringify({ model_profile: `${HAIKU.provider}/${HAIKU.id}`, telemetry: { enabled: false } }));
    writeFileSync(join(project, ".gitignore"), ".omo/\n");
    const git = (...args: string[]): void =>
      void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@l", "-c", "commit.gpgsign=false", ...args], { cwd: project });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: agentDir },
        { name: "CLAUDE_CONFIG_DIR", value: sourceEnv.claudeDir },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
  }, 60_000);

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(agentDir);
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("live_an_answered_question_becomes_a_card_and_a_fork_from_it_is_never_re_asked", async () => {
    const source = await SessionController.create(manager, project, undefined, undefined);
    await source.setModel(HAIKU);
    expect(source.state.model).toEqual(HAIKU);

    const prompt = [
      "Call the ask_user_question tool once, right now, with exactly two questions and nothing else.",
      'First: header "Кэш", question "Как хранить кэш каталога?", three options with a description each: "TTL и запасной кэш", "Только на диске", "Без кэша".',
      'Second: header "Ключ", question "Какой ключ использовать?", two options with descriptions: "age", "gpg".',
      "Pass waitForAnswer: false. Do not reply with text, just make the call.",
    ].join(" ");
    expect(await source.send(prompt, "auto")).toBe(true);
    await waitFor(source, (state) => state.dialogs.length > 0, 180_000);
    const dialog = source.state.dialogs[0] as NonNullable<ChatState["dialogs"][number]>;
    console.log("LIVE question:", JSON.stringify(dialog).slice(0, 1500));
    const asked = (Array.isArray(dialog.questions) ? dialog.questions : []) as Record<string, unknown>[];
    expect(asked).toHaveLength(2);
    expect((asked[0]?.["options"] as Record<string, unknown>[]).every((option) => typeof option["description"] === "string")).toBe(true);

    // one question answered by picking an option, one in the person's own words: both shapes in one answer
    const ids = asked.map((question, index) => (typeof question["id"] === "string" ? question["id"] : `q${index + 1}`));
    const answers: Record<string, { selected: string[]; text?: string }> = {
      [ids[0] as string]: { selected: ["Только на диске"] },
      [ids[1] as string]: { selected: [], text: "не понимаю что это" },
    };
    expect(await source.answer(dialog.id, { answers })).toBe("applied");
    await waitFor(source, (state) => state.blocks.some((block) => block.kind === "user" && block.delivery === undefined && block.answer !== undefined), 240_000);

    const answered = source.state.blocks.find((block) => block.kind === "user" && block.answer !== undefined) as Extract<Block, { kind: "user" }>;
    console.log("LIVE answer text OmO wrote:", JSON.stringify(answered.text));
    console.log("LIVE card:", JSON.stringify(answered.answer));
    expect(answered.text).toContain("[Answer to question "); // OmO's own wording, which the card replaces
    const card = answered.answer as NonNullable<typeof answered.answer>;
    expect(card.questions[0]?.options?.find((option) => option.chosen)?.label).toBe("Только на диске");
    expect(card.questions[0]?.options?.every((option) => option.description !== undefined)).toBe(true);
    expect(card.questions[1]?.words).toBe("не понимаю что это");
    expect(card.forkFrom).toBe(source.state.blocks.find((block) => block.kind === "user")?.id); // the message that led to the question

    // why the card forks there: OmO settles the question before it writes the answer, so a session cut at the
    // answer still holds a question it considers answered — opening it asks nothing again
    const sessionPath = source.tabState.sessionPath as string;
    const { entries } = await source.journal();
    const answerEntry = entries.find((entry) => JSON.stringify(entry).includes("Answer to question")) as Record<string, unknown>;
    const forked = await writeFork(sessionPath, answerEntry["id"] as string);
    expect(forked.chain.some((entry) => entry["customType"] === "ask-user:settlement")).toBe(true);
    await source.release();

    const fork = await SessionController.attach(manager, forked.sessionPath, undefined, undefined, undefined);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    console.log("LIVE fork after open: dialogs", JSON.stringify(fork.state.dialogs), "running", fork.state.running);
    expect(fork.state.dialogs).toEqual([]);
    expect(fork.state.running).toBe(false);
    await fork.release();
  }, 600_000);
});
