import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEnv } from "../../kit/lib/envs.mjs";
import { globalInstructionsState } from "../../kit/lib/tools.mjs";
import { lspDaemonDir } from "../../kit/sandbox/profile.mjs";
import { makeBareRepo, makeFakeCodegraph, makeTmp, runSetup } from "./helpers";

interface Fixture {
  home: string;
  env: Record<string, string>;
  cgDir: string;
}

function fixture(): Fixture {
  const root = makeTmp();
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const repo = makeBareRepo(root);
  const cgDir = makeFakeCodegraph(path.join(root, "bin"), "ctx");
  return {
    home,
    cgDir,
    env: {
      PATH: `${cgDir}:${process.env.PATH ?? ""}`,
      OMO_KIT_SUPERPOWERS_URL: repo.url,
      OMO_KIT_SUPERPOWERS_REF: repo.sha,
    },
  };
}

const snapshot = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(full);
      else out.push(`${full}\0${fs.readFileSync(full, "utf8")}`);
    }
  };
  walk(dir);
  return out.sort();
};

const defaultClone = (home: string): string => path.join(home, ".local/share/agent-tabs/superpowers");

const agentDirOf = (home: string, env = "system") =>
  env === "second" ? path.join(home, ".omo-second/agent") : path.join(home, ".omo/agent");

