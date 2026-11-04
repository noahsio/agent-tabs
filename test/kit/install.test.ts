import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEnv } from "../../kit/lib/envs.mjs";
import { setCodegraph } from "../../kit/lib/tools.mjs";
// @ts-expect-error plain ESM without types
import { guardFilesDir, guardHookEntry, guardHookEvents, installGuardFiles, setGuardHook } from "../../kit/guard/install.mjs";
import { KIT, makeTmp } from "./helpers";

type Handler = { type: string; command: string; timeout?: number };
type Group = { matcher?: string; hooks: Handler[] };
type HooksConfig = { hooks: Record<string, Group[]> };

let root: string;
let home: string;
let env: ReturnType<typeof resolveEnv>;

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const hooksFile = (): string => path.join(env.agentDir, "hooks.json");
const stateFile = (): string => path.join(env.agentDir, "hooks-state.json");
const hooks = (): HooksConfig => readJson(hooksFile());
const allHandlers = (): Handler[] => Object.values(hooks().hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
const isKit = (command: string): boolean => command.includes(path.join(home, ".omo/kit") + path.sep);
const ourGroups = (event = "PreToolUse"): Group[] => (hooks().hooks[event] ?? []).filter((group) => group.hooks.some((handler) => handler.command.endsWith(`--agent-dir '${env.agentDir}'`)));
const codegraphHooks = (): Handler[] => allHandlers().filter((handler) => handler.command.includes("codegraph"));
const trustedCount = (): number =>
  Object.values(readJson<{ hooks: Record<string, { sourcePath: string }> }>(stateFile()).hooks).filter((record) => record.sourcePath === hooksFile()).length;
const handlerCount = (): number => allHandlers().filter((handler) => isKit(handler.command)).length;

beforeEach(() => {
  root = makeTmp("omo-guard-install-");
  home = path.join(root, "home");
  env = resolveEnv("second", home);
  const kitHooks = path.join(home, ".omo/kit/abc123def456/hooks");
  fs.mkdirSync(kitHooks, { recursive: true });
  fs.writeFileSync(path.join(kitHooks, "codegraph-init.sh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(kitHooks, "codegraph-prompt.mjs"), "\n", { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("installGuardFiles", () => {
  it("copies_the_guard_into_a_content_hashed_kit_dir", () => {
    const dir = installGuardFiles(home);
    expect(path.dirname(path.dirname(dir))).toBe(path.join(home, ".omo/kit"));
    expect(path.basename(dir)).toBe("guard");
    expect(path.basename(path.dirname(dir))).toMatch(/^[0-9a-f]{12}$/);
    const source = fs.readdirSync(path.join(KIT, "guard")).sort();
    expect(fs.readdirSync(dir).sort()).toEqual(source);
    for (const name of source) expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(fs.readFileSync(path.join(KIT, "guard", name), "utf8"));
    expect(installGuardFiles(home)).toBe(dir);
    // the extension bundle names the kit it ships instead of its own module URL
    expect(installGuardFiles(home, path.join(KIT, "guard"))).toBe(dir);
  });

  it("guard_files_dir_names_the_copy_without_writing", () => {
    const named = guardFilesDir(home, path.join(KIT, "guard"));
    expect(fs.existsSync(path.join(home, ".omo/kit", path.basename(path.dirname(named))))).toBe(false);
    expect(installGuardFiles(home, path.join(KIT, "guard"))).toBe(named);
  });
});

describe("guardHookEntry", () => {
  it("is_one_pre_tool_use_group_without_matcher_and_a_330_s_timeout", () => {
    const kitDir = installGuardFiles(home);
    const entry = guardHookEntry({ node: "/opt/node/bin/node", kitDir, agentDir: env.agentDir });
    expect(entry).toEqual({
      hooks: [{ type: "command", command: `'/opt/node/bin/node' '${path.join(kitDir, "hook.mjs")}' --agent-dir '${env.agentDir}'`, timeout: 330 }],
    });
  });
});

describe("setGuardHook", () => {
  let entry: Group;
  beforeEach(() => {
    entry = guardHookEntry({ node: "/opt/node/bin/node", kitDir: installGuardFiles(home), agentDir: env.agentDir });
  });

  it("set_guard_hook_adds_once_removes_cleanly_and_retrusts", () => {
    setCodegraph(env, true, { codegraph: "/opt/bin/codegraph" });
    setGuardHook(env, true, entry);
    setGuardHook(env, true, entry);
    expect(ourGroups()).toHaveLength(1);
    expect(ourGroups()[0]).toEqual(entry);
    // P31: the same group answers SessionStart (the sandbox note), after the CodeGraph one
    expect(ourGroups("SessionStart")).toEqual([entry]);
    expect(hooks().hooks["SessionStart"]!.at(-1)).toEqual(entry);
    expect(trustedCount()).toBe(handlerCount());
    expect(trustedCount()).toBe(4);
    setGuardHook(env, false, entry);
    expect(ourGroups()).toHaveLength(0);
    expect(ourGroups("SessionStart")).toHaveLength(0);
    expect(hooks().hooks["PreToolUse"]).toBeUndefined();
    expect(codegraphHooks()).toHaveLength(2);
    expect(trustedCount()).toBe(2);
  });

  it("guard_hook_events_reports_where_our_group_is", () => {
    expect(guardHookEvents(env)).toEqual([]);
    setGuardHook(env, true, entry);
    expect(guardHookEvents(env)).toEqual(["PreToolUse", "SessionStart"]);
    const config = hooks();
    delete config.hooks["SessionStart"];
    fs.writeFileSync(hooksFile(), JSON.stringify(config));
    expect(guardHookEvents(env)).toEqual(["PreToolUse"]);
  });

  it("other_hooks_stay_and_a_newer_kit_replaces_ours_in_place", () => {
    const foreign = { matcher: "bash", hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] };
    fs.mkdirSync(env.agentDir, { recursive: true });
    fs.writeFileSync(hooksFile(), JSON.stringify({ hooks: { PreToolUse: [foreign] } }));
    setGuardHook(env, true, entry);
    expect(hooks().hooks["PreToolUse"]).toEqual([foreign, entry]);

    const newer = guardHookEntry({ node: "/opt/node/bin/node", kitDir: path.join(home, ".omo/kit/fedcba987654/guard"), agentDir: env.agentDir });
    const after = { hooks: [{ type: "command", command: "/usr/local/bin/after.sh" }] };
    const config = hooks();
    config.hooks["PreToolUse"]!.push(after);
    fs.writeFileSync(hooksFile(), JSON.stringify(config));
    setGuardHook(env, true, newer);
    expect(hooks().hooks["PreToolUse"]).toEqual([foreign, newer, after]);
    const previews = Object.values(readJson<{ hooks: Record<string, { commandPreview: string }> }>(stateFile()).hooks).map((record) => record.commandPreview);
    expect(previews).toEqual([newer.hooks[0]!.command, newer.hooks[0]!.command]); // PreToolUse and SessionStart

    setGuardHook(env, false, newer);
    expect(hooks().hooks["PreToolUse"]).toEqual([foreign, after]);
  });

  it("off_without_a_hooks_file_writes_nothing", () => {
    expect(setGuardHook(env, false, entry)).toEqual([]);
    expect(fs.existsSync(hooksFile())).toBe(false);
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it("a_v1_agent_guard_handler_is_replaced", () => {
    const v1 = { matcher: "bash|eval|write|edit|apply_patch", hooks: [{ type: "command", command: `node ${path.join(home, ".omo/kit/111111111111/guard/agent-guard.mjs")} --agent-dir ${env.agentDir}`, timeout: 330 }] };
    fs.mkdirSync(env.agentDir, { recursive: true });
    fs.writeFileSync(hooksFile(), JSON.stringify({ hooks: { PreToolUse: [v1] } }));
    setGuardHook(env, true, entry);
    expect(hooks().hooks["PreToolUse"]).toEqual([entry]);
  });
});
