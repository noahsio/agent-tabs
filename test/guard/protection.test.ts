import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFilesDir } from "../../kit/guard/lifecycle.mjs";
import { hostSocketPath, profilePath, protectedHostPidPath, protectedHostSocketPath } from "../../kit/sandbox/profile.mjs";
import { launchAgentPath, serviceLabel } from "../../src/guard/launchAgent";
import {
  chooseServiceNode,
  disableProtection,
  enableProtection,
  installedKit,
  protectionState,
  protectionStatus,
  refreshProfile,
  refreshProtection,
  hostRestarter,
  isSandboxed,
  systemProtectionDeps,
  waitForSocket,
  type ProtectionDeps,
  type VscodePaths,
  loginPathDenies,
  plannedWriteDenies,
  writablePrefix,
} from "../../src/guard/protection";
import { envPaths, type EnvPaths } from "../../src/settings/paths";
import { KIT, writeSuperpowersManifests } from "../kit/helpers";

type Handler = { type: string; command: string; timeout?: number };
type Group = { matcher?: string; hooks: Handler[] };

let root: string;
let paths: EnvPaths;
let vscode: VscodePaths;
let calls: string[];
let seen: Set<string>;
let service: ChildProcess | undefined;
let deps: ProtectionDeps;
let userBin: string;
let nodeBin: string;

const exists = (file: string): boolean => fs.existsSync(file);
const hooksJson = (): { hooks: Record<string, Group[]> } =>
  exists(paths.hooksJson) ? JSON.parse(fs.readFileSync(paths.hooksJson, "utf8")) : { hooks: {} };
const ourGroups = (event = "PreToolUse"): Group[] =>
  (hooksJson().hooks[event] ?? []).filter((group) => group.hooks.some((handler) => handler.command.includes("/guard/hook.mjs")));
const plistFile = (): string => launchAgentPath(paths.home, serviceLabel(paths.agentDir));
const rulesFile = (): string => path.join(paths.guardDir, "rules.json");
const inputs = (): string => path.join(paths.guardDir, "sandbox.json");
const kitInstalled = (): boolean =>
  exists(path.join(paths.home, ".omo/kit")) &&
  fs.readdirSync(path.join(paths.home, ".omo/kit")).some((hash) => exists(path.join(paths.home, ".omo/kit", hash, "guard/service.mjs")));

/** Steps that leave no deps call are read off the disk at the next deps call, so `calls` is the order things happened. */
function observe(): void {
  const states: [string, () => boolean][] = [
    ["kit", kitInstalled],
    ["hook", () => ourGroups().length > 0],
    ["dirs", () => exists(path.join(paths.agentDir, "extensions"))],
  ];
  for (const [name, test] of states) {
    if (!seen.has(name) && test()) {
      seen.add(name);
      calls.push(name);
    }
  }
}

const isWrite = (call: string): boolean => !["kit", "hook", "dirs", "socket", "restart"].includes(call);

/** As launchd's bootout: SIGTERM, then wait for the exit (the service releases its lock on the way out). */
async function stopService(): Promise<void> {
  const running = service;
  service = undefined;
  if (running === undefined || running.exitCode !== null) return;
  const exited = new Promise((resolve) => running.once("exit", resolve));
  running.kill("SIGTERM");
  await exited;
}

/** launchd look-alike: bootstrap runs the plist's ProgramArguments as they are (the installed kit copy). */
function startFromPlist(file: string): void {
  const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
  const [program, ...args] = plist.ProgramArguments as string[];
  service = spawn(program as string, args, { env: { PATH: process.env.PATH ?? "", HOME: paths.home }, stdio: "ignore" });
}

