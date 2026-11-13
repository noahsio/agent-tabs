import { liveModel, modelsSource, readLiveKey } from "./config";
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const ROOT = "/tmp/agent-tabs-superpowers-live";
const AGENT_DIR = join(ROOT, "agent");
const PROJECT = join(ROOT, "proj");
const LOG = join(ROOT, "requests.jsonl");
/** The session model people use (haiku builds the app even with the bootstrap in front of it: 1 of 4 runs loaded the skill). */
const MODEL = liveModel("AUTO_");
/** The environment's own settings (its skills and its superpowers package), so the scratch host loads what tabs load. */
const SOURCE_SETTINGS = process.env["AGENT_TABS_LIVE_SETTINGS_JSON"] ?? join(homedir(), ".omo/agent/settings.json");

/** Writes, for every provider request, whether the superpowers bootstrap and OmO's clause against skills are in it. */
const RECORDER = `
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_provider_request", (event) => {
    const text = JSON.stringify(event);
    appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({
      bootstrap: text.includes("superpowers:using-superpowers bootstrap for pi"),
      againstSkills: text.includes("mere availability is not a reason"),
    }) + "\\n");
  });
}
`;

async function until(done: () => boolean, ticks: number): Promise<boolean> {
  for (let tick = 0; tick < ticks && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 100));
  return done();
}

/**
 * Measured live (omo 5.1.64): the superpowers pi extension used to add its using-superpowers bootstrap only
 * until the first agent_end, so a tab's session saw it on its first message and never again — in 3 of 23 provider
 * calls — and superpowers' own acceptance test, «Let's make a react todo list», sent as the second message made opus
 * build the app at once (2 of 2 runs). The bootstrap must be in every request, and that message must load brainstorming
 * and write no code (with the fix: 2 of 2).
 */
describe.skipIf(!LIVE)("superpowers on every message of a tab's session (live omo, scratch agent dir)", () => {
  let manager: DaemonManager;

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(join(AGENT_DIR, "extensions"), { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await mkdir(join(PROJECT, ".omo"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT, stdio: "ignore" });
    await copyFile(modelsSource, join(AGENT_DIR, "models.json"));
    const settings = JSON.parse(await readFile(SOURCE_SETTINGS, "utf8")) as Record<string, unknown>;
    await writeFile(join(AGENT_DIR, "settings.json"), JSON.stringify({ ...settings, defaultProvider: MODEL.provider, defaultModel: MODEL.id, permissionPreset: "full-access" }, null, 2));
    await writeFile(join(PROJECT, ".omo", "omo.jsonc"), JSON.stringify({ model_profile: `${MODEL.provider}/${MODEL.id}`, telemetry: { enabled: false } }));
    await writeFile(join(AGENT_DIR, "extensions", "recorder.ts"), RECORDER);
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "OMO_MEMORY_HOME", value: join(ROOT, "memory") },
        { name: "CLAUDE_CONFIG_DIR", value: join(homedir(), ".claude") },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
  }, 60_000);

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(AGENT_DIR);
  }, 30_000);

  it("the_bootstrap_is_in_every_request_and_the_second_message_loads_brainstorming_first", async () => {
    const tab = await SessionController.create(manager, PROJECT);
    await tab.setModel(MODEL);
    expect(await tab.send("Reply with exactly: one", "auto")).toBe(true);
    expect(await until(() => tab.state.blocks.some((block) => block.kind === "assistant") && !tab.state.running, 1200)).toBe(true);

    expect(await tab.send("Let's make a react todo list", "auto")).toBe(true);
    const sessionPath = tab.tabState.sessionPath as string;
    const packageJson = join(PROJECT, "package.json");
    const built = (): Promise<boolean> => access(packageJson).then(() => true, () => false);
    const loaded = async (): Promise<boolean> => {
      const journal = await readFile(sessionPath, "utf8");
      const second = journal.indexOf("react todo list");
      return second >= 0 && journal.indexOf("brainstorming/SKILL.md", second) >= 0;
    };
    let skill = false;
    let code = false;
    for (let tick = 0; tick < 480 && !skill && !code; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      [skill, code] = [await loaded(), await built()];
    }
    if (tab.state.running) await tab.stop(); // a question waiting for the person, or a build under way: either way decided
    await tab.release();
    code = code || (await built());

    const requests = (await readFile(LOG, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { bootstrap: boolean; againstSkills: boolean });
    expect(requests.length).toBeGreaterThan(3);
    expect(requests.map((request) => request.bootstrap)).toEqual(requests.map(() => true));
    expect(requests.some((request) => request.againstSkills)).toBe(false);
    expect({ skill, code }).toEqual({ skill: true, code: false });
  }, 600_000);
});
