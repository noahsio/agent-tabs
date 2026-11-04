import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { commandText, ENV_AGENT_DIRS, guardStateReason } from "../../kit/guard/protect.mjs";
import { ENV_NAMES, resolveEnv } from "../../kit/lib/envs.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-state-")));
const agentDir = path.join(home, ".omo", "agent");
const project = path.join(home, "work", "proj");
const where = { cwd: project, agentDir, home };
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const reasonOf = (tool: string, input: Record<string, unknown>, at = where): string | null => guardStateReason(commandText(tool, input), at);
const bash = (command: string) => reasonOf("bash", { command });
const evalJs = (code: string) => reasonOf("eval", { language: "js", code });

describe("guard state: paths, not words", () => {
  it("knows_the_agent_dir_of_every_environment", () => {
    const fromEnvs = new Set(ENV_NAMES.map((name: string) => path.relative(home, resolveEnv(name, home).agentDir)));
    expect(new Set(ENV_AGENT_DIRS)).toEqual(fromEnvs);
  });

  it("prose_about_the_guard_written_to_a_project_file_is_not_its_state", () => {
    // The user's case (card «guard + answers/used/cache/rules/key/watchers/pending»), paraphrased: an eval writes a spec.
    const spec = [
      "var draftSpec = `# Task Spec: decider cache",
      "",
      "The guard keeps its rules and a cache; every key has pending answers, watchers and used tickets.",
      "AC1: the guard never reuses a cached deny.`;",
      "fs.writeFileSync(root + '/.agent/tasks/guard-cache/spec.md', draftSpec);",
    ].join("\n");
    expect(evalJs(spec)).toBeNull();
    expect(bash('grep -rn "guard" src | grep -c rules && echo "cache key pending"')).toBeNull();
    expect(bash("cat kit/guard/rules.mjs kit/guard/decider.mjs")).toBeNull();
    expect(reasonOf("task", { prompt: "Review the guard: rules, cache, answers, the pending key" })).toBeNull();
  });

  it("the_guard_state_locations_are_for_the_person_only", () => {
    for (const command of [
      "cat ~/.omo/agent/guard/rules.json",
      "rm ~/.omo/agent/guard/answers.json",
      `cat ${agentDir}/guard/cache.json`,
      "cat $HOME/.omo/agent/guard/sandbox.sb",
      "node ~/.omo/kit/x/guard/guardctl.mjs answer abc allow-once",
      "guardctl pending",
      "cat ~/.omo-second/agent/guard/cache.json",
      "ls ~/.omo-second/agent/keys/",
      "echo '{}' > guard/pending.json",
      "nc -U /somewhere/agent/guard/admin.sock",
      "cat /x/guard/service.lock",
      "cat ~/.omo/agent/hooks.json",
    ]) expect([command, bash(command)]).toEqual([command, expect.any(String)]);
    for (const code of [
      "fs.writeFileSync(home+'/.omo/agent/guard/rules.json', '{}')",
      'fs.writeFileSync(path.join(os.homedir(), ".omo", "agent", "guard", "rules.json"), "{}")',
      "const dir = os.homedir() + '/.omo-second/agent' + '/guard'; fs.rmSync(dir + '/used.json')",
      "await fetch('http://x', { socketPath: base + '/guard/hook.sock' })",
    ]) expect([code, evalJs(code)]).toEqual([code, expect.any(String)]);
    expect(guardStateReason("ls", { ...where, cwd: path.join(agentDir, "guard") })).toEqual(expect.any(String));
  });
});