/** Files the lifecycle owns: name -> content. */
function snapshot(): Record<string, string> {
  const files = [paths.hooksJson, path.join(paths.agentDir, "hooks-state.json"), rulesFile(), plistFile(), profilePath(paths.agentDir), inputs()];
  return Object.fromEntries(files.filter(exists).map((file) => [file, fs.readFileSync(file, "utf8")]));
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync("/tmp/agp-"));
  const home = path.join(root, "h");
  const agentDir = path.join(home, ".omo/agent");
  fs.mkdirSync(agentDir, { recursive: true });
  paths = envPaths({ env: {}, agentDir, omoPath: "/x/omo", secrets: [] }, home);
  const userDataDir = path.join(root, "Code");
  vscode = {
    appRoot: path.join(root, "VS Code.app"),
    userDataDir,
    userSettings: path.join(userDataDir, "User/settings.json"),
    extensionsDir: path.join(home, ".vscode/extensions"),
  };
  // a dir of the person's on the login PATH (P33), next to the node the tests run with
  userBin = path.join(root, "bin");
  fs.mkdirSync(userBin);
  nodeBin = path.join(root, "nodebin"); // a PATH dir of the person's whose node links to the one the tests run with
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, "node"));
  calls = [];
  seen = new Set();
  deps = {
    uid: 501,
    kitDir: KIT,
    vscode,
    loginPath: async () => [nodeBin, userBin, home],
    workspaceFolders: [],
    launchctl: async (args) => {
      observe();
      calls.push(args[0] as string);
      if (args[0] === "bootout") await stopService();
      if (args[0] === "bootstrap") startFromPlist(args[2] as string);
    },
    writeFile: async (file, content, mode) => {
      observe();
      const name = file === plistFile() ? "plist" : file === profilePath(paths.agentDir) ? "profile" : file === rulesFile() ? "rules" : `write ${file}`;
      calls.push(name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode });
    },
    removeFile: async (file) => {
      observe();
      calls.push(`remove ${path.basename(file)}`);
      fs.rmSync(file, { force: true });
    },
    restartHost: async () => {
      observe();
      calls.push("restart");
    },
    waitForSocket: async (file, ms) => {
      observe();
      calls.push("socket");
      return waitForSocket(file, ms);
    },
  };
});

