import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  hostPidPath,
  hostSocketPath,
  lspDaemonDir,
  profilePath,
  protectedHostPidPath,
  protectedHostSocketPath,
  realOf,
} from "../kit/sandbox/profile.mjs";
import { redact, type OmoEnv } from "./env";
import { RpcClient } from "./rpc/client";

/** The spawned host as far as the manager needs it (a `ChildProcess` fits). */
export type HostProcess = {
  readonly pid?: number | undefined;
  unref(): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};
export type SpawnFn = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string; stdio: "ignore"; detached: true },
) => HostProcess;
/**
 * `kill` has `process.kill` semantics (signal 0 probes); `commandLine` is undefined for a process that is gone;
 * `listensOn` tells whether the process holds the unix socket bound at `socket`.
 */
export type ProcessOps = {
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  commandLine(pid: number): Promise<string | undefined>;
  listensOn(pid: number, socket: string): Promise<boolean>;
  /** Every live host of `socket` by command line: how a host is identified when the pid file is missing. */
  hostPids(socket: string): Promise<number[]>;
  /**
   * The OS's own start time for `pid`, undefined when there is no such process: the half of a cooldown key a process
   * cannot rotate, and the cheapest «is it still there» there is.
   */
  startedAt(pid: number): Promise<string | undefined>;
  /**
   * Descriptors of `pid` named with the unix socket `socket`: the listener it bound, plus one per client connected to
   * it (macOS names an accepted unix socket by the path it was bound with). 0 means it does not hold the path at all.
   */
  socketFds(pid: number, socket: string): Promise<number>;
  /** Cumulative CPU seconds charged to `pid`, undefined when it is gone: two samples make a rate. */
  cpuSeconds(pid: number): Promise<number | undefined>;
};
/** `beforeLaunch` runs before every host start (P7: the protection profile is regenerated there). */
export type HostDeps = { spawn?: SpawnFn; processes?: ProcessOps; readyTimeoutMs?: number; beforeLaunch?: () => void };

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Delays (ms) before each automatic reconnect attempt; its length is the attempt cap. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

const HOST_READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 200;
const HOST_STOP_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_MS = 30_000;
/** How long a window waits for whichever window is starting the host before it stops waiting and reports why. */
const START_LOCK_WAIT_MS = 40_000;
const START_LOCK_POLL_MS = 100;
/** A unix socket path may not pass this many bytes (macOS); a lock path longer than that is not used at all. */
const MAX_SOCKET_PATH = 103;

/**
 * Our own bare host's socket (never the shared `omo daemon` one, whose environment is an allowlist of names) and the
 * pid file for «Перезапустить OmO». Protection off: `<agentDir>/rpc/` as always (P35: a running host keeps its
 * sessions across an upgrade). Protection on: `<agentDir>/guard/host/`, which a sandboxed agent cannot write — it may
 * neither move the socket away nor plant a link at the pid path.
 */
export { hostPidPath, hostSocketPath, protectedHostPidPath, protectedHostSocketPath };

type HostLocation = { socket: string; pid: string; protected: boolean };

function hostLocations(agentDir: string): HostLocation[] {
  return [
    { socket: hostSocketPath(agentDir), pid: hostPidPath(agentDir), protected: false },
    { socket: protectedHostSocketPath(agentDir), pid: protectedHostPidPath(agentDir), protected: true },
  ];
}

/** Where this environment's host listens now: the protected place while the profile exists. */
function activeLocation(agentDir: string): HostLocation {
  const [plain, guarded] = hostLocations(agentDir) as [HostLocation, HostLocation];
  return existsSync(profilePath(agentDir)) ? guarded : plain;
}

export function activeHostSocketPath(agentDir: string): string {
  return activeLocation(agentDir).socket;
}

const defaultSpawn: SpawnFn = (file, args, options) => spawn(file, args, options) as HostProcess;

