import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KIT } from "./helpers";

function environments(extra: Record<string, string> = {}): { names: string[]; paths: Record<string, { agentDir: string; memoryHome: string; claudeDir: string; codegraph: string | null }> } {
  const source = `import { ENV_NAMES, resolveEnv } from ${JSON.stringify(pathToFileURL(path.join(KIT, "lib/envs.mjs")).href)};
console.log(JSON.stringify({ names: ENV_NAMES, paths: Object.fromEntries(ENV_NAMES.map(name => [name, resolveEnv(name, "/tmp/home")])) }));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...extra },
  }));
}

describe("public environment configuration", () => {
  it("exposes_only_system_and_default_without_an_explicit_second_agent", () => {
    const result = environments();
    expect(result.names).toEqual(["system", "default"]);
    expect(result.paths["system"]).toMatchObject({ agentDir: "/tmp/home/.omo/agent", memoryHome: "/tmp/home/.omo/memory", claudeDir: "/tmp/home/.claude", codegraph: null });
    expect(result.paths["default"]).toMatchObject({ agentDir: "/tmp/home/.omo/agent" });
    expect(environments({ OMO_KIT_SECOND_CLAUDE_DIR: "other" }).names).not.toContain("second");
  });

  it("resolves_absolute_and_home_relative_second_paths", () => {
    const result = environments({
      OMO_KIT_SECOND_AGENT_DIR: "/tmp/separate/agent",
      OMO_KIT_SECOND_MEMORY_HOME: "memory",
      OMO_KIT_SECOND_CLAUDE_DIR: "/tmp/separate/claude",
      OMO_KIT_SECOND_CODEGRAPH: "bin/codegraph",
    });
    expect(result.names).toContain("second");
    expect(result.paths["second"]).toMatchObject({ agentDir: "/tmp/separate/agent", memoryHome: "/tmp/home/memory", claudeDir: "/tmp/separate/claude", codegraph: "/tmp/home/bin/codegraph" });
    expect(environments({ OMO_KIT_SECOND_AGENT_DIR: ".omo-second/agent" }).paths["second"]).toMatchObject({ agentDir: "/tmp/home/.omo-second/agent", memoryHome: "/tmp/home/.omo-second/memory", claudeDir: "/tmp/home/.omo-second/claude", codegraph: null });
  });
});
