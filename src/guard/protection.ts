import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ENV_NAMES, resolveEnv } from "../../kit/lib/envs.mjs";
import {
  guardHandlers,
  guardHookEntry,
  installGuardFiles,
  rulesToWrite,
  servicePaths,
  setGuardHook,
  socketAlive,
} from "../../kit/guard/lifecycle.mjs";
import {
  buildProfile,
  hostSocketPath,
  loadedResourceDenies,
  profilePath,
  protectedHostPidPath,
  protectedHostSocketPath,
  type VscodeInstall,
} from "../../kit/sandbox/profile.mjs";
import { listensOn } from "../daemon";
import type { EnvPaths } from "../settings/paths";
import { launchAgentPath, launchAgentPlist, serviceLabel } from "./launchAgent";

/** This window's VS Code (from VS Code itself): the app bundle, user data, the profile's settings.json, extensions. */
export type VscodePaths = Required<VscodeInstall>;
export type ProtectionState = "off" | "on" | "broken";

export type ProtectionDeps = {
  launchctl(args: string[]): Promise<void>;
  writeFile(file: string, content: string, mode: number): Promise<void>;
  removeFile(file: string): Promise<void>;
  /** Stops this environment's host and starts a fresh one: no session keeps running under the old (or no) profile. */
  restartHost(): Promise<void>;
  /** True once something accepts connections on `file` within `ms` (0: one probe). */
  waitForSocket(file: string, ms: number): Promise<boolean>;
  /** The directories of the person's login-shell PATH, read outside the sandbox when protection is turned on. */
  loginPath(): Promise<string[]>;
  /** This window's VS Code workspace folders: never closed as a whole (P38). */
  workspaceFolders: string[];
  uid: number;
  /** The kit this extension ships (`<extension>/kit`; the repo's `kit` in tests). */
  kitDir: string;
  vscode: VscodePaths;
};

/**
 * What the profile is built from besides the fixed lists, kept in `<agentDir>/guard/sandbox.json` (only the extension
 * writes it): every VS Code install that ran this environment while protected, and the P33 directories fixed when
 * protection was turned on. Every window builds the same profile from it.
 */
type SandboxInputs = { vscodeInstalls: VscodeInstall[]; writableDirs: string[] };

const SERVICE_START_MS = 10_000;
const SOCKET_POLL_MS = 100;
const PATH_MARK = "__agent_tabs_path__";

const inputsFile = (agentDir: string): string => path.join(agentDir, "guard", "sandbox.json");

function readOr(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isInstall(value: unknown): value is VscodeInstall {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item["userDataDir"] === "string" &&
    typeof item["extensionsDir"] === "string" &&
    ["appRoot", "userSettings"].every((key) => item[key] === undefined || typeof item[key] === "string")
  );
}

/** No file: nothing recorded yet. A file that cannot be read throws (the profile is never rebuilt from less). */
function readInputs(agentDir: string): SandboxInputs {
  const text = readOr(inputsFile(agentDir));
  if (text === undefined) return { vscodeInstalls: [], writableDirs: [] };
  const raw = JSON.parse(text) as Record<string, unknown>;
  const installs = raw["vscodeInstalls"];
  const dirs = raw["writableDirs"];
  if (!Array.isArray(installs) || !installs.every(isInstall) || !isStringList(dirs)) throw new Error(`${inputsFile(agentDir)}: не тот формат`);
  return { vscodeInstalls: installs, writableDirs: dirs };
}

const installKey = (install: VscodeInstall): string =>
  JSON.stringify([install.userDataDir, install.extensionsDir, install.appRoot ?? "", install.userSettings ?? ""]);

function mergeInstalls(lists: VscodeInstall[][]): VscodeInstall[] {
  const byKey = new Map<string, VscodeInstall>();
  for (const install of lists.flat()) byKey.set(installKey(install), install);
  return [...byKey.keys()].sort().map((key) => byKey.get(key) as VscodeInstall);
}

/** Installs recorded by every kit environment (another env's unreadable file adds nothing). */
function otherEnvInstalls(paths: EnvPaths): VscodeInstall[][] {
  const others = new Set(ENV_NAMES.map((name) => resolveEnv(name, paths.home).agentDir).filter((dir) => dir !== paths.agentDir));
  return [...others].map((dir) => {
    try {
      return readInputs(dir).vscodeInstalls;
    } catch {
      return [];
    }
  });
}

