import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { launchAgentPath, launchAgentPlist, serviceLabel } from "../../src/guard/launchAgent";

const spec = {
  label: "local.agent-tabs.guard.0123abcd",
  node: "/opt/homebrew/bin/node",
  serviceScript: "/Users/me/.omo/kit/abc/guard/service.mjs",
  agentDir: "/Users/me/.omo/agent",
  logFile: "/Users/me/.omo/agent/guard/service.log",
};

describe("launch agent", () => {
  it("plist_runs_the_service_for_one_agent_dir", () => {
    const plist = launchAgentPlist(spec);
    expect(plist).toContain(`<string>${spec.serviceScript}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(serviceLabel("/a")).toMatch(/^local\.agent-tabs\.guard\.[0-9a-f]{8}$/);
    expect(serviceLabel("/a")).not.toBe(serviceLabel("/b"));
    expect(launchAgentPath("/Users/me", spec.label)).toBe(`/Users/me/Library/LaunchAgents/${spec.label}.plist`);
  });

  it.runIf(process.platform === "darwin")("plist_parses_with_the_exact_arguments_even_with_xml_characters", () => {
    const odd = { ...spec, agentDir: "/Users/me/a <b> & \"c\"" };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "plist-")), "x.plist");
    fs.writeFileSync(file, launchAgentPlist(odd));
    const parsed = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    expect(parsed.Label).toBe(odd.label);
    expect(parsed.ProgramArguments).toEqual([odd.node, odd.serviceScript, "--agent-dir", odd.agentDir]);
    expect(parsed.KeepAlive).toBe(true);
    expect(parsed.RunAtLoad).toBe(true);
    expect(parsed.StandardErrorPath).toBe(odd.logFile);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
