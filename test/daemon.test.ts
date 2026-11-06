import { EventEmitter } from "node:events";
import { existsSync, lstatSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeHostSocketPath,
  DaemonManager,
  listensOn,
  hostPidPath,
  hostSocketPath,
  protectedHostPidPath,
  protectedHostSocketPath,
  type HostProcess,
  type ProcessOps,
  type SpawnFn,
} from "../src/daemon";
import type { OmoEnv } from "../src/env";
import { buildProfile, lspDaemonDir, profilePath } from "../kit/sandbox/profile.mjs";
import { FakeDaemon } from "./helpers/fakeDaemon";
import type { RpcClient } from "../src/rpc/client";

let daemon: FakeDaemon;
let manager: DaemonManager | undefined;

const FAKE_PID = 4242;
/** `ps -o lstart=` for the fake host: the other half of a holder's identity. */
const FAKE_STARTED = "Thu Nov  5 14:48:53 2026";

const lstatOrUndefined = (file: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(file);
  } catch {
    return undefined;
  }
};

function envFor(agentDir: string): OmoEnv {
  return {
    env: { OMO_CODING_AGENT_DIR: agentDir, GW_API_KEY: "sekret-key-123", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/tmp/claude-second" },
    agentDir,
    omoPath: "/fake/omo",
    secrets: ["sekret-key-123"],
  };
}

/** Publishes the fake daemon where the host is expected now (rpc/ off, guard/host/ while protected). */
async function linkSocket(): Promise<void> {
  const sock = activeHostSocketPath(daemon.agentDir);
  await mkdir(join(sock, ".."), { recursive: true });
  await symlink(daemon.socketPath, sock);
}

/** Polls with real time (the host start waits 200 ms between connection attempts). */
async function eventually(done: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done()).toBe(true);
}

const protect = async (agentDir: string): Promise<void> => {
  await mkdir(join(agentDir, "guard"), { recursive: true });
  await writeFile(profilePath(agentDir), "(version 1)\n(allow default)\n");
};

/** Polls with real I/O ticks (vi.waitFor would advance the fake timers). */
async function settle(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200 && !done(); tick++) await new Promise((resolve) => setImmediate(resolve));
  expect(done()).toBe(true);
}

/**
 * Real I/O ticks with nothing to wait for: a failed start arms its next retry only once its own file work has settled
 * (the start lock closed and removed), and the fake clock must not be moved before that.
 */
async function drain(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) await new Promise((resolve) => setImmediate(resolve));
}

function noSpawn(): SpawnFn {
  return vi.fn(() => {
    throw new Error("spawn failed with sekret-key-123");
  });
}

type FakeChild = HostProcess & EventEmitter & { unref: ReturnType<typeof vi.fn> };

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { pid: FAKE_PID, unref: vi.fn() }) as FakeChild;
}

/** A spawn that runs `onSpawn` (e.g. publish the socket) and hands back a child that never exits. */
function fakeSpawn(onSpawn: (child: FakeChild) => void | Promise<void> = () => linkSocket()): SpawnFn & ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    const child = fakeChild();
    void onSpawn(child);
    return child;
  }) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
}

/** Process table with one process: our fake host, whose command line names `socket`. */
function fakeProcesses(
  socket: string,
  onTerm: () => void | Promise<void> = () => undefined,
): ProcessOps & { kill: ReturnType<typeof vi.fn>; die(): void; revive(): void } {
  let alive = true;
  return {
    die: () => {
      alive = false;
    },
    revive: () => {
      alive = true;
    },
    // our host holds the socket while it is alive and the path still leads to the fake daemon (not someone else)
    listensOn: async (pid: number, file: string) => pid === FAKE_PID && alive && file === socket && ownsPath(file),
    kill: vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid !== FAKE_PID || !alive) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        alive = false;
        void onTerm();
      }
    }),
    commandLine: async (pid: number) => (pid === FAKE_PID && alive ? `/x/omo --mode rpc --listen unix://${socket}` : undefined),
    hostPids: async (file: string) => (alive && file === socket ? [FAKE_PID] : []),
    startedAt: async (pid: number) => (pid === FAKE_PID && alive ? FAKE_STARTED : undefined),
    socketFds: async (pid: number, file: string) => (pid === FAKE_PID && alive && file === socket && ownsPath(file) ? 1 : 0),
    cpuSeconds: async (pid: number) => (pid === FAKE_PID && alive ? 0 : undefined),
  };
}

