// Guard v2 Seatbelt profile (spec §4.1, §6a; live check F3; review rulings P32–P34): a deny-list over (allow default).
// Reads, network and writes elsewhere stay allowed, so where projects live does not matter. Every path is embedded as
// a Scheme string (`\` and `"` escaped), both as given and resolved: Seatbelt matches real paths (/private/tmp, a
// symlinked rc file's target), so a link must not be a way around a deny.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEnv, ENV_NAMES } from "../lib/envs.mjs";
import { servicePaths } from "../guard/sockets.mjs";
import { loadConfig, superpowersState, validateSettings } from "../lib/tools.mjs";

/** The generated profile of an environment: its presence is what «protection on» means to every launcher. */
export function profilePath(agentDir) {
  return path.join(agentDir, "guard", "sandbox.sb");
}

/** The extension's own host while protection is off (P35: the paths a running host already uses). */
export function hostSocketPath(agentDir) {
  return path.join(agentDir, "rpc", "agent-tabs.sock");
}

export function hostPidPath(agentDir) {
  return path.join(agentDir, "rpc", "agent-tabs.pid");
}

/** The protected host: socket and pid file in a dir the sandbox cannot write (only the socket may be created). */
export function protectedHostSocketPath(agentDir) {
  return path.join(agentDir, "guard", "host", "agent-tabs.sock");
}

export function protectedHostPidPath(agentDir) {
  return path.join(agentDir, "guard", "host", "agent-tabs.pid");
}

// OmO puts its LSP daemon socket at <dir>/v<version>/daemon.sock and needs it ≤ 100 bytes (F5.3).
const LSP_SOCKET_TAIL = "v0.1.0/daemon.sock";
const LSP_SOCKET_MAX = 100;

/** OMO_LSP_DAEMON_DIR of a protected host: its own daemon under the agent dir, never the unsandboxed ~/.omo one. */
export function lspDaemonDir(agentDir) {
  const dir = path.join(agentDir, "lsp-daemon");
  return Buffer.byteLength(path.join(dir, LSP_SOCKET_TAIL)) <= LSP_SOCKET_MAX ? dir : path.join(agentDir, "lsp");
}

/**
 * VS Code installs protected whichever VS Code writes the profile: the standard one and the person's portable one.
 * An install: { appRoot? (the .app bundle), userDataDir, userSettings?, extensionsDir }; argv.json sits next to the
 * extensions dir.
 */
export function knownVscodeInstalls(home) {
  const portable = process.env.AGENT_TABS_SECOND_VSCODE ? path.resolve(home, process.env.AGENT_TABS_SECOND_VSCODE) : null;
  return [
    {
      appRoot: "/Applications/Visual Studio Code.app",
      userDataDir: path.join(home, "Library/Application Support/Code"),
      extensionsDir: path.join(home, ".vscode/extensions"),
    },
    ...(portable ? [{
      appRoot: path.join(portable, "Visual Studio Code.app"),
      userDataDir: path.join(portable, "code-portable-data/user-data"),
      extensionsDir: path.join(portable, "code-portable-data/extensions"),
    }] : []),
  ];
}

/** The real path of `file`, or of its deepest existing ancestor with the rest appended. */
export function realOf(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(realOf(parent), path.basename(file));
  }
}

