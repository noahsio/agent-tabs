import { modelsSource } from "./config";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-live-commands"; // its own host
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const SKILL = "probe-skill";

describe.skipIf(!LIVE)("get_commands skill rows (live omo, scratch agent dir)", () => {
  let manager: DaemonManager | undefined;
  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(AGENT_DIR); // only this scratch dir's own host
  }, 30_000);

  it("skill_rows_are_named_with_the_skill_prefix_and_dollar_syntax", async () => {
    await mkdir(join(AGENT_DIR, "skills", SKILL), { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await writeFile(join(AGENT_DIR, "skills", SKILL, "SKILL.md"), `---\nname: ${SKILL}\ndescription: Probe skill for the agent-tabs live test\n---\nSay hi.\n`);
    await mkdir(PROJECT_DIR, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(modelsSource, join(AGENT_DIR, "models.json"));
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "GW_API_KEY", value: "not-a-real-token" }, // no model is called
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
    const controller = await SessionController.create(manager, PROJECT_DIR);
    const rows = await controller.commands();
    const skills = rows.filter((row) => row.source === "skill");
    console.log(`LIVE get_commands: ${rows.length} rows, ${skills.length} skills; skill names (first 5): ${skills.slice(0, 5).map((row) => `${row.name} [${row.syntax}]`).join(", ")}`);
    expect(skills.find((row) => row.name.endsWith(SKILL))).toMatchObject({ name: `skill:${SKILL}`, syntax: "dollar" });
    expect(skills.every((row) => row.name.startsWith("skill:") && row.syntax === "dollar")).toBe(true);
    await controller.release();
  }, 120_000);
});
