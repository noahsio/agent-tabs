import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessOps } from "../daemon";
import type { Holder } from "./refusal";

/**
 * How long EVERY task log of the environment must have been untouched before a holder counts as idle. The person's own
 * hand check used thirteen minutes; ten is the floor under it. The records carry no timestamps of their own (measured
 * across 119 real logs), so this is the file's mtime and nothing finer. Its job is narrow — a task whose last record is
 * terminal could still be revived by itself a moment later (`revived`, `task_self_resumed`) — and ten minutes is far
 * past any such bounce.
 */
export const LOG_QUIET_MS = 600_000;
/** Between the TERM and the KILL that may follow it: the same wait «Перезапустить OmO» gives its own host. */
export const TERM_GRACE_MS = 10_000;
/** The CPU sample's window, and the share of one core a holder may not be over. */
export const CPU_SAMPLE_MS = 1_000;
/**
 * Measured on live 5.1.59 hosts: an idle host burns 0–6 % of a core on its background timers, and a host mid-turn is an
 * order of magnitude above that. A quarter of a core sits in the empty middle, so neither side is a close call.
 */
export const CPU_IDLE_SHARE = 0.25;
/** One attempt per holder per this long. Longer than the quiet period, so a refusal is never re-tried on stale facts. */
export const REAP_COOLDOWN_MS = 600_000;

/** How much of a task log's tail is read to find its last record: a single record is never anywhere near this. */
const TAIL_BYTES = 64 * 1024;

/**
 * Types whose presence as the LAST record means the task is over or parked. Measured over 119 real logs: every one of
 * them ended in one of these. `suspended` carries `idle`/`reload`/`quit`/`cancel` — all of them mean nothing is running.
 */
const ENDED_TYPES: ReadonlySet<string> = new Set(["suspended", "destroyed", "cancelled"]);
/** `transition_applied` statuses that are an end; `running` is the only one that is not. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["completed", "error", "cancelled", "lost"]);

/** What was proved about a holder, in the numbers the feed line and the honest line quote. */
export type ReapProof = {
  pid: number;
  /** The OS's own start time for that pid: the half of the cooldown key a process cannot rotate. */
  startedAt: string;
  /** Clients talking to it. 0 is the proof nobody is — and the proof it is not the host serving the socket. */
  clients: number;
  /** Task logs of this environment whose last record is not an end: tasks that still look alive. */
  live: number;
  /** How long the newest task log has been untouched, ms; Infinity when the environment has no task logs at all. */
  quietMs: number;
  /** Share of one core over the sample window. */
  cpuShare: number;
};

export type ReapOutcome =
  /** The holder was stopped and the path is free. `escalated`: TERM was not enough and KILL followed the grace. */
  | { verdict: "stopped"; proof: ReapProof; note: string; escalated?: true }
  /** The holder is not there any more (or no longer holds our path): nothing was signalled, and the open is worth retrying. */
  | { verdict: "gone"; reason: string }
  /** Nothing was touched. `reason` is the whole honest sentence; `offerStop` when the person may still decide. */
  | { verdict: "refused"; reason: string; offerStop: boolean };

/** What the reaper needs to know about the environment it is reaping in; a `DaemonManager` is one. */
export type ReapTarget = {
  readonly socketPath: string;
  readonly agentDir: string;
  /** The pid this extension recorded for the host serving that socket, while it is still that host. */
  servingPid(): Promise<number | undefined>;
};

export type ReaperDeps = {
  processes: ProcessOps;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** One task log: when it was last written, and whether its last record is an end. */
export type TaskLog = { file: string; writtenAt: number; ended: boolean };

/**
 * True when this record ends its task. Anything else — a tool execution, an assistant message, a running transition, a
 * steer, a revival — is work, and so is a line that will not parse: a half-written record means a writer.
 */
export function recordEndsTask(line: string): boolean {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof record !== "object" || record === null) return false;
  const type = (record as Record<string, unknown>)["type"];
  if (typeof type !== "string") return false;
  if (ENDED_TYPES.has(type)) return true;
  if (type !== "transition_applied") return false;
  const payload = (record as Record<string, unknown>)["payload"];
  const status = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["status"] : undefined;
  return typeof status === "string" && ENDED_STATUSES.has(status);
}

/** The last non-blank line of a file, read from its tail. */
async function lastLine(file: string, size: number): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = (lines[index] as string).trim();
      if (line !== "") return line;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Every `<agentDir>/projects/*​/senpi-task/logs/*.jsonl` of this environment. Scoped to the whole environment, not to
 * the holder: a task log names no pid, and the host does not keep its descriptor open (measured on a live host), so
 * there is nothing to attribute one by. The error is on the safe side — while anything in the environment is mid-task,
 * no copy of the host is stopped by itself.
 */
