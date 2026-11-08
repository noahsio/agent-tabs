import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProfile, hostSocketPath, protectedHostSocketPath, realOf } from "../../kit/sandbox/profile.mjs";

let home: string;
let spec: Parameters<typeof buildProfile>[0];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-layers-")));
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ skills: ["../resources/skill"] }));
  fs.writeFileSync(path.join(home, ".zshrc"), "source ~/sourced.sh\n");
  spec = {
    home,
    agentDir,
    envs: [{ agentDir: path.join(home, "sibling"), claudeDir: path.join(home, "claude-config") }],
    writableDirs: [path.join(home, "login-bin")],
    vscodes: [{ appRoot: path.join(home, "Editor.app"), userDataDir: path.join(home, "editor-data"), extensionsDir: path.join(home, "editor-ext") }],
  };
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const allOn = { launch: true, agentCode: true, localServices: true };
const core = (): string[] => [
  ...["agent", "sibling"].flatMap((dir) => [
    ...["guard", "extensions", "keys", "agent-tabs"].map((name) => `(subpath "${home}/${dir}/${name}")`),
    ...["settings.json", "models.json", "mcp.json", "hooks.json", "hooks-state.json", "AGENTS.md"].map((name) => `(literal "${home}/${dir}/${name}")`),
    `(deny network-outbound (remote unix-socket (path-literal "${hostSocketPath(`${home}/${dir}`)}")))`,
    `(deny network-outbound (remote unix-socket (path-literal "${protectedHostSocketPath(`${home}/${dir}`)}")))`,
    `(deny network-outbound (remote unix-socket (path-literal "${home}/${dir}/guard/admin.sock")))`,
  ]),
  ...[".omo/kit", ".omo/binary-runtime", "Library/LaunchAgents"].map((dir) => `(subpath "${home}/${dir}")`),
  ...[".omo", ".omo/omo.jsonc"].map((file) => `(literal "${home}/${file}")`),
];

describe("sandbox layers", () => {
  it.each(["launch", "agentCode", "localServices"] as const)("turning %s off keeps core and the other layers", (layer) => {
    const profile = buildProfile({ ...spec, layers: { ...allOn, [layer]: false } });
    const rules = {
      launch: [
        ...[".local/bin", "login-bin", ".ssh", ".config/git", ".config/fish", "Editor.app", "editor-data", "editor-ext"].map((dir) => `(subpath "${home}/${dir}")`),
        ...[".gitconfig", ".zshrc", ".zshrc.zwc", "sourced.sh", "sourced.sh.zwc", "editor-data/User/settings.json", "argv.json"].map((file) => `(literal "${home}/${file}")`),
        '(regex #"/\\.git$")',
        '(regex #"/\\.git/(.*/)?(config(\\.worktree)?|hooks(/.*)?|commondir|gitdir)$")',
      ],
      agentCode: [
        ...["claude-config/plugins", "claude-config/hooks", "claude-config/commands", "claude-config/skills", "claude-config/agents", "resources/skill", ".omo/packages"].map((dir) => `(subpath "${home}/${dir}")`),
        `(literal "${home}/.claude.json")`,
        '(regex #"/\\.(omo|senpi|pi)$")',
        '(regex #"/\\.mcp\\.json$")',
        '(regex #"/\\.claude/(commands|skills|agents)(/|$)")',
      ],
      localServices: [
        `(subpath "${home}/.omo/lsp-daemon")`,
        '(deny network-outbound (remote tcp "localhost:22"))',
        "(deny lsopen)",
        "(deny appleevent-send)",
        "vscode-(git|ipc)",
        "-main\\\\.sock$",
        "/ide/[^/]*\\\\.lock$",
      ],
    };
    for (const rule of core()) expect(profile, rule).toContain(rule);
    for (const [owner, entries] of Object.entries(rules)) {
      for (const rule of entries) {
        if (owner === layer) expect(profile, rule).not.toContain(rule);
        else expect(profile, rule).toContain(rule);
      }
    }
    if (layer === "launch") {
      expect(profile).not.toContain("vnode-type SYMLINK");
      expect(profile).not.toContain("vnode-type SOCKET");
    }
  });

  it("all layers off leaves the core and its parent protection", () => {
    const profile = buildProfile({ ...spec, layers: { launch: false, agentCode: false, localServices: false } });
    for (const rule of core()) expect(profile, rule).toContain(rule);
    expect(profile).toContain(`(literal "${home}/Library")`);
    expect(profile).not.toContain("(regex ");
  });

  it("the omitted choice is the all-on profile", () => {
    expect(buildProfile(spec)).toBe(buildProfile({ ...spec, layers: allOn }));
  });

  it("temporary project regex allowances exclude every explicitly protected path", () => {
    const profile = buildProfile(spec);
    const allow = profile.slice(profile.indexOf("; temporary project files"), profile.indexOf("; end temporary project files"));
    expect(allow).toContain('(allow file-write* (require-all');
    for (const dir of new Set(["/private/tmp", realOf("/private/tmp"), os.tmpdir(), realOf(os.tmpdir())])) {
      expect(allow).toContain(`(subpath "${dir}")`);
    }
    expect(allow).toContain('(regex #"/\\.git$")');
    expect(allow).toContain('(regex #"/\\.(omo|senpi|pi)$")');
    expect(allow).toContain('(require-not (require-any');
    for (const rule of core().filter((rule) => !rule.startsWith("(deny "))) expect(allow, rule).toContain(rule);
    expect(allow).toContain(`(literal "${home}/Library")`);
    expect(profile.indexOf("; temporary project files")).toBeGreaterThan(profile.indexOf("(deny file-write*"));
  });

  it("an empty temporary directory list keeps project denies without an override", () => {
    const profile = buildProfile({ ...spec, tempDirs: [] });
    expect(profile).not.toContain("; temporary project files");
    expect(profile).toContain('(regex #"/\\.git$")');
    expect(profile).toContain('(regex #"/\\.(omo|senpi|pi)$")');
    expect(profile).toContain('(regex #"/\\.mcp\\.json$")');
    for (const rule of core()) expect(profile, rule).toContain(rule);
  });

  it("an explicit temporary root replaces the defaults and excludes core paths", () => {
    const profile = buildProfile({ ...spec, tempDirs: [home] });
    const allow = profile.slice(profile.indexOf("; temporary project files"), profile.indexOf("; end temporary project files"));
    expect(allow).toContain(`(require-any (subpath "${home}"))`);
    expect(allow).not.toContain('(subpath "/private/tmp")');
    expect(allow).not.toContain(`(subpath "${os.tmpdir()}")`);
    expect(allow).toContain('(regex #"/\\.git$")');
    expect(allow).toContain('(regex #"/\\.(omo|senpi|pi)$")');
    const exclusions = allow.slice(allow.indexOf("(require-not"));
    for (const rule of core().filter((rule) => !rule.startsWith("(deny "))) expect(exclusions, rule).toContain(rule);
  });

  it("IDE lock reads are denied for every Claude directory only with localServices", () => {
    const profile = buildProfile(spec);
    expect(profile).toContain("(deny file-read*");
    expect(profile).toContain(`${home}/claude-config/ide/[^/]*\\\\.lock$`);
    expect(profile).toContain(`${home}/\\\\.claude/ide/[^/]*\\\\.lock$`);
    expect(profile).toContain(`${home}/\\\\.omo-second/claude/ide/[^/]*\\\\.lock$`);
    expect(buildProfile({ ...spec, layers: { ...allOn, localServices: false } })).not.toContain("(deny file-read*");
  });
});
