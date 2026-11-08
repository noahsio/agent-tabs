import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProfile, profilePath } from "../../kit/sandbox/profile.mjs";
import { refreshProfile, sandboxLayers, setSandboxLayer, type ProtectionDeps } from "../../src/guard/protection";
import { envPaths, type EnvPaths } from "../../src/settings/paths";
import { KIT } from "../kit/helpers";

let home: string;
let paths: EnvPaths;
let deps: ProtectionDeps;
let calls: string[];
const inputs = (): string => path.join(paths.guardDir, "sandbox.json");

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "layer-store-")));
  paths = envPaths({ env: { CLAUDE_CONFIG_DIR: path.join(home, "claude-config") }, agentDir: path.join(home, "agent"), omoPath: "/x/omo", secrets: [] }, home);
  calls = [];
  deps = {
    uid: 501,
    kitDir: KIT,
    workspaceFolders: [],
    vscode: { appRoot: "/fixture/Editor.app", userDataDir: "/fixture/data", userSettings: "/fixture/data/User/settings.json", extensionsDir: "/fixture/ext" },
    loginPath: async () => [],
    launchctl: async () => { throw new Error("unexpected launchctl"); },
    waitForSocket: async () => { throw new Error("unexpected socket probe"); },
    removeFile: async () => { throw new Error("unexpected removal"); },
    writeFile: async (file, content, mode) => {
      calls.push("profile");
      fs.writeFileSync(file, content, { mode });
    },
    restartHost: async () => { calls.push("restart"); },
  };
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("sandbox layer choice", () => {
  it("absent inputs mean all on and setting an enabled default is a no-op", async () => {
    expect(sandboxLayers(paths.agentDir)).toEqual({ launch: true, agentCode: true, localServices: true });
    await setSandboxLayer(paths, deps, "launch", true);
    expect(fs.existsSync(inputs())).toBe(false);
    expect(calls).toEqual([]);
  });

  it("off stores a private choice without creating a profile or restarting", async () => {
    await setSandboxLayer(paths, deps, "launch", false);
    expect(JSON.parse(fs.readFileSync(inputs(), "utf8"))).toEqual({
      vscodeInstalls: [], writableDirs: [], layers: { launch: false, agentCode: true, localServices: true },
    });
    expect(fs.statSync(inputs()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(profilePath(paths.agentDir))).toBe(false);
    expect(calls).toEqual([]);
    const modified = fs.statSync(inputs()).mtimeMs;
    await setSandboxLayer(paths, deps, "launch", false);
    expect(fs.statSync(inputs()).mtimeMs).toBe(modified);
  });

  it("on rewrites the profile before restarting and repeating the choice does nothing", async () => {
    fs.mkdirSync(paths.guardDir, { recursive: true });
    fs.writeFileSync(inputs(), JSON.stringify({ vscodeInstalls: [deps.vscode], writableDirs: ["/fixture/bin"] }));
    fs.writeFileSync(profilePath(paths.agentDir), "old profile");
    await setSandboxLayer(paths, deps, "agentCode", false);
    const expected = buildProfile({
      home, agentDir: paths.agentDir, envs: [{ agentDir: paths.agentDir, claudeDir: paths.claudeDir }],
      vscodes: [deps.vscode], writableDirs: ["/fixture/bin"], layers: { launch: true, agentCode: false, localServices: true },
    });
    expect(fs.readFileSync(profilePath(paths.agentDir), "utf8")).toBe(expected);
    expect(calls).toEqual(["profile", "restart"]);
    calls = [];
    await setSandboxLayer(paths, deps, "agentCode", false);
    expect(calls).toEqual([]);
    refreshProfile(paths, { ...deps.vscode, userSettings: "/fixture/another/settings.json" });
    expect(sandboxLayers(paths.agentDir)).toEqual({ launch: true, agentCode: false, localServices: true });
    expect(fs.readFileSync(profilePath(paths.agentDir), "utf8")).not.toContain('(regex #"/\\.mcp\\.json$")');
  });

  it.each([null, {}, { launch: "no", agentCode: true, localServices: true }])("rejects malformed stored layers: %j", (layers) => {
    fs.mkdirSync(paths.guardDir, { recursive: true });
    fs.writeFileSync(inputs(), JSON.stringify({ vscodeInstalls: [], writableDirs: [], layers }));
    expect(() => sandboxLayers(paths.agentDir)).toThrow("не тот формат");
  });
});
