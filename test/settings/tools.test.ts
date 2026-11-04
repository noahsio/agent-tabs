import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEnv } from "../../kit/lib/envs.mjs";
import { SUPERPOWERS_REF } from "../../kit/lib/tools.mjs";
import { envPaths, type EnvPaths } from "../../src/settings/paths";
import { DEFAULT_HIDDEN_COMMANDS } from "../../src/settings/protocol";
import { FieldErrors, SettingsService } from "../../src/settings/service";
import { MASK, readHiddenCommands, ToolsHost, type ToolsAction, type ToolsView } from "../../src/settings/tools";
import { cloneTo, makeBareRepo, makeFakeClaude } from "../kit/helpers";

let home: string;
let paths: EnvPaths;
let host: ToolsHost;
let secrets: string[];
let shown: string[];
let hiddenLists: string[][];
let logged: string[];

const readJson = <T = Record<string, any>>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const settingsFile = (): string => path.join(paths.agentDir, "settings.json");
const view = async (): Promise<ToolsView> => host.view();
const perform = async (action: ToolsAction): Promise<void> => host.perform(action);
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function makeHost(gitTimeoutMs?: number): ToolsHost {
  return new ToolsHost({
    paths,
    addSecret: (value) => secrets.push(value),
    openFile: async (file) => void shown.push(file),
    hiddenChanged: (list) => hiddenLists.push(list),
    log: (text) => logged.push(text),
    ...(gitTimeoutMs !== undefined ? { gitTimeoutMs } : {}),
  });
}