/** sandbox.json with this window's install added (and, when given, the P33 dirs replaced). */
function nextInputs(paths: EnvPaths, vscode: VscodePaths, writableDirs?: string[]): SandboxInputs {
  const current = readInputs(paths.agentDir);
  return { vscodeInstalls: mergeInstalls([current.vscodeInstalls, [vscode]]), writableDirs: writableDirs ?? current.writableDirs };
}

/** The profile for `inputs` and every other env's installs: identical whichever VS Code builds it once all recorded. */
function profileFor(paths: EnvPaths, inputs: SandboxInputs): string {
  return buildProfile({
    home: paths.home,
    agentDir: paths.agentDir,
    envs: [{ agentDir: paths.agentDir, claudeDir: paths.claudeDir }],
    vscodes: mergeInstalls([...otherEnvInstalls(paths), inputs.vscodeInstalls]),
    writableDirs: inputs.writableDirs,
  });
}

/** Writes `content` through a temp file and a rename (a reader never sees half a file). */
function writeAtomic(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function writeInputs(agentDir: string, inputs: SandboxInputs): void {
  const content = JSON.stringify(inputs, null, 2) + "\n";
  if (readOr(inputsFile(agentDir)) !== content) writeAtomic(inputsFile(agentDir), content, 0o600);
}

/** Writes through `deps` only when the file differs: true when it wrote. */
async function writeIfDifferent(deps: ProtectionDeps, file: string, content: string, mode: number): Promise<boolean> {
  if (readOr(file) === content) return false;
  await deps.writeFile(file, content, mode);
  return true;
}

/** The person's to rewrite: writable by them, and not a shared sticky dir like /tmp (others' entries stay put there). */
const userWritable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return (fs.statSync(file).mode & 0o1000) === 0 // sticky bit;
  } catch {
    return false;
  }
};

function ancestors(file: string): string[] {
  const out: string[] = [];
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) out.push(dir);
  return out;
}

/**
 * Paths a write-deny prefix must never cover: home and every agent dir and memory dir (`keep`), and the window's VS Code
 * workspace folders (P38: the person's projects, wherever they are).
 */
export type PrefixGuard = { home: string; keep: string[]; workspaces?: string[] };

function prefixGuard(paths: EnvPaths, workspaces: string[] = []): PrefixGuard {
  const envs = ENV_NAMES.map((name) => resolveEnv(name, paths.home));
  return {
    home: paths.home,
    keep: [paths.home, paths.agentDir, paths.memoryHome, ...envs.flatMap((env) => [env.agentDir, env.memoryHome])],
    workspaces: workspaces.flatMap((dir) => (fs.existsSync(dir) ? [dir, fs.realpathSync(dir)] : [dir])),
  };
}

const isWithin = (file: string, dir: string): boolean => file === dir || file.startsWith(dir + path.sep);

/** Dirs looked into before a dir in home counts as holding a repo anyway (P38: too big to tell is never closed whole). */
const REPO_SCAN_BUDGET = 1_000;
/** One scan per dir per guard: the links of one PATH share their ancestors. */
const repoScans = new WeakMap<PrefixGuard, Map<string, boolean>>();

/** A dir in home with a git repo somewhere below it (node_modules not looked into), or too many dirs to tell. */
function holdsRepo(dir: string, guard: PrefixGuard): boolean {
  const scans = repoScans.get(guard) ?? new Map<string, boolean>();
  repoScans.set(guard, scans);
  let found = scans.get(dir);
  if (found === undefined) scans.set(dir, (found = scanForRepo(dir)));
  return found;
}

function scanForRepo(dir: string): boolean {
  const queue = [dir];
  for (let budget = REPO_SCAN_BUDGET; queue.length > 0; budget -= 1) {
    if (budget === 0) return true;
    const current = queue.shift() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // a file, or unreadable
    }
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (entry.isDirectory() && entry.name !== "node_modules") queue.push(path.join(current, entry.name));
    }
  }
  return false;
}

/** A dir like /Applications: app bundles right inside it. */
function holdsApps(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name.endsWith(".app"));
  } catch {
    return false;
  }
}

