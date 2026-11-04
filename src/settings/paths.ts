import { homedir } from "node:os";
import path from "node:path";
import { ENV_NAMES, resolveEnv } from "../../kit/lib/envs.mjs";
import type { OmoEnv } from "../env";

/** Where this window's environment keeps the files the settings read and write. */
export type EnvPaths = {
  home: string;
  agentDir: string;
  modelsJson: string;
  mcpJson: string;
  hooksJson: string;
  keysDir: string;
  /** `<agentDir>/agent-tabs`: the plugin's own files. */
  pluginDir: string;
  modelsCache: string;
  /** `~/.omo/omo.jsonc`: roles, shared by every environment. */
  omoJsonc: string;
  guardDir: string;
  claudeDir: string;
  memoryHome: string;
};

function expandTilde(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** The agent dir as OmO is given it (never canonicalized: hook trust is bound to that spelling). */
export function envPaths(env: OmoEnv, home: string = homedir()): EnvPaths {
  const agentDir = env.agentDir;
  const pluginDir = path.join(agentDir, "agent-tabs");
  const fromEnv = (name: string, fallback: string): string => {
    const value = env.env[name];
    return value === undefined || value === "" ? fallback : expandTilde(value, home);
  };
  return {
    home,
    agentDir,
    modelsJson: path.join(agentDir, "models.json"),
    mcpJson: path.join(agentDir, "mcp.json"),
    hooksJson: path.join(agentDir, "hooks.json"),
    keysDir: path.join(agentDir, "keys"),
    pluginDir,
    modelsCache: path.join(pluginDir, "models-cache.json"),
    omoJsonc: path.join(home, ".omo", "omo.jsonc"),
    guardDir: path.join(agentDir, "guard"),
    claudeDir: fromEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude")),
    memoryHome: fromEnv("OMO_MEMORY_HOME", path.join(home, ".omo", "memory")),
  };
}

/** The kit's name for the environment whose agent dir this is («second»), else «своя». */
export function envName(paths: EnvPaths): string {
  return ENV_NAMES.find((name) => resolveEnv(name, paths.home).agentDir === paths.agentDir) ?? "своя";
}