/** What the person typed reaches the host as the webview posts it; parse is the host's own check. */
function parsed(raw: Record<string, unknown>): ToolsAction {
  const action = host.parse(raw);
  if (action === undefined) throw new Error(`refused: ${JSON.stringify(raw)}`);
  return action;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-tools-"));
  const second = resolveEnv("second", home);
  paths = envPaths({ env: { CLAUDE_CONFIG_DIR: second.claudeDir, OMO_MEMORY_HOME: second.memoryHome }, agentDir: second.agentDir, omoPath: "/fake/omo", secrets: [] }, home);
  fs.mkdirSync(paths.agentDir, { recursive: true });
  const kitHooks = path.join(home, ".omo/kit/abc123def456/hooks");
  fs.mkdirSync(kitHooks, { recursive: true });
  fs.writeFileSync(path.join(kitHooks, "codegraph-init.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(kitHooks, "codegraph-prompt.mjs"), "\n");
  for (const name of ["prompt-master", "security-audit"]) {
    fs.mkdirSync(path.join(paths.claudeDir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(paths.claudeDir, "skills", name, "SKILL.md"), "x\n");
  }
  fs.writeFileSync(path.join(paths.claudeDir, "CLAUDE.md"), "# rules\n");
  secrets = [];
  shown = [];
  hiddenLists = [];
  logged = [];
  host = makeHost();
});

afterEach(() => {
  delete process.env["OMO_KIT_SUPERPOWERS_REF"];
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ToolsHost · CodeGraph", () => {
  it("codegraph_set_turns_the_mcp_server_and_hooks_on_and_off", async () => {
    expect((await view()).codegraph).toEqual({ on: false });
    await perform(parsed({ kind: "codegraph.set", on: true }));
    expect((await view()).codegraph).toEqual({ on: true });
    expect(readJson(paths.mcpJson)["mcpServers"]["codegraph"]["args"]).toEqual(["serve", "--mcp"]);
    expect(Object.keys(readJson(paths.hooksJson)["hooks"]).sort()).toEqual(["SessionStart", "UserPromptSubmit"]);
    await perform(parsed({ kind: "codegraph.set", on: false }));
    expect((await view()).codegraph).toEqual({ on: false });
    expect(readJson(paths.hooksJson)["hooks"]).toEqual({});
    // the settings UI keeps one rolling backup, never a timestamped one per click
    expect(fs.readdirSync(paths.agentDir).filter((name) => name.includes(".bak-")).sort()).toEqual([
      "hooks-state.json.bak-agent-tabs",
      "hooks.json.bak-agent-tabs",
      "mcp.json.bak-agent-tabs",
    ]);
  });

  it("codegraph_without_the_installed_kit_is_refused_with_a_clear_message", async () => {
    fs.rmSync(path.join(home, ".omo/kit"), { recursive: true });
    await expect(perform({ kind: "codegraph.set", on: true })).rejects.toThrow(FieldErrors);
    await expect(perform({ kind: "codegraph.set", on: true })).rejects.toThrow(/setup-omo/);
  });
});

describe("ToolsHost · skills", () => {
  const cloneDir = (): string => path.join(home, ".omo/superpowers");
  const systemClaude = (): string => path.join(home, ".claude");
  const writeSettings = (value: unknown): void => fs.writeFileSync(settingsFile(), JSON.stringify(value));
  const installClone = (): { url: string; sha: string } => {
    const repo = makeBareRepo(home);
    cloneTo(repo.url, cloneDir());
    return repo;
  };
  const claudeSettings = (claudeDir: string, enabledPlugins: Record<string, boolean>): void => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins }));
  };

  it("skills_set_writes_the_curated_skills_list", async () => {
    const promptMaster = path.join(paths.claudeDir, "skills", "prompt-master");
    expect((await view()).skills).toEqual([
      { folder: promptMaster, name: "prompt-master", on: false },
      { folder: path.join(paths.claudeDir, "skills", "security-audit"), name: "security-audit", on: false },
    ]);
    await perform(parsed({ kind: "skills.set", folder: promptMaster, on: true }));
    expect(readJson(settingsFile())["skills"]).toEqual([promptMaster]);
    expect((await view()).skills[0]).toEqual({ folder: promptMaster, name: "prompt-master", on: true });
    await perform(parsed({ kind: "skills.set", folder: promptMaster, on: false }));
    expect(readJson(settingsFile())["skills"]).toEqual([]);
  });

  it("only_real_skill_folders_are_rows_and_other_skill_paths_are_listed_read_only", async () => {
    installClone();
    const skills = path.join(paths.claudeDir, "skills");
    // Claude's cloud bucket and a folder of folders: no SKILL.md at their top
    fs.mkdirSync(path.join(skills, "synced", "bucket-1", "some-skill"), { recursive: true });
    fs.writeFileSync(path.join(skills, "synced", "bucket-1", "some-skill", "SKILL.md"), "x\n");
    fs.mkdirSync(path.join(skills, "skills", "chainium-agent"), { recursive: true });
    fs.writeFileSync(path.join(skills, "skills", "chainium-agent", "SKILL.md"), "x\n");
    const outside = path.join(home, "my-skills");
    fs.mkdirSync(outside);
    const dangling = path.join(skills, "gone");
    writeSettings({ skills: [path.join(cloneDir(), "skills"), path.join(skills, "prompt-master"), outside, dangling] });

    const shown = await view();
    expect(shown.skills.map((skill) => skill.name)).toEqual(["prompt-master", "security-audit"]);
    expect(shown.skills[0]?.on).toBe(true);
    expect(shown.otherSkills).toEqual([
      { path: outside, exists: true },
      { path: dangling, exists: false },
    ]);
    await expect(perform(parsed({ kind: "skills.set", folder: outside, on: false }))).rejects.toThrow(FieldErrors);
    await expect(perform(parsed({ kind: "skills.set", folder: path.join(skills, "synced"), on: true }))).rejects.toThrow(FieldErrors);
  });

  it("a_folder_the_view_does_not_offer_is_refused", async () => {
    await expect(perform({ kind: "skills.set", folder: "/etc", on: true })).rejects.toThrow(FieldErrors);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it("superpowers_shows_the_clone_its_plugin_version_and_sha_and_each_claude_environment", async () => {
    const repo = installClone();
    fs.mkdirSync(path.join(cloneDir(), "skills", "brainstorming"));
    fs.writeFileSync(path.join(cloneDir(), "skills", "brainstorming", "SKILL.md"), "x\n");
    writeSettings({ packages: [cloneDir()] });
    claudeSettings(systemClaude(), { "superpowers@yasherisa-superpowers": true, "superpowers@claude-plugins-official": false });
    claudeSettings(paths.claudeDir, { "superpowers@yasherisa-superpowers": false });

    expect((await view()).superpowers).toEqual({
      mode: "package",
      folder: cloneDir(),
      version: "6.3.1-test.1",
      sha: repo.sha.slice(0, 7),
      pinned: SUPERPOWERS_REF.slice(0, 7),
      skills: 1,
      claude: [
        { dir: paths.claudeDir, label: "~/.omo-second/claude", plugin: "off" },
        { dir: systemClaude(), label: "~/.claude", plugin: "on" },
      ],
    });
  });

  it("superpowers_set_adds_and_removes_the_package_entry_and_never_the_clone", async () => {
    installClone();
    writeSettings({ skills: ["/a"] });
    expect((await view()).superpowers).toMatchObject({ mode: "off", folder: cloneDir() });
    await perform(parsed({ kind: "superpowers.set", on: true }));
    expect(readJson(settingsFile())).toEqual({ skills: ["/a"], packages: [cloneDir()] });
    expect((await view()).superpowers).toMatchObject({ mode: "package" });
    await perform(parsed({ kind: "superpowers.set", on: false }));
    expect(readJson(settingsFile())).toEqual({ skills: ["/a"] });
    expect(fs.existsSync(path.join(cloneDir(), ".git"))).toBe(true);
  });

  it("the_skills_dir_mode_is_reported_as_legacy_and_migrated_to_the_package_entry", async () => {
    installClone();
    writeSettings({ skills: [path.join(cloneDir(), "skills"), "/a"], extensions: [path.join(cloneDir(), ".pi/extensions/superpowers.ts")] });
    expect((await view()).superpowers).toMatchObject({ mode: "skills", folder: cloneDir() });
    expect((await view()).otherSkills).toEqual([{ path: "/a", exists: false }]);
    await perform(parsed({ kind: "superpowers.set", on: true }));
    expect(readJson(settingsFile())).toEqual({ skills: ["/a"], packages: [cloneDir()] });
    expect((await view()).superpowers.mode).toBe("package");
  });

  it("superpowers_without_a_clone_is_refused_with_a_clear_message", async () => {
    expect((await view()).superpowers).toEqual({ mode: "off", pinned: SUPERPOWERS_REF.slice(0, 7), skills: 0, claude: expect.any(Array) });
    await expect(perform(parsed({ kind: "superpowers.set", on: true }))).rejects.toThrow(/setup-omo/);
    await expect(perform({ kind: "superpowers.update" })).rejects.toThrow(/setup-omo/);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  describe("superpowers update", () => {
    let savedPath: string | undefined;
    let claudeLog: string;
    const calls = (): string[] => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, "utf8").trim().split("\n") : []);

    beforeEach(() => {
      savedPath = process.env["PATH"];
      claudeLog = path.join(home, "claude.log");
    });
    afterEach(() => {
      process.env["PATH"] = savedPath;
    });

    it("checks_out_the_pinned_ref_then_updates_the_claude_plugin_where_it_is_installed", async () => {
      const repo = installClone();
      writeSettings({ skills: [path.join(cloneDir(), "skills")] });
      const work = path.join(home, "sp-work");
      fs.mkdirSync(path.join(work, "skills", "brainstorming"));
      fs.writeFileSync(path.join(work, "skills", "brainstorming", "SKILL.md"), "x\n");
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "next");
      const superpowersRef = git(work, "rev-parse", "HEAD");
      git(work, "push", "-q", repo.url, "HEAD:main");
      process.env["OMO_KIT_SUPERPOWERS_REF"] = superpowersRef; // as for setup-omo: the pinned ref, overridable
      claudeSettings(paths.claudeDir, { "superpowers@yasherisa-superpowers": true });
      process.env["PATH"] = `${makeFakeClaude(path.join(home, "claude-bin"), claudeLog)}:${savedPath ?? ""}`;

      expect((await view()).superpowers).toMatchObject({ sha: repo.sha.slice(0, 7), pinned: superpowersRef.slice(0, 7), skills: 0 });
      await perform(parsed({ kind: "superpowers.update" }));
      expect((await view()).superpowers).toMatchObject({ sha: superpowersRef.slice(0, 7), skills: 1 });
      expect(calls()).toEqual([
        `${paths.claudeDir}|plugin marketplace update yasherisa-superpowers|eof`,
        `${paths.claudeDir}|plugin update superpowers@yasherisa-superpowers|eof`,
      ]);
    });

    it("a_failing_claude_update_is_reported_after_the_clone_moved", async () => {
      installClone();
      writeSettings({ skills: [path.join(cloneDir(), "skills")] });
      process.env["OMO_KIT_SUPERPOWERS_REF"] = git(cloneDir(), "rev-parse", "HEAD");
      claudeSettings(systemClaude(), { "superpowers@yasherisa-superpowers": true });
      process.env["PATH"] = `${makeFakeClaude(path.join(home, "claude-bin"), claudeLog, { exitCode: 2 })}:${savedPath ?? ""}`;
      await expect(perform({ kind: "superpowers.update" })).rejects.toThrow(/Claude.*~\/\.claude/);
      expect(logged.join("\n")).toMatch(/boom/);
    });

    it("without_claude_on_PATH_the_clone_is_updated_and_the_plugin_skipped_with_a_note", async () => {
      installClone();
      writeSettings({ skills: [path.join(cloneDir(), "skills")] });
      process.env["OMO_KIT_SUPERPOWERS_REF"] = git(cloneDir(), "rev-parse", "HEAD");
      claudeSettings(systemClaude(), { "superpowers@yasherisa-superpowers": true });
      // only git on PATH: never the real claude
      const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const gitOnly = path.join(home, "git-only");
      fs.mkdirSync(gitOnly);
      fs.symlinkSync(realGit, path.join(gitOnly, "git"));
      process.env["PATH"] = gitOnly;
      await perform({ kind: "superpowers.update" });
      expect(logged.join("\n")).toMatch(/claude не найден в PATH/);
    });

    it("a_git_that_hangs_is_stopped_by_the_timeout_with_a_clear_message_and_no_checkout", async () => {
      const repo = installClone();
      writeSettings({ skills: [path.join(cloneDir(), "skills")] });
      // A `git` first on PATH whose fetch never answers (the network hangs); everything else is the real git.
      const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const stubDir = path.join(home, "stub-bin");
      fs.mkdirSync(stubDir);
      fs.writeFileSync(path.join(stubDir, "git"), `#!/bin/sh\nif [ "$1" = fetch ]; then exec sleep 30; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      process.env["PATH"] = `${stubDir}:${savedPath ?? ""}`;
      process.env["OMO_KIT_SUPERPOWERS_REF"] = "f".repeat(40);
      host = makeHost(1_000);
      const started = Date.now();
      await expect(perform({ kind: "superpowers.update" })).rejects.toThrow(new FieldErrors("Не удалось обновить superpowers: git не ответил за 1 с — проверьте сеть", []));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(git(cloneDir(), "rev-parse", "HEAD")).toBe(repo.sha); // the checkout never ran
      expect(git(cloneDir(), "status", "--porcelain")).toBe("");
      expect(logged.join("\n")).toMatch(/timed out after 1 s/);
    });
  });
});

describe("ToolsHost · MCP servers", () => {
  beforeEach(() => {
    fs.writeFileSync(
      paths.mcpJson,
      JSON.stringify({ mcpServers: { gh: { command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: "tok-123", REGION: "eu" }, timeout: 30 }, other: { command: "x" } } }),
    );
  });

  it("mcp_secret_env_is_masked_in_the_view", async () => {
    const tools = await view();
    expect(JSON.stringify(tools)).not.toContain("tok-123");
    expect(tools.mcp.find((server) => server.name === "gh")).toEqual({ name: "gh", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: MASK, REGION: "eu" } });
    expect(secrets).toContain("tok-123"); // a stored secret joins the redaction set as soon as it is read
  });

  it("resubmitting_a_masked_value_keeps_the_stored_one", async () => {
    await perform(parsed({ kind: "mcp.save", name: "gh", command: "gh-mcp", args: ["--stdio", "-v"], env: { GITHUB_TOKEN: MASK, REGION: "us" } }));
    const gh = readJson(paths.mcpJson)["mcpServers"]["gh"];
    expect(gh).toEqual({ command: "gh-mcp", args: ["--stdio", "-v"], env: { GITHUB_TOKEN: "tok-123", REGION: "us" }, timeout: 30 });
    expect(fs.statSync(paths.mcpJson).mode & 0o777).toBe(0o644); // an existing file keeps its mode
  });

  it("a_typed_secret_joins_the_redaction_set_before_anything_is_written_or_logged", async () => {
    const service = new SettingsService({ name: "second", agentDir: paths.agentDir }, (text) => logged.push(text));
    service.register(host as never);
    fs.rmSync(paths.mcpJson);
    fs.mkdirSync(paths.mcpJson); // the write fails: the log must not carry the key
    const result = await service.perform("tools", { kind: "mcp.save", name: "new", command: "srv", args: [], env: { OPENAI_API_KEY: "sk-typed-0123456789" } });
    expect(result.ok).toBe(false);
    expect(secrets).toContain("sk-typed-0123456789");
    expect(logged.join("\n")).not.toContain("sk-typed-0123456789");
  });

  it("a_new_server_is_added_with_a_private_file_mode_when_mcp_json_is_new", async () => {
    fs.rmSync(paths.mcpJson);
    await perform(parsed({ kind: "mcp.save", name: "local", command: "/bin/srv", args: [], env: {} }));
    expect(readJson(paths.mcpJson)).toEqual({ mcpServers: { local: { command: "/bin/srv", args: [] } } });
    expect(fs.statSync(paths.mcpJson).mode & 0o777).toBe(0o600);
  });

  it("a_masked_value_without_a_stored_one_and_a_bad_name_are_refused", async () => {
    await expect(perform({ kind: "mcp.save", name: "new", command: "srv", args: [], env: { API_TOKEN: MASK } })).rejects.toThrow(FieldErrors);
    expect(host.parse({ kind: "mcp.save", name: "bad name", command: "srv", args: [], env: {} })).toBeUndefined();
    expect(host.parse({ kind: "mcp.save", name: "ok", command: "", args: [], env: {} })).toBeUndefined();
  });

  it("an_argument_with_spaces_is_stored_and_shown_as_one_argument", async () => {
    await perform(parsed({ kind: "mcp.save", name: "fs", command: "srv", args: ["--root", "/Users/me/My Projects"], env: {} }));
    expect(readJson(paths.mcpJson)["mcpServers"]["fs"]["args"]).toEqual(["--root", "/Users/me/My Projects"]);
    expect((await view()).mcp.find((server) => server.name === "fs")?.args).toEqual(["--root", "/Users/me/My Projects"]);
  });

  it("secret_looking_args_are_masked_joined_to_the_redaction_set_and_kept_on_resubmit", async () => {
    const args = ["--api-key", "ak-111", "--token=tk-222", "OPENAI_API_KEY=ok-333", "--stdio", "--keyboard", "on", "--root", "/work"];
    fs.writeFileSync(paths.mcpJson, JSON.stringify({ mcpServers: { svc: { command: "svc-mcp", args } } }));
    const shown = (await view()).mcp.find((server) => server.name === "svc");
    expect(shown?.args).toEqual(["--api-key", MASK, `--token=${MASK}`, `OPENAI_API_KEY=${MASK}`, "--stdio", "--keyboard", "on", "--root", "/work"]);
    expect(JSON.stringify(shown)).not.toMatch(/ak-111|tk-222|ok-333/);
    expect(secrets).toEqual(expect.arrayContaining(["ak-111", "tk-222", "ok-333"]));
    // sent back masked, the stored values stay; a typed one joins the redaction set before it is written
    await perform(parsed({ kind: "mcp.save", name: "svc", command: "svc-mcp", args: [...(shown?.args ?? []).slice(0, 3), "OPENAI_API_KEY=ok-new", "--stdio"], env: {} }));
    expect(readJson(paths.mcpJson)["mcpServers"]["svc"]["args"]).toEqual(["--api-key", "ak-111", "--token=tk-222", "OPENAI_API_KEY=ok-new", "--stdio"]);
    expect(secrets).toContain("ok-new");
    // a mask where nothing is stored is refused
    await expect(perform({ kind: "mcp.save", name: "svc", command: "svc-mcp", args: ["--secret", MASK], env: {} })).rejects.toThrow(FieldErrors);
  });

  it("mcp_remove_drops_only_that_server", async () => {
    await perform(parsed({ kind: "mcp.remove", name: "gh" }));
    expect(readJson(paths.mcpJson)).toEqual({ mcpServers: { other: { command: "x" } } });
  });
});

describe("ToolsHost · hidden commands and instructions", () => {
  it("hidden_commands_default_to_the_built_in_list_and_round_trip_through_ui_json", async () => {
    expect((await view()).hidden).toEqual([...DEFAULT_HIDDEN_COMMANDS]);
    expect(readHiddenCommands(paths)).toEqual([...DEFAULT_HIDDEN_COMMANDS]);
    await perform(parsed({ kind: "hidden.set", commands: ["/tui", "keybindings", "/tui", " "] }));
    expect(readJson(path.join(paths.pluginDir, "ui.json"))).toEqual({ hiddenCommands: ["tui", "keybindings"] });
    expect(readHiddenCommands(paths)).toEqual(["tui", "keybindings"]);
    expect(hiddenLists).toEqual([["tui", "keybindings"]]);
    expect((await view()).hidden).toEqual(["tui", "keybindings"]);
    expect(host.parse({ kind: "hidden.set", commands: ["/a b"] })).toBeUndefined();
  });

  it("instructions_set_links_this_environments_claude_md", async () => {
    expect((await view()).instructions).toEqual({ on: false, path: path.join(paths.claudeDir, "CLAUDE.md"), exists: true });
    await perform(parsed({ kind: "instructions.set", on: true }));
    expect(fs.readlinkSync(path.join(paths.agentDir, "AGENTS.md"))).toBe(path.join(paths.claudeDir, "CLAUDE.md"));
    expect((await view()).instructions.on).toBe(true);
  });

  it("an_agents_md_of_the_persons_own_is_refused_with_a_clear_message", async () => {
    fs.writeFileSync(path.join(paths.agentDir, "AGENTS.md"), "mine\n");
    await expect(perform({ kind: "instructions.set", on: true })).rejects.toThrow(/AGENTS\.md — ваш собственный файл.*не изменён/);
    expect(fs.readFileSync(path.join(paths.agentDir, "AGENTS.md"), "utf8")).toBe("mine\n");
  });

  it("the_system_claude_md_is_always_on", async () => {
    paths = envPaths({ env: {}, agentDir: path.join(home, ".omo/agent"), omoPath: "/fake/omo", secrets: [] }, home);
    host = makeHost();
    expect((await view()).instructions).toEqual({ on: true, path: path.join(home, ".claude/CLAUDE.md"), exists: false, always: true });
    await expect(perform({ kind: "instructions.set", on: false })).rejects.toThrow(FieldErrors);
    expect(fs.existsSync(path.join(paths.agentDir, "AGENTS.md"))).toBe(false);
  });

  it("instructions_open_opens_the_file_in_the_editor", async () => {
    await perform(parsed({ kind: "instructions.open" }));
    expect(shown).toEqual([`${paths.claudeDir}/CLAUDE.md`]);
  });
});
