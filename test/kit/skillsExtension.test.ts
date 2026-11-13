import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkillsExtension } from "../../kit/guard/lifecycle.mjs";
import skillsExtension, { CLAUDE_RULE, HOLD_BACK, skillsToAdd, withClaudeRule } from "../../kit/guard/skills-extension.mjs";

let home: string;
let agentDir: string;
let claudeDir: string;

const skill = (name: string): string => {
  const folder = path.join(claudeDir, "skills", name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
  return folder;
};
const settings = (skills: string[]): void => fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ skills }));

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-ext-")));
  agentDir = path.join(home, ".omo/agent");
  claudeDir = path.join(home, ".claude");
  fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("the skills extension: Claude skills as Claude Code has them", () => {
  it("offers_every_claude_skill_but_one_switched_off_or_already_listed", () => {
    const listed = skill("listed");
    const off = skill("off");
    const mine = skill("my-writing-style");
    fs.mkdirSync(path.join(claudeDir, "skills", "synced", "bucket", "cloud-skill"), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "skills", "synced", "bucket", "cloud-skill", "SKILL.md"), "x\n"); // no SKILL.md at its top
    fs.mkdirSync(path.join(claudeDir, "skills", ".trash", "old"), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "skills", ".trash", "old", "SKILL.md"), "x\n");
    settings([listed, `-${off}`, "/elsewhere/skill"]);
    expect(skillsToAdd(claudeDir, agentDir)).toEqual([mine]);
  });

  it("knows_a_linked_skill_by_the_link_and_by_its_target", () => {
    const target = path.join(home, "repo", "chainium-agent");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "x\n");
    fs.mkdirSync(path.join(claudeDir, "skills"), { recursive: true });
    const link = path.join(claudeDir, "skills", "chainium-agent");
    fs.symlinkSync(target, link);
    expect(skillsToAdd(claudeDir, agentDir, [])).toEqual([link]);
    expect(skillsToAdd(claudeDir, agentDir, [target])).toEqual([]); // OmO loads it by its target: not twice
    expect(skillsToAdd(claudeDir, agentDir, [`-${target}`])).toEqual([]);
  });

  it("reads_tilde_and_agent_relative_entries_and_a_missing_settings_file", () => {
    const one = skill("one");
    expect(skillsToAdd(claudeDir, agentDir)).toEqual([one]);
    const relative = path.relative(agentDir, one);
    expect(skillsToAdd(claudeDir, agentDir, [relative])).toEqual([]);
    expect(skillsToAdd(path.join(home, "no-claude"), agentDir)).toEqual([]);
  });

  it("turns_omos_clause_against_skills_into_claude_codes_rule", () => {
    const catalog = `Use the read tool to load a skill's file when its description matches the task and its instructions would change the work; ${HOLD_BACK}`;
    expect(withClaudeRule(catalog)).toBe(`Use the read tool to load a skill's file when its description matches the task and its instructions would change the work; ${CLAUDE_RULE}`);
    expect(withClaudeRule("a prompt with no skill catalog")).toBeUndefined();
  });

  it("registers_discovery_and_the_rule_on_every_run", async () => {
    const one = skill("one");
    const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
    skillsExtension({ on: (event: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => void handlers.set(event, handler) }, { agentDir, claudeDir });
    expect([...handlers.keys()].sort()).toEqual(["before_agent_start", "resources_discover"]);
    expect(await handlers.get("resources_discover")?.({ type: "resources_discover" })).toEqual({ skillPaths: [one] });
    const run = handlers.get("before_agent_start");
    for (let turn = 0; turn < 3; turn++) {
      expect(await run?.({ type: "before_agent_start", systemPrompt: `x; ${HOLD_BACK}` })).toEqual({ systemPrompt: `x; ${CLAUDE_RULE}` });
    }
    expect(await run?.({ type: "before_agent_start", systemPrompt: "no catalog" })).toBeUndefined();
  });

  it("is_installed_as_a_loader_of_the_kit_copy_that_omo_can_import", async () => {
    const source = path.resolve("kit/guard");
    const loader = installSkillsExtension({ agentDir, home, claudeDir }, source);
    expect(loader).toBe(path.join(agentDir, "extensions", "agent-tabs-skills.ts"));
    const text = fs.readFileSync(loader, "utf8");
    const kitCopy = /import skills from "([^"]+)"/.exec(text)?.[1] as string;
    expect(kitCopy.startsWith(path.join(home, ".omo/kit"))).toBe(true);
    expect(text).toContain(JSON.stringify(claudeDir));
    const before = fs.statSync(loader).mtimeMs;
    installSkillsExtension({ agentDir, home, claudeDir }, source); // a second activation writes nothing
    expect(fs.statSync(loader).mtimeMs).toBe(before);
    expect(fs.existsSync(`${loader}.bak-agent-tabs`)).toBe(false);

    const one = skill("one");
    const installed = (await import(pathToFileURL(kitCopy).href)) as { skillsToAdd: typeof skillsToAdd };
    expect(installed.skillsToAdd(claudeDir, agentDir, [])).toEqual([one]);
  });
});