export async function taskLogs(agentDir: string): Promise<TaskLog[]> {
  let projects: string[];
  try {
    projects = await readdir(join(agentDir, "projects"));
  } catch {
    return [];
  }
  const logs: TaskLog[] = [];
  for (const project of projects) {
    const dir = join(agentDir, "projects", project, "senpi-task", "logs");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        // A log with no records at all describes no task: there is nothing in it that could still be running.
        const line = info.size === 0 ? undefined : await lastLine(file, info.size);
        logs.push({ file, writtenAt: info.mtimeMs, ended: line === undefined || recordEndsTask(line) });
      } catch {
        continue; // it was rotated away between the listing and the read
      }
    }
  }
  return logs;
}

/** The two numbers the idleness proof needs out of the environment's task logs. */
export async function taskLogState(agentDir: string, now: number): Promise<{ live: number; quietMs: number }> {
  const logs = await taskLogs(agentDir);
  const newest = logs.reduce((latest, log) => Math.max(latest, log.writtenAt), -Infinity);
  return { live: logs.filter((log) => !log.ended).length, quietMs: newest === -Infinity ? Infinity : Math.max(0, now - newest) };
}

function minutes(ms: number): string {
  return ms === Infinity ? "всегда" : `${Math.floor(ms / 60_000)} мин`;
}

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

/** The whole safety case, as one clause the person can audit. */
function safetyClause(proof: ReapProof): string {
  return `к ней никто не был подключён, все её задачи завершены или приостановлены, журналы задач молчали ${minutes(proof.quietMs)}, CPU ${percent(proof.cpuShare)}`;
}

/** The feed's one line: what was stopped, its pid, and why it was safe. */
function stoppedNote(proof: ReapProof, escalated: boolean): string {
  const how = escalated ? "TERM не хватило, остановил принудительно" : "послал TERM";
  return `Остановил вторую копию хоста OmO (pid ${proof.pid}, запущена ${proof.startedAt}): ${safetyClause(proof)} — ${how}. Файл сессии освободился.`;
}

/** Why this holder was left alone, with the facts the person decides on. */
function refusalWords(proof: ReapProof, blocker: string): string {
  const facts = `клиентов ${proof.clients}, незакрытых задач ${proof.live}, журналы молчат ${minutes(proof.quietMs)}, CPU ${percent(proof.cpuShare)}`;
  return `Файл сессии держит другая копия хоста OmO (pid ${proof.pid}): ${blocker}. Сама её не останавливаю — ${facts}.`;
}

/** The first proof of idleness that does not hold, or undefined when all of them do. */
function blockerOf(proof: ReapProof): string | undefined {
  if (proof.clients > 0) return `к ней подключено ${proof.clients}`;
  if (proof.live > 0) return `в этой среде ещё идут задачи (${proof.live})`;
  if (proof.quietMs < LOG_QUIET_MS) return `журналы задач писались ${minutes(proof.quietMs)} назад`;
  if (proof.cpuShare > CPU_IDLE_SHARE) return `она занимает ${percent(proof.cpuShare)} ядра`;
  return undefined;
}

/**
 * Stops a second copy of this environment's own host when every proof of safety holds, and says which proof it used.
 * One instance per window owns the bounds: an attempt per holder per cooldown, and every tab blocked by one holder
 * joins that single attempt, so ten restored tabs make one TERM and one line in the feed.
 */
export class HostReaper {
  /** When each holder (pid + the OS's start time) last had its attempt; entries past the cooldown are dropped. */
  private readonly attempted = new Map<string, number>();
  /** The attempt in flight per holder pid: every tab waiting on that holder gets this same outcome. */
  private readonly inflight = new Map<number, Promise<ReapOutcome>>();
  private readonly processes: ProcessOps;
  private readonly now: () => number;
  private readonly pause: (ms: number) => Promise<void>;

  constructor(deps: ReaperDeps) {
    this.processes = deps.processes;
    this.now = deps.now ?? (() => Date.now());
    this.pause = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * `force` is the person's own click: it skips the proofs of idleness, which are theirs to judge, and keeps every
   * proof of attribution — a process we cannot tie to our own socket path is never signalled, whatever it looks like.
   */
  stop(target: ReapTarget, holder: Holder | undefined, options: { force?: boolean } = {}): Promise<ReapOutcome> {
    const pid = holder?.pid;
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
      return Promise.resolve({ verdict: "refused", reason: "Хост OmO не назвал pid того, кто держит файл сессии", offerStop: false });
    }
    const running = this.inflight.get(pid);
    if (running !== undefined) return running;
    const attempt = this.run(target, pid, options.force === true).finally(() => this.inflight.delete(pid));
    this.inflight.set(pid, attempt);
    return attempt;
  }

