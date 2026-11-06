import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { commandText, ENV_AGENT_DIRS, guardStateReason, protectedTarget } from "../../kit/guard/protect.mjs";
// @ts-expect-error plain ESM without types
import { isReadTool } from "../../kit/guard/classify.mjs";
import { ENV_NAMES, resolveEnv } from "../../kit/lib/envs.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-state-")));
const agentDir = path.join(home, ".omo", "agent");
const project = path.join(home, "work", "proj");
const where = { cwd: project, agentDir, home };
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const reasonOf = (tool: string, input: Record<string, unknown>, at = where): string | null =>
  guardStateReason(commandText(tool, input), at, isReadTool(tool.toLowerCase()));
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

  it("a_bash_call_written_as_argv_is_still_seen_touching_the_guard", () => {
    // P39 made `{program, args}` readable to the classifier. This check reads the call separately and falls back to
    // the whole input as JSON, which still carries the paths — so the protection must not regress if commandText is
    // ever tidied up. Every one of these has to name a reason.
    for (const input of [
      { program: "cat", args: [path.join(agentDir, "guard", "rules.json")] },
      { program: "rm", args: ["-rf", path.join(agentDir, "guard")] },
      { program: "tee", args: [path.join(agentDir, "hooks.json")] },
      { program: "nc", args: ["-U", path.join(agentDir, "guard", "admin.sock")] },
      { program: "bash", args: ["-c", `echo '{}' > ${path.join(agentDir, "guard", "rules.json")}`] },
    ]) expect([input, reasonOf("bash", input)]).toEqual([input, expect.any(String)]);
    expect(reasonOf("bash", { program: "curl", args: ["--version"] })).toBeNull();
  });
});

