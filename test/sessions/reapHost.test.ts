import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessOps } from "../../src/daemon";
import { CPU_IDLE_SHARE, HostReaper, LOG_QUIET_MS, recordEndsTask, type ReapTarget } from "../../src/sessions/reapHost";

/** The person's own case, with the pids they measured. */
const HOLDER = 46960;
const SERVING = 47080;
const STARTED = "Thu Nov  5 14:48:42 2026";

const SUSPENDED = { type: "suspended", payload: { reason: "idle" } };
const WORKING = { type: "tool_execution", payload: { tool: "ls", is_error: false } };

let root: string;
let agentDir: string;
let socket: string;
/** The fake clock the reaper reads and that its own sleeps move: no test ever waits for a real second. */
let at: number;
let signals: { pid: number; signal: NodeJS.Signals | 0 }[];

type World = {
  /** Live pids whose command line is our host's command for `socket`. */
  hosts: number[];
  /** Descriptors named with our socket, per pid: the listener plus one per client. */
  fds: Map<number, number>;
  /** CPU seconds handed out in order, one per sample. */
  cpu: Map<number, number[]>;
  /** Pids the process table still has. */
  alive: Set<number>;
  /** What a TERM does to this pid; the default is a clean exit. */
  onTerm: (pid: number) => void;
  /** The pid the extension recorded for the host serving the socket. */
  serving: number | undefined;
  /** What `ps -o lstart=` says about the holder: the other half of its identity. */
  started: string;
};

function world(over: Partial<World> = {}): World {
  return {
    hosts: [HOLDER],
    fds: new Map([
      [HOLDER, 1],
      [SERVING, 2],
    ]),
    cpu: new Map(),
    alive: new Set([HOLDER, SERVING]),
    onTerm: (pid) => void w.alive.delete(pid),
    serving: undefined,
    started: STARTED,
    ...over,
  };
}

let w: World;

