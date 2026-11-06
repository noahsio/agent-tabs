import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEnv } from "../../kit/lib/envs.mjs";
import { buildProfile, hostSocketPath, loadedResourceDenies, lspDaemonDir, profilePath, protectedHostSocketPath, sourcedFiles } from "../../kit/sandbox/profile.mjs";
import { writeSuperpowersManifests } from "./helpers";

const darwin = process.platform === "darwin";
const run = promisify(execFile);

// Short real paths under /tmp: sockets need ≤ 103 bytes and Seatbelt matches resolved paths (/private/tmp).
let tmp: string;
let home: string;
let agentDir: string; // the profile's own environment ("system")
let otherAgentDir: string; // a sibling kit environment ("second")
let proj: string;
let repo: string;
let dotfiles: string;
let brewBin: string;
let current: { appRoot: string; userDataDir: string; userSettings: string; extensionsDir: string };
let spec: Parameters<typeof buildProfile>[0];
let profileFile: string;
const servers: net.Server[] = [];
const sockets: Record<string, string> = {};

function listen(file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const server = net.createServer((socket) => socket.end());
  servers.push(server);
  return new Promise((resolve) => server.listen(file, () => resolve()));
}

const write = (file: string, text = "x\n"): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function underProfileText(profile: string, command: string): { code: number | null; stderr: string } {
  const file = path.join(tmp, `p-${Math.random().toString(36).slice(2)}.sb`);
  fs.writeFileSync(file, profile);
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", command], { encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
}

const underProfile = (command: string): { code: number | null; stderr: string } => {
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profileFile, "/bin/sh", "-c", command], { encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
};
const denied = (command: string): boolean => underProfile(command).code !== 0;
const q = (file: string): string => `'${file.replace(/'/g, `'\\''`)}'`;
/** The dirs exist (made outside the sandbox), so only writing the file itself is tested. */
const writeDenied = (file: string): boolean => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return denied(`echo x > ${q(file)}`);
};

/** Connects to `file` from a sandboxed node: "connected" or the error code. Async so this process's servers keep running. */
async function connectUnder(file: string): Promise<string> {
  const script = `const s=require("net").createConnection(${JSON.stringify(file)});s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",(e)=>{console.log(e.code);process.exit(0)})`;
  const { stdout } = await run("/usr/bin/sandbox-exec", ["-f", profileFile, process.execPath, "-e", script]);
  return stdout.trim();
}

