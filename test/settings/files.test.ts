import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OmoEnv } from "../../src/env";
import { writeIfChanged } from "../../kit/lib/files.mjs";
import { writeHooksJson, writeOmoFile } from "../../src/settings/files";
import { envName, envPaths, type EnvPaths } from "../../src/settings/paths";

let home: string;
let paths: EnvPaths;
let file: string;

function env(vars: Record<string, string> = {}): OmoEnv {
  const agentDir = path.join(home, ".omo/agent");
  return { env: { OMO_CODING_AGENT_DIR: agentDir, ...vars }, agentDir, omoPath: "/fake/omo", secrets: [] };
}

function backups(target: string): string[] {
  return fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith(`${path.basename(target)}.bak-`));
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function readJson(target: string): { hooks: Record<string, { commandPreview: string }> } {
  return JSON.parse(fs.readFileSync(target, "utf8")) as { hooks: Record<string, { commandPreview: string }> };
}

type Config = { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> };

function handlerCount(config: Config): number {
  return Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks)).length;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-files-"));
  paths = envPaths(env(), home);
  file = path.join(paths.agentDir, "models.json");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("envPaths", () => {
  it("places_connections_in_the_agent_dir_and_roles_in_the_home", () => {
    const agentDir = path.join(home, ".omo/agent");
    expect(paths).toEqual({
      home,
      agentDir,
      modelsJson: path.join(agentDir, "models.json"),
      mcpJson: path.join(agentDir, "mcp.json"),
      hooksJson: path.join(agentDir, "hooks.json"),
      keysDir: path.join(agentDir, "keys"),
      pluginDir: path.join(agentDir, "agent-tabs"),
      modelsCache: path.join(agentDir, "agent-tabs", "models-cache.json"),
      omoJsonc: path.join(home, ".omo/omo.jsonc"),
      guardDir: path.join(agentDir, "guard"),
      claudeDir: path.join(home, ".claude"),
      memoryHome: path.join(home, ".omo/memory"),
    });
  });

  it("takes_the_claude_and_memory_dirs_from_the_environment", () => {
    const custom = envPaths(env({ CLAUDE_CONFIG_DIR: "~/.cache/claude", OMO_MEMORY_HOME: "/data/memory" }), home);
    expect(custom.claudeDir).toBe(path.join(home, ".cache/claude"));
    expect(custom.memoryHome).toBe("/data/memory");
  });

  it("names_a_kit_environment_by_its_agent_dir", () => {
    const second = { ...env(), agentDir: path.join(home, ".omo-second/agent") };
    expect(envName(envPaths(second, home))).toBe("second");
    expect(envName(paths)).toBe("system");
    expect(envName(envPaths({ ...env(), agentDir: "/elsewhere/agent" }, home))).toBe("своя");
  });
});

