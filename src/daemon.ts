import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const defaultProcesses: ProcessOps = {
  kill: (pid, signal) => process.kill(pid, signal),
  commandLine: async (pid) => {
    try {
      const { stdout } = await promisify(execFile)("ps", ["-o", "command=", "-p", String(pid)]);
      return stdout.trim() || undefined;
    } catch {
      return undefined; // ps exits 1 when there is no such process
    }
  },
  listensOn: (pid, socket) => listensOn(pid, socket),
};

/** True when `pid` holds a unix socket bound at `socket` (lsof names it by the path it was bound with, or the real one). */
export async function listensOn(pid: number, socket: string): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-U", "-F", "n"]));
  } catch {
    return false; // no such process, or nothing open
  }
  const names = new Set([socket, realOf(socket)].map((file) => `n${file}`));
  return stdout.split("\n").some((line) => names.has(line));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the connection to this environment's omo host: a bare `omo --mode rpc --listen` the extension spawns detached
 * with exactly the built environment (so CLAUDE_CONFIG_DIR and the rest reach it), outliving VS Code.
 * Events: "connected"(client), "disconnected", "gave_up"(reason), "warning"(text).
 * A new "connected" client has a new instanceId, so session handles from the previous one are invalid.
 */
export class DaemonManager extends EventEmitter {
  private current: RpcClient | undefined;
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
    this.processes = deps.processes ?? defaultProcesses;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? HOST_READY_TIMEOUT_MS;
    this.beforeLaunch = deps.beforeLaunch ?? (() => undefined);
  }

  /** Secret values to redact from anything shown to the person. */
  get secrets(): readonly string[] {
    return this.env.secrets;
  }

  /** True while there is a live client. */
  get connected(): boolean {
    return this.current !== undefined;
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
    let client: RpcClient;
    if (location.protected && (await this.recordedHostPid(location)) === undefined) {
      // N6: any sandboxed process may bind the protected socket; only our recorded host is ever talked to
      client = await this.startHost();
    } else {
      try {
        client = await RpcClient.connect(location.socket, this.env.agentDir);
      } catch {
        client = await this.startHost();
      }
    }
    if (this.disposed) {
      client.close();
      throw new Error("daemon manager is disposed");
    }
    this.current = client;
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

  /** Spawns the bare host (no stdin: omo prepends inherited stdin to prompts) and connects once it answers. */
  private async startHost(): Promise<RpcClient> {
    const fail = (message: string): Error => new Error(redact(message, this.env.secrets));
    try {
      this.beforeLaunch();
    } catch (error) {
      this.emit("warning", redact(`Профиль песочницы не обновлён: ${errorText(error)}`, this.env.secrets));
    }
    const location = activeLocation(this.env.agentDir);
    if (location.protected) {
      // The host binds in a dir a sandboxed host cannot create in or unlink from: make it, and clear whatever is at
      // the socket unless it is our recorded host (a foreign listener is not killed, only unbound from the path).
      // rpc/ (its key files) cannot be created under the profile either: the unprotected host's place is closed.
      await mkdir(dirname(hostSocketPath(this.env.agentDir)), { recursive: true });
      await mkdir(dirname(location.socket), { recursive: true, mode: 0o700 });
      if ((await this.recordedHostPid(location)) === undefined) await rm(location.socket, { force: true });
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
      if (ended !== undefined) throw fail(`omo host ${ended}`);
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