afterEach(async () => {
  await stopService();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("protection lifecycle", () => {
  it("enable_runs_in_order_and_twice_is_a_no_op", async () => {
    await enableProtection(paths, deps);
    expect(calls).toEqual(["rules", "kit", "plist", "bootout", "bootstrap", "socket", "hook", "dirs", "profile", "restart"]);
    expect(await protectionState(paths, vscode)).toBe("on");
    expect(fs.statSync(path.join(paths.agentDir, "extensions")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(paths.guardDir, "host")).isDirectory()).toBe(true);
    // P33: the person's PATH dirs are closed (home itself never is; the node they link to is nobody's to rewrite)
    expect(JSON.parse(fs.readFileSync(inputs(), "utf8")).writableDirs).toEqual([userBin, nodeBin]);
    expect(fs.readFileSync(profilePath(paths.agentDir), "utf8")).toContain(`(subpath "${userBin}")`);

    const before = snapshot();
    calls = [];
    await enableProtection(paths, deps);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(calls).toContain("restart"); // an explicit enable always leaves a host started under the profile
  });

  it("the_installed_hook_answers_both_events", async () => {
    await enableProtection(paths, deps);
    expect(ourGroups("PreToolUse")).toHaveLength(1);
    expect(ourGroups("SessionStart")).toHaveLength(1);
    const command = ourGroups("SessionStart")[0]!.hooks[0]!.command;
    expect(command.startsWith(`'${fs.realpathSync(process.execPath)}' '${path.join(paths.home, ".omo/kit")}`)).toBe(true);
    const out = spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: root }),
      encoding: "utf8",
    });
    const context = JSON.parse(out.stdout).hookSpecificOutput;
    expect(context.hookEventName).toBe("SessionStart");
    expect(context.additionalContext).toContain("--disable-sandbox");
    expect(context.additionalContext).toContain("-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePackageSandbox=YES");
    expect(context.additionalContext).toContain("git clone");
    // the PreToolUse side reaches the live service through the hook socket
    const pre = spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "rm -rf /" }, cwd: root, session_id: "s" }),
      encoding: "utf8",
    });
    const decision = JSON.parse(pre.stdout).hookSpecificOutput;
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).not.toContain("не запущена");
  });

  it("a_service_that_does_not_come_up_leaves_protection_off", async () => {
    deps.waitForSocket = async () => false;
    await expect(enableProtection(paths, deps)).rejects.toThrow(/служба защиты не запустилась/i);
    expect(exists(profilePath(paths.agentDir))).toBe(false);
    expect(ourGroups()).toHaveLength(0);
    expect(calls).not.toContain("restart");
    expect(calls.slice(-2)).toEqual(["bootout", `remove ${path.basename(plistFile())}`]);
    expect(exists(plistFile())).toBe(false);
    expect(await protectionState(paths, vscode)).toBe("off");
  });

  it("on_needs_the_running_host_to_be_sandboxed", async () => {
    await enableProtection(paths, deps);
    const listen = async (file: string): Promise<net.Server> => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(file, resolve));
      return server;
    };
    // a protected host recorded in guard/host whose process is not under the profile
    const host = await listen(protectedHostSocketPath(paths.agentDir));
    fs.writeFileSync(protectedHostPidPath(paths.agentDir), String(process.pid));
    try {
      expect(await protectionStatus(paths, vscode, { sandboxed: async () => false })).toEqual({
        state: "broken",
        reason: expect.stringContaining(`pid ${process.pid}`),
      });
      expect(await protectionStatus(paths, vscode, { sandboxed: async (pid) => pid === process.pid })).toEqual({ state: "on" });
    } finally {
      await new Promise((resolve) => host.close(resolve));
    }
    // a host answering on the unprotected socket (a window still on 0.2.x): broken, whatever the pid file says
    const plain = await listen(hostSocketPath(paths.agentDir));
    try {
      expect(await protectionStatus(paths, vscode, { sandboxed: async () => true })).toEqual({
        state: "broken",
        reason: expect.stringContaining("без песочницы"),
      });
    } finally {
      await new Promise((resolve) => plain.close(resolve));
    }
  });

  it.runIf(process.platform === "darwin")("sandbox_check_tells_a_sandboxed_process_from_ours", async () => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/sleep", "20"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // sandbox-exec has applied the profile and exec'd sleep
      expect(await isSandboxed(child.pid as number)).toBe(true);
      expect(await isSandboxed(process.pid)).toBe(false);
    } finally {
      child.kill();
    }
  });

  it("a_silent_service_is_broken", async () => {
    await enableProtection(paths, deps);
    await stopService();
    expect(await protectionState(paths, vscode)).toBe("broken");
  });

  it("broken_says_why", async () => {
    await enableProtection(paths, deps);
    expect(await protectionStatus(paths, vscode)).toEqual({ state: "on" });
    const profile = profilePath(paths.agentDir);
    const good = fs.readFileSync(profile, "utf8");
    const hooksText = fs.readFileSync(paths.hooksJson, "utf8");
    const node = fs.realpathSync(process.execPath);

    // the hook names a node that is gone (a Node.js upgrade removed it)
    fs.writeFileSync(paths.hooksJson, hooksText.split(`'${node}'`).join(`'${path.join(root, "gone/node")}'`));
    expect(await protectionStatus(paths, vscode)).toEqual({ state: "broken", reason: expect.stringContaining(path.join(root, "gone/node")) });
    fs.writeFileSync(paths.hooksJson, hooksText);

    // the installed kit copy the hook runs is gone
    const command = ourGroups()[0]!.hooks[0]!.command;
    const kitGuard = path.dirname(/'([^']*\/hook\.mjs)'/.exec(command)![1]!);
    fs.renameSync(kitGuard, `${kitGuard}.moved`);
    expect(await protectionStatus(paths, vscode)).toEqual({ state: "broken", reason: expect.stringContaining(kitGuard) });
    fs.renameSync(`${kitGuard}.moved`, kitGuard);

    fs.writeFileSync(profile, good.replace("(deny lsopen)", ""));
    expect(await protectionStatus(paths, vscode)).toEqual({ state: "broken", reason: expect.stringContaining("профиль песочницы") });
    fs.writeFileSync(profile, good);

    await stopService();
    expect(await protectionStatus(paths, vscode)).toEqual({ state: "broken", reason: expect.stringContaining("не отвечает") });
  });

  it("a_leftover_v1_hook_alone_is_off_with_a_note_and_enable_replaces_it", async () => {
    const v1 = `'${process.execPath}' '${path.join(paths.home, ".omo/kit/abc123def456/guard/agent-guard.mjs")}'`;
    fs.writeFileSync(paths.hooksJson, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: v1 }] }] } }));
    expect(await protectionStatus(paths, vscode)).toEqual({ state: "off", note: "найдена старая защита v1 — включите защиту, чтобы заменить её" });
    await enableProtection(paths, deps);
    expect(await protectionStatus(paths, vscode)).toEqual({ state: "on" });
    expect(fs.readFileSync(paths.hooksJson, "utf8")).not.toContain("agent-guard.mjs");
  });

  it("a_window_without_a_host_fails_the_switch_instead_of_reporting_success", async () => {
    let restarted = 0;
    await expect(hostRestarter(() => ({ ok: false, error: "Не заданы переменные: OMO_CODING_AGENT_DIR" }))()).rejects.toThrow(/Не заданы переменные/);
    await hostRestarter(() => ({ ok: true, value: { restartHost: async () => void (restarted += 1) } }))();
    expect(restarted).toBe(1);
    await enableProtection(paths, deps);
    deps.restartHost = hostRestarter(() => ({ ok: false, error: "Не заданы переменные: OMO_CODING_AGENT_DIR" }));
    await expect(disableProtection(paths, deps)).rejects.toThrow(/Не заданы переменные/);
  });

  it("system_deps_need_a_real_uid", () => {
    const getuid = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      expect(() => systemProtectionDeps({ kitDir: KIT, vscode, workspaceFolders: [], restartHost: async () => undefined })).toThrow(/uid/);
    } finally {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true });
    }
    expect(systemProtectionDeps({ kitDir: KIT, vscode, workspaceFolders: [], restartHost: async () => undefined }).uid).toBe(process.getuid?.());
  });

  it("two_vscode_installs_build_the_same_profile_and_both_see_on", async () => {
    await enableProtection(paths, deps);
    const other: VscodePaths = {
      appRoot: path.join(root, "Portable.app"),
      userDataDir: path.join(root, "portable/user-data"),
      userSettings: path.join(root, "portable/user-data/User/settings.json"),
      extensionsDir: path.join(root, "portable/extensions"),
    };
    refreshProfile(paths, other); // the other VS Code's window starts
    const written = fs.readFileSync(profilePath(paths.agentDir), "utf8");
    expect(written).toContain(`(subpath "${other.extensionsDir}")`);
    expect(written).toContain(`(subpath "${vscode.extensionsDir}")`);
    expect(await protectionState(paths, vscode)).toBe("on");
    expect(await protectionState(paths, other)).toBe("on");
    refreshProfile(paths, vscode);
    refreshProfile(paths, other);
    expect(fs.readFileSync(profilePath(paths.agentDir), "utf8")).toBe(written); // no flip-flop
  });

  it("the_consent_list_is_what_enable_closes_and_a_workspace_file_closes_alone", async () => {
    const project = path.join(root, "proj");
    fs.mkdirSync(path.join(project, "bin"), { recursive: true });
    fs.writeFileSync(path.join(project, "bin/tool"), "", { mode: 0o755 });
    fs.symlinkSync(path.join(project, "bin/tool"), path.join(userBin, "tool"));
    deps.workspaceFolders = [project];
    const planned = await plannedWriteDenies(paths, deps);
    expect(planned).toContain(path.join(project, "bin/tool"));
    expect(planned.some((dir) => project.startsWith(dir + path.sep) || dir === project)).toBe(false);
    await enableProtection(paths, deps);
    expect(JSON.parse(fs.readFileSync(inputs(), "utf8")).writableDirs).toEqual(planned);
  });

  it("the_consent_list_names_the_superpowers_clone_and_the_skills_dirs_omo_loads_and_the_profile_closes_them", async () => {
    const clone = path.join(paths.home, ".omo/superpowers");
    fs.mkdirSync(path.join(clone, "skills"), { recursive: true });
    writeSuperpowersManifests(clone);
    const teamSkills = path.join(root, "proj/team-skills");
    fs.mkdirSync(teamSkills, { recursive: true });
    fs.writeFileSync(path.join(paths.agentDir, "settings.json"), JSON.stringify({ packages: [clone], skills: [teamSkills] }));
    const planned = await plannedWriteDenies(paths, deps);
    expect(planned).toEqual(expect.arrayContaining([clone, teamSkills]));
    await enableProtection(paths, deps);
    const profile = fs.readFileSync(profilePath(paths.agentDir), "utf8");
    for (const dir of [clone, teamSkills]) expect(profile).toContain(`(subpath "${dir}")`);
  });

  it("no_node_stops_before_anything_is_written", async () => {
    deps.loginPath = async () => [userBin];
    await expect(enableProtection(paths, deps)).rejects.toThrow(/не найден node/i);
    expect(calls).toEqual([]);
    expect(exists(rulesFile())).toBe(false);
    expect(kitInstalled()).toBe(false);
  });

  it("disable_removes_hook_profile_and_plist", async () => {
    await enableProtection(paths, deps);
    calls = [];
    await disableProtection(paths, deps);
    expect(calls).toEqual(["remove sandbox.sb", "bootout", `remove ${path.basename(plistFile())}`, "restart"]);
    expect(await protectionState(paths, vscode)).toBe("off");
    expect(ourGroups("PreToolUse")).toHaveLength(0);
    expect(ourGroups("SessionStart")).toHaveLength(0);
    expect(exists(plistFile())).toBe(false);
    expect(exists(rulesFile())).toBe(true); // the person's rules stay

    const before = snapshot();
    calls = [];
    await disableProtection(paths, deps);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it("disable_clears_whatever_sits_at_the_unprotected_host_socket_before_the_restart", async () => {
    await enableProtection(paths, deps);
    const plain = hostSocketPath(paths.agentDir);
    fs.symlinkSync(path.join(root, "fake-host.sock"), plain); // planted while protected (by anything outside the sandbox)
    let atRestart: boolean | undefined;
    deps.restartHost = async () => {
      atRestart = fs.existsSync(plain) || fs.lstatSync(plain, { throwIfNoEntry: false }) !== undefined;
    };
    await disableProtection(paths, deps);
    expect(atRestart).toBe(false);
    expect(calls).toContain("remove agent-tabs.sock");
  });

  it("enable_makes_the_dirs_a_sandboxed_host_cannot", async () => {
    await enableProtection(paths, deps);
    for (const dir of ["extensions", "rpc", "guard/host"]) expect(fs.statSync(path.join(paths.agentDir, dir)).isDirectory(), dir).toBe(true);
  });

  it("a_stale_unreadable_or_partial_profile_is_broken_and_regenerated", async () => {
    await enableProtection(paths, deps);
    const profile = profilePath(paths.agentDir);
    const good = fs.readFileSync(profile, "utf8");

    fs.writeFileSync(profile, good.replace("(deny lsopen)", ""));
    expect(await protectionState(paths, vscode)).toBe("broken");
    refreshProfile(paths, vscode);
    expect(fs.readFileSync(profile, "utf8")).toBe(good);
    expect(await protectionState(paths, vscode)).toBe("on");

    // another VS Code: the profile takes it in at the next refresh
    const moved = { ...vscode, appRoot: path.join(root, "Other.app") };
    expect(await protectionState(paths, moved)).toBe("broken");
    refreshProfile(paths, moved);
    expect(await protectionState(paths, moved)).toBe("on");

    fs.chmodSync(profile, 0o000);
    expect(await protectionState(paths, moved)).toBe("broken");
    fs.chmodSync(profile, 0o644);

    fs.rmSync(plistFile());
    expect(await protectionState(paths, moved)).toBe("broken");
  });

  it("refresh_never_creates_a_profile_when_protection_is_off", async () => {
    refreshProfile(paths, vscode);
    expect(exists(profilePath(paths.agentDir))).toBe(false);
    expect(await protectionState(paths, vscode)).toBe("off");
  });

  it("v1_rules_are_migrated_and_v2_rules_are_kept", async () => {
    fs.mkdirSync(paths.guardDir, { recursive: true });
    fs.writeFileSync(rulesFile(), JSON.stringify({ version: 1, hardDeny: ["rm -rf /"], escalate: [], ipWhitelist: ["10.1.2.3"], decider: { enabled: false }, human: { waitSeconds: 120 } }));
    await enableProtection(paths, deps);
    const migrated = JSON.parse(fs.readFileSync(rulesFile(), "utf8"));
    expect(migrated.version).toBe(2);
    expect(migrated.decider.mode).toBe("ask-me");

    const kept = JSON.stringify({ ...migrated, hardDeny: ["git push --force"] }, null, 2);
    fs.writeFileSync(rulesFile(), kept);
    await disableProtection(paths, deps);
    await enableProtection(paths, deps);
    expect(fs.readFileSync(rulesFile(), "utf8")).toBe(kept);
  }, 20_000);

  it("the_profile_names_the_real_agent_dir", async () => {
    const link = path.join(root, "link");
    fs.symlinkSync(paths.agentDir, link);
    paths = envPaths({ env: {}, agentDir: link, omoPath: "/x/omo", secrets: [] }, paths.home);
    await enableProtection(paths, deps);
    const text = fs.readFileSync(profilePath(link), "utf8");
    expect(text).toContain(`(subpath "${path.join(fs.realpathSync(link), "guard")}")`);
    expect(text).toContain(`(subpath "${path.join(link, "guard")}")`);
  });
});

