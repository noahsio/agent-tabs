import { modelsSource, readLiveKey } from "./config";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv, type OmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

/**
 * Whose abort is it? The person's journal shows turns ending `abortSource: "system"`, and the ladder sends an RPC
 * `abort` before every step, so the question is what label OmO 5.1.59 puts on an abort that arrives over RPC.
 *
 * The binary answers it outright: the RPC dispatcher routes `abort` to `session.abort()` (or `session.stop()` for
 * `intent: "stop"`), both reach `_abortWithProvenance()`, which calls `_abortActiveAgentAndRetry("user")`; the
 * provenance keeps that source, `classifyTurnEnd` turns `abortSource: "user"` into `endedBy: "user-abort"`, and
 * `abortSourceOf` maps only `system-abort`→`"system"` and `provider-abort`→`"provider"`, leaving a user abort with
 * no `abortSource` on the liveness row at all. The three callers that pass `"system"` are OmO's own: the deadline
 * tracker (`abortTurnForDeadline`), compaction, and the in-process extension API `abort("system")`.
 *
 * This test is that claim against a real host. Run it with `AGENT_TABS_LIVE=1`.
 */
const LIVE = process.env["AGENT_TABS_LIVE"] === "1";

const SCRATCH_ROOT = "/tmp/agent-tabs-abort-live";
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const MEMORY_DIR = join(SCRATCH_ROOT, "memory");
const CLAUDE_DIR = join(SCRATCH_ROOT, "claude");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const MODELS_SOURCE = modelsSource;
const OMO_PATH = join(homedir(), ".local/bin/omo");

/** Every `turn-end-liveness` row this scratch session wrote, oldest first. */
async function livenessRows(sessionPath: string): Promise<Record<string, any>[]> {
  const text = await readFile(sessionPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.includes("turn-end-liveness"))
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((entry) => entry["customType"] === "turn-end-liveness");
}

async function sessionFile(): Promise<string> {
  const root = join(AGENT_DIR, "sessions");
  for (const dir of await readdir(root)) {
    const files = (await readdir(join(root, dir))).filter((name) => name.endsWith(".jsonl"));
    if (files.length > 0) return join(root, dir, files.sort().at(-1) as string);
  }
  throw new Error("no scratch session file");
}

describe.skipIf(!LIVE)("whose abort is it (live omo, scratch agent dir)", () => {
  let omoEnv: OmoEnv;
  let manager: DaemonManager;
  let controller: SessionController | undefined;

  beforeAll(async () => {
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    for (const dir of [MEMORY_DIR, CLAUDE_DIR, PROJECT_DIR]) await mkdir(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(MODELS_SOURCE, join(AGENT_DIR, "models.json"));
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

  it("an_abort_that_arrives_over_rpc_is_never_labelled_system", async () => {
    controller = await SessionController.create(manager, PROJECT_DIR);
    // a turn long enough to still be running when the abort lands
    void controller.send("Посчитай вслух от 1 до 400, по одному числу в строке.", "auto");
    for (let tick = 0; tick < 150 && !controller.state.running; tick++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(controller.state.running).toBe(true);

    await controller.stop(); // the same RPC `abort` every one of our paths sends
    for (let tick = 0; tick < 150 && controller.state.running; tick++) await new Promise((resolve) => setTimeout(resolve, 100));

    const path = await sessionFile();
    const entries = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, any>);

    // 1. the message our abort ended: aborted, and carrying no `abortSource` of any kind
    const abortedMessages = entries.flatMap((entry) => {
      const message = entry["message"];
      return message?.role === "assistant" && message.stopReason === "aborted" ? [message as Record<string, any>] : [];
    });
    expect(abortedMessages.length).toBeGreaterThan(0);
    for (const message of abortedMessages) expect(message["abortSource"]).toBeUndefined();

    // 2. OmO's own verdict on the turn: the person's abort, which is what an RPC abort is
    const endedBy = entries.flatMap((entry) => (entry["data"]?.lastTurnEnd?.endedBy !== undefined ? [entry["data"].lastTurnEnd.endedBy as string] : []));
    expect(endedBy).toContain("user-abort");
    expect(endedBy).not.toContain("system-abort");

    // 3. and no turn-end-liveness row calls it `system` — in fact an RPC abort writes no stall row at all,
    //    because `heldReason` answers "user-abort" before the stall rules are ever reached
    for (const row of await livenessRows(path)) expect(row["data"]?.verdict?.abortSource).not.toBe("system");
  }, 180_000);
});
