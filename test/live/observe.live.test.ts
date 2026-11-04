import { modelsSource } from "./config";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-live-observe"; // its own host
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");

describe.skipIf(!LIVE)("get_state observe across connections (live omo, scratch agent dir)", () => {
  const managers: DaemonManager[] = [];
  afterAll(async () => {
    for (const manager of managers) manager.dispose();
    await stopScratchHost(AGENT_DIR);
  }, 30_000);

  it("observe_works_for_a_session_attached_by_another_connection", async () => {
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await mkdir(PROJECT_DIR, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(modelsSource, join(AGENT_DIR, "models.json"));
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "GW_API_KEY", value: "not-a-real-token" },
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    const owner = new DaemonManager(built.value);
    const observer = new DaemonManager(built.value);
    managers.push(owner, observer);
    const controller = await SessionController.create(owner, PROJECT_DIR);
    const mine = await (await observer.client()).request<{ sessions: Record<string, unknown>[] }>("list_sessions", { observe: true });
    console.log("LIVE list_sessions:", JSON.stringify(mine.sessions.map((s) => ({ sessionId: s["sessionId"], cwd: s["cwd"], status: s["status"], attachments: s["attachments"] }))));
    const live = mine.sessions[0] as Record<string, unknown>;
    expect(live).toBeDefined();
    const observerClient = await observer.client();
    let outcome: string;
    try {
      const state = await observerClient.request<Record<string, unknown>>("get_state", { sessionId: live["sessionId"], observe: true });
      outcome = `OK keys=${Object.keys(state).length} isStreaming=${String(state["isStreaming"])} lifecycle=${JSON.stringify(state["lifecycle"])}`;
    } catch (error) {
      outcome = `ERROR ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log("LIVE get_state observe from other connection:", outcome);
    const attachments = (await observerClient.request<{ sessions: Record<string, unknown>[] }>("list_sessions", { observe: true })).sessions[0]?.["attachments"];
    console.log("LIVE attachments after observe:", attachments);
    expect(outcome.startsWith("OK")).toBe(true);
    await controller.release();
  }, 120_000);
});