  /** Forgets every cooldown (tests start from a clean process). */
  reset(): void {
    this.attempted.clear();
  }

  private async run(target: ReapTarget, pid: number, force: boolean): Promise<ReapOutcome> {
    const socket = target.socketPath;
    const startedAt = await this.processes.startedAt(pid);
    if (startedAt === undefined) return { verdict: "gone", reason: `процесса ${pid} больше нет` };
    if (!force && !this.claim(`${pid}@${startedAt}`)) {
      return {
        verdict: "refused",
        reason: `Файл сессии держит другая копия хоста OmO (pid ${pid}). Остановить её сама я уже пробовала — больше не пробую.`,
        offerStop: true,
      };
    }
    // Ours, by the same rule 0.4.24 identifies a host by: the command line ends with our host's command for THIS socket.
    const ours = await this.processes.hostPids(socket);
    if (!ours.includes(pid)) {
      return {
        verdict: "refused",
        reason: `Файл сессии держит процесс ${pid}, который не является хостом OmO этой среды — я его не трогаю.`,
        offerStop: false,
      };
    }
    // It holds the socket path: a stolen bind stays in lsof under the path it was bound with, which is the fingerprint
    // of «the first host is still sitting on the path». Nothing there means it let go while we were looking.
    const fds = await this.processes.socketFds(pid, socket);
    if (fds < 1) return { verdict: "gone", reason: `pid ${pid} больше не держит сокет этой среды` };
    const serving = await target.servingPid();
    if (serving === pid) {
      return {
        verdict: "refused",
        reason: `Файл сессии держит pid ${pid}, но он же сейчас обслуживает сокет этой среды — это живой хост, я его не трогаю.`,
        offerStop: false,
      };
    }
    const clients = fds - 1; // one descriptor is the listener; the rest are clients talking to it
    const logs = await taskLogState(target.agentDir, this.now());
    const proof: ReapProof = { pid, startedAt, clients, live: logs.live, quietMs: logs.quietMs, cpuShare: await this.cpuShare(pid) };
    const blocker = blockerOf(proof);
    if (!force && blocker !== undefined) return { verdict: "refused", reason: refusalWords(proof, blocker), offerStop: true };
    return this.term(target, proof);
  }

  /** TERM, then the grace, then KILL — but never a KILL once the thing has started working again. */
  private async term(target: ReapTarget, proof: ReapProof): Promise<ReapOutcome> {
    try {
      this.processes.kill(proof.pid, "SIGTERM");
    } catch {
      return { verdict: "gone", reason: `pid ${proof.pid} завершился сам` };
    }
    if (await this.exited(proof.pid)) return { verdict: "stopped", proof, note: stoppedNote(proof, false) };
    // A clean shutdown writes `suspended:quit`, which is an end and does not stand in the way. A `revived` or a running
    // transition does: it means the TERM woke work up instead of ending it, and then nothing is escalated.
    const after = await taskLogState(target.agentDir, this.now());
    if (after.live > 0) {
      return {
        verdict: "refused",
        reason: `Послала TERM второй копии хоста OmO (pid ${proof.pid}), но она снова взялась за задачи (${after.live}) — принудительно её не останавливаю.`,
        offerStop: true,
      };
    }
    try {
      this.processes.kill(proof.pid, "SIGKILL");
    } catch {
      return { verdict: "stopped", proof, note: stoppedNote(proof, false) }; // it went between the probe and the signal
    }
    return { verdict: "stopped", proof, note: stoppedNote(proof, true), escalated: true };
  }

  private async exited(pid: number): Promise<boolean> {
    const deadline = this.now() + TERM_GRACE_MS;
    for (;;) {
      try {
        this.processes.kill(pid, 0);
      } catch {
        return true;
      }
      if (this.now() >= deadline) return false;
      await this.pause(200);
    }
  }

  /** Two samples of the process's own CPU clock: `%cpu` on macOS is a decayed estimate, this is the real difference. */
  private async cpuShare(pid: number): Promise<number> {
    const first = await this.processes.cpuSeconds(pid);
    if (first === undefined) return 0;
    await this.pause(CPU_SAMPLE_MS);
    const second = await this.processes.cpuSeconds(pid);
    if (second === undefined) return 0;
    return Math.max(0, (second - first) / (CPU_SAMPLE_MS / 1_000));
  }

  /** True when this holder may have its one attempt now; the claim starts its cooldown. */
  private claim(key: string): boolean {
    const now = this.now();
    for (const [seen, at] of this.attempted) if (now - at >= REAP_COOLDOWN_MS) this.attempted.delete(seen);
    if (this.attempted.has(key)) return false;
    this.attempted.set(key, now);
    return true;
  }
}