/**
 * The guard the person runs is the installed copy, not the extension's own files: an update that only changes
 * `kit/guard` leaves them on the copy protection was turned on with until something brings it forward.
 */
describe("the installed guard copy follows the extension", () => {
  /** The kit this «extension» ships, editable: an update to it is what the refresh has to notice. */
  let bundled: string;
  let planned: number;

  beforeEach(() => {
    bundled = path.join(root, "kit");
    fs.cpSync(KIT, bundled, { recursive: true });
    deps.kitDir = bundled;
    planned = 0;
    const loginPath = deps.loginPath;
    deps.loginPath = async () => {
      planned += 1;
      return loginPath();
    };
  });

  const source = (): string => path.join(bundled, "guard");
  /** The extension is updated: one guard file changes, so the content hash — and the installed dir — change with it. */
  const update = (): void => fs.appendFileSync(path.join(source(), "classify.mjs"), "\n// the extension was updated\n");
  const running = (): string => path.dirname(/'([^']*\/hook\.mjs)'/.exec(ourGroups()[0]!.hooks[0]!.command)![1]!);
  const shipped = (): string => guardFilesDir(paths.home, source());
  /** The first service start fails; the one that puts the previous service back does not. */
  const serviceWontStart = (): void => {
    const real = deps.waitForSocket;
    let failed = false;
    deps.waitForSocket = async (file, ms) => {
      if (failed) return real(file, ms);
      failed = true;
      calls.push("socket");
      return false;
    };
  };

  it("a_stale_copy_is_brought_forward_at_activation_without_restarting_the_host", async () => {
    await enableProtection(paths, deps);
    const before = running();
    const denies = JSON.parse(fs.readFileSync(inputs(), "utf8")).writableDirs;
    update();
    expect(running()).toBe(before); // nothing refreshes it by itself: this is the bug
    expect(installedKit(paths, source())).toEqual({ dir: before, installedAt: expect.any(Number), stale: true });

    calls = [];
    planned = 0;
    deps.loginPath = async () => {
      planned += 1;
      return [nodeBin, userBin, paths.home, path.join(root, "later")]; // the PATH grew since the person consented
    };
    expect(await refreshProtection(paths, deps)).toEqual({ kind: "refreshed", kitDir: shipped() });

    expect(running()).toBe(shipped());
    expect(ourGroups("SessionStart")[0]!.hooks[0]!.command).toContain(shipped());
    expect(fs.readFileSync(plistFile(), "utf8")).toContain(path.join(shipped(), "service.mjs"));
    expect(fs.readFileSync(path.join(shipped(), "classify.mjs"), "utf8")).toContain("the extension was updated");
    expect(calls).toContain("bootstrap"); // the service runs the new code
    expect(calls).not.toContain("restart"); // nobody's turn is interrupted: the sandbox profile did not change
    expect(await protectionState(paths, vscode)).toBe("on");
    expect(installedKit(paths, source())).toEqual({ dir: shipped(), installedAt: expect.any(Number), stale: false });
    // what the person consented to close stays as it was, and the login shell is never run for a refresh
    expect(JSON.parse(fs.readFileSync(inputs(), "utf8")).writableDirs).toEqual(denies);
    expect(planned).toBe(0);
    // the copy a session already started with keeps working until that session ends
    expect(exists(path.join(before, "hook.mjs"))).toBe(true);
  }, 20_000);

  it("an_up_to_date_copy_is_left_alone", async () => {
    await enableProtection(paths, deps);
    const before = snapshot();
    calls = [];
    expect(await refreshProtection(paths, deps)).toEqual({ kind: "fresh" });
    expect(calls).toEqual([]); // no launchctl, no host restart, nothing written
    expect(snapshot()).toEqual(before);
    expect(await protectionState(paths, vscode)).toBe("on");
  });

  it("a_drifted_plist_or_hook_entry_is_refreshed_too", async () => {
    await enableProtection(paths, deps);
    const good = fs.readFileSync(plistFile(), "utf8");
    fs.writeFileSync(plistFile(), good.replace("<key>KeepAlive</key>", "<key>Disabled</key>\n  <false/>\n  <key>KeepAlive</key>"));
    expect(await refreshProtection(paths, deps)).toEqual({ kind: "refreshed", kitDir: shipped() });
    expect(fs.readFileSync(plistFile(), "utf8")).toBe(good);

    // the hook entry is ours but not what this version writes (an older timeout)
    const text = fs.readFileSync(paths.hooksJson, "utf8");
    fs.writeFileSync(paths.hooksJson, text.replace(/"timeout": \d+/g, '"timeout": 60'));
    expect(await refreshProtection(paths, deps)).toEqual({ kind: "refreshed", kitDir: shipped() });
    expect(fs.readFileSync(paths.hooksJson, "utf8")).toBe(text);
  }, 20_000);

  it("two_windows_activating_at_once_refresh_once", async () => {
    await enableProtection(paths, deps);
    update();
    calls = [];
    const outcomes = await Promise.all([refreshProtection(paths, deps), refreshProtection(paths, deps)]);
    expect(calls.filter((call) => call === "bootstrap")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "refreshed")).toEqual([{ kind: "refreshed", kitDir: shipped() }]);
    // the window that did not get the lock either waited for nothing or found it already done
    expect(["elsewhere", "fresh"]).toContain(outcomes.find((outcome) => outcome.kind !== "refreshed")?.kind);
    expect(running()).toBe(shipped());
    expect(await protectionState(paths, vscode)).toBe("on");
  }, 20_000);

  it("a_failed_refresh_says_why_and_leaves_the_old_copy_running", async () => {
    await enableProtection(paths, deps);
    const before = running();
    update();
    serviceWontStart();
    const outcome = await refreshProtection(paths, deps);
    expect(outcome).toEqual({ kind: "failed", reason: expect.stringMatching(/служба защиты не запустилась/i) });
    // the pair agrees again: the plist runs the copy the hook names, and that service answers
    expect(running()).toBe(before);
    expect(fs.readFileSync(plistFile(), "utf8")).toContain(path.join(before, "service.mjs"));
    expect(await protectionState(paths, vscode)).toBe("on");
    expect(installedKit(paths, source())?.stale).toBe(true);
  }, 20_000);

  it("protection_off_means_no_refresh_at_all", async () => {
    expect(await refreshProtection(paths, deps)).toEqual({ kind: "absent" });
    expect(installedKit(paths, source())).toBeUndefined();
    // a leftover v1 hook is not an installation of ours either
    const v1 = `'${process.execPath}' '${path.join(paths.home, ".omo/kit/abc123def456/guard/agent-guard.mjs")}'`;
    fs.writeFileSync(paths.hooksJson, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: v1 }] }] } }));
    expect(await refreshProtection(paths, deps)).toEqual({ kind: "absent" });
    expect(installedKit(paths, source())).toBeUndefined();

    await enableProtection(paths, deps);
    await disableProtection(paths, deps);
    update();
    calls = [];
    expect(await refreshProtection(paths, deps)).toEqual({ kind: "absent" });
    expect(calls).toEqual([]);
    expect(exists(plistFile())).toBe(false);
  }, 20_000);
});

