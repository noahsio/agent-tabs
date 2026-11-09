import { execFile } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { ENV_NAMES, resolveEnv } from "../../kit/lib/envs.mjs";
import {
  guardFilesDir,
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
  type SandboxLayer,
  type SandboxLayers,
} from "../../kit/sandbox/profile.mjs";
import { MAX_SOCKET_PATH } from "../../kit/guard/sockets.mjs";
import { bindStartLock, listensOn } from "../daemon";
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
  /** Waits between bootstrap attempts (a timer; tests pass a no-op). */
  pause?(ms: number): Promise<void>;
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
type SandboxInputs = { vscodeInstalls: VscodeInstall[]; writableDirs: string[]; layers?: SandboxLayers };

const SERVICE_START_MS = 10_000;
const SOCKET_POLL_MS = 100;
const PATH_MARK = "__agent_tabs_path__";

const inputsFile = (agentDir: string): string => path.join(agentDir, "guard", "sandbox.json");

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  const layers = raw["layers"];
  if (!Array.isArray(installs) || !installs.every(isInstall) || !isStringList(dirs)) throw new Error(`${inputsFile(agentDir)}: не тот формат`);
  if (layers !== undefined && !isLayers(layers)) throw new Error(`${inputsFile(agentDir)}: не тот формат`);
  return { vscodeInstalls: installs, writableDirs: dirs, ...(layers !== undefined ? { layers } : {}) };
}

function isLayers(value: unknown): value is SandboxLayers {
  return typeof value === "object" && value !== null &&
    "launch" in value && typeof value.launch === "boolean" &&
    "agentCode" in value && typeof value.agentCode === "boolean" &&
    "localServices" in value && typeof value.localServices === "boolean";
}

/** The saved choice, including defaults for installations predating layers. */
export function sandboxLayers(agentDir: string): SandboxLayers {
  return readInputs(agentDir).layers ?? { launch: true, agentCode: true, localServices: true };
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
  return { ...current, vscodeInstalls: mergeInstalls([current.vscodeInstalls, [vscode]]), writableDirs: writableDirs ?? current.writableDirs };
}

/** The profile for `inputs` and every other env's installs: identical whichever VS Code builds it once all recorded. */
function profileFor(paths: EnvPaths, inputs: SandboxInputs): string {
  return buildProfile({
    home: paths.home,
    agentDir: paths.agentDir,
    envs: [{ agentDir: paths.agentDir, claudeDir: paths.claudeDir }],
    vscodes: mergeInstalls([...otherEnvInstalls(paths), inputs.vscodeInstalls]),
    writableDirs: inputs.writableDirs,
    ...(inputs.layers !== undefined ? { layers: inputs.layers } : {}),
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
  // ~/.local is an XDG base dir: bin is on PATH, but state/share/lib hold data ordinary tools keep writing
  // (CLI tools keep their state in ~/.local/state/<tool>). Close the PATH entry itself, never the whole tree.
  if (isWithin(file, path.join(home, ".local"))) return file;
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
  const layers = sandboxLayers(paths.agentDir);
  const agentDirs = [paths.agentDir, ...ENV_NAMES.map((name) => resolveEnv(name, paths.home).agentDir)];
  return [...new Set([
    ...(layers.launch ? (await plan(paths, deps)).writableDirs : []),
    ...(layers.agentCode ? loadedResourceDenies(paths.home, agentDirs) : []),
  ])].sort();
}

/** The LaunchAgent that runs `kitGuard`'s service with `node`: the one place the plist's content is decided. */
function plistFor(paths: EnvPaths, node: string, kitGuard: string): string {
  return launchAgentPlist({
    label: serviceLabel(paths.agentDir),
    node,
    serviceScript: path.join(kitGuard, "service.mjs"),
    agentDir: paths.agentDir,
    logFile: path.join(servicePaths(paths.agentDir).dir, "service.log"),
  });
}

/**
 * Boots the LaunchAgent at `plistFile` — only when its plist changed or nothing answers on the hook socket, so a
 * repeat leaves a running service alone. False when the service did not come up in time.
 */
async function bootService(paths: EnvPaths, deps: ProtectionDeps, plistFile: string, plistChanged: boolean): Promise<boolean> {
  const service = servicePaths(paths.agentDir);
  if (!plistChanged && (await deps.waitForSocket(service.hookSock, 0))) return true;
  const label = serviceLabel(paths.agentDir);
  await deps.launchctl(["bootout", `gui/${deps.uid}/${label}`]).catch(() => undefined); // not loaded: nothing to stop
  await bootstrapWhenUnloaded(deps, plistFile);
  return deps.waitForSocket(service.hookSock, SERVICE_START_MS);
}

const BOOTSTRAP_ATTEMPTS = 20;
const BOOTSTRAP_PAUSE_MS = 250;

/**
 * `bootout` returns before launchd has let go of the label; a `bootstrap` of it meanwhile fails with «Bootstrap
 * failed: 5: Input/output error» (measured), so that one error is retried for up to ~5 s. Any other error is final.
 */
async function bootstrapWhenUnloaded(deps: ProtectionDeps, plistFile: string): Promise<void> {
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.launchctl(["bootstrap", `gui/${deps.uid}`, plistFile]);
    } catch (error) {
      const unloading = /Bootstrap failed: 5:/.test(error instanceof Error ? error.message : String(error));
      if (!unloading || attempt >= BOOTSTRAP_ATTEMPTS) throw error;
      await pause(BOOTSTRAP_PAUSE_MS);
    }
  }
}