describe("writeOmoFile", () => {
  it("second_identical_write_is_unchanged_and_first_change_backs_up", () => {
    expect(writeOmoFile(file, "a")).toBe("written");
    expect(writeOmoFile(file, "a")).toBe("unchanged");
    expect(backups(file)).toHaveLength(0);
    expect(writeOmoFile(file, "b")).toBe("written");
    expect(fs.readFileSync(file, "utf8")).toBe("b");
    expect(backups(file)).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), backups(file)[0] as string), "utf8")).toBe("a");
  });

  it("an_existing_files_mode_is_preserved", () => {
    writeOmoFile(file, "a");
    fs.chmodSync(file, 0o600);
    writeOmoFile(file, "c", { mode: 0o644 });
    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("c");
  });

  it("rolling_backup_keeps_one_file_overwritten_on_every_write", () => {
    writeOmoFile(file, "a", { backup: "rolling" });
    for (const content of ["b", "c", "d", "e", "f"]) writeOmoFile(file, content, { backup: "rolling" });
    expect(backups(file)).toEqual([`${path.basename(file)}.bak-agent-tabs`]);
    expect(fs.readFileSync(`${file}.bak-agent-tabs`, "utf8")).toBe("e"); // the content before the last write
    expect(fs.readFileSync(file, "utf8")).toBe("f");
  });

  it("the_kit_write_is_atomic_keeps_the_mode_and_leaves_no_temp_file", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "a", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const before = fs.statSync(file).ino;
    expect(writeIfChanged(file, "b", { mode: 0o644 })).toBe("updated");
    expect(mode(file)).toBe(0o600);
    expect(fs.statSync(file).ino).not.toBe(before); // a new file renamed over the old one, never a half-written one
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(mode(backups(file).map((name) => path.join(path.dirname(file), name))[0] as string)).toBe(0o600);
  });

  it("a_symlinked_file_stays_a_symlink_and_its_real_target_gets_the_content", () => {
    const realDir = path.join(home, "dotfiles");
    const real = path.join(realDir, "models.json");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(real, "a", { mode: 0o600 });
    fs.chmodSync(real, 0o600);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(real, file);
    expect(writeIfChanged(file, "b", { backup: "rolling" })).toBe("updated");
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(file)).toBe(real);
    expect(fs.readFileSync(real, "utf8")).toBe("b");
    expect(mode(real)).toBe(0o600);
    expect(fs.readdirSync(realDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a_two_link_chain_keeps_both_links_and_writes_the_real_file", () => {
    const realDir = path.join(home, "dotfiles");
    const real = path.join(realDir, "models.json");
    const middle = path.join(home, "middle", "models.json");
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(path.dirname(middle), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(real, "a");
    fs.symlinkSync(real, middle);
    fs.symlinkSync(path.relative(path.dirname(file), middle), file); // a relative link, as `ln -s ../x` makes
    expect(writeIfChanged(file, "b")).toBe("updated");
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(middle).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("b");
  });

  it("a_dangling_link_chain_creates_its_final_target_and_stays_a_link", () => {
    const final = path.join(home, "dotfiles", "models.json");
    const middle = path.join(home, "middle", "models.json");
    fs.mkdirSync(path.dirname(middle), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(final, middle);
    fs.symlinkSync(middle, file);
    expect(writeIfChanged(file, "new", { mode: 0o600 })).toBe("created");
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(middle).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(final, "utf8")).toBe("new");
    expect(mode(final)).toBe(0o600);
  });

  it("a_new_file_gets_the_asked_mode", () => {
    const key = path.join(paths.keysDir, "gw.key");
    writeOmoFile(key, "k", { mode: 0o600 });
    expect(mode(key)).toBe(0o600);
  });
});

describe("writeHooksJson", () => {
  it("hooks_json_write_reissues_trust", () => {
    const kit = path.join(home, ".omo/kit/hooks");
    const config: Config = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `${kit}/codegraph-init.sh` }] }],
        PreToolUse: [{ matcher: "Bash|bash", hooks: [{ type: "command", command: `${kit}/guard.mjs` }, { type: "command", command: `${kit}/other.mjs` }] }],
      },
    };
    writeHooksJson(paths, config);
    expect(JSON.parse(fs.readFileSync(paths.hooksJson, "utf8"))).toEqual(config);
    const state = readJson(path.join(paths.agentDir, "hooks-state.json"));
    expect(Object.keys(state.hooks)).toHaveLength(handlerCount(config));
    expect(mode(path.join(paths.agentDir, "hooks-state.json"))).toBe(0o600);

    // A handler that leaves hooks.json loses its trust record on the next write.
    config.hooks["PreToolUse"] = [{ matcher: "Bash|bash", hooks: [{ type: "command", command: `${kit}/guard.mjs` }] }];
    writeHooksJson(paths, config);
    expect(Object.keys(readJson(path.join(paths.agentDir, "hooks-state.json")).hooks)).toHaveLength(handlerCount(config));
  });

  it("a_foreign_handler_is_written_but_never_trusted", () => {
    const config: Config = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/tmp/planted.sh" }, { type: "command", command: `${home}/.omo/kit/hooks/init.sh` }] }],
      },
    };
    writeHooksJson(paths, config);
    const previews = Object.values(readJson(path.join(paths.agentDir, "hooks-state.json")).hooks).map((record) => record.commandPreview);
    expect(previews).toEqual([`${home}/.omo/kit/hooks/init.sh`]);
  });
});