/** The path leads to this test's fake daemon (our host), not to a foreign listener. */
function ownsPath(file: string): boolean {
  try {
    return readlinkSync(file) === daemon.socketPath;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  daemon = await FakeDaemon.start();
});

afterEach(async () => {
  vi.useRealTimers();
  manager?.dispose();
  manager = undefined;
  await daemon.stop();
});

describe("DaemonManager", () => {
  it("an_oversize_record_is_skipped_with_a_warning_and_the_connection_lives_on", async () => {
    await linkSocket();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: noSpawn() });
    const warnings: string[] = [];
    manager.on("warning", (text: string) => warnings.push(text));
    const client = await manager.client();
    const frames: unknown[] = [];
    client.on("frame", (frame: unknown) => frames.push(frame));
    daemon.push({ type: "huge", data: "x".repeat(16_777_216) });
    daemon.push({ type: "small" });
    await vi.waitFor(() => expect(frames).toEqual([{ type: "small" }]));
    expect(warnings).toEqual(["Пропущена запись omo длиной 16777241 символов (предел 16777216)"]);
    expect(manager.connected).toBe(true);
  });

  it("connects_to_running_host_without_spawning", async () => {
    await linkSocket();
    const spawnFn = noSpawn();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn });
    const client = await manager.client();
    expect(await manager.client()).toBe(client);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("spawns_a_detached_bare_host_with_exactly_the_built_env", async () => {
    const env = envFor(daemon.agentDir);
    let child: FakeChild | undefined;
    const spawnFn = fakeSpawn((spawned) => {
      child = spawned;
      return linkSocket();
    });
    manager = new DaemonManager(env, { spawn: spawnFn });
    await manager.client();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawnFn.mock.calls[0] as Parameters<SpawnFn>;
    expect(file).toBe("/fake/omo");
    expect(args).toEqual(["--mode", "rpc", "--listen", `unix://${join(daemon.agentDir, "rpc", "agent-tabs.sock")}`]);
    expect(options).toEqual({ env: { ...env.env, SENPI_BIN: "/fake/omo" }, cwd: homedir(), stdio: "ignore", detached: true });
    expect(options.env["CLAUDE_CONFIG_DIR"]).toBe("/tmp/claude-second");
    expect(options.env["SENPI_BIN"]).toBe("/fake/omo");
    expect(options.env["SENPI_MEMORY_REFLECTION"]).toBeUndefined(); // reflection stays on while protection is off
    expect(child?.unref).toHaveBeenCalled();
    expect(await readFile(hostPidPath(daemon.agentDir), "utf8")).toBe(String(FAKE_PID));
  });

  it("waits_for_the_host_to_publish_its_socket", async () => {
    const spawnFn = fakeSpawn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await linkSocket();
    });
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn });
    await expect(manager.client()).resolves.toBeDefined();
  });

  it("spawn_failure_is_redacted", async () => {
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: noSpawn() });
    const error = await manager.client().catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("sekret-key-123");
    expect((error as Error).message).toContain("‹redacted›");
  });

  it("host_exit_before_ready_fails_fast", async () => {
    const spawnFn = fakeSpawn((child) => {
      setTimeout(() => child.emit("exit", 1, null), 50);
    });
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, readyTimeoutMs: 10_000 });
    const started = Date.now();
    await expect(manager.client()).rejects.toThrow("exited");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("host_not_ready_in_time_fails_and_is_stopped", async () => {
    const processes = fakeProcesses(hostSocketPath(daemon.agentDir));
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: fakeSpawn(() => undefined), processes, readyTimeoutMs: 300 });
    await expect(manager.client()).rejects.toThrow("did not become ready");
    expect(processes.kill).toHaveBeenCalledWith(FAKE_PID, "SIGTERM");
  });

  it("reconnects_after_close_and_emits_connected", async () => {
    await linkSocket();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: noSpawn() });
    const first = await manager.client();
    const events: string[] = [];
    const next = new Promise<RpcClient>((resolve) => {
      manager?.on("connected", (client: RpcClient) => resolve(client));
    });
    manager.on("disconnected", () => events.push("disconnected"));
    daemon.dropConnections();
    const second = await next;
    expect(second).not.toBe(first);
    expect(events).toEqual(["disconnected"]);
    expect(await manager.client()).toBe(second);
  });

  it("gives_up_after_5_attempts", async () => {
    await linkSocket();
    const spawnFn = noSpawn();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn });
    await manager.client();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reasons: string[] = [];
    manager.on("gave_up", (reason: string) => reasons.push(reason));
    await daemon.stop();
    // Server is gone: socket file removed, so every attempt fails.
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(spawnFn).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      await settle(() => vi.mocked(spawnFn).mock.calls.length === index + 1);
      await drain(); // the attempt must finish failing before the clock moves on to its retry
    }
    await settle(() => reasons.length === 1);
    expect(reasons[0]).not.toContain("sekret-key-123");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawnFn).toHaveBeenCalledTimes(5);
    daemon = await FakeDaemon.start();
  });

  it("reconnect_now_during_an_attempt_keeps_one_retry_timer", async () => {
    const spawnFn = noSpawn();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reasons: string[] = [];
    manager.on("gave_up", (reason: string) => reasons.push(reason));
    manager.reconnectNow();
    manager.reconnectNow(); // joins the attempt in flight; both failures schedule a retry
    await settle(() => vi.mocked(spawnFn).mock.calls.length === 1);
    for (let step = 0; step < 40; step++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await drain(); // each attempt must finish failing before the clock reaches its retry
    }
    await settle(() => reasons.length >= 1);
    expect(reasons).toHaveLength(1);
    expect(spawnFn).toHaveBeenCalledTimes(5);
  });

  it("accept_then_drop_reaches_gave_up", async () => {
    await linkSocket();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: noSpawn() });
    let connects = 0;
    let disconnects = 0;
    manager.on("connected", () => (connects += 1));
    manager.on("disconnected", () => (disconnects += 1));
    const reasons: string[] = [];
    manager.on("gave_up", (reason: string) => reasons.push(reason));
    await manager.client();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      const before = connects;
      daemon.dropConnections();
      await settle(() => disconnects === before);
      await vi.advanceTimersByTimeAsync(delay);
      await settle(() => connects === before + 1);
    }
    daemon.dropConnections();
    await settle(() => reasons.length === 1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connects).toBe(6);
    expect(reasons).toHaveLength(1);
  });

  it("reconnect_now_connects_immediately", async () => {
    await linkSocket();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: noSpawn() });
    const connected = vi.fn();
    manager.on("connected", connected);
    expect(manager.connected).toBe(false);
    manager.reconnectNow();
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
    expect(manager.connected).toBe(true);
  });

  it("dispose_does_not_stop_the_host", async () => {
    await linkSocket();
    const processes = fakeProcesses(hostSocketPath(daemon.agentDir));
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: noSpawn(), processes });
    await manager.client();
    const disconnected = vi.fn();
    manager.on("disconnected", disconnected);
    manager.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(daemon.requests.every((request) => request["type"] === "set_client_info")).toBe(true);
    expect(processes.kill).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    await expect(manager.client()).rejects.toThrow("disposed");
  });

  it("restart_host_stops_our_host_and_reconnects_to_a_fresh_one", async () => {
    const socket = hostSocketPath(daemon.agentDir);
    const spawnFn = fakeSpawn();
    const processes = fakeProcesses(socket, async () => {
      await rm(socket, { force: true }); // the host removes its socket and drops every client on SIGTERM
      daemon.dropConnections();
    });
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, processes });
    const first = await manager.client();
    const next = new Promise<RpcClient>((resolve) => manager?.on("connected", resolve));
    expect(await manager.restartHost()).toBe(true);
    const second = await next;
    expect(second).not.toBe(first);
    expect(processes.kill).toHaveBeenCalledWith(FAKE_PID, "SIGTERM");
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[1]?.[2]).toMatchObject({ env: envFor(daemon.agentDir).env, stdio: "ignore", detached: true });
  });

  it("restart_host_never_signals_a_pid_that_is_not_our_host", async () => {
    await linkSocket();
    await writeFile(hostPidPath(daemon.agentDir), "999");
    const processes = fakeProcesses(hostSocketPath(daemon.agentDir));
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: noSpawn(), processes });
    await manager.client();
    expect(await manager.restartHost()).toBe(false);
    expect(processes.kill).not.toHaveBeenCalled();
  });

  /**
   * Two windows cold-starting together used to be able to make two hosts on one socket path, one of which no client
   * could reach while it kept its sessions' files (measured live: host-race case r6). The start lock decides one
   * winner before anything is spawned; the loser finds the host the winner started.
   */
  it("two_windows_starting_together_make_one_host", async () => {
    const spawnFn = fakeSpawn();
    const second = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, processes: fakeProcesses(hostSocketPath(daemon.agentDir)) });
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, processes: fakeProcesses(hostSocketPath(daemon.agentDir)) });
    try {
      const [first, other] = await Promise.all([manager.client(), second.client()]);
      expect(spawnFn).toHaveBeenCalledTimes(1); // one winner: the other window connected to its host
      expect(first.instanceId).toBe(daemon.instanceId);
      expect(other.instanceId).toBe(daemon.instanceId);
      expect(await readFile(hostPidPath(daemon.agentDir), "utf8")).toBe(String(FAKE_PID));
    } finally {
      second.dispose();
    }
  });

  /**
   * The person's own machine: the pid file was lost while a host kept running. The window must join that host, not
   * unlink it from its path and start another — the unlink is what left a working host unreachable.
   */
  it("a_live_host_of_ours_is_joined_not_unbound_when_the_pid_file_is_gone", async () => {
    await protect(daemon.agentDir);
    const sock = protectedHostSocketPath(daemon.agentDir);
    await mkdir(join(sock, ".."), { recursive: true });
    await symlink(daemon.socketPath, sock); // our host, serving the path, with nothing recording it
    const spawnFn = fakeSpawn();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, processes: fakeProcesses(sock) });
    const client = await manager.client();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(client.instanceId).toBe(daemon.instanceId);
    expect(ownsPath(sock)).toBe(true); // never unbound from under it
    expect(await readFile(protectedHostPidPath(daemon.agentDir), "utf8")).toBe(String(FAKE_PID)); // and recorded again
  });

  /** A host that died before it answered must not be what the pid file names, or a restart signals the wrong process. */
  it("the_pid_file_never_names_a_host_that_died_before_it_answered", async () => {
    const spawnFn = fakeSpawn((child) => {
      void linkSocket(); // another window's host is already there, as it is when our omo loses the bind
      setTimeout(() => child.emit("exit", 1, null), 30);
    });
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, readyTimeoutMs: 2_000 });
    const client = await manager.client();
    expect(client.instanceId).toBe(daemon.instanceId); // joined the host that was there
    await settle(() => true);
    expect(existsSync(hostPidPath(daemon.agentDir))).toBe(false);
  });

  it("a_protected_env_spawns_the_host_under_sandbox_exec", async () => {
    const agentDir = daemon.agentDir;
    await protect(agentDir);
    const spawnFn = fakeSpawn();
    const refreshed: string[] = [];
    manager = new DaemonManager(envFor(agentDir), {
      spawn: spawnFn,
      processes: fakeProcesses(protectedHostSocketPath(agentDir)),
      beforeLaunch: () => void refreshed.push("profile"),
    });
    await manager.client();
    const [file, args, options] = spawnFn.mock.calls[0] as Parameters<SpawnFn>;
    expect(refreshed).toEqual(["profile"]);
    expect(existsSync(join(agentDir, "rpc"))).toBe(true); // the profile closes rpc/ itself; the host keeps keys there
    expect(file).toBe("/usr/bin/sandbox-exec");
    expect(args.slice(0, 2)).toEqual(["-f", profilePath(agentDir)]);
    expect(args.slice(2)).toEqual([
      "/fake/omo",
      "--mode",
      "rpc",
      "--listen",
      `unix://${protectedHostSocketPath(agentDir)}`,
    ]);
    expect(options.env).toEqual({ ...envFor(agentDir).env, SENPI_BIN: "/fake/omo", OMO_LSP_DAEMON_DIR: lspDaemonDir(agentDir), SENPI_MEMORY_REFLECTION: "1" });
    expect(options.env["SENPI_BIN"]).toBe("/fake/omo");
    expect(options.env["SENPI_MEMORY_REFLECTION"]).toBe("1"); // reflection disabled under protection (it cannot complete)
  });

  it("a_dead_protected_socket_is_cleared_before_the_host_starts", async () => {
    await protect(daemon.agentDir);
    const sock = protectedHostSocketPath(daemon.agentDir);
    await mkdir(join(sock, ".."), { recursive: true });
    await symlink(join(daemon.agentDir, "nowhere.sock"), sock); // dead, and a dangling link at that
    let sawStale = true;
    manager = new DaemonManager(envFor(daemon.agentDir), {
      processes: fakeProcesses(sock),
      spawn: fakeSpawn(() => {
        sawStale = lstatOrUndefined(sock) !== undefined;
        return linkSocket();
      }),
    });
    await manager.client();
    expect(sawStale).toBe(false);
  });

  it.each([
    ["off", hostPidPath],
    ["on", protectedHostPidPath],
  ] as const)("a_link_planted_at_the_pid_path_is_replaced_not_written_through_protection_%s", async (mode, pidPath) => {
    if (mode === "on") await protect(daemon.agentDir);
    const target = join(daemon.agentDir, "victim.txt");
    const pidFile = pidPath(daemon.agentDir);
    await mkdir(join(pidFile, ".."), { recursive: true });
    await writeFile(target, "keep");
    await symlink(target, pidFile);
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: fakeSpawn(), processes: fakeProcesses(activeHostSocketPath(daemon.agentDir)) });
    await manager.client();
    expect(await readFile(target, "utf8")).toBe("keep");
    expect(lstatSync(pidFile).isSymbolicLink()).toBe(false);
    expect(await readFile(pidFile, "utf8")).toBe(String(FAKE_PID));
  });

  it("turning_protection_on_and_off_moves_the_host_and_stops_the_old_one", async () => {
    const agentDir = daemon.agentDir;
    // a process table: each spawned host listens (a link to the fake daemon) until it is killed
    const table = new Map<number, { command: string; socket: string }>();
    const killed: number[] = [];
    let nextPid = 7000;
    const processes: ProcessOps = {
      kill: (pid, signal) => {
        const entry = table.get(pid);
        if (entry === undefined) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        if (signal === 0) return;
        table.delete(pid);
        killed.push(pid);
        rmSync(entry.socket, { force: true });
      },
      commandLine: async (pid) => table.get(pid)?.command,
      listensOn: async (pid, file) => table.get(pid)?.socket === file,
      hostPids: async (file) => [...table].filter(([, entry]) => entry.socket === file).map(([pid]) => pid),
      startedAt: async (pid) => (table.has(pid) ? FAKE_STARTED : undefined),
      socketFds: async (pid, file) => (table.get(pid)?.socket === file ? 1 : 0),
      cpuSeconds: async (pid) => (table.has(pid) ? 0 : undefined),
    };
    const spawnFn = vi.fn((file: string, args: string[]) => {
      const pid = nextPid++;
      const socket = (args.at(-1) as string).slice("unix://".length);
      table.set(pid, { command: [file, ...args].join(" "), socket });
      void mkdir(join(socket, ".."), { recursive: true }).then(() => symlink(daemon.socketPath, socket));
      return Object.assign(new EventEmitter(), { pid, unref: vi.fn() }) as unknown as HostProcess;
    });
    manager = new DaemonManager(envFor(agentDir), { spawn: spawnFn, processes });
    const listenOf = (call: number): string => (spawnFn.mock.calls[call]?.[1] as string[]).at(-1) as string;

    await manager.client(); // off: the place a running host already uses
    expect(spawnFn.mock.calls[0]?.[0]).toBe("/fake/omo");
    expect(listenOf(0)).toBe(`unix://${hostSocketPath(agentDir)}`);

    await protect(agentDir); // enableProtection writes the profile, then restarts the host
    expect(await manager.restartHost()).toBe(true);
    await eventually(() => spawnFn.mock.calls.length === 2 && manager!.connected);
    expect(killed).toEqual([7000]);
    expect(spawnFn.mock.calls[1]?.[0]).toBe("/usr/bin/sandbox-exec");
    expect(listenOf(1)).toBe(`unix://${protectedHostSocketPath(agentDir)}`);
    expect(existsSync(hostPidPath(agentDir))).toBe(false);
    expect(await readFile(protectedHostPidPath(agentDir), "utf8")).toBe("7001");

    await rm(profilePath(agentDir)); // disableProtection removes the profile, then restarts the host
    expect(await manager.restartHost()).toBe(true);
    await eventually(() => spawnFn.mock.calls.length === 3 && manager!.connected);
    expect(killed).toEqual([7000, 7001]);
    expect(spawnFn.mock.calls[2]?.[0]).toBe("/fake/omo");
    expect(listenOf(2)).toBe(`unix://${hostSocketPath(agentDir)}`);
    expect(existsSync(protectedHostPidPath(agentDir))).toBe(false);
    expect(await readFile(hostPidPath(agentDir), "utf8")).toBe("7002");
  });

  it("a_foreign_listener_on_the_protected_socket_is_never_talked_to", async () => {
    await protect(daemon.agentDir);
    const sock = protectedHostSocketPath(daemon.agentDir);
    const foreign = await FakeDaemon.start();
    try {
      await mkdir(join(sock, ".."), { recursive: true });
      await symlink(foreign.socketPath, sock); // bound by a sandboxed process: no pid file of ours names it
      const processes = fakeProcesses(sock);
      manager = new DaemonManager(envFor(daemon.agentDir), { spawn: fakeSpawn(), processes });
      await manager.client();
      expect(foreign.authFrames).toHaveLength(0);
      expect(daemon.authFrames.length).toBeGreaterThan(0);
      expect(processes.kill).not.toHaveBeenCalled(); // nothing foreign is killed, only unbound from the path
      expect(ownsPath(sock)).toBe(true);
    } finally {
      await foreign.stop();
    }
  });

  it("a_recorded_live_host_that_does_not_hold_the_socket_is_not_trusted_with_it", async () => {
    await protect(daemon.agentDir);
    const sock = protectedHostSocketPath(daemon.agentDir);
    const foreign = await FakeDaemon.start();
    try {
      await mkdir(join(sock, ".."), { recursive: true });
      await writeFile(protectedHostPidPath(daemon.agentDir), String(FAKE_PID)); // ours, alive, right command line
      await symlink(foreign.socketPath, sock); // …but the path leads elsewhere
      manager = new DaemonManager(envFor(daemon.agentDir), { spawn: fakeSpawn(), processes: fakeProcesses(sock) });
      await manager.client();
      expect(foreign.authFrames).toHaveLength(0);
      expect(ownsPath(sock)).toBe(true);
    } finally {
      await foreign.stop();
    }
  });

  it("restart_with_a_dead_recorded_host_still_replaces_a_foreign_socket", async () => {
    await protect(daemon.agentDir);
    const sock = protectedHostSocketPath(daemon.agentDir);
    const processes = fakeProcesses(sock);
    const spawnFn = fakeSpawn(() => {
      processes.revive(); // the freshly spawned host
      return linkSocket();
    });
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, processes });
    await manager.client();
    const foreign = await FakeDaemon.start();
    try {
      processes.die(); // our host is gone; a sandboxed process takes the path
      await rm(sock, { force: true });
      await symlink(foreign.socketPath, sock);
      expect(await manager.restartHost()).toBe(false);
      await eventually(() => spawnFn.mock.calls.length === 2 && manager!.connected);
      expect(foreign.authFrames).toHaveLength(0);
      expect(ownsPath(sock)).toBe(true);
    } finally {
      await foreign.stop();
    }
  });

  it("a_process_that_binds_the_path_before_our_host_is_dropped", async () => {
    await protect(daemon.agentDir);
    const sock = protectedHostSocketPath(daemon.agentDir);
    const foreign = await FakeDaemon.start();
    try {
      // the foreign host even publishes its key where ours would (rpc/keys is writable under the profile)
      await mkdir(join(daemon.agentDir, "rpc", "keys"), { recursive: true });
      await symlink(join(foreign.agentDir, "rpc", "keys", foreign.launchId), join(daemon.agentDir, "rpc", "keys", foreign.launchId));
      const spawnFn = fakeSpawn(async () => {
        await symlink(foreign.socketPath, sock); // wins the race to the path
        await new Promise((resolve) => setTimeout(resolve, 300));
        await rm(sock, { force: true });
        await symlink(daemon.socketPath, sock); // our host binds after all
      });
      manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, processes: fakeProcesses(sock) });
      await manager.client();
      expect(foreign.authFrames.length).toBeGreaterThan(0); // reached once, then dropped
      expect(ownsPath(sock)).toBe(true);
      expect(daemon.authFrames.length).toBeGreaterThan(0);
    } finally {
      await foreign.stop();
    }
  });

  it.runIf(process.platform === "darwin")("listens_on_reads_the_bound_path_of_a_live_process", async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "lsn-")));
    const sock = join(dir, "a b.sock");
    const server = createServer().listen(sock);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      expect(await listensOn(process.pid, sock)).toBe(true);
      expect(await listensOn(process.pid, join(dir, "other.sock"))).toBe(false);
      expect(await listensOn(999_999, sock)).toBe(false);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an_unprotected_env_never_gets_the_lsp_override", async () => {
    const spawnFn = fakeSpawn();
    manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnFn, beforeLaunch: () => undefined });
    await manager.client();
    const [file, , options] = spawnFn.mock.calls[0] as Parameters<SpawnFn>;
    expect(file).toBe("/fake/omo");
    expect(options.env["OMO_LSP_DAEMON_DIR"]).toBeUndefined();
  });

  it("a_failing_profile_refresh_is_a_warning_and_the_host_still_starts", async () => {
    const spawnFn = fakeSpawn();
    const warnings: string[] = [];
    manager = new DaemonManager(envFor(daemon.agentDir), {
      spawn: spawnFn,
      beforeLaunch: () => {
        throw new Error("EACCES sekret-key-123");
      },
    });
    manager.on("warning", (text: string) => warnings.push(text));
    await manager.client();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("sekret-key-123");
  });

  it.runIf(process.platform === "darwin")("the_sandboxed_host_cannot_write_protected_files", async () => {
    const agentDir = daemon.agentDir;
    const real = realpathSync(agentDir);
    await mkdir(join(agentDir, "guard"), { recursive: true });
    await writeFile(profilePath(agentDir), buildProfile({ home: join(real, "home"), agentDir: real }));
    const script = join(agentDir, "fake-omo.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        'echo x > "$OMO_CODING_AGENT_DIR/models.json" 2>/dev/null',
        'echo "$OMO_LSP_DAEMON_DIR" > "$OMO_CODING_AGENT_DIR/lsp.txt"',
        // the closed dir: only the socket itself may be created there (here: a link to the fake daemon's)
        'ln -s "$FAKE_SOCKET" "$OMO_CODING_AGENT_DIR/guard/host/agent-tabs.sock"',
        'echo x > "$OMO_CODING_AGENT_DIR/guard/host/other" 2>/dev/null',
        'mkdir -p "$OMO_CODING_AGENT_DIR/rpc/keys" && echo k > "$OMO_CODING_AGENT_DIR/rpc/keys/launch"',
        "exec sleep 30",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = envFor(agentDir);
    const childEnv = { ...env.env, PATH: "/usr/bin:/bin", FAKE_SOCKET: daemon.socketPath };
    // a shell stands in for omo, so "holds the socket" is answered for it (the link leads to the fake daemon)
    const processes: ProcessOps = {
      kill: (pid, signal) => process.kill(pid, signal),
      commandLine: async () => undefined,
      listensOn: async (_pid, file) => ownsPath(file),
      hostPids: async () => [],
      startedAt: async () => FAKE_STARTED,
      socketFds: async (_pid, file) => (ownsPath(file) ? 1 : 0),
      cpuSeconds: async () => 0,
    };
    manager = new DaemonManager({ ...env, omoPath: script, env: childEnv }, { readyTimeoutMs: 3_000, processes });
    try {
      await expect(manager.client()).resolves.toBeDefined();
      expect(existsSync(join(agentDir, "models.json"))).toBe(false);
      expect(existsSync(join(agentDir, "guard/host/other"))).toBe(false);
      expect(existsSync(join(agentDir, "rpc/keys/launch"))).toBe(true);
      expect((await readFile(join(agentDir, "lsp.txt"), "utf8")).trim()).toBe(lspDaemonDir(agentDir));
    } finally {
      const pid = Number(await readFile(hostPidPath(agentDir), "utf8").catch(() => "0"));
      if (pid > 0) process.kill(pid, "SIGTERM");
    }
  }, 5_000);

  it("host_gets_no_stdin_and_outlives_the_spawn_call", async () => {
    // A stand-in omo that reads stdin to EOF first (as omo does) — an open stdin would hang it until the ready timeout.
    const script = join(daemon.agentDir, "fake-omo.sh");
    await mkdir(daemon.agentDir, { recursive: true });
    await writeFile(
      script,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        'mkdir -p "$OMO_CODING_AGENT_DIR/rpc"',
        'ln -s "$FAKE_SOCKET" "$OMO_CODING_AGENT_DIR/rpc/agent-tabs.sock"',
        "exec sleep 30",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = envFor(daemon.agentDir);
    const childEnv = { ...env.env, PATH: "/usr/bin:/bin", FAKE_SOCKET: daemon.socketPath };
    manager = new DaemonManager({ ...env, omoPath: script, env: childEnv }, { readyTimeoutMs: 3_000 });
    try {
      await expect(manager.client()).resolves.toBeDefined();
    } finally {
      const pid = Number(await readFile(hostPidPath(daemon.agentDir), "utf8").catch(() => "0"));
      if (pid > 0) process.kill(pid, "SIGTERM");
    }
  }, 5_000);
});
