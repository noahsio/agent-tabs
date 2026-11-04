import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEnv } from "../../kit/lib/envs.mjs";
import { writeHooksJson } from "../../kit/lib/hooks.mjs";
import {
  SUPERPOWERS_REF,
  codegraphState,
  globalInstructionsState,
  pinnedSuperpowersRef,
  setCodegraph,
  setGlobalInstructions,
  setSettingsEntry,
  SUPERPOWERS_PLUGIN,
  claudePluginState,
  defaultSuperpowersDir,
  isSuperpowersClone,
  setSuperpowers,
  superpowersClaudeDirs,
  superpowersPluginVersion,
  superpowersState,
  superpowersVersion,
  updateClaudePlugin,
  updateSuperpowers,
} from "../../kit/lib/tools.mjs";
// @ts-expect-error plain ESM without types
import { hookId, sourceKeyHash, trustedHash } from "../../kit/lib/trust.mjs";
import { cloneTo, makeBareRepo, makeFakeClaude, makeTmp, writeSuperpowersManifests } from "./helpers";

type Handler = { type: string; command: string };
type HooksConfig = { hooks: Record<string, Array<{ matcher?: string; hooks: Handler[] }>> };

let root: string;
let home: string;
let second: ReturnType<typeof resolveEnv>;
let system: ReturnType<typeof resolveEnv>;
let kitHooks: string;

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const hooksFile = (): string => path.join(second.agentDir, "hooks.json");
const stateFile = (): string => path.join(second.agentDir, "hooks-state.json");
const mcp = (): { mcpServers: Record<string, unknown> } => readJson(path.join(second.agentDir, "mcp.json"));
const hooks = (): HooksConfig => readJson(hooksFile());
const hookCommands = (): string[] => Object.values(hooks().hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((handler) => handler.command)));
const isKit = (command: string): boolean => command.includes(path.join(home, ".omo/kit") + path.sep);
/** Trust records of this hooks.json. */
const trustedCount = (): number =>
  Object.values(readJson<{ hooks: Record<string, { sourcePath: string }> }>(stateFile()).hooks).filter((record) => record.sourcePath === hooksFile()).length;