/** One `ps` field of one pid, or undefined when `ps` exits 1 because there is no such process. */
async function psField(pid: number, field: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("ps", ["-o", `${field}=`, "-p", String(pid)]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `[[days-]hh:]mm:ss.cc` as `ps` prints a process's CPU clock, in seconds. */
export function cpuTimeSeconds(text: string): number | undefined {
  const [days, clock] = text.includes("-") ? text.split("-") : [undefined, text];
  const parts = (clock as string).split(":").map(Number);
  if (parts.length === 0 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds + (days === undefined ? 0 : Number(days) * 86_400);
}

/** The real process table: everything the manager and the reaper ask of it goes through `ps` and `lsof`. */
export const systemProcesses: ProcessOps = {
  kill: (pid, signal) => process.kill(pid, signal),
  commandLine: (pid) => psField(pid, "command"),
  listensOn: (pid, socket) => listensOn(pid, socket),
  hostPids: (socket) => hostPids(socket),
  startedAt: (pid) => psField(pid, "lstart"),
  socketFds: (pid, socket) => socketFds(pid, socket),
  cpuSeconds: async (pid) => {
    const text = await psField(pid, "cputime");
    return text === undefined ? undefined : cpuTimeSeconds(text);
  },
};

/**
 * Live pids whose command line is this extension's host command for `socket` — the same rule `recordedHostPid` trusts,
 * without the pid file. Under protection the command starts with `sandbox-exec`, which execs omo in place, so there is
 * one process either way.
 */
export async function hostPids(socket: string): Promise<number[]> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("ps", ["-axo", "pid=,command="]));
  } catch {
    return [];
  }
  const tail = ` --mode rpc --listen unix://${socket}`;
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.endsWith(tail)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.push(pid);
  }
  return pids;
}

/**
 * Descriptors of `pid` named with the unix socket `socket` (lsof names one by the path it was bound with, or the real
 * one — a bind that was unlinked from under the process keeps its name here, which is what makes a stolen path
 * visible). The listener counts as one; every client that connected to it counts as one more.
 */
export async function socketFds(pid: number, socket: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-U", "-F", "n"]));
  } catch {
    return 0; // no such process, or nothing open
  }
  const names = new Set([socket, realOf(socket)].map((file) => `n${file}`));
  return stdout.split("\n").filter((line) => names.has(line)).length;
}

/** True when `pid` holds a unix socket bound at `socket`. */
export async function listensOn(pid: number, socket: string): Promise<boolean> {
  return (await socketFds(pid, socket)) > 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Where the start lock for a host socket lives: next to it, so it is per socket path and in the same closed dir. */
export function startLockPath(socket: string): string {
  return `${socket}.start`;
}

/** Something is at this path — a socket, a file, a dangling link. `existsSync` would follow the link and miss it. */
function pathExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** True when something is listening at `file` right now. A path with nothing behind it is free to unlink and rebind. */
function answersOn(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(file);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      probe.destroy();
      resolve(false);
    });
  });
}

/**
 * Binds `file` as this window's claim on a one-at-a-time job (starting the host; refreshing the installed guard, in
 * src/guard/protection.ts), or returns undefined when another window holds it.
 * A bound unix socket is the lock: taking it is one atomic step, and the OS gives it back the moment the process dies,
 * so a window that crashed in the middle of a start never leaves a lock anyone has to judge stale. The only thing it
 * can leave is the socket FILE, which is unlinked exactly when nothing answers on it.
 */
export async function bindStartLock(file: string): Promise<Server | undefined> {
  if (existsSync(file)) {
    if (await answersOn(file)) return undefined; // another window is starting the host right now
    await rm(file, { force: true });
  }
  const server = createServer();
  server.unref(); // the lock must never hold the extension host open
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    return undefined; // another window bound it between the probe and the listen
  }
  return server;
}

/**
 * Owns the connection to this environment's omo host: a bare `omo --mode rpc --listen` the extension spawns detached
 * with exactly the built environment (so CLAUDE_CONFIG_DIR and the rest reach it), outliving VS Code.
 * Events: "connected"(client), "disconnected", "gave_up"(reason), "warning"(text).
 * A new "connected" client has a new instanceId, so session handles from the previous one are invalid.
 */
export class DaemonManager extends EventEmitter {
  private current: RpcClient | undefined;
  /** The live host's own `instanceId`: what tells a refusal's holder apart from the host this window talks to. */
  private instance: string | undefined;
  private inflight: Promise<RpcClient> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private attempts = 0;
  private disposed = false;
  private readonly spawnFn: SpawnFn;
  private readonly processes: ProcessOps;
  private readonly readyTimeoutMs: number;
  private readonly beforeLaunch: () => void;