function ops(): ProcessOps {
  return {
    kill: (pid, signal) => {
      if (signal !== 0) signals.push({ pid, signal }); // signal 0 is a liveness probe, not a signal
      if (!w.alive.has(pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      if (signal === "SIGTERM") w.onTerm(pid);
      if (signal === "SIGKILL") w.alive.delete(pid);
    },
    commandLine: async (pid) => (w.hosts.includes(pid) ? `/x/omo --mode rpc --listen unix://${socket}` : undefined),
    listensOn: async (pid, file) => file === socket && (w.fds.get(pid) ?? 0) > 0,
    hostPids: async (file) => (file === socket ? w.hosts.filter((pid) => w.alive.has(pid)) : []),
    startedAt: async (pid) => (w.alive.has(pid) ? w.started : undefined),
    socketFds: async (pid, file) => (file === socket && w.alive.has(pid) ? (w.fds.get(pid) ?? 0) : 0),
    cpuSeconds: async (pid) => {
      if (!w.alive.has(pid)) return undefined;
      const samples = w.cpu.get(pid);
      return samples === undefined ? 0 : (samples.shift() ?? 0);
    },
  };
}

function reaper(): HostReaper {
  return new HostReaper({
    processes: ops(),
    now: () => at,
    sleep: async (ms) => {
      at += ms; // the reaper's own waits move the clock, so a grace period passes without a real one
    },
  });
}

function target(): ReapTarget {
  return { socketPath: socket, agentDir, servingPid: async () => w.serving };
}

/** One task log of this environment, with the records it ends in and how long ago it was last written. */
async function log(task: string, records: unknown[], ageMs: number, project = "proj-a"): Promise<void> {
  const dir = join(agentDir, "projects", project, "senpi-task", "logs");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${task}.jsonl`);
  await writeFile(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  const when = new Date(at - ageMs);
  await utimes(file, when, when);
}

/** The same, written where a signal handler can: the process reacts to a TERM without an await to hang it on. */
function logNow(task: string, records: unknown[], project = "proj-a"): void {
  const dir = join(agentDir, "projects", project, "senpi-task", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task}.jsonl`), records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

/** The whole environment quiet, the way the person found it: four tasks suspended, nothing written for thirteen minutes. */
async function quietEnvironment(): Promise<void> {
  for (const task of ["st_1", "st_2", "st_3", "st_4"]) await log(task, [WORKING, SUSPENDED], 13 * 60_000);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reap-"));
  agentDir = join(root, "agent");
  socket = join(root, "rpc", "agent-tabs.sock");
  at = Date.now();
  signals = [];
  w = world();
  await mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the record that ends a task", () => {
  /** The vocabulary measured across 119 of the person's own task logs. */
  it("knows_every_ending_omo_really_writes_and_counts_everything_else_as_work", () => {
    for (const reason of ["idle", "reload", "quit", "cancel"]) {
      expect(recordEndsTask(JSON.stringify({ type: "suspended", payload: { reason } }))).toBe(true);
    }
    expect(recordEndsTask(JSON.stringify({ type: "destroyed", payload: { cause: "cancel" } }))).toBe(true);
    expect(recordEndsTask(JSON.stringify({ type: "cancelled", payload: { previous_status: "pending" } }))).toBe(true);
    for (const status of ["completed", "error", "cancelled", "lost"]) {
      expect(recordEndsTask(JSON.stringify({ type: "transition_applied", payload: { status } }))).toBe(true);
    }
    for (const record of [
      { type: "transition_applied", payload: { status: "running" } },
      { type: "tool_execution", payload: { tool: "ls" } },
      { type: "assistant_message", payload: { text: "…" } },
      { type: "revived", payload: { run_epoch: 1 } },
      { type: "task_self_resumed", payload: { run_epoch: 2 } },
      { type: "steered", payload: { delivered: "steer" } },
      { type: "child_error", payload: { message: "overloaded" } },
      { type: "reconcile_reattached", payload: {} },
    ]) {
      expect(recordEndsTask(JSON.stringify(record))).toBe(false);
    }
  });

  it("a_half_written_record_is_a_writer_and_so_counts_as_work", () => {
    expect(recordEndsTask('{"type":"suspended","payl')).toBe(false);
    expect(recordEndsTask("not json at all")).toBe(false);
    expect(recordEndsTask("[]")).toBe(false);
  });
});

describe("stopping a duplicate host when every proof holds", () => {
  it("terms_it_and_says_which_proof_it_used", async () => {
    await quietEnvironment();
    const outcome = await reaper().stop(target(), { pid: HOLDER });

    expect(outcome.verdict).toBe("stopped");
    expect(signals).toEqual([{ pid: HOLDER, signal: "SIGTERM" }]); // never a KILL first
    expect(outcome.verdict === "stopped" && outcome.escalated).toBeUndefined();
    expect(outcome.verdict === "stopped" && outcome.proof).toMatchObject({ pid: HOLDER, startedAt: STARTED, clients: 0, live: 0 });
    const note = outcome.verdict === "stopped" ? outcome.note : "";
    expect(note).toContain(`pid ${HOLDER}`);
    expect(note).toContain("никто не был подключён");
    expect(note).toContain("журналы задач молчали 13 мин");
    expect(note).toContain("CPU 0 %");
  });

  it("an_environment_with_no_task_logs_at_all_is_quiet", async () => {
    const outcome = await reaper().stop(target(), { pid: HOLDER });
    expect(outcome.verdict).toBe("stopped");
  });

  /** An empty log file describes no task, so it does not stand in the way of anything. */
  it("an_empty_log_file_is_not_a_running_task", async () => {
    await log("st_empty", [], 13 * 60_000);
    expect((await reaper().stop(target(), { pid: HOLDER })).verdict).toBe("stopped");
  });
});

describe("every proof that fails in turn leaves the process alone", () => {
  it("a_holder_the_host_did_not_name_is_never_looked_for", async () => {
    await quietEnvironment();
    const outcome = await reaper().stop(target(), { socket });
    expect(outcome).toMatchObject({ verdict: "refused", offerStop: false });
    expect(signals).toEqual([]);
  });

  /** The rule with no exception: a process we cannot tie to our own socket path is not signalled even by the button. */
  it("a_stranger_on_another_path_is_never_a_candidate_however_idle_it_looks", async () => {
    await quietEnvironment();
    w.hosts = []; // its command line is not our host's command for this socket
    const outcome = await reaper().stop(target(), { pid: HOLDER });

    expect(outcome).toMatchObject({ verdict: "refused", offerStop: false });
    expect(outcome.verdict === "refused" && outcome.reason).toContain("не является хостом OmO этой среды");
    expect(signals).toEqual([]);

    const forced = await reaper().stop(target(), { pid: HOLDER }, { force: true });
    expect(forced).toMatchObject({ verdict: "refused", offerStop: false });
    expect(signals).toEqual([]);
  });

  it("a_host_of_ours_that_no_longer_holds_the_path_is_not_signalled_and_the_open_is_worth_retrying", async () => {
    await quietEnvironment();
    w.fds.set(HOLDER, 0);
    const outcome = await reaper().stop(target(), { pid: HOLDER });
    expect(outcome.verdict).toBe("gone");
    expect(signals).toEqual([]);
  });

  it("the_host_serving_the_socket_is_never_stopped_even_by_the_button", async () => {
    await quietEnvironment();
    w.serving = HOLDER;
    expect(await reaper().stop(target(), { pid: HOLDER })).toMatchObject({ verdict: "refused", offerStop: false });
    expect(await reaper().stop(target(), { pid: HOLDER }, { force: true })).toMatchObject({ verdict: "refused", offerStop: false });
    expect(signals).toEqual([]);
  });

  it("a_holder_someone_is_connected_to_is_left_alone_and_the_person_gets_the_facts", async () => {
    await quietEnvironment();
    w.fds.set(HOLDER, 3); // the listener and two clients
    const outcome = await reaper().stop(target(), { pid: HOLDER });

    expect(outcome).toMatchObject({ verdict: "refused", offerStop: true });
    expect(outcome.verdict === "refused" && outcome.reason).toContain(`pid ${HOLDER}`);
    expect(outcome.verdict === "refused" && outcome.reason).toContain("к ней подключено 2");
    expect(outcome.verdict === "refused" && outcome.reason).toContain("клиентов 2");
    expect(signals).toEqual([]);
  });

  /** The holder is working: the one case the person asked never to be touched by itself. */
  it("a_task_log_that_has_not_ended_is_the_proof_that_something_is_working", async () => {
    await quietEnvironment();
    await log("st_live", [SUSPENDED, WORKING], 13 * 60_000);
    const outcome = await reaper().stop(target(), { pid: HOLDER });

    expect(outcome).toMatchObject({ verdict: "refused", offerStop: true });
    expect(outcome.verdict === "refused" && outcome.reason).toContain("ещё идут задачи (1)");
    expect(signals).toEqual([]);
  });

  it("a_task_log_still_being_written_is_the_proof_too_however_terminal_its_last_record_looks", async () => {
    await quietEnvironment();
    await log("st_fresh", [WORKING, SUSPENDED], LOG_QUIET_MS - 60_000);
    const outcome = await reaper().stop(target(), { pid: HOLDER });

    expect(outcome).toMatchObject({ verdict: "refused", offerStop: true });
    expect(outcome.verdict === "refused" && outcome.reason).toContain("журналы задач писались 9 мин назад");
    expect(signals).toEqual([]);
  });

  it("a_log_in_any_project_of_the_environment_counts", async () => {
    await quietEnvironment();
    await log("st_other", [WORKING], 13 * 60_000, "proj-b");
    expect(await reaper().stop(target(), { pid: HOLDER })).toMatchObject({ verdict: "refused", offerStop: true });
    expect(signals).toEqual([]);
  });

  it("a_holder_burning_cpu_is_left_alone", async () => {
    await quietEnvironment();
    w.cpu.set(HOLDER, [100, 100 + (CPU_IDLE_SHARE + 0.4)]); // the two samples are one second apart
    const outcome = await reaper().stop(target(), { pid: HOLDER });

    expect(outcome).toMatchObject({ verdict: "refused", offerStop: true });
    expect(outcome.verdict === "refused" && outcome.reason).toContain("ядра");
    expect(signals).toEqual([]);
  });

  it("cpu_just_under_the_bound_is_still_idle", async () => {
    await quietEnvironment();
    w.cpu.set(HOLDER, [100, 100 + (CPU_IDLE_SHARE - 0.1)]);
    expect((await reaper().stop(target(), { pid: HOLDER })).verdict).toBe("stopped");
  });

  it("a_process_that_is_already_gone_is_not_signalled", async () => {
    await quietEnvironment();
    w.alive.delete(HOLDER);
    expect((await reaper().stop(target(), { pid: HOLDER })).verdict).toBe("gone");
    expect(signals).toEqual([]);
  });
});

describe("the person's own say-so", () => {
  it("stops_a_working_holder_the_extension_refused_to_touch", async () => {
    await quietEnvironment();
    await log("st_live", [WORKING], 10_000);
    w.fds.set(HOLDER, 4);
    const one = reaper();

    expect(await one.stop(target(), { pid: HOLDER })).toMatchObject({ verdict: "refused", offerStop: true });
    expect(signals).toEqual([]);

    const forced = await one.stop(target(), { pid: HOLDER }, { force: true });
    expect(forced.verdict).toBe("stopped");
    expect(signals).toEqual([{ pid: HOLDER, signal: "SIGTERM" }]); // the person's click is not a KILL either
  });

  it("is_not_refused_by_the_cooldown_the_automatic_attempt_started", async () => {
    await quietEnvironment();
    await log("st_live", [WORKING], 10_000);
    const one = reaper();
    await one.stop(target(), { pid: HOLDER }); // spends the one automatic attempt

    expect((await one.stop(target(), { pid: HOLDER }, { force: true })).verdict).toBe("stopped");
  });
});

describe("the bound on self-healing", () => {
  /** A refused attempt is the one that could be repeated, and it is not: the second ask says so and signals nothing. */
  it("one_attempt_per_holder_and_then_it_says_so_instead_of_repeating", async () => {
    await quietEnvironment();
    await log("st_live", [WORKING], 10_000); // a proof fails, so the first attempt refuses
    const one = reaper();

    expect(await one.stop(target(), { pid: HOLDER })).toMatchObject({ verdict: "refused", offerStop: true });
    const again = await one.stop(target(), { pid: HOLDER });
    expect(again).toMatchObject({ verdict: "refused", offerStop: true });
    expect(again.verdict === "refused" && again.reason).toContain("больше не пробую");
    expect(signals).toEqual([]);
  });

  it("a_holder_that_was_stopped_is_not_a_holder_any_more", async () => {
    await quietEnvironment();
    const one = reaper();
    expect((await one.stop(target(), { pid: HOLDER })).verdict).toBe("stopped");
    expect((await one.stop(target(), { pid: HOLDER })).verdict).toBe("gone"); // nothing left to attempt
    expect(signals).toEqual([{ pid: HOLDER, signal: "SIGTERM" }]);
  });

  /** The cooldown key is pid + the OS's start time, so a reused pid is a different holder and gets its own attempt. */
  it("a_reused_pid_with_a_new_start_time_is_a_different_holder", async () => {
    await quietEnvironment();
    await log("st_live", [WORKING], 10_000);
    const one = reaper();
    expect(await one.stop(target(), { pid: HOLDER })).toMatchObject({ verdict: "refused", offerStop: true });

    w.started = "Thu Nov  5 19:00:00 2026"; // the pid came back as another process
    const after = await one.stop(target(), { pid: HOLDER });
    expect(after.verdict === "refused" && after.reason).not.toContain("больше не пробую");
  });

  it("several_tabs_blocked_by_one_holder_make_one_attempt_between_them", async () => {
    await quietEnvironment();
    const one = reaper();
    const outcomes = await Promise.all([0, 1, 2, 3, 4].map(() => one.stop(target(), { pid: HOLDER })));

    expect(outcomes.every((outcome) => outcome.verdict === "stopped")).toBe(true);
    expect(signals).toEqual([{ pid: HOLDER, signal: "SIGTERM" }]); // one TERM for all five tabs
  });
});

describe("escalating past the TERM", () => {
  it("kills_only_after_the_grace_and_says_it_had_to", async () => {
    await quietEnvironment();
    w.onTerm = () => undefined; // it ignores the TERM
    const outcome = await reaper().stop(target(), { pid: HOLDER });

    expect(outcome).toMatchObject({ verdict: "stopped", escalated: true });
    expect(signals.map((signal) => signal.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome.verdict === "stopped" && outcome.note).toContain("остановил принудительно");
  });

  /** The person's rule: never escalate at all if it starts writing again. */
  it("never_kills_a_holder_that_started_working_again_after_the_term", async () => {
    await quietEnvironment();
    w.onTerm = () => logNow("st_woke", [SUSPENDED, WORKING]);
    const outcome = await reaper().stop(target(), { pid: HOLDER });

    expect(outcome).toMatchObject({ verdict: "refused", offerStop: true });
    expect(outcome.verdict === "refused" && outcome.reason).toContain("снова взялась за задачи");
    expect(signals.map((signal) => signal.signal)).toEqual(["SIGTERM"]);
  });

  /** A clean shutdown writes `suspended:quit`, which is an end: it must not be read as work resuming. */
  it("a_clean_shutdowns_own_record_does_not_block_the_escalation", async () => {
    await quietEnvironment();
    w.onTerm = () => logNow("st_1", [WORKING, { type: "suspended", payload: { reason: "quit" } }]);
    const outcome = await reaper().stop(target(), { pid: HOLDER });
    expect(outcome).toMatchObject({ verdict: "stopped", escalated: true });
  });
});