describe("service node and login PATH (P33, N4)", () => {
  const guardOf = (home: string, ...keep: string[]): { home: string; keep: string[] } => ({ home, keep: [home, ...keep] });

  it("a_node_nobody_can_rewrite_wins", () => {
    // real predicate: the temp copy is the person's, /bin/sh and everything above it are not
    const mine = path.join(root, "bin/node");
    fs.writeFileSync(mine, "", { mode: 0o755 });
    expect(chooseServiceNode([mine, "/bin/sh"], guardOf("/Users/me"))).toEqual({ node: "/bin/sh" });
  });

  it("only_a_writable_node_comes_with_its_prefix", () => {
    const brew = path.join(root, "opt/homebrew");
    const node = path.join(brew, "Cellar/node/22/bin/node");
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, "", { mode: 0o755 });
    fs.mkdirSync(path.join(brew, "bin"));
    fs.symlinkSync(node, path.join(brew, "bin/node"));
    const writable = (file: string): boolean => file.startsWith(brew);
    expect(chooseServiceNode([path.join(brew, "bin/node")], guardOf("/Users/me"), writable)).toEqual({ node, prefix: brew });
    expect(chooseServiceNode([path.join(root, "missing/node")], guardOf("/Users/me"), writable)).toBeUndefined();
  });

  it("a_prefix_under_home_is_a_tool_dir_never_home_a_project_dir_or_an_agent_dir", () => {
    const home = path.join(root, "home");
    const mine = (file: string): boolean => file.startsWith(root);
    const guard = guardOf(home, path.join(home, ".omo/agent"), path.join(home, ".omo-second/agent"));
    expect(writablePrefix(path.join(home, ".nvm/versions/node/v22/bin/node"), guard, mine)).toBe(path.join(home, ".nvm"));
    // ~/Documents holds the projects: only the file itself
    expect(writablePrefix(path.join(home, "Documents/dev/repo/bin/tool"), guard, mine)).toBe(path.join(home, "Documents/dev/repo/bin/tool"));
    // ~/.omo and ~/.cache hold agent dirs: narrowed below them
    expect(writablePrefix(path.join(home, ".omo/kit/abc/hooks/x"), guard, mine)).toBe(path.join(home, ".omo/kit"));
    expect(writablePrefix(path.join(home, ".omo-second/codegraph/bin/codegraph"), guard, mine)).toBe(path.join(home, ".omo-second/codegraph"));
    expect(writablePrefix("/usr/bin/git", guard, mine)).toBeUndefined();
  });

  it("a_path_dir_under_local_closes_at_its_own_path_never_the_whole_xdg_base", () => {
    // ~/.local is an XDG base dir: bin is on PATH, but state/share/lib hold data ordinary tools write
    // (CLI tools keep their state in ~/.local/state/<tool>). Closing the topmost writable dir would be
    // ~/.local whole — the P33 over-reach already fixed for ~/.cache. A PATH dir under it closes alone.
    const home = path.join(root, "home");
    const mine = (file: string): boolean => file.startsWith(root);
    const guard = guardOf(home, path.join(home, ".omo/agent"), path.join(home, ".omo-second/agent"));
    expect(writablePrefix(path.join(home, ".local/bin"), guard, mine)).toBe(path.join(home, ".local/bin"));
    expect(writablePrefix(path.join(home, ".local/share/pipx/bin"), guard, mine)).toBe(path.join(home, ".local/share/pipx/bin"));
  });

  it("login_path_dirs_under_local_close_specifically_not_the_whole_local_tree", () => {
    const home = path.join(root, "home");
    const binDir = path.join(home, ".local/bin");
    const pipxBin = path.join(home, ".local/share/pipx/bin");
    for (const dir of [binDir, pipxBin, path.join(home, ".local/state")]) fs.mkdirSync(dir, { recursive: true });
    const denies = loginPathDenies([binDir, pipxBin], guardOf(home), (file) => file.startsWith(home));
    expect(denies).toEqual([binDir, pipxBin].sort());
    expect(denies).not.toContain(path.join(home, ".local"));
  });

  it("every_login_path_entry_and_every_link_inside_closes_its_writable_prefix", () => {
    const home = path.join(root, "home");
    const brew = path.join(root, "opt/homebrew");
    const system = path.join(root, "usr/local/bin"); // not the person's
    const make = (file: string): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "", { mode: 0o755 });
    };
    make(path.join(brew, "Cellar/git/2/bin/git"));
    fs.mkdirSync(path.join(brew, "bin"), { recursive: true });
    fs.symlinkSync(path.join(brew, "Cellar/git/2/bin/git"), path.join(brew, "bin/git"));
    make(path.join(home, ".codegraph/bin/codegraph"));
    make(path.join(home, "Documents/repo/bin/tool"));
    make(path.join(system, "plain"));
    fs.symlinkSync(path.join(home, ".codegraph/bin/codegraph"), path.join(system, "codegraph"));
    fs.symlinkSync(path.join(home, "Documents/repo/bin/tool"), path.join(system, "tool"));
    fs.symlinkSync(path.join(home, ".later/bin/x"), path.join(system, "dangling"));
    const writable = (file: string): boolean => file.startsWith(brew) || file.startsWith(home);
    const dirs = [path.join(brew, "bin"), system, path.join(home, "go/bin"), home, "relative/bin"];
    expect(loginPathDenies(dirs, guardOf(home), writable)).toEqual(
      [
        brew,
        path.join(home, ".codegraph"),
        path.join(home, ".later"),
        path.join(home, "Documents/repo/bin/tool"),
        path.join(home, "go/bin"), // not there yet: nobody may create it
      ].sort(),
    );
  });
});