  constructor(
    private readonly env: OmoEnv,
    deps: HostDeps = {},
  ) {
    super();
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.processes = deps.processes ?? systemProcesses;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? HOST_READY_TIMEOUT_MS;
    this.beforeLaunch = deps.beforeLaunch ?? (() => undefined);
  }

  /** Secret values to redact from anything shown to the person. */
  get secrets(): readonly string[] {
    return this.env.secrets;
  }

  /** The environment this host belongs to, as the person's own setting names it. */
  get agentDir(): string {
    return this.env.agentDir;
  }

  /** True while there is a live client. */
  get connected(): boolean {
    return this.current !== undefined;
  }

  /** The socket this window's host serves: a refusal's holder is «ours» only when it names this path. */
  get socketPath(): string {
    return activeHostSocketPath(this.env.agentDir);
  }

  /** The live host's `instanceId`, once it has answered; undefined while it has not. */
  get hostInstance(): string | undefined {
    return this.instance;
  }

  /**
   * The pid this extension RECORDED for the host serving this environment's socket, while that pid is still that host.
   * Only the record, never the process table's guess: with the record lost (which is how two hosts happen at all) both
   * copies hold the path and the guess could name either, so an answer of «undefined» is the honest one. What tells a
   * second copy from the serving host without it is that nothing is connected to the second copy.
   */
  servingPid(): Promise<number | undefined> {
    return this.recordedHostPid(activeLocation(this.env.agentDir));
  }