/** Handlers of the kit's own in hooks.json (the only ones that are ever trusted). */
const handlerCount = (): number => hookCommands().filter(isKit).length;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  root = makeTmp("omo-tools-");
  home = path.join(root, "home");
  second = resolveEnv("second", home);
  system = resolveEnv("system", home);
  kitHooks = path.join(home, ".omo/kit/abc123def456/hooks");
  fs.mkdirSync(kitHooks, { recursive: true });
  fs.writeFileSync(path.join(kitHooks, "codegraph-init.sh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(kitHooks, "codegraph-prompt.mjs"), "\n", { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("setCodegraph", () => {
  it("codegraph_on_adds_the_mcp_server_and_both_hooks_from_the_installed_kit_all_trusted", () => {
    const written = setCodegraph(second, true);
    expect(written.sort()).toEqual([path.join(second.agentDir, "mcp.json"), hooksFile(), stateFile()].sort());
    expect(mcp().mcpServers["codegraph"]).toEqual({ command: second.codegraph, args: ["serve", "--mcp"] });
    expect(Object.keys(hooks().hooks).sort()).toEqual(["SessionStart", "UserPromptSubmit"]);
    expect(hooks().hooks["SessionStart"]?.[0]?.hooks[0]?.command).toContain(path.join(kitHooks, "codegraph-init.sh"));
    expect(hooks().hooks["UserPromptSubmit"]?.[0]?.hooks[0]?.command).toContain(path.join(kitHooks, "codegraph-prompt.mjs"));
    expect(trustedCount()).toBe(2);
    expect(codegraphState(second)).toEqual({ on: true });
  });

  it("codegraph_on_twice_is_idempotent", () => {
    setCodegraph(second, true);
    expect(setCodegraph(second, true)).toEqual([]);
  });

  it("codegraph_off_removes_mcp_and_hooks_and_retrusts", () => {
    fs.mkdirSync(second.agentDir, { recursive: true });
    fs.writeFileSync(path.join(second.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    setCodegraph(second, true);
    // Another kit handler after codegraph in the same group, and a foreign one: removing codegraph moves the kit one.
    const config = hooks();
    const guard = { type: "command", command: `${path.join(home, ".omo/kit/abc123def456/guard/hook.mjs")}` };
    config.hooks["SessionStart"]?.[0]?.hooks.push(guard);
    config.hooks["SessionStart"]?.push({ matcher: "x", hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] });
    writeHooksJson(second.agentDir, config, { isOwn: isKit });
    expect(trustedCount()).toBe(3);

    setCodegraph(second, false);
    expect(mcp().mcpServers["codegraph"]).toBeUndefined();
    expect(mcp().mcpServers["other"]).toEqual({ command: "x" });
    expect(hookCommands()).not.toContainEqual(expect.stringContaining("codegraph"));
    expect(hooks().hooks["SessionStart"]).toEqual([{ hooks: [guard] }, { matcher: "x", hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] }]);
    expect(hooks().hooks["UserPromptSubmit"]).toBeUndefined();
    expect(trustedCount()).toBe(handlerCount());
    const previews = Object.values(readJson<{ hooks: Record<string, { commandPreview: string }> }>(stateFile()).hooks).map((record) => record.commandPreview);
    expect(previews).toEqual([guard.command]);
    expect(codegraphState(second)).toEqual({ on: false });
  });

  describe("a trust record follows its hook when CodeGraph moves it", () => {
    const FOREIGN = { type: "command", command: "/usr/local/bin/mine.sh" };
    type Record_ = { enabled: boolean; trustedHash: string; sourcePath: string; commandPreview: string };
    const state = (): Record<string, Record_> => readJson<{ hooks: Record<string, Record_> }>(stateFile()).hooks;
    const skh = (): string => sourceKeyHash("global", hooksFile());
    const ids = (): string[] =>
      Object.entries(hooks().hooks).flatMap(([event, groups]) => groups.flatMap((group, g) => group.hooks.map((_handler, h) => hookId(skh(), event, g, h) as string)));

    /** CodeGraph on, then a foreign SessionStart hook after its group that the person trusted in OmO (as OmO records it). */
    function trustForeignAfterCodegraph(): string {
      setCodegraph(second, true);
      const config = hooks();
      config.hooks["SessionStart"]?.push({ hooks: [FOREIGN] });
      fs.writeFileSync(hooksFile(), JSON.stringify(config));
      const id = hookId(skh(), "SessionStart", 1, 0) as string;
      const records = readJson<{ version: number; hooks: Record<string, unknown> }>(stateFile());
      records.hooks[id] = {
        enabled: true,
        trustedHash: trustedHash({ event: "SessionStart", handler: FOREIGN, matcher: undefined, skh: skh() }),
        scope: "global",
        sourcePath: hooksFile(),
        commandPreview: FOREIGN.command,
        updatedAt: "by-omo",
      };
      fs.writeFileSync(stateFile(), JSON.stringify(records));
      return id;
    }

    it("a_trusted_foreign_hook_after_the_codegraph_group_keeps_its_trust_through_off_and_on", () => {
      const before = trustForeignAfterCodegraph();
      const record = state()[before];
      setCodegraph(second, false);
      const moved = hookId(skh(), "SessionStart", 0, 0) as string;
      expect(hooks().hooks["SessionStart"]).toEqual([{ hooks: [FOREIGN] }]);
      expect(state()[moved]).toEqual(record);
      expect(state()[before]).toBeUndefined();
      setCodegraph(second, true);
      expect(hooks().hooks["SessionStart"]?.[0]).toEqual({ hooks: [FOREIGN] }); // CodeGraph comes back after it
      expect(state()[moved]).toEqual(record);
      expect(Object.keys(state()).sort()).toEqual(ids().sort()); // no orphan records
    });

    it("a_foreign_hook_whose_command_changed_is_not_trusted_and_its_old_record_goes", () => {
      const before = trustForeignAfterCodegraph();
      const config = hooks();
      (config.hooks["SessionStart"]?.[1]?.hooks[0] as Handler).command = "/usr/local/bin/planted.sh";
      fs.writeFileSync(hooksFile(), JSON.stringify(config));
      setCodegraph(second, false);
      expect(state()[hookId(skh(), "SessionStart", 0, 0) as string]).toBeUndefined();
      expect(state()[before]).toBeUndefined();
      expect(Object.values(state()).map((record) => record.commandPreview)).not.toContain("/usr/local/bin/planted.sh");
    });
  });

  it("codegraph_on_without_an_installed_kit_throws_and_writes_nothing", () => {
    fs.rmSync(path.join(home, ".omo/kit"), { recursive: true });
    expect(() => setCodegraph(second, true)).toThrow(/kit/);
    expect(fs.existsSync(second.agentDir)).toBe(false);
  });

  it("dry_run_reports_the_files_and_writes_nothing", () => {
    expect(setCodegraph(second, true, { dryRun: true })).toHaveLength(3);
    expect(fs.existsSync(second.agentDir)).toBe(false);
  });
});

