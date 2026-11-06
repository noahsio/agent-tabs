import { modelsSource, readLiveKey } from "./config";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv, type OmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-stopq-live";
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const MEMORY_DIR = join(SCRATCH_ROOT, "memory");
const CLAUDE_DIR = join(SCRATCH_ROOT, "claude");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const MODELS_SOURCE = modelsSource;
const OMO_PATH = join(homedir(), ".local/bin/omo");
const LONG_TURN = "Use the bash tool to run `sleep 20`, then reply with exactly: slept.";

async function until(done: () => boolean, ticks = 400): Promise<boolean> {
  for (let tick = 0; tick < ticks && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 100));
  return done();
}

function userBlock(state: ChatState, text: string): Extract<ChatState["blocks"][number], { kind: "user" }> | undefined {
  const block = state.blocks.find((candidate) => candidate.kind === "user" && candidate.text === text);
  return block?.kind === "user" ? block : undefined;
}

describe.skipIf(!LIVE)("Stop and the queue (live omo, scratch agent dir)", () => {
  let omoEnv: OmoEnv;
  let manager: DaemonManager;
  let controller: SessionController | undefined;

  beforeAll(async () => {
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    for (const dir of [MEMORY_DIR, CLAUDE_DIR, PROJECT_DIR]) await mkdir(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(MODELS_SOURCE, join(AGENT_DIR, "models.json"));
    await writeFile(join(AGENT_DIR, "settings.json"), JSON.stringify({ permissionPreset: "full-access" }, null, 2));
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
    await controller?.release();
    manager?.dispose();
    await stopScratchHost(AGENT_DIR);
  }, 30_000);

  it("stop_drains_the_queued_message_and_delivers_it_exactly_once", async () => {
    controller = await SessionController.create(manager, PROJECT_DIR);
    const tab = controller;
    expect(await tab.send(LONG_TURN, "auto")).toBe(true);
    expect(await until(() => tab.state.activity === "tool", 1200)).toBe(true);

    const queued = "Then reply with exactly: DRAINED";
    expect(await tab.send(queued, "followUp")).toBe(true);
    expect(await until(() => userBlock(tab.state, queued)?.delivery?.state === "queued", 150)).toBe(true);

    await tab.stop();

    // The fix: once the stopped turn ends, the tab takes the queued message out of OmO's queue and sends it as the
    // next turn. It must leave the queue (delivery clears), run, and appear exactly once — never a second copy.
    expect(await until(() => userBlock(tab.state, queued)?.delivery === undefined, 400)).toBe(true);
    expect(await until(() => tab.state.blocks.some((block) => block.kind === "assistant" && /DRAINED/.test(block.text)), 1200)).toBe(true);

    const rows = (await readFile(await sessionFile(), "utf8")).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, any>);
    const userSaidDrained = rows.filter((row) => row["type"] === "message" && row["message"]?.role === "user" && JSON.stringify(row["message"]?.content ?? "").includes("DRAINED"));
    expect(userSaidDrained).toHaveLength(1); // exactly once: the dequeued copy was removed before it could run
    // eslint-disable-next-line no-console
    console.log("[stopq] drained=ok, user 'DRAINED' messages in journal:", userSaidDrained.length);
  }, 300_000);

  async function sessionFile(): Promise<string> {
    const { readdir } = await import("node:fs/promises");
    const root = join(AGENT_DIR, "sessions");
    const found: string[] = [];
    for (const dir of await readdir(root)) {
      const files = (await readdir(join(root, dir)).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
      for (const file of files) found.push(join(root, dir, file));
    }
    const newest = found.sort().at(-1);
    if (newest === undefined) throw new Error("no scratch session file");
    return newest;
  }
});
