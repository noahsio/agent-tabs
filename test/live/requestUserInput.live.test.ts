import { modelsSource, readLiveKey, sourceEnv } from "./config";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const HAIKU = { provider: "gw-anthropic", id: "claude-haiku-5-5" };
async function waitFor(controller: SessionController, done: (state: ChatState) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(controller.state)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Measured live (omo 5.1.59, scratch agent dir, haiku only). The built-in question tool has two names for one builtin
 * (`request_user_input` / `ask_user_question`, settings.md) and two shapes that need opposite handling:
 *
 *   waitForAnswer:false → the tool returns at once ("Question accepted; the answer will arrive as a user message"), the
 *     turn ends, and OmO holds the session on waiting_human with an `ask-user` wait in waitingOn.background — a standing
 *     invitation. The tab must be IDLE: running=false, composer free, a typed message delivered (not queued).
 *   waitForAnswer:true  → the call blocks; waiting_human with the question in waitingOn.human and no background wait.
 *     The turn runs; the question is answered/declined from the dock; Stop must still escape it.
 */
describe.runIf(LIVE)("the two question shapes, end to end (live omo, haiku only)", () => {
  const root = LIVE ? realpathSync(mkdtempSync("/tmp/agent-tabs-live-rui-")) : "";
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

  const prompt = (wait: boolean): string =>
    `Call the ask_user_question tool once right now: question "Which color?", options "red" and "blue", waitForAnswer: ${wait}. No prose, no todo, only that call.`;

  it("live_a_non_blocking_question_leaves_the_tab_idle_and_a_typed_message_is_delivered", async () => {
    const source = await SessionController.create(manager, project, undefined, undefined);
    await source.setModel(HAIKU);
    expect(await source.send(prompt(false), "auto")).toBe(true);
    expect(await waitFor(source, (state) => state.dialogs.length > 0, 240_000)).toBe(true);

    // The question is tagged non-blocking and the tab settles to idle: the composer is free, not locked to a queue.
    const dialog = source.state.dialogs[0] as NonNullable<ChatState["dialogs"][number]>;
    expect(dialog.blocking).toBe(false);
    expect(await waitFor(source, (state) => state.running === false, 60_000)).toBe(true);

    // A plain message, sent while idle, is DELIVERED (a prompt that starts a turn) — not stranded in a queue that never
    // drains. Measured: pre-fix the same send went out as a steer and stuck at delivery:"queued"; now it lands as a real
    // user message (delivery cleared). Whether it also answers the standing question is OmO's to decide — the point is
    // the person is not trapped.
    expect(await source.send("green", "auto")).toBe(true);
    // Measured: the message lands as a plain delivered user block ("green", delivery cleared) — NOT stranded at
    // delivery:"queued" as it was pre-fix, when the idle tab still read as running and sent it as a steer the ended
    // turn never drained. OmO delivers it as an ordinary message; the standing question stays open for a real answer.
    const delivered = (state: ChatState): boolean =>
      state.blocks.some((block: Block) => block.kind === "user" && block.text === "green" && block.delivery === undefined);
    expect(await waitFor(source, delivered, 180_000)).toBe(true);
    expect(source.state.blocks.some((block: Block) => block.kind === "user" && block.delivery?.state === "queued")).toBe(false);
    await source.release();
  }, 600_000);

  it("live_a_blocking_question_runs_and_stop_escapes_it", async () => {
    const source = await SessionController.create(manager, project, undefined, undefined);
    await source.setModel(HAIKU);
    expect(await source.send(prompt(true), "auto")).toBe(true);
    expect(await waitFor(source, (state) => state.dialogs.length > 0, 240_000)).toBe(true);

    // A blocking question keeps the turn running; its dialog is not tagged non-blocking.
    const dialog = source.state.dialogs[0] as NonNullable<ChatState["dialogs"][number]>;
    expect(dialog.blocking).toBeUndefined();
    expect(source.state.running).toBe(true);

    // Stop cancels the question and aborts; the turn ends and the composer is usable again.
    await source.stop();
    expect(await waitFor(source, (state) => state.running === false && state.dialogs.length === 0, 60_000)).toBe(true);
    await source.release();
  }, 600_000);
});
