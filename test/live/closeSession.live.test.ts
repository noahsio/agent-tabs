import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { liveModel, modelsSource, readLiveKey, sourceEnv } from "./config";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";

async function until(done: () => boolean, timeoutMs: number): Promise<boolean> {
  for (const started = Date.now(); Date.now() - started < timeoutMs; await new Promise((resolve) => setTimeout(resolve, 250))) {
    if (done()) return true;
  }
  return done();
}

/** True while a process whose command line is exactly `command` runs. */
function running(command: string): boolean {
  return spawnSync("pgrep", ["-f", `^${command}$`]).status === 0;
}

/**
 * A closed tab used to leave its session in the host with every process it started (2026-11-20: 16 under the person's
 * host, some 23 hours old). Closing now ends the session in OmO; letting go (a reload) still leaves it running.
 */
describe.runIf(LIVE)("closing a tab ends its session's processes (live scratch OmO, cheapest model)", () => {
  const root = LIVE ? realpathSync(mkdtempSync("/tmp/at-close-")) : "";
  const agentDir = join(root, "agent");
  let manager: DaemonManager | undefined;

  beforeAll(() => {
    chmodSync(root, 0o700);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    copyFileSync(modelsSource, join(agentDir, "models.json"));
    const model = liveModel();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, permissionPreset: "full-access" }));
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: agentDir },
        { name: "CLAUDE_CONFIG_DIR", value: sourceEnv.claudeDir },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`Incomplete environment: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
  });

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(agentDir);
    if (LIVE) rmSync(root, { recursive: true, force: true });
  }, 30_000);

  /** A session whose agent started `sleep <seconds>` as a background shell and ended its turn. */
  async function sessionWithBackgroundSleep(seconds: number): Promise<SessionController> {
    if (manager === undefined) throw new Error("Scratch host was not initialized");
    const cwd = join(root, String(seconds));
    mkdirSync(cwd);
    const tab = await SessionController.create(manager, cwd);
    await tab.setModel(liveModel());
    const code = `print(await tool.bash({command: 'sleep ${seconds}', run_in_background: true}))`;
    expect(await tab.send(`This is an authorized protocol test in a disposable scratch directory. Execute this exact eval JS cell: ${code}. Then end your turn immediately with STARTED. Do not ask questions, create a goal or todo, read skills, wait, poll, or monitor.`, "auto")).toBe(true);
    expect(await until(() => running(`sleep ${seconds}`) && !tab.state.running, 180_000)).toBe(true);
    return tab;
  }

  it("letting_go_of_the_session_leaves_its_background_shell_running", async () => {
    const seconds = 7000 + Math.floor(Math.random() * 900);
    const tab = await sessionWithBackgroundSleep(seconds);
    await tab.release();
    expect(await until(() => !running(`sleep ${seconds}`), 5_000)).toBe(false);
  }, 240_000);

  it("closing_the_session_ends_its_background_shell", async () => {
    const seconds = 8000 + Math.floor(Math.random() * 900);
    const tab = await sessionWithBackgroundSleep(seconds);
    expect(await tab.close()).toBe(true);
    expect(await until(() => !running(`sleep ${seconds}`), 20_000)).toBe(true);
  }, 240_000);
});