describe("global instructions", () => {
  const claudeMd = (): string => path.join(second.claudeDir, "CLAUDE.md");
  const agentsMd = (): string => path.join(second.agentDir, "AGENTS.md");

  beforeEach(() => {
    fs.mkdirSync(second.claudeDir, { recursive: true });
    fs.writeFileSync(claudeMd(), "# rules\n");
  });

  it("global_instructions_follow_the_environments_claude_dir", () => {
    expect(globalInstructionsState(second)).toEqual({ on: false, path: claudeMd(), exists: true });
    setGlobalInstructions(second, true);
    expect(globalInstructionsState(second)).toEqual({ on: true, path: `${second.claudeDir}/CLAUDE.md`, exists: true });
    expect(fs.readlinkSync(agentsMd())).toBe(claudeMd());
    expect(fs.readFileSync(agentsMd(), "utf8")).toBe("# rules\n");
    expect(setGlobalInstructions(second, true)).toEqual([]);
  });

  it("off_removes_only_the_link", () => {
    setGlobalInstructions(second, true);
    expect(setGlobalInstructions(second, false)).toEqual([agentsMd()]);
    expect(fs.existsSync(agentsMd())).toBe(false);
    expect(fs.readFileSync(claudeMd(), "utf8")).toBe("# rules\n");
    expect(globalInstructionsState(second).on).toBe(false);
  });

  it("an_existing_agents_md_that_is_not_a_link_is_never_overwritten_or_removed", () => {
    fs.mkdirSync(second.agentDir, { recursive: true });
    fs.writeFileSync(agentsMd(), "mine\n");
    expect(() => setGlobalInstructions(second, true)).toThrow(expect.objectContaining({ code: "AGENTS_MD_NOT_A_LINK" }));
    setGlobalInstructions(second, false);
    expect(fs.readFileSync(agentsMd(), "utf8")).toBe("mine\n");
    expect(globalInstructionsState(second).on).toBe(false);
  });

  it("a_link_to_something_else_is_the_persons_own_and_left_alone", () => {
    const other = path.join(root, "old-claude/CLAUDE.md");
    fs.mkdirSync(second.agentDir, { recursive: true });
    fs.symlinkSync(other, agentsMd());
    expect(globalInstructionsState(second).on).toBe(false);
    expect(() => setGlobalInstructions(second, true)).toThrow(expect.objectContaining({ code: "AGENTS_MD_NOT_A_LINK" }));
    expect(setGlobalInstructions(second, false)).toEqual([]);
    expect(fs.readlinkSync(agentsMd())).toBe(other);
  });

  it("the_system_claude_dir_is_always_loaded_so_no_link_is_made", () => {
    expect(globalInstructionsState(system)).toEqual({ on: true, path: path.join(home, ".claude/CLAUDE.md"), exists: false, always: true });
    expect(setGlobalInstructions(system, true)).toEqual([]);
    expect(setGlobalInstructions(system, false)).toEqual([]);
    expect(fs.existsSync(path.join(system.agentDir, "AGENTS.md"))).toBe(false);
  });

  it("a_missing_claude_md_is_reported_and_the_link_still_made", () => {
    fs.rmSync(claudeMd());
    setGlobalInstructions(second, true);
    expect(globalInstructionsState(second)).toEqual({ on: true, path: claudeMd(), exists: false });
  });
});

