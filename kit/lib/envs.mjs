// Environment table: where each OmO environment keeps its agent dir, memory and Claude profile.
import path from "node:path";

const TABLE = {
  system: { agentDir: ".omo/agent", memoryHome: ".omo/memory", claudeDir: ".claude", codegraph: null },
  default: { agentDir: ".omo/agent", memoryHome: ".omo/memory", claudeDir: ".claude", codegraph: null },
};

const second = process.env.OMO_KIT_SECOND_AGENT_DIR;
if (second) {
  TABLE.second = {
    agentDir: second,
    memoryHome: process.env.OMO_KIT_SECOND_MEMORY_HOME ?? ".omo-second/memory",
    claudeDir: process.env.OMO_KIT_SECOND_CLAUDE_DIR ?? ".omo-second/claude",
    codegraph: process.env.OMO_KIT_SECOND_CODEGRAPH ?? null,
  };
}

export const ENV_NAMES = Object.keys(TABLE);

/** Resolve an environment name to absolute paths under `home`. `codegraph` is null when it comes from PATH. */
export function resolveEnv(name, home) {
  const row = TABLE[name];
  if (!row) throw new Error(`unknown --env "${name}" (expected ${ENV_NAMES.join("|")})`);
  const abs = (rel) => (rel === null ? null : path.isAbsolute(rel) ? rel : path.join(home, rel));
  return {
    name,
    home,
    agentDir: abs(row.agentDir),
    memoryHome: abs(row.memoryHome),
    claudeDir: abs(row.claudeDir),
    codegraph: abs(row.codegraph),
  };
}