/**
 * What to close so nobody rewrites `file` (P33, P38): `file` itself when it is in a workspace folder or in a git work
 * tree in home (the person's projects); the outermost `.app` bundle it is in; else its topmost user-writable dir below
 * home (/opt/homebrew, ~/.nvm, ~/.codegraph), narrowed until it holds no agent dir, memory, workspace folder, app
 * bundle and — in home — no git repo; `file` itself when that top is a plain dir in home (~/Documents: projects live
 * there) or nothing narrower fits. Undefined when nothing on the way is writable. Outside home a writable git tree is
 * a package prefix (Homebrew's /opt/homebrew is one) and is closed whole.
 */
export function writablePrefix(file: string, guard: PrefixGuard, isWritable: (file: string) => boolean = userWritable): string | undefined {
  const { home } = guard;
  const workspaces = guard.workspaces ?? [];
  const below = [file, ...ancestors(file)].filter((dir) => dir !== home && !home.startsWith(dir + path.sep));
  const writable = below.filter(isWritable);
  const top = writable.at(-1);
  if (top === undefined) return undefined;
  if (workspaces.some((dir) => isWithin(file, dir))) return file;
  if (below.some((dir) => isWithin(dir, home) && fs.existsSync(path.join(dir, ".git")))) return file;
  const bundle = [...below].reverse().find((dir) => dir.endsWith(".app"));
  if (bundle !== undefined) return bundle;
  if (path.dirname(top) === home && !path.basename(top).startsWith(".")) return file;
  const holdsKept = (dir: string): boolean => [...guard.keep, ...workspaces].some((kept) => isWithin(kept, dir));
  const closable = (dir: string): boolean => !holdsKept(dir) && !holdsApps(dir) && !(isWithin(dir, home) && holdsRepo(dir, guard));
  return [...writable].reverse().find(closable) ?? file;
}

/**
 * The node the LaunchAgent and the hook run (P33): the first candidate whose real file and every dir above it are not
 * the person's to write; else the first one there is, with the `prefix` to be write-denied under protection.
 * Undefined when no candidate exists.
 */
export function chooseServiceNode(
  candidates: string[],
  guard: PrefixGuard,
  isWritable: (file: string) => boolean = userWritable,
): { node: string; prefix?: string } | undefined {
  const found = [...new Set(candidates.filter((file) => path.isAbsolute(file) && fs.existsSync(file)).map((file) => fs.realpathSync(file)))];
  const safe = found.find((file) => ![file, ...ancestors(file)].some(isWritable));
  if (safe !== undefined) return { node: safe };
  const node = found[0];
  if (node === undefined) return undefined;
  return { node, prefix: writablePrefix(node, guard, isWritable) ?? node };
}

/**
 * P33/N4: what to close on the login PATH (a tool there runs outside the sandbox the next time the person types its
 * name): for every entry — and every link inside one — the writable prefix of its real path; an entry that does not
 * exist yet is closed as it is (nobody may create it). Never home, or a dir holding home, an agent dir or memory.
 */
export function loginPathDenies(dirs: string[], guard: PrefixGuard, isWritable: (file: string) => boolean = userWritable): string[] {
  const out = new Set<string>();
  const add = (file: string): void => {
    const prefix = writablePrefix(file, guard, isWritable);
    if (prefix !== undefined) out.add(prefix);
  };
  for (const dir of new Set(dirs)) {
    if (!path.isAbsolute(dir) || guard.keep.some((kept) => kept === dir || kept.startsWith(dir + path.sep))) continue;
    if (!fs.existsSync(dir)) {
      out.add(dir);
      continue;
    }
    add(fs.realpathSync(dir));
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // unreadable: its own prefix is all we can close
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (!fs.lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
      let target: string;
      try {
        target = fs.realpathSync(full);
      } catch {
        target = path.resolve(dir, fs.readlinkSync(full)); // dangling: the agent must not create what it names
      }
      add(target);
    }
  }
  return [...out].sort();
}

type PlanDeps = Pick<ProtectionDeps, "loginPath" | "workspaceFolders">;

/** The node the service and hook run and the dirs closed to agents (P33, P38), from the login PATH as it is now. */
async function plan(paths: EnvPaths, deps: PlanDeps): Promise<{ node: string; writableDirs: string[] }> {
  const loginDirs = await deps.loginPath();
  const guard = prefixGuard(paths, deps.workspaceFolders);
  const choice = chooseServiceNode(
    loginDirs.map((dir) => path.join(dir, "node")),
    guard,
  );
  if (choice === undefined) throw new Error("Не найден node — установите Node.js 22+ и откройте настройки снова");
  return { node: choice.node, writableDirs: [...new Set([...loginPathDenies(loginDirs, guard), ...(choice.prefix !== undefined ? [choice.prefix] : [])])].sort() };
}

