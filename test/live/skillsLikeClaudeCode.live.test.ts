import { liveModel, modelsSource, readLiveKey } from "./config";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installSkillsExtension } from "../../kit/guard/lifecycle.mjs";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const ROOT = process.env["AGENT_TABS_LIVE_ROOT"] ?? "/tmp/agent-tabs-skills-live";
const AGENT_DIR = join(ROOT, "agent");
const PROJECT = join(ROOT, "proj");
const LOG = join(ROOT, "requests.jsonl");
const CLAUDE_DIR = join(homedir(), ".claude");
/** The session model people use (haiku is a poor judge here: it skipped a matching skill in 3 of 4 runs). */
const MODEL = liveModel("AUTO_");
/** The environment's own settings: its packages (superpowers as the person has it), none of its `skills` entries. */
const SOURCE_SETTINGS = process.env["AGENT_TABS_LIVE_SETTINGS_JSON"] ?? join(homedir(), ".omo/agent/settings.json");
/** Package dirs to use instead of the environment's (a copy of superpowers at an older version, say), comma-separated. */
const PACKAGES = process.env["AGENT_TABS_LIVE_PACKAGES"];
/** A skill of the person's own, in `<claudeDir>/skills`, that no settings entry names. */
const PERSONAL = process.env["AGENT_TABS_LIVE_PERSONAL_SKILL"] ?? "my-writing-style";

/** Writes, for every provider request, whether OmO's clause against skills and the personal skill are in it. */
const RECORDER = `
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_provider_request", (event) => {
    const text = JSON.stringify(event);
    appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({
      againstSkills: text.includes("mere availability is not a reason"),
      personal: text.includes(${JSON.stringify(PERSONAL)}),
    }) + "\\n");
  });
}
`;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until the journal after `message` names a file matching `skillFile` (true) or `gaveUp()` holds. */
async function readBefore(tab: SessionController, message: string, skillFile: RegExp, gaveUp: () => Promise<boolean>): Promise<boolean> {
  expect(await tab.send(message, "auto")).toBe(true);
  const sessionPath = tab.tabState.sessionPath as string;
  for (let tick = 0; tick < 480; tick++) {
    await sleep(500);
    const journal = await readFile(sessionPath, "utf8");
    const at = journal.indexOf(message.slice(0, 40)); // the message itself: later copies (a title, a summary) come after it
    if (at >= 0 && skillFile.test(journal.slice(at))) return true;
    if (await gaveUp()) return false;
  }
  return false;
}

/**
 * Measured live (omo 5.1.64): OmO's skill catalog tells the model «keyword overlap or mere availability is not a reason»,
 * and Agent Tabs gave OmO only the Claude skills switched on one by one. Skills went unused: with superpowers as it
 * ships, «Let's make a react todo list» sent as a tab's second message made opus write code with no skill read in 1
 * of 2 runs, and the person's own skills were not there at all. The Agent Tabs skills extension, and nothing in the
 * skills themselves, must give OmO every Claude skill and Claude Code's rule for using them: a skill read before code.
 */
describe.skipIf(!LIVE)("skills as in Claude Code, from the Agent Tabs extension alone (live omo, scratch agent dir)", () => {
  let manager: DaemonManager;

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(join(AGENT_DIR, "extensions"), { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await mkdir(join(PROJECT, ".omo"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT, stdio: "ignore" });
    await copyFile(modelsSource, join(AGENT_DIR, "models.json"));
    const settings = JSON.parse(await readFile(SOURCE_SETTINGS, "utf8")) as Record<string, unknown>;
    const packages = PACKAGES !== undefined ? PACKAGES.split(",") : settings["packages"];
    await writeFile(join(AGENT_DIR, "settings.json"), JSON.stringify({ ...settings, skills: [], packages, defaultProvider: MODEL.provider, defaultModel: MODEL.id, permissionPreset: "full-access" }, null, 2));
    await writeFile(join(PROJECT, ".omo", "omo.jsonc"), JSON.stringify({ model_profile: `${MODEL.provider}/${MODEL.id}`, telemetry: { enabled: false } }));
    await writeFile(join(AGENT_DIR, "extensions", "recorder.ts"), RECORDER);
    installSkillsExtension({ agentDir: AGENT_DIR, home: ROOT, claudeDir: CLAUDE_DIR }, join(process.cwd(), "kit/guard"));
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "OMO_MEMORY_HOME", value: join(ROOT, "memory") },
        { name: "CLAUDE_CONFIG_DIR", value: CLAUDE_DIR },
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

  it("a_second_message_reads_a_skill_before_it_writes_code", async () => {
    const tab = await SessionController.create(manager, PROJECT);
    await tab.setModel(MODEL);
    expect(await tab.send("Reply with exactly: one", "auto")).toBe(true);
    for (let tick = 0; tick < 1200 && !(tab.state.blocks.some((block) => block.kind === "assistant") && !tab.state.running); tick++) await sleep(100);
    const message = "Let's make a react todo list";
    const wrote = async (): Promise<boolean> => {
      const journal = await readFile(tab.tabState.sessionPath as string, "utf8");
      const at = journal.indexOf(message);
      return at >= 0 && /"name":"(write|edit)"/.test(journal.slice(at));
    };
    const skill = await readBefore(tab, message, /\/SKILL\.md/, wrote);
    if (tab.state.running) await tab.stop(); // a question waiting for the person, or a build: either way decided
    await tab.release();
    expect(skill).toBe(true);
  }, 600_000);

  it("the_persons_own_skill_is_there_and_is_read_when_it_applies", async () => {
    const tab = await SessionController.create(manager, PROJECT);
    await tab.setModel(MODEL);
    const replied = (): Promise<boolean> => Promise.resolve(!tab.state.running && tab.state.blocks.some((block) => block.kind === "assistant" && block.text.trim() !== ""));
    const skill = await readBefore(tab, "Напиши от моего имени короткое сообщение другу Саше, что я опоздаю на встречу минут на пятнадцать.", new RegExp(`${PERSONAL}/SKILL\\.md`), replied);
    if (tab.state.running) await tab.stop();
    await tab.release();
    const requests = (await readFile(LOG, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { againstSkills: boolean; personal: boolean });
    expect(requests.some((request) => request.againstSkills)).toBe(false);
    expect(requests.every((request) => request.personal)).toBe(true);
    expect(skill).toBe(true);
  }, 600_000);
});