describe("guard state is the decision surface, not the whole tree (P40)", () => {
  const skill = path.join(home, ".omo", "binary-runtime", "5.1.59", "plugin", "skills", "coding-agent-sessions", "scripts", "find-agent-sessions.py");

  it("the_two_photographed_cards_are_ordinary_tooling", () => {
    // OmO ships this script inside its own versioned runtime and the person runs it to list sessions. It used to ask
    // only because the command names a path under the agent dir — the sessions it is pointed at.
    const command = `python3 -B ${skill} find --query zec-sweep --include-subagents --platform senpi --root ${path.join(agentDir, "projects")} --limit 8`;
    expect(reasonOf("monitor", { command })).toBeNull();
    expect(evalJs(`display(await tool.monitor({description:'Locate transcript', command:${JSON.stringify(command)}, timeout_ms:120000}));`)).toBeNull();
  });

  it.each([
    // The agent's own data under the agent dir: its transcripts, projects, memory, the runtime it was unpacked from.
    `ls ${path.join(agentDir, "sessions")}`,
    `cat ${path.join(agentDir, "sessions", "s1", "x.jsonl")}`,
    `grep -rn zec ${path.join(agentDir, "projects")}`,
    `rg --files ${path.join(home, ".omo", "binary-runtime", "5.1.59")}`,
    `wc -l ${path.join(agentDir, "memory", "MEMORY.md")}`,
    `python3 ${skill} find --query x`,
    `cd ${path.join(agentDir, "sessions")} && ls`,
    `tar -czf /tmp/t.tgz ${path.join(agentDir, "projects")}`,
  ])("the_agents_own_data_is_not_the_guards_state: %s", (command) => {
    expect(bash(command), command).toBeNull();
  });

  it.each([
    // The guard's own decision surface, whatever the tool: its state, its keys, its wiring, the kit it runs from.
    `cat ${path.join(agentDir, "guard", "rules.json")}`,
    `ls ${path.join(agentDir, "keys")}`,
    `cat ${path.join(agentDir, "keys", "gw.key")}`,
    `cat ${path.join(agentDir, "hooks.json")}`,
    `cat ${path.join(agentDir, "hooks-state.json")}`,
    // settings.json carries permissionPreset and models.json the provider keys: both decide what the agent may do
    `echo '{}' > ${path.join(agentDir, "settings.json")}`,
    `cat ${path.join(agentDir, "models.json")}`,
    `node ${path.join(home, ".omo", "kit", "abc", "guard", "service.mjs")}`,
    `rm -rf ${path.join(home, ".omo", "kit")}`,
    `cat ${path.join(home, ".omo", "omo.jsonc")}`,
    // the LaunchAgent that starts the service, and the launchctl calls that would stop it
    `cp /tmp/x.plist ${path.join(home, "Library", "LaunchAgents", "com.agent-tabs.guard.plist")}`,
    "launchctl bootout gui/501/com.agent-tabs.guard",
    "launchctl unload ~/Library/LaunchAgents/com.agent-tabs.guard.plist",
    "guardctl pending",
    "agent-guard answer abc allow-once",
  ])("the_decision_surface_still_asks: %s", (command) => {
    expect(bash(command), command).toEqual(expect.any(String));
  });

  it.each([
    // Answering its own request, reading the ticket it would need, or reaching the sockets that take answers.
    `cat ${path.join(agentDir, "guard", "pending.json")}`,
    `cat ${path.join(agentDir, "guard", "answers.json")}`,
    `cat ${path.join(agentDir, "guard", "used.json")}`,
    `nc -U ${path.join(agentDir, "guard", "admin.sock")}`,
    `node -e "require('net').createConnection('${path.join(agentDir, "guard", "hook.sock")}')"`,
    // Switching the guard off: its rules, its profile, its lock, the kit, the plist, the launchd job.
    `echo '{"version":2,"hardDeny":[]}' > ${path.join(agentDir, "guard", "rules.json")}`,
    `rm -f ${path.join(agentDir, "guard", "service.lock")}`,
    `cp /tmp/open.sb ${path.join(agentDir, "guard", "sandbox.sb")}`,
    `sed -i '' s/deny/allow/ ${path.join(home, ".omo", "kit", "abc", "guard", "classify.mjs")}`,
    `defaults write ${path.join(home, "Library", "LaunchAgents", "com.agent-tabs.guard.plist")} x 1`,
    "launchctl stop com.agent-tabs.guard",
    "launchctl kickstart -k gui/501/com.agent-tabs.guard",
    // Taking the credentials the decider authenticates with.
    `cat ${path.join(agentDir, "keys", "gw.key")}`,
    `cp -r ${path.join(agentDir, "keys")} /tmp/stolen`,
    // Re-pointing the hook wiring or the permission preset.
    `echo '{"hooks":{}}' > ${path.join(agentDir, "hooks.json")}`,
    `jq '.permissionPreset="full-access"' ${path.join(agentDir, "settings.json")}`,
  ])("nothing_that_could_disable_or_forge_a_decision_became_allowed: %s", (command) => {
    expect(bash(command), command).toEqual(expect.any(String));
  });

  it("running_inside_the_guard_or_keys_dir_still_asks_but_not_the_whole_agent_dir", () => {
    expect(guardStateReason("ls", { ...where, cwd: path.join(agentDir, "guard") })).toEqual(expect.any(String));
    expect(guardStateReason("ls", { ...where, cwd: path.join(agentDir, "keys") })).toEqual(expect.any(String));
    expect(guardStateReason("ls", { ...where, cwd: path.join(home, ".omo", "kit", "abc") })).toEqual(expect.any(String));
    expect(guardStateReason("ls", { ...where, cwd: path.join(agentDir, "sessions") })).toBeNull();
    expect(guardStateReason("ls", { ...where, cwd: agentDir })).toBeNull();
  });
});