/**
 * For the consent dialog: the dirs enabling now would write-deny — the login-PATH ones enableProtection records in
 * sandbox.json, and what OmO loads as skills or extensions, which every profile build reads afresh from the settings.
 */
export async function plannedWriteDenies(paths: EnvPaths, deps: PlanDeps): Promise<string[]> {
  const agentDirs = [paths.agentDir, ...ENV_NAMES.map((name) => resolveEnv(name, paths.home).agentDir)];
  return [...new Set([...(await plan(paths, deps)).writableDirs, ...loadedResourceDenies(paths.home, agentDirs)])].sort();
}

/**
 * Turns protection on, in an order that is safe to stop anywhere and to repeat: rules -> kit copy -> LaunchAgent
 * (rebooted only when its plist changed or the service is not answering) -> hook socket up (else the LaunchAgent goes
 * again and an error: state off) -> our hook group -> agent dirs -> sandbox inputs and profile -> host restart (always:
 * no session stays unsandboxed).
 */
export async function enableProtection(paths: EnvPaths, deps: ProtectionDeps): Promise<void> {
  const { node, writableDirs } = await plan(paths, deps);
  const source = path.join(deps.kitDir, "guard");
  const service = servicePaths(paths.agentDir);

  fs.mkdirSync(service.dir, { recursive: true, mode: 0o700 });
  const rules = rulesToWrite(service.rules, source);
  if (rules !== undefined) await deps.writeFile(service.rules, rules, 0o600);

  const kitGuard = installGuardFiles(paths.home, source);

  const label = serviceLabel(paths.agentDir);
  const plistFile = launchAgentPath(paths.home, label);
  const plist = launchAgentPlist({
    label,
    node,
    serviceScript: path.join(kitGuard, "service.mjs"),
    agentDir: paths.agentDir,
    logFile: path.join(service.dir, "service.log"),
  });
  const plistChanged = await writeIfDifferent(deps, plistFile, plist, 0o644);
  if (plistChanged || !(await deps.waitForSocket(service.hookSock, 0))) {
    // not loaded: nothing to stop
    const bootout = (): Promise<void> => deps.launchctl(["bootout", `gui/${deps.uid}/${label}`]).catch(() => undefined);
    await bootout();
    await deps.launchctl(["bootstrap", `gui/${deps.uid}`, plistFile]);
    if (!(await deps.waitForSocket(service.hookSock, SERVICE_START_MS))) {
      await bootout();
      await deps.removeFile(plistFile);
      throw new Error(`Служба защиты не запустилась за ${SERVICE_START_MS / 1000} с — журнал: ${path.join(service.dir, "service.log")}`);
    }
  }

  setGuardHook(paths, true, guardHookEntry({ node, kitDir: kitGuard, agentDir: paths.agentDir }));

  // must exist before a sandboxed host starts (it cannot create them); the guard dir exists since the rules step
  fs.mkdirSync(path.join(paths.agentDir, "extensions"), { recursive: true });
  fs.mkdirSync(path.dirname(hostSocketPath(paths.agentDir)), { recursive: true });
  fs.mkdirSync(path.dirname(protectedHostSocketPath(paths.agentDir)), { recursive: true, mode: 0o700 });

  const inputs = nextInputs(paths, deps.vscode, writableDirs);
  writeInputs(paths.agentDir, inputs);
  await writeIfDifferent(deps, profilePath(paths.agentDir), profileFor(paths, inputs), 0o644);
  await deps.restartHost();
}

/**
 * The reverse: profile -> hook group -> LaunchAgent -> whatever sits at the unprotected host's socket (nothing there is
 * ours while protected) -> host restart there. Rules, sandbox inputs and the kit copy stay.
 */