describe("what a login PATH link closes (P38)", () => {
  const make = (file: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", { mode: 0o755 });
  };
  let home: string;
  let system: string; // a PATH dir that is not the person's
  beforeEach(() => {
    home = path.join(root, "home");
    system = path.join(root, "usr/local/bin");
    fs.mkdirSync(system, { recursive: true });
  });
  const link = (target: string, name = path.basename(target)): void => fs.symlinkSync(target, path.join(system, name));
  const guard = (workspaces: string[] = []): { home: string; keep: string[]; workspaces: string[] } => ({ home, keep: [home], workspaces });

  it("a_link_into_a_git_work_tree_closes_only_the_file", () => {
    const tool = path.join(home, ".hidden/x/repo/bin/tool");
    make(tool);
    fs.mkdirSync(path.join(home, ".hidden/x/repo/.git"));
    link(tool);
    expect(loginPathDenies([system], guard(), (file) => file.startsWith(home))).toEqual([tool]);
  });

  it("a_link_into_an_app_bundle_closes_only_that_bundle_never_the_applications_dir", () => {
    const apps = path.join(root, "Applications"); // stand-in for /Applications, writable by an admin
    const foo = path.join(apps, "Foo.app/Contents/MacOS/foo");
    make(foo);
    make(path.join(apps, "Other.app/Contents/MacOS/other"));
    make(path.join(apps, "loose-tool"));
    link(foo);
    link(path.join(apps, "loose-tool"));
    expect(loginPathDenies([system], guard(), (file) => file.startsWith(apps))).toEqual([path.join(apps, "Foo.app"), path.join(apps, "loose-tool")]);
  });

  it("a_dir_holding_repos_or_a_workspace_folder_is_never_closed", () => {
    const tool = path.join(home, ".cache/tools/bin/x");
    make(tool);
    fs.mkdirSync(path.join(home, ".cache/dev/proj/.git"), { recursive: true });
    link(tool);
    const work = path.join(root, "work");
    const project = path.join(work, "proj");
    make(path.join(project, "bin/t"));
    make(path.join(work, "tools/bin/u"));
    link(path.join(project, "bin/t"));
    link(path.join(work, "tools/bin/u"));
    const writable = (file: string): boolean => file.startsWith(home) || file.startsWith(work);
    expect(loginPathDenies([system], guard([project]), writable)).toEqual(
      [path.join(home, ".cache/tools"), path.join(project, "bin/t"), path.join(work, "tools")].sort(),
    );
  });
});
