import { modelsSource, readLiveKey, liveModel } from "./config";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv, type OmoEnv } from "../../src/env";
import { listPastSessions } from "../../src/sessions/history";
import { SessionController } from "../../src/sessions/controller";
import { hostHasEnvName, scratchHostPid, stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-live";
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const MEMORY_DIR = join(SCRATCH_ROOT, "memory");
const CLAUDE_DIR = join(SCRATCH_ROOT, "claude");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const OMO_PATH = join(homedir(), ".local/bin/omo");
const AUTO_MODEL = liveModel("AUTO_");
const MANUAL_MODEL = liveModel("MANUAL_");


async function waitFor(controller: SessionController, done: (state: ChatState) => boolean, timeoutMs: number): Promise<ChatState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(controller.state)) return controller.state;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out; last blocks: ${controller.state.blocks.map((block) => block.kind).join(",")} error=${controller.state.error ?? "-"}`);
}

function assistantText(state: ChatState): string {
  return state.blocks.map((block) => (block.kind === "assistant" ? block.text : "")).join("\n");
}

describe.skipIf(!LIVE)("agent-tabs end to end (live omo, scratch agent dir)", () => {
  let omoEnv: OmoEnv;
  let manager: DaemonManager;
  let controller: SessionController | undefined;

  beforeAll(async () => {
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await mkdir(MEMORY_DIR, { recursive: true });
    await mkdir(CLAUDE_DIR, { recursive: true });
    await mkdir(PROJECT_DIR, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(modelsSource, join(AGENT_DIR, "models.json"));
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "OMO_MEMORY_HOME", value: MEMORY_DIR },
        { name: "CLAUDE_CONFIG_DIR", value: CLAUDE_DIR },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      OMO_PATH,
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    omoEnv = built.value;
    manager = new DaemonManager(omoEnv);
  }, 60_000);

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(AGENT_DIR); // only the host this test's scratch dir recorded; never any other omo
  }, 30_000);

  it("runs_a_full_session_lifecycle", async () => {
    controller = await SessionController.create(manager, PROJECT_DIR);
    const hostPid = scratchHostPid(AGENT_DIR);
    expect(hostPid).toBeDefined();
    const hasClaudeConfigDir = hostHasEnvName(hostPid as number, "CLAUDE_CONFIG_DIR");
    console.log(`host env has CLAUDE_CONFIG_DIR: ${String(hasClaudeConfigDir)}`);
    expect(hasClaudeConfigDir).toBe(omoEnv.env["CLAUDE_CONFIG_DIR"] !== undefined);

    expect(await controller.send("Reply with exactly: PONG", "auto")).toBe(true);
    const ponged = await waitFor(controller, (state) => assistantText(state).includes("PONG") && !state.running, 120_000);
    expect(ponged.running).toBe(false);
    expect(ponged.blocks.filter((block) => block.kind === "user")).toHaveLength(1);

    // a dropped socket in the middle of a tool turn: reconnect, catch up from the journal, no duplicate user message
    const prompt = "Use the bash tool to run `sleep 10`, then reply with exactly: SLEPT";
    expect(await controller.send(prompt, "auto")).toBe(true);
    await waitFor(controller, (state) => state.blocks.some((block) => block.kind === "tool" && block.state === "running"), 120_000);
    (await manager.client()).close();
    const finished = await waitFor(controller, (state) => assistantText(state).includes("SLEPT") && !state.running, 180_000);
    expect(finished.blocks.filter((block) => block.kind === "user" && block.text === prompt)).toHaveLength(1);

    // manual model, then back to the profile's auto model
    await controller.setModel(MANUAL_MODEL);
    expect(controller.state.model).toEqual(MANUAL_MODEL);
    expect(controller.tabState.modelMode).toBe("manual");
    await controller.setModel("auto");
    expect(controller.state.model).toEqual(AUTO_MODEL);
    expect(controller.tabState.modelMode).toBe("auto");

    const past = await listPastSessions(AGENT_DIR, PROJECT_DIR);
    expect(past.map((session) => session.sessionPath)).toContain(controller.tabState.sessionPath);

    await controller.release();
  }, 600_000);
});