export async function disableProtection(paths: EnvPaths, deps: ProtectionDeps): Promise<void> {
  const profile = profilePath(paths.agentDir);
  if (fs.existsSync(profile)) await deps.removeFile(profile);
  setGuardHook(paths, false, { hooks: [] });
  const label = serviceLabel(paths.agentDir);
  const plistFile = launchAgentPath(paths.home, label);
  if (fs.existsSync(plistFile)) {
    await deps.launchctl(["bootout", `gui/${deps.uid}/${label}`]).catch(() => undefined);
    await deps.removeFile(plistFile);
  }
  const plainSocket = hostSocketPath(paths.agentDir);
  if (lstatOrUndefined(plainSocket) !== undefined) await deps.removeFile(plainSocket);
  await deps.restartHost();
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}

/** The state, and for «broken» what is wrong, in the person's words. */
export type ProtectionStatus = { state: "off"; note?: string } | { state: "on" } | { state: "broken"; reason: string };

export const V1_NOTE = "найдена старая защита v1 — включите защиту, чтобы заменить её";
const isV1 = (command: string): boolean => command.includes(`${path.sep}guard${path.sep}agent-guard.mjs`);

const UNREADABLE = "hooks.json или guard/sandbox.json не читается";
const shellUnquote = (word: string): string => word.slice(1, -1).replace(/'\\''/g, "'");

/** The node and the hook script of our handler (`'<node>' '<kitDir>/hook.mjs' --agent-dir …`), when it reads so. */
function hookFiles(command: string): { node: string; script: string } | undefined {
  const words = command.match(/'(?:[^']|'\\'')*'/g);
  return words === null || words.length < 2 ? undefined : { node: shellUnquote(words[0] as string), script: shellUnquote(words[1] as string) };
}

/**
 * True when `pid` runs under a Seatbelt profile: `sandbox_check(pid, NULL, 0)` called through stock osascript's JXA
 * bridge (no compiler, no native module; ~50 ms). The process list cannot tell: sandbox-exec execs the host, so its
 * command line is the host's own.
 */
export async function isSandboxed(pid: number): Promise<boolean> {
  const script = `ObjC.bindFunction("sandbox_check", ["int", ["int", "void *", "int"]]); $.sandbox_check(${Math.trunc(pid)}, null, 0)`;
  const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 5_000 });
  return stdout.trim() === "1";
}

/** How protectionStatus tells whether the running host is sandboxed (isSandboxed; a fake in tests). */
export type HostSandboxCheck = { sandboxed(pid: number): Promise<boolean> };

/**
 * Why the running host is not one protection put in place, or undefined: a host answering on the unprotected socket
 * (a window still on 0.2.x started it), or the protected host recorded in guard/host (only the extension writes there)
 * — alive and holding its socket — running outside the sandbox.
 */
async function unsandboxedHost(paths: EnvPaths, check: HostSandboxCheck): Promise<string | undefined> {
  const plain = hostSocketPath(paths.agentDir);
  if (await socketAlive(plain)) return `хост OmO без песочницы отвечает на ${plain} — окно со старой версией расширения? Перезагрузите все окна VS Code`;
  const pid = Number(readOr(protectedHostPidPath(paths.agentDir))?.trim());
  if (!Number.isInteger(pid) || pid <= 0 || !(await listensOn(pid, protectedHostSocketPath(paths.agentDir)))) return undefined;
  const sandboxed = await check.sandboxed(pid).catch(() => undefined);
  if (sandboxed === undefined) return `не удалось проверить, что хост OmO (pid ${pid}) в песочнице`;
  return sandboxed ? undefined : `хост OmO (pid ${pid}) работает без песочницы — нажмите «Перезапустить OmO»`;
}

/**
 * «off»: no profile, no hook group, no LaunchAgent. «on»: all three, the hook under both events naming a node and an
 * installed kit copy that exist, the service answering on its hook socket, the profile exactly what it should be now
 * and no host of this environment running outside the sandbox. Anything else — a part missing, a stale or unreadable
 * profile, a silent service, an unsandboxed host, an unusable hooks.json or sandbox.json — is «broken», with the first
 * problem found as the reason.
 */