describe("settings.json lists", () => {
  it("an_entry_is_added_once_and_removed_keeping_the_rest", () => {
    const settings = path.join(second.agentDir, "settings.json");
    fs.mkdirSync(second.agentDir, { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ theme: "dark", skills: ["/a"] }));
    expect(setSettingsEntry(second, "skills", "/b", true)).toEqual([settings]);
    expect(setSettingsEntry(second, "skills", "/b", true)).toEqual([]);
    expect(readJson<{ skills: string[]; theme: string }>(settings)).toEqual({ theme: "dark", skills: ["/a", "/b"] });
    setSettingsEntry(second, "skills", "/a", false);
    setSettingsEntry(second, "packages", "/p", true);
    expect(readJson(settings)).toEqual({ theme: "dark", skills: ["/b"], packages: ["/p"] });
  });

  it("a_settings_file_of_the_wrong_shape_is_refused_unchanged", () => {
    const settings = path.join(second.agentDir, "settings.json");
    fs.mkdirSync(second.agentDir, { recursive: true });
    fs.writeFileSync(settings, '{"skills": "oops"}');
    expect(() => setSettingsEntry(second, "skills", "/b", true)).toThrow(/settings\.json/);
    expect(fs.readFileSync(settings, "utf8")).toBe('{"skills": "oops"}');
  });
});