/**
 * Puts the protection of this environment in place, in an order that is safe to stop anywhere and to repeat: rules ->
 * kit copy -> LaunchAgent (rebooted only when its plist changed or the service is not answering) -> hook socket up
 * (else the LaunchAgent goes again and an error: nothing of ours is loaded) -> our hook group -> agent dirs -> sandbox
 * inputs and profile. `writableDirs` left out keeps the dirs sandbox.json already names (what the person consented to
 * close); the host is the caller's to restart.
 */
async function provision(paths: EnvPaths, deps: ProtectionDeps, spec: { node: string; writableDirs?: string[] }): Promise<void> {
  const source = path.join(deps.kitDir, "guard");
  const service = servicePaths(paths.agentDir);

  fs.mkdirSync(service.dir, { recursive: true, mode: 0o700 });
  const rules = rulesToWrite(service.rules, source);
  if (rules !== undefined) await deps.writeFile(service.rules, rules, 0o600);

  const kitGuard = installGuardFiles(paths.home, source);

  const label = serviceLabel(paths.agentDir);
  const plistFile = launchAgentPath(paths.home, label);
  const plistChanged = await writeIfDifferent(deps, plistFile, plistFor(paths, spec.node, kitGuard), 0o644);
  // A service that did not come up, or that launchd refused, is undone alike: no plist is left behind to read as «broken».
  const up = await bootService(paths, deps, plistFile, plistChanged).catch((error: unknown) => error);
  if (up !== true) {
    await deps.launchctl(["bootout", `gui/${deps.uid}/${label}`]).catch(() => undefined);
    await deps.removeFile(plistFile);
    if (up !== false) throw up;
    throw new Error(`Служба защиты не запустилась за ${SERVICE_START_MS / 1000} с — журнал: ${path.join(service.dir, "service.log")}`);
  }

  setGuardHook(paths, true, guardHookEntry({ node: spec.node, kitDir: kitGuard, agentDir: paths.agentDir }));

  // must exist before a sandboxed host starts (it cannot create them); the guard dir exists since the rules step
  fs.mkdirSync(path.join(paths.agentDir, "extensions"), { recursive: true });
  // the coordinate tool of this kit copy (as kit/setup-omo.mjs writes it): agents cannot write extensions/, the plugin can
  await writeIfDifferent(deps, path.join(paths.agentDir, "extensions/coordinate.ts"),
    `export { default } from ${JSON.stringify(path.join(kitGuard, "coordinate-extension.mjs"))};\n`, 0o644);
  fs.mkdirSync(path.dirname(hostSocketPath(paths.agentDir)), { recursive: true });
  fs.mkdirSync(path.dirname(protectedHostSocketPath(paths.agentDir)), { recursive: true, mode: 0o700 });

  const inputs = nextInputs(paths, deps.vscode, spec.writableDirs);
  writeInputs(paths.agentDir, inputs);
  await writeIfDifferent(deps, profilePath(paths.agentDir), profileFor(paths, inputs), 0o644);
}