  /** The live client, connecting (and starting the host if needed) when there is none. */
  client(): Promise<RpcClient> {
    if (this.disposed) return Promise.reject(new Error("daemon manager is disposed"));
    if (this.current !== undefined) return Promise.resolve(this.current);
    this.inflight ??= this.establish().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Manual retry after "gave_up": resets the attempt budget and tries immediately. */
  reconnectNow(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.attempts = 0;
    void this.attempt();
  }

  /**
   * Stops the hosts this extension spawned at either place (pid files, checked against the process's command line so
   * a reused pid is never signalled), then reconnects at once: a fresh host starts with this window's environment, at
   * the place protection calls for now, and tabs re-open their sessions by path. False when no such host was running.
   */
  async restartHost(): Promise<boolean> {
    if (this.disposed) return false;
    let stopped = false;
    for (const location of hostLocations(this.env.agentDir)) {
      const pid = await this.recordedHostPid(location);
      if (pid !== undefined) {
        stopped = true;
        this.processes.kill(pid, "SIGTERM");
        if (!(await this.exited(pid))) {
          try {
            this.processes.kill(pid, "SIGKILL");
          } catch {
            // it exited between the probe and the signal
          }
        }
      }
      await rm(location.pid, { force: true });
    }
    const old = this.current;
    if (old !== undefined) {
      this.onClose(old); // announce now rather than whenever the dead socket reports it
      old.close();
    }
    this.reconnectNow();
    return stopped;
  }

  /** Closes the socket and cancels retries. The host itself keeps running. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    const client = this.current;
    this.current = undefined;
    client?.close();
  }

  private async establish(): Promise<RpcClient> {
    const location = activeLocation(this.env.agentDir);
    // A host that is already serving the path is the only host: nothing is started, and nothing is unlinked from
    // under it. Starting one happens under a lock, so two windows cold-starting together cannot make two hosts.
    const client = (await this.connectExisting(location)) ?? (await this.startUnderLock(location));
    if (this.disposed) {
      client.close();
      throw new Error("daemon manager is disposed");
    }
    this.current = client;
    this.instance = client.instanceId;
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.attempts = 0;
    }, STABLE_CONNECTION_MS);
    client.once("close", () => this.onClose(client));
    client.on("warning", (text: string) => this.emit("warning", text));
    this.emit("connected", client);
    return client;
  }

  /**
   * The host already serving this socket, or undefined when there is none. Protected (N6): any sandboxed process may
   * bind the protected socket, so only a host of ours is ever talked to, and the record is written back — a lost pid
   * write (or an older version's) stops making «Перезапустить OmO» miss its host. Unprotected: whatever answers the
   * authenticated handshake, as before, and the process table is left alone (it is on every connect).
   */
  private async connectExisting(location: HostLocation): Promise<RpcClient | undefined> {
    if (!existsSync(location.socket)) return undefined;
    if (location.protected) {
      const own = await this.ownHostOn(location);
      if (own === undefined) return undefined;
      await this.writePid(location.pid, own);
    }
    try {
      return await RpcClient.connect(location.socket, this.env.agentDir);
    } catch {
      return undefined;
    }
  }

  /**
   * A host of ours holding this socket path now: the pid file when it still names one, else the live process whose
   * command line is our host command for this path. It is what tells «a leftover socket file» and «a stranger bound
   * our path» (both go) from «our own live host» (never unbound — that unlink is what orphaned a working host).
   */
  private async ownHostOn(location: HostLocation): Promise<number | undefined> {
    const recorded = await this.recordedHostPid(location);
    if (recorded !== undefined) return recorded;
    for (const pid of await this.processes.hostPids(location.socket)) {
      if (await this.processes.listensOn(pid, location.socket)) return pid;
    }
    return undefined;
  }

  /**
   * Starts the host as the one window allowed to. The lock is taken first and the path is looked at again under it, so
   * the window that loses connects to the host the winner started instead of starting a second one. Without a usable
   * lock path the start still cannot double-bind — a socket that answers is never unlinked, and omo itself refuses a
   * live one with EADDRINUSE — so the lock is skipped rather than failing the start.
   */
  private async startUnderLock(location: HostLocation): Promise<RpcClient> {
    // The lock and the socket share a directory, so it has to exist before either is bound. Protected: the host binds
    // in a dir a sandboxed host cannot create in or unlink from, and rpc/ (its key files) cannot be created under the
    // profile either, so both are made here.
    if (location.protected) await mkdir(dirname(hostSocketPath(this.env.agentDir)), { recursive: true });
    await mkdir(dirname(location.socket), { recursive: true, ...(location.protected ? { mode: 0o700 } : {}) });
    const file = startLockPath(location.socket);
    if (Buffer.byteLength(file) > MAX_SOCKET_PATH) return this.startHost(location);
    const deadline = Date.now() + START_LOCK_WAIT_MS;
    for (;;) {
      const lock = await bindStartLock(file);
      if (lock !== undefined) {
        try {
          return (await this.connectExisting(location)) ?? (await this.startHost(location));
        } finally {
          lock.close();
          await rm(file, { force: true });
        }
      }
      const started = await this.connectExisting(location);
      if (started !== undefined) return started;
      if (Date.now() >= deadline) {
        throw new Error(redact(`другое окно запускает хост omo дольше ${START_LOCK_WAIT_MS / 1_000} с`, this.env.secrets));
      }
      await sleep(START_LOCK_POLL_MS);
    }
  }

  /**
   * The host's command: bare omo, or — while protection is on (the profile exists) — omo under `sandbox-exec` with its
   * own LSP daemon dir, so it never talks to an unsandboxed daemon (F5.3).
   */
  private hostCommand(location: HostLocation): { file: string; args: string[]; env: Record<string, string> } {
    const hostArgs = ["--mode", "rpc", "--listen", `unix://${location.socket}`];
    if (!location.protected) return { file: this.env.omoPath, args: hostArgs, env: this.env.env };
    return {
      file: SANDBOX_EXEC,
      args: ["-f", profilePath(this.env.agentDir), this.env.omoPath, ...hostArgs],
      env: { ...this.env.env, OMO_LSP_DAEMON_DIR: lspDaemonDir(this.env.agentDir) },
    };
  }

  /**
   * Spawns the bare host (no stdin: omo prepends inherited stdin to prompts) and connects once it answers. Only ever
   * called with the start lock held and with nothing answering on the socket, so the host it starts is the only one.
   */
  private async startHost(location: HostLocation): Promise<RpcClient> {
    const fail = (message: string): Error => new Error(redact(message, this.env.secrets));
    try {
      this.beforeLaunch();
    } catch (error) {
      this.emit("warning", redact(`Профиль песочницы не обновлён: ${errorText(error)}`, this.env.secrets));
    }
    // Whatever sits at the socket goes — a leftover file, a dangling link, a sandboxed process that bound the path
    // (N6: unbound from the path, never killed) — UNLESS a host of ours is serving it. Unlinking a live host of ours
    // is how a second host used to take the path away from the first, leaving the first unreachable with its
    // sessions' files still held (measured live: host-race case r6).
    if (location.protected && pathExists(location.socket) && (await this.ownHostOn(location)) === undefined) {
      await rm(location.socket, { force: true });
    }
    const command = this.hostCommand(location);
    let child: HostProcess;
    try {
      child = this.spawnFn(command.file, command.args, {
        env: command.env,
        cwd: homedir(),
        stdio: "ignore",
        detached: true,
      });
    } catch (error) {
      throw fail(`omo could not start: ${errorText(error)}`);
    }
    let ended: string | undefined;
    child.once("error", (error) => {
      ended ??= `could not start: ${error.message}`;
    });
    child.once("exit", (code, signal) => {
      ended ??= `exited (code ${String(code)}, signal ${String(signal)}) before it was ready`;
    });
    child.unref();
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastError = "no answer";
    for (;;) {
      if (ended !== undefined) {
        // Our host is gone (a live socket refuses the bind with EADDRINUSE). Whatever answers the path now was there
        // before us, so it is joined — never fought for the path, and never recorded as our child's pid.
        const already = await this.connectExisting(location);
        if (already !== undefined) return already;
        throw fail(`omo host ${ended}`);
      }
      try {
        const client = await RpcClient.connect(location.socket, this.env.agentDir);
        if (location.protected && (child.pid === undefined || !(await this.processes.listensOn(child.pid, location.socket)))) {
          // someone else bound the path before our host did: drop them from it and wait for ours
          client.close();
          await rm(location.socket, { force: true });
          throw new Error("на сокете хоста чужой процесс");
        }
        if (child.pid !== undefined) {
          await this.writePid(location.pid, child.pid);
        }
        return client;
      } catch (error) {
        lastError = errorText(error);
      }
      if (Date.now() >= deadline) {
        if (child.pid !== undefined) {
          try {
            this.processes.kill(child.pid, "SIGTERM"); // ours and useless: never leave it behind
          } catch {
            // already gone
          }
        }
        throw fail(`omo host did not become ready in ${this.readyTimeoutMs} ms: ${lastError}`);
      }
      await sleep(READY_POLL_MS);
    }
  }

  /** A fresh file (`wx` after unlinking): whatever sits at the path, a link included, is never written through. */
  private async writePid(file: string, pid: number): Promise<void> {
    try {
      await rm(file, { force: true });
      await writeFile(file, String(pid), { mode: 0o600, flag: "wx" });
    } catch {
      // only «Перезапустить OmO» reads it, and it falls back to a plain reconnect without it
    }
  }

  /**
   * The host recorded at `location`, if it is still ours: a live pid whose command line is our host on that socket.
   * Protected (N6): exactly `… --mode rpc --listen unix://<socket>` and the process holds the socket — the pid file is
   * the extension's (the sandbox cannot write it), the socket path is not.
   */
  private async recordedHostPid(location: HostLocation): Promise<number | undefined> {
    let text: string;
    try {
      text = await readFile(location.pid, "utf8");
    } catch {
      return undefined;
    }
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const command = await this.processes.commandLine(pid);
    if (!location.protected) return command?.includes(`unix://${location.socket}`) === true ? pid : undefined;
    const ours = command?.endsWith(` --mode rpc --listen unix://${location.socket}`) === true && (await this.processes.listensOn(pid, location.socket));
    return ours ? pid : undefined;
  }

  private async exited(pid: number): Promise<boolean> {
    const deadline = Date.now() + HOST_STOP_TIMEOUT_MS;
    for (;;) {
      try {
        this.processes.kill(pid, 0);
      } catch {
        return true;
      }
      if (Date.now() >= deadline) return false;
      await sleep(100);
    }
  }

  private onClose(client: RpcClient): void {
    if (this.current !== client) return;
    this.current = undefined;
    this.instance = undefined;
    if (this.disposed) return;
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.emit("disconnected");
    this.scheduleNext("reconnect budget exhausted");
  }

  private scheduleNext(reason: string): void {
    this.clearTimer(); // a reconnectNow joining an attempt in flight must not leave two timers
    const delay = RECONNECT_DELAYS_MS[this.attempts];
    if (delay === undefined) {
      this.emit("gave_up", redact(reason, this.env.secrets));
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.attempt();
    }, delay);
  }

  private async attempt(): Promise<void> {
    this.attempts += 1;
    try {
      await this.client();
    } catch (error) {
      if (this.disposed) return;
      this.scheduleNext(errorText(error));
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