describe("superpowers", () => {
  const settingsOf = (env: ReturnType<typeof resolveEnv>): string => path.join(env.agentDir, "settings.json");
  const writeSettings = (env: ReturnType<typeof resolveEnv>, value: unknown): void => {
    fs.mkdirSync(env.agentDir, { recursive: true });
    fs.writeFileSync(settingsOf(env), JSON.stringify(value));
  };
  const clone = (dir: string): { url: string; sha: string } => {
    const repo = makeBareRepo(root);
    cloneTo(repo.url, dir);
    return repo;
  };
  const claudeSettings = (claudeDir: string, enabledPlugins: Record<string, boolean>): void => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ model: "x", enabledPlugins }));
  };

  afterEach(() => {
    delete process.env["OMO_KIT_SUPERPOWERS_REF"];
    delete process.env["OMO_KIT_SUPERPOWERS_DIR"];
  });

  it("a_packages_entry_of_the_clone_is_the_on_state_in_any_spelling", () => {
    const dir = path.join(home, ".omo/superpowers");
    clone(dir);
    writeSettings(second, { packages: ["/other", dir] });
    expect(superpowersState(second)).toEqual({ mode: "package", dir });
    writeSettings(second, { packages: ["~/.omo/superpowers"] });
    expect(superpowersState(second)).toEqual({ mode: "package", dir });
  });

  it("a_skills_dir_or_bootstrap_entry_of_the_clone_is_the_legacy_state_even_next_to_the_package", () => {
    const dir = path.join(home, ".omo/superpowers");
    clone(dir);
    writeSettings(second, { skills: [path.join(dir, "skills"), "/other"] });
    expect(superpowersState(second)).toEqual({ mode: "skills", dir });
    writeSettings(second, { extensions: [path.join(dir, ".pi/extensions/superpowers.ts")] });
    expect(superpowersState(second)).toEqual({ mode: "skills", dir });
    writeSettings(second, { packages: [dir], skills: [path.join(dir, "skills")] });
    expect(superpowersState(second)).toEqual({ mode: "skills", dir });
  });

  it("without_an_entry_a_clone_in_a_known_place_is_found_and_off", () => {
    expect(superpowersState(second)).toEqual({ mode: "off", dir: null });
    const dir = path.join(home, ".omo/superpowers");
    clone(dir);
    expect(superpowersState(second)).toEqual({ mode: "off", dir });
    expect(defaultSuperpowersDir(home)).toBe(path.join(home, ".local/share/agent-tabs/superpowers"));
    process.env["OMO_KIT_SUPERPOWERS_DIR"] = path.join(root, "elsewhere");
    expect(defaultSuperpowersDir(home)).toBe(path.join(root, "elsewhere"));
  });

  it("a_skills_dir_of_another_marketplace_is_not_the_fork", () => {
    const dir = path.join(root, "upstream");
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    writeSuperpowersManifests(dir, "superpowers-dev");
    writeSettings(second, { skills: [path.join(dir, "skills")] });
    expect(isSuperpowersClone(dir)).toBe(false);
    expect(superpowersState(second)).toEqual({ mode: "off", dir: null });
  });

  it("on_adds_the_package_entry_and_migrates_the_legacy_skills_mode_off_removes_it_and_keeps_the_clone", () => {
    const dir = path.join(home, ".omo/superpowers");
    const extension = path.join(dir, ".pi/extensions/superpowers.ts");
    clone(dir);
    writeSettings(second, { theme: "dark", skills: [path.join(dir, "skills"), "/a"], extensions: ["/x.ts", extension], packages: ["/pkg"] });
    expect(setSuperpowers(second, dir, true)).toEqual([settingsOf(second)]);
    expect(readJson(settingsOf(second))).toEqual({ theme: "dark", skills: ["/a"], extensions: ["/x.ts"], packages: ["/pkg", dir] });
    expect(superpowersState(second)).toEqual({ mode: "package", dir });
    expect(setSuperpowers(second, dir, true)).toEqual([]);
    setSuperpowers(second, dir, false);
    expect(readJson(settingsOf(second))).toEqual({ theme: "dark", skills: ["/a"], extensions: ["/x.ts"], packages: ["/pkg"] });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
  });

  it("on_keeps_the_entry_where_the_person_put_it_and_drops_a_second_clones_entries", () => {
    const dir = path.join(home, ".omo/superpowers");
    const old = path.join(home, ".omo/packages/yasherisa-superpowers");
    cloneTo(clone(dir).url, old);
    writeSettings(second, { skills: ["/a", path.join(old, "skills")], extensions: [path.join(old, ".pi/extensions/superpowers.ts")], packages: [old, "~/.omo/superpowers", "/pkg"] });
    setSuperpowers(second, dir, true);
    expect(readJson(settingsOf(second))).toEqual({ skills: ["/a"], packages: ["~/.omo/superpowers", "/pkg"] });
  });

  it("the_plugin_version_and_short_sha_are_read_from_the_clone", async () => {
    const dir = path.join(home, ".local/share/agent-tabs/superpowers");
    const repo = clone(dir);
    expect(superpowersPluginVersion(dir)).toBe("6.3.1-test.1");
    expect(await superpowersVersion(dir)).toBe(repo.sha.slice(0, 7));
    expect(superpowersPluginVersion(path.join(root, "none"))).toBeUndefined();
    expect(await superpowersVersion(path.join(root, "none"))).toBeUndefined();
  });

  it("the_claude_plugin_state_comes_from_enabledPlugins", () => {
    const on = path.join(root, "claude-on");
    const off = path.join(root, "claude-off");
    claudeSettings(on, { [SUPERPOWERS_PLUGIN]: true, "superpowers@claude-plugins-official": false });
    claudeSettings(off, { [SUPERPOWERS_PLUGIN]: false });
    expect(claudePluginState(on)).toBe("on");
    expect(claudePluginState(off)).toBe("off");
    expect(claudePluginState(path.join(root, "claude-none"))).toBe("absent");
  });

  it("the_claude_dirs_are_every_kit_environments_once_plus_this_one", () => {
    expect(superpowersClaudeDirs(home, "/custom/claude")).toEqual(["/custom/claude", path.join(home, ".claude"), path.join(home, ".omo-second/claude")]);
    expect(superpowersClaudeDirs(home, path.join(home, ".claude"))).toEqual([path.join(home, ".claude"), path.join(home, ".omo-second/claude")]);
  });

  it("update_fetches_and_checks_out_the_pinned_ref_and_returns_its_short_sha", async () => {
    const dir = path.join(home, ".omo/superpowers");
    const repo = clone(dir);
    // A newer commit the installed clone has not fetched yet.
    const work = path.join(root, "sp-work");
    fs.writeFileSync(path.join(work, "skills", "NEW.md"), "y\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "next");
    const next = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", repo.url, "HEAD:main");

    expect(await superpowersVersion(dir)).toBe(repo.sha.slice(0, 7));
    expect(pinnedSuperpowersRef()).toBe(SUPERPOWERS_REF);
    process.env["OMO_KIT_SUPERPOWERS_REF"] = next; // the same override setup-omo honours
    expect(pinnedSuperpowersRef()).toBe(next);
    const short = await updateSuperpowers(dir);
    expect(short).toBe(next.slice(0, 7));
    expect(git(dir, "rev-parse", "HEAD")).toBe(next);
  });

  it("a_git_call_over_its_timeout_is_killed_and_reported_with_code_GIT_TIMEOUT", async () => {
    const dir = path.join(home, ".omo/superpowers");
    const repo = clone(dir);
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const stubDir = path.join(root, "stub-bin");
    fs.mkdirSync(stubDir);
    fs.writeFileSync(path.join(stubDir, "git"), `#!/bin/sh\nif [ "$1" = fetch ]; then exec sleep 30; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${stubDir}:${savedPath ?? ""}`;
    try {
      await expect(updateSuperpowers(dir, repo.sha, { timeoutMs: 500 })).rejects.toMatchObject({ code: "GIT_TIMEOUT", timeoutMs: 500 });
    } finally {
      process.env["PATH"] = savedPath;
    }
    expect(git(dir, "rev-parse", "HEAD")).toBe(repo.sha);
  });

  it("update_without_a_clone_throws", async () => {
    await expect(updateSuperpowers(path.join(root, "none"), "abc")).rejects.toThrow(/not installed/);
  });

  describe("updateClaudePlugin", () => {
    let savedPath: string | undefined;
    let log: string;
    const systemClaude = (): string => path.join(home, ".claude");
    const secondClaude = (): string => path.join(home, ".omo-second/claude");
    const calls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
    const withClaude = (options: { exitCode?: number; sleep?: number } = {}): void => {
      process.env["PATH"] = `${makeFakeClaude(path.join(root, "claude-bin"), log, options)}:${savedPath ?? ""}`;
    };

    beforeEach(() => {
      savedPath = process.env["PATH"];
      log = path.join(root, "claude.log");
      process.env["CLAUDE_CONFIG_DIR"] = "/inherited/claude";
    });
    afterEach(() => {
      process.env["PATH"] = savedPath;
      delete process.env["CLAUDE_CONFIG_DIR"];
    });

    it("each_env_with_the_plugin_installed_updates_its_marketplace_then_the_plugin_under_its_own_config_dir", async () => {
      claudeSettings(systemClaude(), { [SUPERPOWERS_PLUGIN]: true });
      claudeSettings(secondClaude(), { [SUPERPOWERS_PLUGIN]: false });
      const none = path.join(root, "claude-none");
      claudeSettings(none, {});
      withClaude();
      const results = await updateClaudePlugin([systemClaude(), secondClaude(), none], home);
      expect(results).toEqual([
        { claudeDir: systemClaude(), outcome: "updated" },
        { claudeDir: secondClaude(), outcome: "updated" },
      ]);
      expect(calls()).toEqual([
        // the system dir is Claude's default: no CLAUDE_CONFIG_DIR (an inherited one is dropped); stdin is closed
        "unset|plugin marketplace update yasherisa-superpowers|eof",
        `unset|plugin update ${SUPERPOWERS_PLUGIN}|eof`,
        `${secondClaude()}|plugin marketplace update yasherisa-superpowers|eof`,
        `${secondClaude()}|plugin update ${SUPERPOWERS_PLUGIN}|eof`,
      ]);
    });

    it("a_failing_claude_is_reported_per_env_and_the_plugin_update_is_not_run", async () => {
      claudeSettings(secondClaude(), { [SUPERPOWERS_PLUGIN]: true });
      withClaude({ exitCode: 3 });
      const [result] = await updateClaudePlugin([secondClaude()], home);
      expect(result).toMatchObject({ claudeDir: secondClaude(), outcome: "failed" });
      expect(result?.detail).toMatch(/boom/);
      expect(calls()).toHaveLength(1);
    });

    it("a_claude_over_its_timeout_is_killed_and_reported_failed", async () => {
      claudeSettings(secondClaude(), { [SUPERPOWERS_PLUGIN]: true });
      withClaude({ sleep: 30 });
      const started = Date.now();
      const [result] = await updateClaudePlugin([secondClaude()], home, { timeoutMs: 500 });
      expect(result).toMatchObject({ outcome: "failed", detail: expect.stringMatching(/timed out after 0\.5 s/) });
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("without_claude_on_PATH_the_installed_envs_are_skipped_with_a_note", async () => {
      claudeSettings(secondClaude(), { [SUPERPOWERS_PLUGIN]: true });
      process.env["PATH"] = path.join(root, "empty-bin");
      expect(await updateClaudePlugin([secondClaude(), systemClaude()], home)).toEqual([{ claudeDir: secondClaude(), outcome: "skipped", detail: "claude not found on PATH" }]);
    });
  });
});