/**
 * Turns protection on: the provisioning above with the node and the write-denies planned from the login PATH as it is
 * now, and then a host restart (always: no session stays unsandboxed).
 */
export async function enableProtection(paths: EnvPaths, deps: ProtectionDeps): Promise<void> {
  await provision(paths, deps, await plan(paths, deps));
  await deps.restartHost();
}

/** A profile exists exactly while launchers use protection; its rules take effect only at host start. */
export async function setSandboxLayer(paths: EnvPaths, deps: ProtectionDeps, layer: SandboxLayer, on: boolean): Promise<void> {
  const inputs = readInputs(paths.agentDir);
  const layers = inputs.layers ?? { launch: true, agentCode: true, localServices: true };
  if (layers[layer] === on) return;
  const next = { ...inputs, layers: { ...layers, [layer]: on } };
  writeInputs(paths.agentDir, next);
  const profile = profilePath(paths.agentDir);
  if (!fs.existsSync(profile)) return;
  await writeIfDifferent(deps, profile, profileFor(paths, next), 0o644);
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

type GuardHandler = { event: string; command: string; timeout?: number };

/** The guard copy, the node and the handlers of the hook entry installed here, when hooks.json holds a v2 one of ours. */
function installedHook(paths: EnvPaths): { node: string; kitDir: string; handlers: GuardHandler[] } | undefined {
  let handlers: GuardHandler[];
  try {
    handlers = guardHandlers(paths).filter((handler) => !isV1(handler.command));
  } catch {
    return undefined; // an unusable hooks.json is «broken»: nothing is read off it
  }
  for (const { command } of handlers) {
    const files = hookFiles(command);
    if (files !== undefined) return { node: files.node, kitDir: path.dirname(files.script), handlers };
  }
  return undefined;
}

/** The guard copy that actually runs: where it is, when it was installed there, and whether it is the shipped one. */
export type InstalledKit = { dir: string; installedAt?: number; stale: boolean };

/**
 * What «Безопасность» says about the guard the person actually runs: the installed copy the hook entry names, when it
 * was installed, and whether it is `source`'s. `stale`: the classifier, the rules and the service in use are an older
 * build's — what this whole refresh exists to make visible. Undefined while no v2 hook of ours is installed.
 */
export function installedKit(paths: EnvPaths, source: string): InstalledKit | undefined {
  const hook = installedHook(paths);
  if (hook === undefined) return undefined;
  const installedAt = lstatOrUndefined(path.join(hook.kitDir, "hook.mjs"))?.mtimeMs;
  return { dir: hook.kitDir, ...(installedAt !== undefined ? { installedAt } : {}), stale: hook.kitDir !== guardFilesDir(paths.home, source) };
}

/** An installation to carry forward: the node it already names (a refresh never re-decides it) and the copy to run. */
type Installation = { node: string; kitDir: string };

/**
 * Whether what is installed is what the bundled kit calls for, read off the disk alone — no launchctl, no login shell,
 * so an activation with nothing to do costs nothing and touches nothing. The comparison is exact: the hook entry under
 * both events and the LaunchAgent must be what `provision` would write for the bundled copy and the node the hook
 * already names, so a changed kit, a drifted plist and a drifted entry are all one check. «absent»: nothing of ours is
 * installed here (no v2 hook group, no LaunchAgent, an unreadable hooks.json), or the node the hook names is gone —
 * that last one is «broken», and «Починить» plans a node anew instead of this guessing one.
 */
function refreshTarget(paths: EnvPaths, source: string): Installation | "absent" | "fresh" {
  const hook = installedHook(paths);
  if (hook === undefined || !fs.existsSync(hook.node)) return "absent";
  const plistFile = launchAgentPath(paths.home, serviceLabel(paths.agentDir));
  if (!fs.existsSync(plistFile)) return "absent";
  const kitDir = guardFilesDir(paths.home, source);
  const wanted = guardHookEntry({ node: hook.node, kitDir, agentDir: paths.agentDir }).hooks[0];
  const entryIsCurrent =
    new Set(hook.handlers.map((handler) => handler.event)).size === 2 &&
    hook.handlers.every((handler) => handler.command === wanted?.command && handler.timeout === wanted.timeout);
  return entryIsCurrent && readOr(plistFile) === plistFor(paths, hook.node, kitDir) ? "fresh" : { node: hook.node, kitDir };
}

/** What activation did about the installed guard copy. */
export type RefreshOutcome =
  | { kind: "absent" }
  | { kind: "fresh" }
  | { kind: "elsewhere" }
  | { kind: "refreshed"; kitDir: string }
  | { kind: "failed"; reason: string };

const REFRESH_LOCK = "refresh.sock";

/**
 * Brings the installed guard up to the one this extension ships, at activation. Protection is refreshed without asking:
 * the person consented to the guard running from an installed copy, and a copy left behind by an update is not a
 * gentler version of that — it denies and asks for what today's rules allow, for as long as nobody notices (which is
 * the bug this fixes). What it costs is bounded in exchange: nothing of the person's choosing is re-decided (the node
 * and the dirs sandbox.json closes stay as they are), no host is restarted — so no turn is interrupted — and the only
 * window of harm is the second or two the decision service is rebooting, in which a tool call that needs it is denied
 * and the agent may retry. `provision`'s own ordering does the work, so the plist, the hook entry, the sandbox inputs
 * and the service come out of a refresh exactly as they do out of enabling.
 *
 * One refresh at a time across every window (the lock src/daemon.ts binds for host starts), re-checked under the lock;
 * the loser leaves it to the holder. A failure never leaves the hook entry and the LaunchAgent naming different copies.
 */
export async function refreshProtection(paths: EnvPaths, deps: ProtectionDeps): Promise<RefreshOutcome> {
  const source = path.join(deps.kitDir, "guard");
  const target = refreshTarget(paths, source);
  if (typeof target === "string") return { kind: target };
  const lockFile = path.join(servicePaths(paths.agentDir).dir, REFRESH_LOCK);
  let lock: Server | undefined;
  // A path too long to bind is skipped rather than failing the refresh, as a host start skips its own lock.
  if (Buffer.byteLength(lockFile) <= MAX_SOCKET_PATH) {
    lock = await bindStartLock(lockFile);
    if (lock === undefined) return { kind: "elsewhere" }; // another window is refreshing it right now
  }
  try {
    const under = refreshTarget(paths, source); // the window that held the lock may have just done it
    if (typeof under === "string") return { kind: under };
    try {
      await provision(paths, deps, { node: under.node });
      return { kind: "refreshed", kitDir: under.kitDir };
    } catch (error) {
      return { kind: "failed", reason: await realign(paths, deps, errorText(error)) };
    }
  } finally {
    lock?.close();
    if (lock !== undefined) fs.rmSync(lockFile, { force: true });
  }
}

/**
 * After a failed refresh: a hook entry naming a copy the LaunchAgent does not run — or no LaunchAgent at all, which is
 * what a service that would not start leaves behind — denies every tool call until someone notices. The plist for the
 * copy the hook entry names (the previous one, or the new one when the entry got that far) is put back and booted
 * before the failure is reported; the reason says so when even that did not work. The copy itself is still there:
 * installing a new one never removes an old one.
 */
async function realign(paths: EnvPaths, deps: ProtectionDeps, reason: string): Promise<string> {
  const hook = installedHook(paths);
  if (hook === undefined) return reason;
  const plistFile = launchAgentPath(paths.home, serviceLabel(paths.agentDir));
  try {
    const changed = await writeIfDifferent(deps, plistFile, plistFor(paths, hook.node, hook.kitDir), 0o644);
    if (await bootService(paths, deps, plistFile, changed)) return reason;
    return `${reason}; прежняя служба защиты тоже не поднялась — включите защиту заново`;
  } catch (error) {
    return `${reason}; прежнюю службу защиты не вернуть: ${errorText(error)}`;
  }
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