const SHELL_RC = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile"];
const SOURCE_DEPTH = 3;
const SOURCE_LINE = /(?:^|[\s;&|(])(?:source|\.)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;

/**
 * Files the shell rc files `source` / `.` (followed SOURCE_DEPTH deep): a login shell runs them outside the sandbox.
 * A target that does not exist yet is listed too (the agent must not create it). Paths with other variables or globs
 * are not followed (residual risk).
 */
export function sourcedFiles(home) {
  const found = new Set();
  const visit = (file, depth) => {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      const code = line.replace(/(^|\s)#.*$/, "");
      for (const match of code.matchAll(SOURCE_LINE)) {
        let target = match[1].replace(/^["']|["']$/g, "");
        target = target.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
        if (/[$*?`[]/.test(target)) continue;
        target = path.resolve(home, target);
        if (found.has(target)) continue;
        found.add(target);
        if (depth < SOURCE_DEPTH) visit(target, depth + 1);
      }
    }
  };
  for (const name of [...SHELL_RC, ".config/fish/config.fish"]) visit(path.join(home, name), 1);
  return [...found].sort();
}

const str = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const reEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const both = (file) => [...new Set([file, realOf(file)])];
const sorted = (values) => [...new Set(values)].sort();

/** Every directory above `file` except the root: a deny on these stops renaming a protected tree away. */
function ancestors(file) {
  const out = [];
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) out.push(dir);
  return out;
}

function agentDirDenies(agentDir) {
  const inAgent = (name) => path.join(agentDir, name);
  return {
    subpaths: ["guard", "extensions", "keys", "agent-tabs"].map(inAgent),
    literals: [
      agentDir,
      // AGENTS.md: mechanism B links it to the Claude instructions (F6)
      ...["settings.json", "models.json", "mcp.json", "hooks.json", "hooks-state.json", "AGENTS.md"].map(inAgent),
      // the unprotected host's place: no fake host waiting there for protection to be turned off (and, through the
      // ancestor rule, no renaming rpc/ away — its launcher creates rpc/ before a protected host starts)
      hostSocketPath(agentDir),
      hostPidPath(agentDir),
    ],
  };
}

function claudeDirDenies(claudeDir) {
  return {
    subpaths: ["plugins", "hooks", "commands", "skills", "agents"].map((name) => path.join(claudeDir, name)),
    literals: [claudeDir, path.join(claudeDir, ".claude.json"), path.join(claudeDir, "settings.json"), path.join(claudeDir, "settings.local.json")],
    regexes: both(claudeDir).map((dir) => `^${reEscape(dir)}/settings[^/]*\\.json$`),
  };
}

const RESOURCE_LISTS = ["skills", "extensions", "packages"];
/** A list entry that is a pattern or an exclusion, not one path: not followed (residual risk). */
const isPattern = (entry) => /^[!-]/.test(entry) || /[*?[\]{}]/.test(entry);

/**
 * What OmO loads as prompts or code from outside its agent dir, so no agent may rewrite it (a `packages` entry that is a source like `npm:x` is not a local path): the superpowers clone of
 * every environment, whole, wherever it is, and each entry of each environment's `<agentDir>/settings.json` `skills`,
 * `extensions` and `packages` lists (`~` and agent-dir-relative paths resolved, `+` force-includes followed, patterns and
 * exclusions not) — that entry itself, even inside a git work tree or a project (P38: never the repo around it), or the
 * outermost `.app` bundle holding it. An entry that does not exist yet is listed too (nobody may create it). Never
 * home, a dir above it, or a dir holding an agent dir. A settings file that cannot be read adds nothing.
 */
export function loadedResourceDenies(home, agentDirs) {
  const out = new Set();
  const clones = new Set();
  for (const agentDir of new Set(agentDirs)) {
    let settings;
    try {
      settings = loadConfig(path.join(agentDir, "settings.json"), validateSettings, () => undefined);
      const clone = superpowersState({ home, agentDir }).dir;
      if (clone !== null) clones.add(path.resolve(clone));
    } catch {
      continue;
    }
    for (const list of RESOURCE_LISTS) {
      for (const entry of settings[list] ?? []) {
        if (typeof entry !== "string" || entry.trim() === "" || isPattern(entry)) continue;
        if (list === "packages" && /^[a-z][a-z0-9+.-]*:/i.test(entry)) continue; // npm:, git: … sources are not local paths
        const file = path.resolve(agentDir, entry.replace(/^\+/, "").replace(/^~(?=\/|$)/, home));
        const bundle = [file, ...ancestors(file)].reverse().find((dir) => dir.endsWith(".app"));
        out.add(bundle ?? file);
      }
    }
  }
  const within = (file, dir) => file === dir || file.startsWith(dir + path.sep);
  const closable = (dir) => !within(home, dir) && !agentDirs.some((agentDir) => within(agentDir, dir));
  const kept = [...clones, ...[...out].filter((file) => ![...clones].some((clone) => within(file, clone)))];
  return sorted(kept.filter(closable));
}

/**
 * The profile text for the environment whose agent dir is `agentDir` (its host may create its own socket).
 * Protected as well, so an agent cannot reach around through a sibling: every kit environment (kit/lib/envs.mjs) and
 * `envs` ({agentDir, claudeDir}), every known VS Code install and `vscodes`, `writableDirs` (P33: user-writable dirs
 * on the login PATH and the service's node prefix), whatever the shell rc files source, and what OmO loads as skills
 * or extensions (loadedResourceDenies).
 */
export function buildProfile({ home, agentDir, envs = [], vscodes = [], writableDirs = [] }) {
  const inHome = (name) => path.join(home, name);
  const allEnvs = [...ENV_NAMES.map((name) => resolveEnv(name, home)), ...envs];
  const agentDirs = sorted([agentDir, ...allEnvs.map((env) => env.agentDir)]);
  const claudeDirs = sorted(allEnvs.map((env) => env.claudeDir));
  const installs = [...knownVscodeInstalls(home), ...vscodes];

  const subpaths = [
    ...agentDirs.flatMap((dir) => agentDirDenies(dir).subpaths),
    ...claudeDirs.flatMap((dir) => claudeDirDenies(dir).subpaths),
    ...[".omo/kit", ".omo/packages", ".omo/binary-runtime", ".omo/lsp-daemon", ".local/bin", "Library/LaunchAgents", ".ssh", ".config/git", ".config/fish"].map(inHome),
    ...installs.flatMap((install) => [install.appRoot, install.userDataDir, install.extensionsDir].filter(Boolean)),
    ...writableDirs,
    ...loadedResourceDenies(home, agentDirs),
  ];
  const literals = [
    ...agentDirs.flatMap((dir) => agentDirDenies(dir).literals),
    ...claudeDirs.flatMap((dir) => claudeDirDenies(dir).literals),
    ...[".omo", ".omo/omo.jsonc", ".gitconfig", ".claude.json"].map(inHome),
    // zsh prefers a compiled `<file>.zwc` next to each file it sources
    ...[...SHELL_RC.map(inHome), ...sourcedFiles(home)].flatMap((file) => [file, `${file}.zwc`]),
    ...installs.flatMap((install) => [
      install.userSettings ?? path.join(install.userDataDir, "User", "settings.json"),
      path.join(path.dirname(install.extensionsDir), "argv.json"),
    ]),
  ];
  const subpathSet = sorted(subpaths.flatMap(both));
  const literalSet = sorted(literals.flatMap(both)).filter((file) => !subpathSet.includes(file));
  const listed = new Set([...subpathSet, ...literalSet]);
  const parents = sorted([...listed].flatMap(ancestors)).filter((dir) => !listed.has(dir));
  const claudeRegexes = sorted(claudeDirs.flatMap((dir) => claudeDirDenies(dir).regexes));

  const sockets = sorted(
    agentDirs.flatMap((dir) => [hostSocketPath(dir), protectedHostSocketPath(dir), servicePaths(dir).adminSock]).flatMap(both),
  );
  const ownSocket = both(protectedHostSocketPath(agentDir));
  const knownHosts = both(inHome(".ssh/known_hosts"));
  const sshDir = both(inHome(".ssh"));
  const socketRegexes = sorted([
    ...installs.flatMap((install) => both(install.userDataDir)).map((dir) => `^${reEscape(dir)}/[^/]*-main\\.sock$`),
    ...both(inHome(".omo/lsp-daemon")).map((dir) => `^${reEscape(dir)}/`),
    // VS Code's git askpass and terminal IPC sockets in $TMPDIR (the `code` CLI runs things outside the sandbox)
    ...both(os.tmpdir()).map((dir) => `^${reEscape(dir)}/vscode-(git|ipc)-[^/]*\\.sock$`),
    "^(/private)?/var/folders/[^/]+/[^/]+/T/vscode-(git|ipc)-[^/]*\\.sock$",
  ]);

  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    "; OmO proves its identity with `ps -o lstart=`; /bin/ps is setuid and may not run inside a sandbox (SIP-protected).",
    '(allow process-exec (literal "/bin/ps") (with no-sandbox))',
    "",
    "(deny file-write*",
    ...subpathSet.map((dir) => `  (subpath ${str(dir)})`),
    ...literalSet.map((file) => `  (literal ${str(file)})`),
    "  ; the directories above them: no renaming a protected tree away and recreating it",
    ...parents.map((dir) => `  (literal ${str(dir)})`),
    ...claudeRegexes.map((regex) => `  (regex ${str(regex)})`),
    "  ; project hook/config files, the dirs that hold them, new MCP servers, Claude Code project settings",
    '  (regex #"/\\.(omo|senpi|pi)/(hooks|hooks-state|settings|mcp)\\.json$")',
    '  (regex #"/\\.(omo|senpi|pi)/extensions(/|$)")',
    '  (regex #"/\\.(omo|senpi|pi)$")',
    '  (regex #"/\\.mcp\\.json$")',
    '  (regex #"/\\.claude/settings(\\.local)?\\.json$")',
    '  (regex #"/\\.claude$")',
    '  (regex #"/\\.claude/(commands|skills|agents)(/|$)")',
    "  ; git runs config and hooks outside the sandbox (VS Code, the person): no repo config, hooks or new .git (P32)",
    '  (regex #"/\\.git/(.*/)?(config(\\.worktree)?|hooks(/.*)?|commondir|gitdir)$")',
    '  (regex #"/\\.git$"))',
    "",
    "; the host binds (and chmods: OmO does) its own socket in the closed dir; first ssh connections still record the",
    "; host key (P34)",
    `(allow file-write-create file-write-mode ${ownSocket.map((file) => `(literal ${str(file)})`).join(" ")})`,
    `(allow file-write* ${knownHosts.map((file) => `(literal ${str(file)})`).join(" ")})`,
    "; …but never as a link: ssh would append through it into a protected file",
    ...knownHosts.map((file) => `(deny file-write-create (require-all (literal ${str(file)}) (vnode-type SYMLINK)))`),
    "; ssh ControlMaster multiplexing binds and unlinks a unix socket under ~/.ssh; allow only socket vnodes, so keys,",
    "; config and symlinks stay write-denied (after the deny block above: later rules win)",
    ...sshDir.map((dir) => `(allow file-write* (require-all (subpath ${str(dir)}) (vnode-type SOCKET)))`),
    "",
    "; no driving a host over RPC, the decision service's admin socket, VS Code, the shared LSP daemon or sshd",
    ...sockets.map((file) => `(deny network-outbound (remote unix-socket (path-literal ${str(file)})))`),
    ...socketRegexes.map((regex) => `(deny network-outbound (remote unix-socket (regex ${str(regex)})))`),
    '(deny network-outbound (remote tcp "localhost:22"))',
    "; no starting code outside the sandbox through LaunchServices or Apple Events",
    "(deny lsopen)",
    "(deny appleevent-send)",
    "",
  ];
  return lines.join("\n");
}