describe("setup-omo", () => {
  it("a_clean_default_setup_needs_no_optional_tools_or_superpowers", () => {
    const root = makeTmp();
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    const result = runSetup(["--home", home], { HOME: home, PATH: bin });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".omo/agent/settings.json"), "utf8"))).toEqual({ skills: [] });
    expect(fs.existsSync(defaultClone(home))).toBe(false);
    expect(fs.existsSync(path.join(home, ".omo/agent/mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".omo/agent/hooks.json"))).toBe(false);
    expect(fs.statSync(path.join(home, ".local/bin/omo-system")).mode & 0o111).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".omo/omo.jsonc"), "utf8")).memory.reflection.category).toBe("quick");
    expect(result.stdout).toContain("CodeGraph: не найден");
    expect(result.stdout).toContain("Установите CodeGraph и добавьте codegraph в PATH");
    expect(result.stdout).toContain("Superpowers: пропущен");
    expect(result.stdout).toContain("Навыки: 0");
    expect(result.stdout).toContain("Хуки: пропущены");
  });

  it("default_setup_preserves_existing_packages_without_cloning", () => {
    const fx = fixture();
    const dir = agentDirOf(fx.home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["/my/package"], skills: ["/my/skill"] }));
    const result = runSetup(["--home", fx.home], { ...fx.env, OMO_KIT_SUPERPOWERS_URL: "/missing/repository" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"))).toEqual({ packages: ["/my/package"], skills: ["/my/skill"] });
    expect(fs.existsSync(defaultClone(fx.home))).toBe(false);
    expect(result.stdout).toContain("CodeGraph: подключён");
  });

  it("setup_is_idempotent", () => {
    const fx = fixture();
    const first = runSetup(["--env", "system", "--home", fx.home], fx.env);
    expect(first.status, first.stderr).toBe(0);
    const before = snapshot(fx.home);
    const second = runSetup(["--env", "system", "--home", fx.home], fx.env);
    expect(second.status, second.stderr).toBe(0);
    expect(snapshot(fx.home)).toEqual(before);
    expect(before.some((entry) => entry.includes(".bak-"))).toBe(false);
  });

  it("skills_only_existing_curated_folders", () => {
    const fx = fixture();
    const skills = path.join(fx.home, ".claude/skills");
    for (const name of ["prompt-master", "security-audit", "supervisor", "synced"]) fs.mkdirSync(path.join(skills, name), { recursive: true });
    const result = runSetup(["--env", "system", "--home", fx.home], fx.env);
    expect(result.status, result.stderr).toBe(0);
    const settings = JSON.parse(fs.readFileSync(path.join(agentDirOf(fx.home), "settings.json"), "utf8"));
    expect(settings.skills).toEqual([path.join(skills, "prompt-master"), path.join(skills, "security-audit")]);
    expect(settings.extensions).toBeUndefined();
    expect(settings.packages).toBeUndefined();
  });

  describe("superpowers", () => {
    const settingsOf = (home: string, env = "system") => JSON.parse(fs.readFileSync(path.join(agentDirOf(home, env), "settings.json"), "utf8"));
    const clone = (fx: Fixture, dir: string): void => {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      execFileSync("git", ["clone", "-q", fx.env["OMO_KIT_SUPERPOWERS_URL"] as string, dir]);
    };

    it("a_fresh_install_clones_the_fork_to_the_neutral_default_adds_it_as_a_package_and_prints_the_claude_commands", () => {
      const fx = fixture();
      const result = runSetup(["--superpowers", "--env", "second", "--home", fx.home], fx.env);
      expect(result.status, result.stderr).toBe(0);
      const dir = defaultClone(fx.home);
      expect(fs.existsSync(path.join(dir, "skills/README.md"))).toBe(true);
      expect(settingsOf(fx.home, "second")).toEqual({ skills: [], packages: [dir] });
      const claudeDir = path.join(fx.home, ".omo-second/claude");
      expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR='${claudeDir}' claude plugin marketplace add '${dir}'`);
      expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR='${claudeDir}' claude plugin install superpowers@yasherisa-superpowers`);
    });

    it("the_system_claude_dir_gets_the_commands_without_a_config_dir_and_none_once_the_plugin_is_installed", () => {
      const fx = fixture();
      const first = runSetup(["--superpowers", "--env", "system", "--home", fx.home], fx.env);
      expect(first.stdout).toMatch(/^ {2}claude plugin marketplace add /m);
      expect(first.stdout).not.toContain("CLAUDE_CONFIG_DIR");
      fs.mkdirSync(path.join(fx.home, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(fx.home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@yasherisa-superpowers": true } }));
      expect(runSetup(["--superpowers", "--env", "system", "--home", fx.home], fx.env).stdout).not.toContain("claude plugin");
    });

    it("an_existing_clone_where_it_was_moved_by_hand_is_used", () => {
      const fx = fixture();
      const moved = path.join(fx.home, ".omo/superpowers");
      clone(fx, moved);
      expect(runSetup(["--superpowers", "--env", "system", "--home", fx.home], fx.env).status).toBe(0);
      expect(settingsOf(fx.home).packages).toEqual([moved]);
      expect(fs.existsSync(defaultClone(fx.home))).toBe(false);
    });

    it("the_legacy_package_clone_is_kept_as_the_package_and_a_skills_dir_connection_is_migrated", () => {
      const fx = fixture();
      const legacy = path.join(fx.home, ".omo/packages/yasherisa-superpowers");
      clone(fx, legacy);
      fs.mkdirSync(agentDirOf(fx.home), { recursive: true });
      fs.writeFileSync(path.join(agentDirOf(fx.home), "settings.json"), JSON.stringify({ skills: [path.join(legacy, "skills"), "/mine"], extensions: [path.join(legacy, ".pi/extensions/superpowers.ts")], packages: ["/other-pkg"] }));
      expect(runSetup(["--superpowers", "--env", "system", "--home", fx.home], fx.env).status).toBe(0);
      expect(settingsOf(fx.home)).toEqual({ skills: ["/mine"], packages: ["/other-pkg", legacy] });
      expect(fs.existsSync(defaultClone(fx.home))).toBe(false);
    });

    it("OMO_KIT_SUPERPOWERS_DIR_chooses_where_the_fork_is_cloned", () => {
      const fx = fixture();
      const chosen = path.join(fx.home, "tools/superpowers");
      const result = runSetup(["--superpowers", "--env", "system", "--home", fx.home], { ...fx.env, OMO_KIT_SUPERPOWERS_DIR: chosen });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(chosen, "skills/README.md"))).toBe(true);
      expect(settingsOf(fx.home).packages).toEqual([chosen]);
    });
  });

  it("mcp_uses_env_codegraph_binary", () => {
    const fx = fixture();
    expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
    const system = JSON.parse(fs.readFileSync(path.join(agentDirOf(fx.home), "mcp.json"), "utf8"));
    expect(system.mcpServers.codegraph).toEqual({ command: path.join(fx.cgDir, "codegraph"), args: ["serve", "--mcp"] });

    expect(runSetup(["--env", "second", "--home", fx.home], fx.env).status).toBe(0);
    const second = JSON.parse(fs.readFileSync(path.join(agentDirOf(fx.home, "second"), "mcp.json"), "utf8"));
    expect(second.mcpServers.codegraph).toEqual({
      command: path.join(fx.home, ".omo-second/codegraph/codegraph"),
      args: ["serve", "--mcp"],
    });
  });

  it("trust_matches_hooks_after_edit", () => {
    const fx = fixture();
    expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
    const agentDir = agentDirOf(fx.home);
    const hooksFile = path.join(agentDir, "hooks.json");
    const config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    expect(Object.keys(config.hooks).sort()).toEqual(["SessionStart", "UserPromptSubmit"]);
    const state = JSON.parse(fs.readFileSync(path.join(agentDir, "hooks-state.json"), "utf8"));
    expect(Object.keys(state.hooks)).toHaveLength(2);
    const beforeHashes = Object.values<{ trustedHash: string }>(state.hooks).map((entry) => entry.trustedHash);

    config.hooks.SessionStart[0].hooks[0].command += " # edited";
    fs.writeFileSync(hooksFile, JSON.stringify(config));
    expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
    // setup rewrites its own hook entries, so the edit is reverted and trust matches the final file.
    const final = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    expect(final.hooks.SessionStart[0].hooks[0].command).not.toContain("# edited");
    const after = JSON.parse(fs.readFileSync(path.join(agentDir, "hooks-state.json"), "utf8"));
    expect(Object.values<{ trustedHash: string }>(after.hooks).map((entry) => entry.trustedHash)).toEqual(beforeHashes);

    // A different env resolves different source paths, hence different ids and hashes.
    expect(runSetup(["--env", "second", "--home", fx.home], fx.env).status).toBe(0);
    const secondState = JSON.parse(fs.readFileSync(path.join(agentDirOf(fx.home, "second"), "hooks-state.json"), "utf8"));
    const secondHashes = Object.values<{ trustedHash: string }>(secondState.hooks).map((entry) => entry.trustedHash);
    expect(secondHashes).not.toEqual(beforeHashes);
  });

  it("re-trusts a changed hook command (new codegraph binary)", () => {
    const fx = fixture();
    expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
    const stateFile = path.join(agentDirOf(fx.home), "hooks-state.json");
    const before = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const other = makeFakeCodegraph(makeTmp(), "other");
    expect(runSetup(["--env", "system", "--home", fx.home], { ...fx.env, PATH: `${other}:${process.env.PATH}` }).status).toBe(0);
    const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const hashesOf = (state: { hooks: Record<string, { trustedHash: string }> }) => Object.values(state.hooks).map((entry) => entry.trustedHash);
    expect(hashesOf(after)).not.toEqual(hashesOf(before));
    const hooks = JSON.parse(fs.readFileSync(path.join(agentDirOf(fx.home), "hooks.json"), "utf8"));
    expect(JSON.stringify(hooks)).toContain(path.join(other, "codegraph"));
    expect(fs.readdirSync(agentDirOf(fx.home)).some((name) => name.startsWith("hooks-state.json.bak-"))).toBe(true);
  });

  it("omo_wrapper_sets_env", () => {
    const fx = fixture();
    expect(runSetup(["--env", "second", "--home", fx.home], fx.env).status).toBe(0);
    const wrapper = path.join(fx.home, ".local/bin/omo-second");
    const text = fs.readFileSync(wrapper, "utf8");
    expect(text).toContain(`OMO_CODING_AGENT_DIR="${path.join(fx.home, ".omo-second/agent")}"`);
    expect(text).toContain(`OMO_MEMORY_HOME="${path.join(fx.home, ".omo-second/memory")}"`);
    expect(text).toContain(`CLAUDE_CONFIG_DIR="${path.join(fx.home, ".omo-second/claude")}"`);
    expect(fs.statSync(wrapper).mode & 0o111).not.toBe(0);
    // Executing the wrapper against a fake omo shows the exported env.
    const fakeOmo = path.join(fx.home, ".local/bin/omo");
    fs.writeFileSync(fakeOmo, '#!/bin/sh\necho "$OMO_CODING_AGENT_DIR|$CLAUDE_CONFIG_DIR|$1"\n', { mode: 0o755 });
    const run = spawnSync(wrapper, ["arg1"], { encoding: "utf8" });
    expect(run.stdout.trim()).toBe(`${path.join(fx.home, ".omo-second/agent")}|${path.join(fx.home, ".omo-second/claude")}|arg1`);
  });

  it("omo_wrapper_keeps_dollar_backtick_quote_and_backslash_in_paths_literal", () => {
    const fx = fixture();
    const home = path.join(path.dirname(fx.home), 'h $HOME `id` "q" \\x');
    fs.mkdirSync(home, { recursive: true });
    expect(runSetup(["--env", "second", "--home", home], fx.env).status).toBe(0);
    const fakeOmo = path.join(home, ".local/bin/omo");
    fs.writeFileSync(fakeOmo, '#!/bin/sh\nprintf "%s|%s" "$OMO_CODING_AGENT_DIR" "$CLAUDE_CONFIG_DIR"\n', { mode: 0o755 });
    const run = spawnSync(path.join(home, ".local/bin/omo-second"), [], { encoding: "utf8" });
    expect(run.stdout).toBe(`${path.join(home, ".omo-second/agent")}|${path.join(home, ".omo-second/claude")}`);
  });

  it.runIf(process.platform === "darwin")("omo_wrapper_runs_under_the_profile_when_protection_is_on", () => {
    const fx = fixture();
    expect(runSetup(["--env", "second", "--home", fx.home], fx.env).status).toBe(0);
    const wrapper = path.join(fx.home, ".local/bin/omo-second");
    const agentDir = path.join(fx.home, ".omo-second/agent");
    const fakeOmo = path.join(fx.home, ".local/bin/omo");
    fs.writeFileSync(fakeOmo, '#!/bin/sh\necho x > "$OMO_CODING_AGENT_DIR/models.json" 2>/dev/null && echo wrote; echo "lsp=$OMO_LSP_DAEMON_DIR|$1"\n', { mode: 0o755 });
    const plain = spawnSync(wrapper, ["a"], { encoding: "utf8" });
    expect(plain.stdout.trim()).toBe("wrote\nlsp=|a");
    fs.rmSync(path.join(agentDir, "models.json"));

    fs.mkdirSync(path.join(agentDir, "guard"), { recursive: true });
    const real = fs.realpathSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "guard/sandbox.sb"), `(version 1)\n(allow default)\n(deny file-write* (literal "${real}/models.json"))\n`);
    const sandboxed = spawnSync(wrapper, ["b"], { encoding: "utf8" });
    expect(sandboxed.stdout.trim()).toBe(`lsp=${lspDaemonDir(agentDir)}|b`);
    expect(fs.statSync(path.join(agentDir, "rpc")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "models.json"))).toBe(false);
  });

  it("merges memory.reflection.category into omo.jsonc without touching other keys", () => {
    const fx = fixture();
    const jsonc = path.join(fx.home, ".omo/omo.jsonc");
    fs.mkdirSync(path.dirname(jsonc), { recursive: true });
    fs.writeFileSync(jsonc, '// keep me\n{\n  "telemetry": { "enabled": false },\n  "memory": { "facts": true }\n}\n');
    expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
    const text = fs.readFileSync(jsonc, "utf8");
    expect(text).toContain("// keep me");
    expect(text).toContain('"telemetry": { "enabled": false }');
    expect(text).toContain('"facts": true');
    const stripped = text.replace(/\/\/.*$/gm, "");
    expect(JSON.parse(stripped).memory.reflection.category).toBe("quick");
  });

  it("setup_enables_global_instructions_by_default", () => {
    const fx = fixture();
    const second = resolveEnv("second", fx.home);
    fs.mkdirSync(second.claudeDir, { recursive: true });
    fs.writeFileSync(path.join(second.claudeDir, "CLAUDE.md"), "# rules\n");
    const result = runSetup(["--env", "second", "--home", fx.home], fx.env);
    expect(result.status, result.stderr).toBe(0);
    expect(globalInstructionsState(second).on).toBe(true);
    expect(fs.readlinkSync(path.join(second.agentDir, "AGENTS.md"))).toBe(path.join(second.claudeDir, "CLAUDE.md"));
    // The system environment's ~/.claude/CLAUDE.md is loaded by OmO itself: no link there.
    expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
    expect(fs.existsSync(path.join(agentDirOf(fx.home), "AGENTS.md"))).toBe(false);
  });

  it("setup_leaves_an_agents_md_of_the_users_alone_with_a_warning", () => {
    const fx = fixture();
    const agentsMd = path.join(agentDirOf(fx.home, "second"), "AGENTS.md");
    fs.mkdirSync(path.dirname(agentsMd), { recursive: true });
    fs.writeFileSync(agentsMd, "mine\n");
    const result = runSetup(["--env", "second", "--home", fx.home], fx.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/warning: .*AGENTS\.md/);
    expect(fs.readFileSync(agentsMd, "utf8")).toBe("mine\n");
  });

  it("setup_keeps_a_non_codegraph_kit_handler", () => {
    const fx = fixture();
    expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
    const hooksFile = path.join(agentDirOf(fx.home), "hooks.json");
    const config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    const guard = { type: "command", command: path.join(fx.home, ".omo/kit/guard/hook.mjs") };
    config.hooks.SessionStart[0].hooks.push(guard);
    fs.writeFileSync(hooksFile, JSON.stringify(config));
    expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(hooksFile, "utf8")).hooks.SessionStart[0].hooks[1]).toEqual(guard);
  });

  it("dry-run writes nothing", () => {
    const fx = fixture();
    const result = runSetup(["--env", "system", "--home", fx.home, "--dry-run"], fx.env);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(fx.home)).toEqual([]);
  });

  describe("preservation and validation", () => {
    const put = (file: string, content: string, mode = 0o644) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode });
      fs.chmodSync(file, mode);
    };
    const readJsonFile = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

    it("keeps the mode of an existing file and merges other mcpServers", () => {
      const fx = fixture();
      const mcpFile = path.join(agentDirOf(fx.home), "mcp.json");
      put(mcpFile, JSON.stringify({ mcpServers: { other: { command: "x", env: { TOKEN: "t" } } } }), 0o600);
      const result = runSetup(["--env", "system", "--home", fx.home], fx.env);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.statSync(mcpFile).mode & 0o777).toBe(0o600);
      const backup = fs.readdirSync(path.dirname(mcpFile)).find((name) => name.startsWith("mcp.json.bak-"))!;
      expect(fs.statSync(path.join(path.dirname(mcpFile), backup)).mode & 0o777).toBe(0o600);
      const mcp = readJsonFile(mcpFile);
      expect(mcp.mcpServers.other.env.TOKEN).toBe("t");
      expect(mcp.mcpServers.codegraph.args).toEqual(["serve", "--mcp"]);
    });

    it("keeps foreign hook groups and never trusts them; unrelated and disabled state survives", () => {
      const fx = fixture();
      const agentDir = agentDirOf(fx.home);
      const hooksFile = path.join(agentDir, "hooks.json");
      const foreign = { matcher: "bash", hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] };
      put(
        hooksFile,
        JSON.stringify({
          hooks: {
            SessionStart: [foreign, { hooks: [{ type: "prompt", prompt: "no command" }] }, { matcher: "x" }],
            Stop: [foreign],
          },
        }),
      );
      const keep = { enabled: false, trustedHash: "sha256:abc", scope: "global", sourcePath: "/elsewhere/hooks.json", commandPreview: "z" };
      put(path.join(agentDir, "hooks-state.json"), JSON.stringify({ version: 1, extra: 1, hooks: { hk_other: keep } }), 0o600);
      const result = runSetup(["--env", "system", "--home", fx.home], fx.env);
      expect(result.status, result.stderr).toBe(0);
      const config = readJsonFile(hooksFile);
      expect(config.hooks.SessionStart[0]).toEqual(foreign);
      expect(config.hooks.SessionStart).toHaveLength(4);
      expect(config.hooks.Stop).toEqual([foreign]);
      const state = readJsonFile(path.join(agentDir, "hooks-state.json"));
      expect(state.extra).toBe(1);
      expect(state.hooks.hk_other).toEqual(keep);
      const previews = Object.values<{ commandPreview: string }>(state.hooks).map((record) => record.commandPreview);
      expect(previews.some((command) => command.includes("mine.sh"))).toBe(false);
      expect(Object.keys(state.hooks)).toHaveLength(3);
      expect(fs.statSync(path.join(agentDir, "hooks-state.json")).mode & 0o777).toBe(0o600);
    });

    it("rerun keeps order of [kit, foreign], mixed groups and the foreign trust record; prunes stale kit ids", () => {
      const fx = fixture();
      const agentDir = agentDirOf(fx.home);
      const hooksFile = path.join(agentDir, "hooks.json");
      const stateFile = path.join(agentDir, "hooks-state.json");
      expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
      const config = readJsonFile(hooksFile);
      const foreign = { matcher: "bash", hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] };
      const kitHandler = config.hooks.SessionStart[0].hooks[0];
      config.hooks.SessionStart = [config.hooks.SessionStart[0], foreign];
      config.hooks.UserPromptSubmit[0].hooks.push({ type: "command", command: "/usr/local/bin/mixed.sh" });
      fs.writeFileSync(hooksFile, JSON.stringify(config));
      const state = readJsonFile(stateFile);
      const foreignId = Object.keys(state.hooks)[0]!.replace(/_[A-Za-z]+_\d+_\d+$/, "_SessionStart_1_0");
      state.hooks[foreignId] = { enabled: true, trustedHash: "sha256:user", scope: "global", sourcePath: hooksFile, commandPreview: "/usr/local/bin/mine.sh" };
      const staleId = foreignId.replace("_SessionStart_1_0", "_SessionStart_7_0");
      state.hooks[staleId] = { enabled: true, trustedHash: "sha256:old", scope: "global", sourcePath: hooksFile, commandPreview: kitHandler.command };
      fs.writeFileSync(stateFile, JSON.stringify(state));
      expect(runSetup(["--env", "system", "--home", fx.home], { ...fx.env, PATH: `${makeFakeCodegraph(makeTmp(), "o")}:${process.env.PATH}` }).status).toBe(0);
      const after = readJsonFile(hooksFile);
      expect(after.hooks.SessionStart).toHaveLength(2);
      expect(after.hooks.SessionStart[0].hooks[0].command).not.toBe(kitHandler.command);
      expect(after.hooks.SessionStart[1]).toEqual(foreign);
      expect(after.hooks.UserPromptSubmit).toHaveLength(1);
      expect(after.hooks.UserPromptSubmit[0].hooks[1].command).toBe("/usr/local/bin/mixed.sh");
      const final = readJsonFile(stateFile);
      expect(final.hooks[foreignId].trustedHash).toBe("sha256:user");
      expect(final.hooks[staleId]).toBeUndefined();
    });

    it("does not re-enable a disabled kit hook", () => {
      const fx = fixture();
      expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
      const stateFile = path.join(agentDirOf(fx.home), "hooks-state.json");
      const state = readJsonFile(stateFile);
      const [firstId] = Object.keys(state.hooks);
      state.hooks[firstId!].enabled = false;
      fs.writeFileSync(stateFile, JSON.stringify(state));
      expect(runSetup(["--env", "system", "--home", fx.home], fx.env).status).toBe(0);
      expect(readJsonFile(stateFile).hooks[firstId!].enabled).toBe(false);
    });

    it.each([
      ["mcp.json", "{ not json"],
      ["settings.json", '{"skills": "oops"}'],
      ["hooks.json", '{"hooks": {"SessionStart": {}}}'],
      ["hooks-state.json", "[]"],
    ])("aborts without changes when %s is invalid", (name, content) => {
      const fx = fixture();
      const agentDir = agentDirOf(fx.home);
      put(path.join(agentDir, name), content);
      const before = snapshot(fx.home);
      const result = runSetup(["--env", "system", "--home", fx.home], fx.env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(name);
      expect(snapshot(fx.home)).toEqual(before);
      expect(fs.existsSync(path.join(fx.home, ".local/share"))).toBe(false);
      expect(fs.existsSync(path.join(fx.home, ".omo/kit"))).toBe(false);
    });
  });

  it("warns when the agent dir path is a symlink, without canonicalizing", () => {
    const fx = fixture();
    const real = path.join(path.dirname(fx.home), "real-agent");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.join(fx.home, ".omo"), { recursive: true });
    fs.symlinkSync(real, path.join(fx.home, ".omo/agent"));
    const result = runSetup(["--env", "system", "--home", fx.home], fx.env);
    expect(`${result.stdout}${result.stderr}`).toMatch(/warning: .*\.omo\/agent resolves to .*real-agent/);
    expect(fs.existsSync(path.join(fx.home, ".omo/agent/hooks-state.json"))).toBe(true);
  });
});