export async function protectionStatus(paths: EnvPaths, vscode: VscodePaths, host: HostSandboxCheck = { sandboxed: isSandboxed }): Promise<ProtectionStatus> {
  const profile = profilePath(paths.agentDir);
  const plistFile = launchAgentPath(paths.home, serviceLabel(paths.agentDir));
  const plist = fs.existsSync(plistFile);
  let all: Array<{ event: string; command: string }>;
  let expected: string;
  try {
    all = guardHandlers(paths);
    expected = profileFor(paths, nextInputs(paths, vscode));
  } catch {
    return { state: "broken", reason: UNREADABLE };
  }
  // A v1 hook (agent-guard.mjs) is not part of v2 protection: alone it is «off»; enabling replaces it.
  const handlers = all.filter((handler) => !isV1(handler.command));
  const hasProfile = fs.existsSync(profile);
  if (!hasProfile && handlers.length === 0 && !plist) return handlers.length < all.length ? { state: "off", note: V1_NOTE } : { state: "off" };
  if (!plist) return { state: "broken", reason: `нет LaunchAgent службы защиты: ${plistFile}` };
  if (new Set(handlers.map((handler) => handler.event)).size !== 2) return { state: "broken", reason: `хук защиты подключён в ${paths.hooksJson} не полностью` };
  for (const { command } of handlers) {
    const files = hookFiles(command);
    if (files === undefined) return { state: "broken", reason: `хук защиты в ${paths.hooksJson} не разобрать` };
    if (!fs.existsSync(files.node)) return { state: "broken", reason: `нет node, который запускает хук: ${files.node}` };
    if (!fs.existsSync(files.script)) return { state: "broken", reason: `нет установленной копии защиты: ${path.dirname(files.script)}` };
  }
  if (!hasProfile) return { state: "broken", reason: `нет профиля песочницы: ${profile}` };
  if (readOr(profile) !== expected) return { state: "broken", reason: "профиль песочницы устарел или не читается" };
  if (!(await socketAlive(servicePaths(paths.agentDir).hookSock))) return { state: "broken", reason: "служба защиты не отвечает на хуковом сокете" };
  const unsandboxed = await unsandboxedHost(paths, host);
  if (unsandboxed !== undefined) return { state: "broken", reason: unsandboxed };
  return { state: "on" };
}

export async function protectionState(paths: EnvPaths, vscode: VscodePaths): Promise<ProtectionState> {
  return (await protectionStatus(paths, vscode)).state;
}

/**
 * P7: while protection is on, this window's VS Code joins sandbox.json and the profile is rewritten from it; off,
 * nothing is created. Throws (profile left as it is) when sandbox.json cannot be read.
 */
export function refreshProfile(paths: EnvPaths, vscode: VscodePaths): void {
  const profile = profilePath(paths.agentDir);
  if (!fs.existsSync(profile)) return;
  const inputs = nextInputs(paths, vscode);
  writeInputs(paths.agentDir, inputs);
  const content = profileFor(paths, inputs);
  if (readOr(profile) !== content) writeAtomic(profile, content, 0o644);
}

/** Polls `file` until something accepts connections on it or `ms` passes. */
export async function waitForSocket(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await socketAlive(file)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SOCKET_POLL_MS));
  }
}

/** The login shell's PATH (`zsh -l`, outside the sandbox); the marker skips anything the profile files print. */
async function loginPath(): Promise<string[]> {
  const { stdout } = await promisify(execFile)("/bin/zsh", ["-lc", `printf '\\n${PATH_MARK}%s' "$PATH"`], { timeout: 10_000 });
  const at = stdout.lastIndexOf(PATH_MARK);
  return at < 0 ? [] : stdout.slice(at + PATH_MARK.length).trim().split(":").filter(Boolean);
}

/**
 * restartHost for the protection switch: this window's host manager restarts the host; a window without one fails the
 * switch (the change is not done while no host restarted under it).
 */
export function hostRestarter(daemon: () => { ok: true; value: { restartHost(): Promise<unknown> } } | { ok: false; error: string }): () => Promise<void> {
  return async () => {
    const manager = daemon();
    if (!manager.ok) throw new Error(manager.error);
    await manager.value.restartHost();
  };
}

/** The real machine: launchctl, the user's LaunchAgents, the login PATH. */
export function systemProtectionDeps(spec: { kitDir: string; vscode: VscodePaths; workspaceFolders: string[]; restartHost(): Promise<void> }): ProtectionDeps {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Не удалось узнать uid пользователя — службу защиты не поставить");
  return {
    ...spec,
    launchctl: async (args) => {
      await promisify(execFile)("/bin/launchctl", args);
    },
    writeFile: async (file, content, mode) => writeAtomic(file, content, mode),
    removeFile: async (file) => fs.rmSync(file, { force: true }),
    waitForSocket,
    loginPath,
    uid,
  };
}