const calculatorRunning = (): boolean => spawnSync("/usr/bin/pgrep", ["-x", "Calculator"]).status === 0;
const git = (cwd: string, ...args: string[]): void => {
  execFileSyncQuiet("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], cwd);
};
function execFileSyncQuiet(file: string, args: string[], cwd: string): void {
  const result = spawnSync(file, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${file} ${args.join(" ")}: ${result.stderr}`);
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync("/tmp/sbp-"));
  home = path.join(tmp, "h");
  agentDir = resolveEnv("system", home).agentDir;
  otherAgentDir = resolveEnv("second", home).agentDir;
  proj = path.join(tmp, "proj");
  repo = path.join(tmp, "repo");
  dotfiles = path.join(tmp, "dotfiles");
  brewBin = path.join(tmp, "brew", "bin");
  for (const dir of [agentDir, otherAgentDir, proj, repo, brewBin, path.join(home, ".ssh"), path.join(home, "Library/LaunchAgents")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const dir of [".senpi", ".omo", ".pi"]) fs.mkdirSync(path.join(proj, dir));
  // shell files: a symlinked .zshrc that sources two more files
  write(path.join(dotfiles, "zshrc"), `source ~/aliases.zsh # comment\n[ -f "$HOME/more.sh" ] && . "$HOME/more.sh"\nsource $ZSH/oh-my-zsh.sh\n[ -f ~/later.zsh ] && source ~/later.zsh\n`);
  fs.symlinkSync(path.join(dotfiles, "zshrc"), path.join(home, ".zshrc"));
  write(path.join(home, "aliases.zsh"));
  write(path.join(home, "more.sh"));
  git(repo, "init", "-q");
  write(path.join(repo, "a.txt"));
  // this window's VS Code is somewhere else entirely
  const vscodeRoot = path.join(tmp, "VS Code \"x\"");
  current = {
    appRoot: path.join(vscodeRoot, "Code.app"),
    userDataDir: path.join(vscodeRoot, "data"),
    userSettings: path.join(vscodeRoot, "data/User/settings.json"),
    extensionsDir: path.join(vscodeRoot, "ext/extensions"),
  };
  spec = { home, agentDir, vscodes: [current], writableDirs: [brewBin] };
  profileFile = path.join(tmp, "own.sb");
  fs.writeFileSync(profileFile, buildProfile(spec));

  if (!darwin) return;
  const portableData = path.join(home, ".vscode-portable/code-portable-data/user-data");
  Object.assign(sockets, {
    hook: path.join(agentDir, "guard/hook.sock"),
    admin: path.join(agentDir, "guard/admin.sock"),
    otherAdmin: path.join(otherAgentDir, "guard/admin.sock"),
    otherHost: protectedHostSocketPath(otherAgentDir),
    otherPlainHost: hostSocketPath(otherAgentDir),
    ownPlainHost: hostSocketPath(agentDir), // the unprotected host this env had before protection
    standardMain: path.join(home, "Library/Application Support/Code/1.99.0-main.sock"),
    portableMain: path.join(portableData, "1.13-main.sock"),
    currentMain: path.join(current.userDataDir, "1.2-main.sock"),
    lsp: path.join(home, ".omo/lsp-daemon/v0.1.0/daemon.sock"),
    ipc: path.join(fs.realpathSync(os.tmpdir()), `vscode-ipc-${process.pid}-${Date.now()}.sock`),
  });
  for (const file of Object.values(sockets)) await listen(file);
});

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  if (sockets["ipc"] !== undefined) fs.rmSync(sockets["ipc"], { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("sandbox profile", () => {
  it("paths_of_the_profile_and_the_host", () => {
    expect(profilePath("/a/agent")).toBe("/a/agent/guard/sandbox.sb");
    expect(hostSocketPath("/a/agent")).toBe("/a/agent/rpc/agent-tabs.sock");
    expect(protectedHostSocketPath("/a/agent")).toBe("/a/agent/guard/host/agent-tabs.sock");
  });

  it("lsp_daemon_dir_is_under_the_agent_dir_and_keeps_its_socket_short", () => {
    expect(lspDaemonDir("/a/agent")).toBe("/a/agent/lsp-daemon");
    const deep = `/a/${"x".repeat(70)}`;
    expect(lspDaemonDir(deep)).toBe(`${deep}/lsp`);
    expect(Buffer.byteLength(path.join(lspDaemonDir(deep), "v0.1.0/daemon.sock"))).toBeLessThanOrEqual(100);
  });

  it("the_profile_does_not_depend_on_which_window_lists_the_installs_first", () => {
    const another = { ...current, userDataDir: path.join(tmp, "other data"), extensionsDir: path.join(tmp, "other/extensions") };
    expect(buildProfile({ ...spec, vscodes: [current, another] })).toBe(buildProfile({ ...spec, vscodes: [another, current, current] }));
  });

  it("sourced_files_are_followed_and_variables_are_not", () => {
    // later.zsh does not exist yet: listed so the agent cannot create it (N3)
    expect(sourcedFiles(home)).toEqual([path.join(home, "aliases.zsh"), path.join(home, "later.zsh"), path.join(home, "more.sh")]);
  });

  it.runIf(darwin)("protected_writes_fail_and_project_writes_work", () => {
    for (const dir of [agentDir, otherAgentDir]) {
      expect(denied(`echo x > ${dir}/models.json`)).toBe(true);
      expect(denied(`echo x > ${dir}/guard/x`)).toBe(true);
      expect(denied(`echo x > ${dir}/AGENTS.md`)).toBe(true);
      expect(denied(`mkdir -p ${dir}/extensions/evil`)).toBe(true);
    }
    expect(denied(`mkdir ${proj}/.omo2 && mv ${proj}/.omo2 ${proj}/.omo/x`)).toBe(false); // inside .omo: other names are fine
    expect(denied(`mkdir ${proj}/sub && mkdir ${proj}/sub/.omo`)).toBe(true);
    expect(denied(`echo x > ${home}/Library/LaunchAgents/evil.plist`)).toBe(true);
    expect(denied(`mkdir -p ${home}/.omo/kit/x`)).toBe(true);
    expect(denied(`echo x > ${proj}/a.txt`)).toBe(false);
    expect(denied(`mkdir -p ${agentDir}/sessions && echo x > ${agentDir}/sessions/s.jsonl && echo x > ${agentDir}/auth.json`)).toBe(false);
  });

  it.runIf(darwin)("every_vscode_install_is_closed", () => {
    const standard = path.join(home, "Library/Application Support/Code");
    const portable = path.join(home, ".vscode-portable");
    for (const file of [
      `${standard}/User/settings.json`,
      `${home}/.vscode/extensions/evil/package.json`,
      `${home}/.vscode/argv.json`,
      `${portable}/code-portable-data/user-data/User/settings.json`,
      `${portable}/code-portable-data/extensions/evil/package.json`,
      `${portable}/code-portable-data/argv.json`,
      `${portable}/Visual Studio Code.app/Contents/x`,
      current.userSettings,
      `${current.extensionsDir}/evil/package.json`,
      `${path.dirname(current.extensionsDir)}/argv.json`,
      `${current.appRoot}/Contents/x`,
    ]) {
      expect(writeDenied(file), file).toBe(true);
    }
  });

  it.runIf(darwin)("git_config_and_hooks_cannot_be_written_but_commits_work", () => {
    expect(denied(`git -C ${repo} config core.fsmonitor 'touch ${tmp}/pwned'`)).toBe(true);
    // N1: commondir/gitdir point git (run by VS Code, outside the sandbox) at a repo whose config the agent wrote
    const evil = path.join(tmp, "evil.git");
    execFileSyncQuiet("git", ["init", "-q", "--bare", evil], tmp);
    execFileSyncQuiet("git", ["--git-dir", evil, "config", "core.fsmonitor", `touch ${tmp}/pwned`], tmp);
    expect(denied(`echo ${evil} > ${repo}/.git/commondir`)).toBe(true);
    expect(denied(`mkdir -p ${repo}/.git/worktrees/w && echo ${evil} > ${repo}/.git/worktrees/w/commondir`)).toBe(true);
    expect(denied(`echo ${evil} > ${repo}/.git/worktrees/w/gitdir`)).toBe(true);
    expect(denied(`echo x > ${repo}/.git/worktrees/w/config`)).toBe(true);
    // OmO memory reflection creates worktrees at ~/.omo/memory/agents/<id>/repo/.git/worktrees/<run>/; the same global
    // rule denies their gitdir/commondir. It cannot be separated from the escape above (the memory repo is shared with
    // the unsandboxed host's reflection, and Seatbelt cannot check commondir content), so the profile stays unchanged
    // and reflection does not run under protection (Half B).
    const memWt = `${home}/.omo/memory/agents/x/repo/.git/worktrees/run-1`;
    fs.mkdirSync(memWt, { recursive: true });
    expect(denied(`echo x > ${memWt}/gitdir`)).toBe(true);
    expect(denied(`echo ${evil} > ${memWt}/commondir`)).toBe(true);
    execFileSyncQuiet("git", ["status", "--short"], repo); // as VS Code would, outside the sandbox
    expect(fs.existsSync(path.join(tmp, "pwned"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, ".git/config"), "utf8")).not.toContain("fsmonitor");
    expect(denied(`echo x > ${repo}/.git/hooks/pre-commit`)).toBe(true);
    expect(denied(`git init -q ${tmp}/fresh`)).toBe(true);
    expect(denied(`mkdir ${proj}/wt && printf 'gitdir: ${tmp}/evil\\n' > ${proj}/wt/.git`)).toBe(true);
    expect(denied(`HOME=${home} git config --global core.fsmonitor x`)).toBe(true);
    expect(denied(`mkdir -p ${home}/.config/git && echo x > ${home}/.config/git/config`)).toBe(true);
    expect(denied(`cd ${repo} && git add a.txt && git -c user.name=t -c user.email=t@t commit -qm one`)).toBe(false);
  });

  it.runIf(darwin)("claude_code_settings_plugins_and_hooks_are_closed", () => {
    for (const claudeDir of [path.join(home, ".claude"), resolveEnv("second", home).claudeDir]) {
      for (const name of ["settings.json", "settings.local.json", "settings-x.json", ".claude.json", "plugins/p/x.json", "hooks/h.sh", "commands/c.md", "skills/s/SKILL.md", "agents/a.md"]) {
        expect(writeDenied(path.join(claudeDir, name)), name).toBe(true);
      }
    }
    expect(denied(`echo x > ${home}/.claude.json`)).toBe(true);
    expect(denied(`mkdir ${proj}/.claude`)).toBe(true);
    fs.mkdirSync(path.join(repo, ".claude"));
    expect(denied(`echo x > ${repo}/.claude/settings.local.json`)).toBe(true);
    for (const dir of ["commands", "skills", "agents"]) expect(denied(`mkdir -p ${repo}/.claude/${dir}/x`), dir).toBe(true);
    expect(denied(`echo x > ${repo}/.claude/notes.md`)).toBe(false);
  });

  it.runIf(darwin)("ssh_control_socket_is_writable_but_keys_and_links_are_not", () => {
    // ssh ControlMaster multiplexing binds/unlinks a unix socket under ~/.ssh; only socket vnodes may be written
    const p = buildProfile(spec);
    expect(p.indexOf(`(allow file-write* (require-all (subpath "${home}/.ssh") (vnode-type SOCKET)))`)).toBeGreaterThan(
      p.indexOf(`  (subpath "${home}/.ssh")`),
    );
    const sock = `${home}/.ssh/cm-test`;
    const bind = (file: string): string =>
      spawnSync("/usr/bin/sandbox-exec", ["-f", profileFile, process.execPath, "-e",
        `const fs=require("fs");const s=require("net").createServer();s.listen(${JSON.stringify(file)},()=>{fs.unlinkSync(${JSON.stringify(file)});console.log("ok");process.exit(0)}).on("error",(e)=>{console.log(e.code);process.exit(1)})`],
        { encoding: "utf8" }).stdout.trim();
    expect(bind(sock)).toBe("ok"); // bind + unlink the control socket both allowed
    expect(denied(`echo x > ${home}/.ssh/id_evil`)).toBe(true); // a regular file (e.g. a planted key) stays denied
    expect(denied(`ln -s ${home}/.zshenv ${home}/.ssh/evil-link`)).toBe(true); // a symlink stays denied
  });

  it.runIf(darwin)("files_the_person_runs_later_are_closed", () => {
    expect(denied(`echo x > ${home}/.ssh/config`)).toBe(true);
    expect(denied(`echo x > ${home}/.ssh/authorized_keys`)).toBe(true);
    expect(denied(`echo 'host key' >> ${home}/.ssh/known_hosts`)).toBe(false); // P34
    // N5: but never as a link through which ssh would append into a protected file
    expect(denied(`ln -sf ${home}/.zshenv ${home}/.ssh/known_hosts`)).toBe(true);
    expect(fs.lstatSync(path.join(home, ".ssh/known_hosts"), { throwIfNoEntry: false })?.isSymbolicLink() ?? false).toBe(false);
    expect(denied(`ln -s ${home}/.zshenv ${tmp}/kh-link && mv -f ${tmp}/kh-link ${home}/.ssh/known_hosts`)).toBe(true);
    expect(denied(`echo 'host key' > ${home}/.ssh/known_hosts`)).toBe(false);
    for (const name of [".zlogout", ".bash_login", ".bash_logout", ".profile", ".config/fish/config.fish", ".gitconfig"]) {
      expect(writeDenied(path.join(home, name)), name).toBe(true);
    }
    // a symlinked rc file: neither the link nor its target; the files it sources too
    expect(denied(`echo x >> ${home}/.zshrc`)).toBe(true);
    expect(denied(`echo x >> ${dotfiles}/zshrc`)).toBe(true);
    expect(denied(`echo x >> ${home}/aliases.zsh`)).toBe(true);
    expect(denied(`echo x >> ${home}/more.sh`)).toBe(true);
    expect(denied(`echo x > ${home}/later.zsh`)).toBe(true); // N3: sourced, not there yet
    // N2: zsh loads a compiled .zwc next to a file it sources
    for (const file of [".zshenv", ".zshrc", "aliases.zsh", "later.zsh"]) expect(denied(`echo x > ${home}/${file}.zwc`), file).toBe(true);
    // a hard link cannot carry a protected file out to an open path
    expect(denied(`ln ${home}/aliases.zsh ${tmp}/hardlink`)).toBe(true);
    // P33: a user-writable dir on the login PATH
    expect(denied(`echo x > ${brewBin}/git`)).toBe(true);
    expect(denied(`mv ${path.dirname(brewBin)} ${tmp}/brew2`)).toBe(true);
  });

  it.runIf(darwin)("xdg_data_dirs_under_local_are_writable_but_path_dirs_under_it_are_not", () => {
    const localBin = path.join(home, ".local/bin");
    const pipxBin = path.join(home, ".local/share/pipx/bin"); // a deeper PATH dir the login PATH closed specifically
    const p = buildProfile({ ...spec, writableDirs: [localBin, pipxBin] });
    const file = path.join(tmp, "local.sb");
    fs.writeFileSync(file, p);
    const under = (command: string): number | null => spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", command], { encoding: "utf8" }).status;
    for (const dir of [".local/state", ".local/share", ".local/lib", ".local/bin", ".local/share/pipx/bin"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
    // XDG data dirs the person's tools write to stay open (a CLI tool keeps its state in ~/.local/state/<tool>)
    expect(under(`echo x > ${home}/.local/state/sometool.pid`)).toBe(0);
    expect(under(`echo x > ${home}/.local/share/foo`)).toBe(0);
    expect(under(`mkdir -p ${home}/.local/state/sometool/abc && echo x > ${home}/.local/state/sometool/abc/pid`)).toBe(0);
    // the PATH dirs themselves stay closed: planting a binary there is the escape
    expect(under(`echo x > ${localBin}/git`)).not.toBe(0);
    expect(under(`echo x > ${pipxBin}/evil`)).not.toBe(0);
    // ~/.local is not closed as a whole tree, but its node still cannot be renamed away (parent of ~/.local/bin)
    expect(p).not.toContain(`(subpath "${home}/.local")`);
    expect(p).toContain(`(subpath "${home}/.local/bin")`);
    expect(under(`mv ${home}/.local ${home}/.local.old`)).not.toBe(0);
  });

  it.runIf(darwin)("an_ancestor_of_a_protected_dir_cannot_be_renamed_away", () => {
    expect(denied(`mv ${home} ${tmp}/home2`)).toBe(true);
    expect(denied(`mv ${home}/.cache ${home}/cache2`)).toBe(true);
    expect(denied(`mv ${home}/Library ${home}/Library2`)).toBe(true);
    expect(fs.existsSync(path.join(otherAgentDir))).toBe(true);
    expect(denied(`echo x > ${home}/new.txt && mkdir ${home}/newdir`)).toBe(false);
  });

  it.runIf(darwin)("sockets_outside_the_hook_are_refused", async () => {
    expect(await connectUnder(sockets["hook"] as string)).toBe("connected");
    for (const name of ["admin", "otherAdmin", "otherHost", "otherPlainHost", "ownPlainHost", "standardMain", "portableMain", "currentMain", "lsp", "ipc"]) {
      expect(await connectUnder(sockets[name] as string), name).toBe("EPERM");
    }
    expect(await connectUnder((sockets["admin"] as string).replace(/^\/private\/tmp\//, "/tmp/"))).toBe("EPERM");
    expect(await connectUnder((sockets["ipc"] as string).replace(/^\/private\/var\//, "/var/"))).toBe("EPERM");
  });

  it.runIf(darwin)("the_host_binds_its_socket_but_nobody_moves_it_or_reaches_it", async () => {
    const sock = protectedHostSocketPath(agentDir);
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    fs.rmSync(sock, { force: true });
    // a sandboxed "host" binds and chmods its socket (OmO 5.1.59 does both) and keeps it open
    const host = spawn("/usr/bin/sandbox-exec", [
      "-f",
      profileFile,
      process.execPath,
      "-e",
      `const s=require("net").createServer(c=>c.end()).listen(${JSON.stringify(sock)},()=>{require("fs").chmodSync(${JSON.stringify(sock)},0o600);console.log("up")})`,
    ]);
    try {
      await new Promise<void>((resolve, reject) => {
        host.stdout.once("data", () => resolve());
        host.once("exit", (code) => reject(new Error(`host exited ${String(code)}`)));
      });
      expect(denied(`rm -f ${sock}`)).toBe(true);
      expect(denied(`mv ${sock} ${tmp}/moved.sock`)).toBe(true);
      expect(denied(`mv ${path.dirname(sock)} ${tmp}/moved`)).toBe(true);
      expect(await connectUnder(sock)).toBe("EPERM");
      fs.symlinkSync(sock, path.join(proj, "link.sock"));
      expect(await connectUnder(path.join(proj, "link.sock"))).toBe("EPERM");
      expect(denied(`echo x > ${path.join(path.dirname(sock), "agent-tabs.pid")}`)).toBe(true);
    } finally {
      host.kill("SIGKILL");
    }
  });

  it.runIf(darwin)("no_fake_host_waits_at_the_unprotected_place", () => {
    // a third environment nobody listens in yet, so a refused bind can only be the profile (not EADDRINUSE)
    const third = path.join(tmp, "third-agent");
    const profile = buildProfile({ ...spec, envs: [{ agentDir: third, claudeDir: path.join(tmp, "third-claude") }] });
    for (const dir of [agentDir, otherAgentDir, third]) {
      const rpc = path.join(dir, "rpc");
      fs.mkdirSync(rpc, { recursive: true }); // its launcher makes it before a protected host starts
      expect(underProfileText(profile, `ln -s ${tmp}/x ${rpc}/agent-tabs.sock`).code, dir).not.toBe(0);
      expect(underProfileText(profile, `echo 1 > ${rpc}/agent-tabs.pid`).code, dir).not.toBe(0);
      expect(underProfileText(profile, `mv ${rpc} ${dir}/rpc2`).code, dir).not.toBe(0);
      // the host's key files still go there
      expect(underProfileText(profile, `mkdir -p ${rpc}/keys && echo k > ${rpc}/keys/launch`).code, dir).toBe(0);
    }
    const file = path.join(tmp, "third.sb");
    fs.writeFileSync(file, profile);
    const sock = path.join(third, "rpc", "agent-tabs.sock");
    const bind = `require("net").createServer().listen(${JSON.stringify(sock)},()=>{console.log("listening");process.exit(0)}).on("error",(e)=>{console.log(e.code);process.exit(1)})`;
    expect(spawnSync("/usr/bin/sandbox-exec", ["-f", file, process.execPath, "-e", bind], { encoding: "utf8" }).stdout.trim()).toBe("EPERM");
    expect(fs.existsSync(sock)).toBe(false);
  });

  it.runIf(darwin)("lsopen_and_apple_events_are_denied", () => {
    const before = calculatorRunning();
    const result = underProfile("open -g -j /System/Applications/Calculator.app");
    try {
      expect(result.code).not.toBe(0);
      // a real event (an application's `name` is answered locally, without one)
      expect(denied(`osascript -e 'tell application "Finder" to get name of startup disk'`)).toBe(true);
    } finally {
      // only a Calculator this test started is closed
      if (result.code === 0 && !before) spawnSync("/usr/bin/pkill", ["-x", "Calculator"]);
    }
  });

  it.runIf(darwin)("paths_with_spaces_and_quotes_are_escaped", () => {
    const odd = `${tmp}/a "b" c`;
    fs.mkdirSync(odd, { recursive: true });
    const p = buildProfile({ ...spec, agentDir: odd, vscodes: [{ ...current, userDataDir: `${tmp}/u\\d "x"` }] });
    expect(underProfileText(p, `echo x > '${tmp}/a "b" c/models.json'`).code).not.toBe(0);
    expect(underProfileText(p, `echo x > '${tmp}/a "b" c/notes.txt'`).code).toBe(0);
    fs.mkdirSync(`${tmp}/u\\d "x"`, { recursive: true });
    expect(underProfileText(p, `echo x > '${tmp}/u\\d "x"/f'`).code).not.toBe(0);
  });

  it.runIf(darwin)("ps_runs_outside_the_sandbox", () => {
    expect(denied(`/bin/ps -o lstart= -p $$`)).toBe(false);
  });
});

describe("what OmO loads as skills or extensions", () => {
  let h: string;
  let clone: string;
  let sysAgent: string;
  let secondAgent: string;
  let project: string;
  let file: string;
  const deniedHere = (command: string): boolean => {
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", command], { encoding: "utf8" });
    return result.status !== 0;
  };
  const writeDeniedHere = (target: string): boolean => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return deniedHere(`echo x > ${q(target)}`);
  };

  beforeAll(() => {
    h = path.join(tmp, "res-home");
    clone = path.join(h, ".omo/superpowers");
    sysAgent = resolveEnv("system", h).agentDir;
    secondAgent = resolveEnv("second", h).agentDir;
    project = path.join(tmp, "res-project");
    for (const dir of [path.join(clone, "skills/brainstorming"), path.join(clone, ".pi/extensions"), path.join(project, "team-skills"), path.join(h, "my-skills"), sysAgent, secondAgent]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writeSuperpowersManifests(clone);
    write(path.join(clone, ".pi/extensions/superpowers.ts"));
    git(project, "init", "-q");
    write(path.join(tmp, "Tools.app/Contents/ext.ts"));
    write(
      path.join(sysAgent, "settings.json"),
      JSON.stringify({
        skills: [path.join(clone, "skills"), path.join(project, "team-skills"), "~/my-skills", "rel-skills", path.join(h, "gone-skills"), "!**/*.md", "~"],
        extensions: [path.join(clone, ".pi/extensions/superpowers.ts"), `+${path.join(tmp, "Tools.app/Contents/ext.ts")}`],
      }),
    );
    write(path.join(secondAgent, "settings.json"), JSON.stringify({ skills: [path.join(tmp, "other-skills")], packages: [clone, "~/my-pkg", "npm:@scope/pkg", "git:github.com/a/b"] }));
    file = path.join(tmp, "res.sb");
    fs.writeFileSync(file, buildProfile({ home: h, agentDir: sysAgent }));
  });

  it("each_entry_is_closed_alone_the_clone_whole_and_never_home_or_an_agent_dir", () => {
    expect(loadedResourceDenies(h, [sysAgent, secondAgent])).toEqual(
      [
        clone,
        path.join(h, "gone-skills"),
        path.join(h, "my-pkg"),
        path.join(h, "my-skills"),
        path.join(project, "team-skills"),
        path.join(sysAgent, "rel-skills"),
        path.join(tmp, "Tools.app"),
        path.join(tmp, "other-skills"),
      ].sort(),
    );
  });

  it("an_unreadable_settings_file_adds_nothing", () => {
    const broken = path.join(tmp, "broken-agent");
    write(path.join(broken, "settings.json"), "{ not json");
    expect(loadedResourceDenies(h, [broken])).toEqual([]);
  });

  it.runIf(darwin)("the_agent_cannot_rewrite_or_create_what_omo_loads_but_the_repo_around_a_skills_dir_stays_open", () => {
    for (const target of [
      path.join(clone, "README.md"),
      path.join(clone, ".pi/extensions/superpowers.ts"),
      path.join(clone, "skills/brainstorming/SKILL.md"),
      path.join(project, "team-skills/new/SKILL.md"),
      path.join(h, "my-skills/x/SKILL.md"),
      path.join(sysAgent, "rel-skills/x/SKILL.md"),
      path.join(tmp, "Tools.app/Contents/other.ts"),
      path.join(tmp, "other-skills/x/SKILL.md"),
    ]) {
      expect(writeDeniedHere(target), target).toBe(true);
    }
    expect(deniedHere(`mkdir ${q(path.join(h, "gone-skills"))}`)).toBe(true); // listed, not there yet
    expect(deniedHere(`mv ${q(clone)} ${q(`${clone}-moved`)}`)).toBe(true);
    // P38: the repo holding a skills dir and home stay writable
    expect(deniedHere(`echo x > ${q(path.join(project, "a.txt"))} && echo x > ${q(path.join(h, "notes.txt"))}`)).toBe(false);
  });
});