describe("a read of the guard's own code/config/state is not guard-state (reads cannot disable or forge)", () => {
  // A typed read tool names a path and runs nothing; reading these files tampers with nothing, and writes to them are
  // hard-denied by the Seatbelt profile and protectedTarget. So listing/reading/grepping them no longer asks.
  it.each([
    ["ls", { path: path.join(home, ".omo", "kit") }],
    ["ls", { path: path.join(home, ".omo", "kit", "abc", "guard") }],
    ["read", { path: path.join(home, ".omo", "kit", "abc", "guard", "classify.mjs") }],
    ["grep", { pattern: "deny", path: path.join(home, ".omo", "kit") }],
    ["read", { path: path.join(home, ".omo", "omo.jsonc") }],
    ["read", { path: path.join(agentDir, "guard", "rules.json") }],
    ["read", { path: path.join(agentDir, "guard", "cache.json") }],
    ["read", { path: path.join(agentDir, "guard", "answers.json") }],
    ["read", { path: path.join(agentDir, "guard", "sandbox.sb") }],
    ["read", { path: path.join(agentDir, "hooks.json") }],
    ["read", { path: path.join(agentDir, "hooks-state.json") }],
    ["read", { path: path.join(agentDir, "settings.json") }],
    ["read", { path: path.join(agentDir, "models.json") }],
    ["ls", { path: path.join(home, "Library", "LaunchAgents") }],
    ["grep", { pattern: "x", path: path.join(agentDir, "guard") }],
  ])("read tool of a non-key guard file is allowed: %s %o", (tool, input) => {
    expect(reasonOf(tool, input as Record<string, unknown>)).toBeNull();
  });

  it.each([
    // The keys dir stays read-sensitive: a bare listing or read of it still asks.
    ["ls", { path: path.join(agentDir, "keys") }],
    ["read", { path: path.join(agentDir, "keys", "gw.key") }],
    ["grep", { pattern: "BEGIN", path: path.join(agentDir, "keys") }],
  ])("a read of the keys dir still asks: %s %o", (tool, input) => {
    expect(reasonOf(tool, input as Record<string, unknown>)).toEqual(expect.any(String));
  });

  it("running inside a guard dir asks even for a read tool", () => {
    // The cwd itself is the guard's surface — a relative path reaches the files without naming them.
    expect(guardStateReason("", { ...where, cwd: path.join(agentDir, "guard") }, true)).toEqual(expect.any(String));
    expect(guardStateReason("", { ...where, cwd: path.join(home, ".omo", "kit", "abc") }, true)).toEqual(expect.any(String));
  });

  it.each([
    // Writes/execs against the same files still ask, read tool or not: a write tool names a reason, and a bash/eval
    // command is never treated as a read (its intent is not cheaply decidable).
    `cat ${path.join(agentDir, "guard", "rules.json")}`,
    `echo '{}' > ${path.join(agentDir, "guard", "rules.json")}`,
    `cat ${path.join(home, ".omo", "omo.jsonc")}`,
    `sed -i '' s/deny/allow/ ${path.join(home, ".omo", "kit", "abc", "guard", "classify.mjs")}`,
    `cat ${path.join(agentDir, "hooks.json")}`,
    "guardctl pending",
    "launchctl bootout gui/501/com.agent-tabs.guard",
    "agent-guard answer abc allow-once",
  ])("a bash command naming the guard still asks: %s", (command) => {
    expect(bash(command), command).toEqual(expect.any(String));
  });

  it.each([
    // The read exemption never touches the write layer: a write tool's target under the kit, the guard dir or the
    // decision files is still hard-denied by protectedTarget (the Seatbelt profile refuses the syscall as well).
    path.join(home, ".omo", "kit", "abc", "guard", "classify.mjs"),
    path.join(home, ".omo", "omo.jsonc"),
    path.join(agentDir, "guard", "rules.json"),
    path.join(agentDir, "hooks.json"),
  ])("a write target under the guard surface is still hard-denied: %s", (target) => {
    expect(protectedTarget(target, where), target).toEqual(expect.any(String));
  });
});
