import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A child session cannot be its own ancestor; a chain longer than this is broken, and resolves to nothing. */
const MAX_HOPS = 8;
/** How long the task records may answer a miss before they are read again. */
const STALE_MS = 250;
/** The same, for the children's journal names: the layout only changes when a task starts, so it is read far less. */
const LAYOUT_STALE_MS = 5_000;
/** The durable session id at the end of a journal's file name (`<iso>_<uuid>.jsonl`). */
const JOURNAL = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

type Record_ = { task: string; parent: string | undefined; root: string | undefined };

export type TaskRegistryOptions = {
  /** A miss is answered from records younger than this; older ones are read again first. */
  staleMs?: number;
  /** The same for the journal-name index, which costs more to build and changes less. */
  layoutStaleMs?: number;
  now?: () => number;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * OmO's own answer to «whose session is this»: the senpi-task records it writes under
 * `<agentDir>/projects/*​/senpi-task/tasks/st_*.json`, each holding the spawned session's `child_session_id` together
 * with the `parent_session_id` and `root_session_id` it was spawned from. The hook only ever reports the asking
 * session's own id (OmO 5.1.59's PreToolUse payload carries no parent), so this is where a subagent's request is tied
 * back to the chat that owns it.
 *
 * A record names only the child session it knows about, and on older runs that is not the session that actually asked
 * (OmO re-points `child_session_id` when it replaces a child). The child's journal says it too — it lives at
 * `projects/*​/senpi-task/children/<task_id>/sessions/*​/<iso>_<session>.jsonl` — so a session the records do not name is
 * looked up by that path, and its task record gives the root. Both are OmO's own bookkeeping, no guessing.
 *
 * One registry per environment, built from that environment's agent dir only: the person's two agent dirs
 * (`~/.omo/agent`, the portable one) hold different runs of the same projects and must never answer for each other.
 *
 * Nothing is read on a hit. A miss re-reads the records at most once every `staleMs` and the journal names at most once
 * every `layoutStaleMs`, so a burst of requests — or a steady stream of sessions nothing claims — does not walk the
 * directory each time. A task written after the last read is found on the next attempt past that window; OmO writes the
 * record when it spawns the child, a good 6 s before the child's first tool call on this person's data, so nothing waits.
 */
export class TaskRegistry {
  private records = new Map<string, Record_>();
  private byChild = new Map<string, string>();
  private byJournal = new Map<string, string>();
  private recordsAt = Number.NEGATIVE_INFINITY;
  private layoutAt = Number.NEGATIVE_INFINITY;
  /** How many times the registry was walked: the tests hold the I/O budget to this. */
  reads = 0;
  layoutReads = 0;

  constructor(
    private readonly agentDir: string,
    private readonly options: TaskRegistryOptions = {},
  ) {}

  /**
   * The session of the chat that owns `session`: the root of the task chain that spawned it. `undefined` when nothing
   * in this environment claims it — a chat's own session, a terminal, or a child OmO has not recorded anywhere.
   */
  rootOf(session: string): string | undefined {
    const known = this.rootFromRecords(session);
    if (known !== undefined) return known;
    if (!this.fresh(this.recordsAt, this.options.staleMs ?? STALE_MS)) {
      this.readRecords();
      const again = this.rootFromRecords(session);
      if (again !== undefined) return again;
    }
    return this.rootFromJournals(session);
  }

  /** Forgets everything read: the next question reads the registry again. */
  invalidate(): void {
    this.recordsAt = Number.NEGATIVE_INFINITY;
    this.layoutAt = Number.NEGATIVE_INFINITY;
  }

  private fresh(at: number, window: number): boolean {
    return (this.options.now?.() ?? Date.now()) - at < window;
  }

  private rootFromRecords(session: string): string | undefined {
    const task = this.byChild.get(session);
    return task === undefined ? undefined : this.rootOfTask(task, session);
  }

  /** A session the records do not name, found by the journal OmO keeps under its task's directory. */
  private rootFromJournals(session: string): string | undefined {
    if (!this.fresh(this.layoutAt, this.options.layoutStaleMs ?? LAYOUT_STALE_MS)) this.readJournalNames();
    const task = this.byJournal.get(session);
    return task === undefined ? undefined : this.rootOfTask(task, session);
  }

  /** `task`'s chain root: OmO's recorded root when it has one, else up the parents until nothing claims one. */
  private rootOfTask(task: string, asked: string): string | undefined {
    let record = this.records.get(task);
    for (let hop = 0; hop < MAX_HOPS && record !== undefined; hop++) {
      if (record.root !== undefined && record.root !== asked) return record.root;
      const parent = record.parent;
      if (parent === undefined || parent === asked) return undefined;
      const next = this.byChild.get(parent);
      if (next === undefined) return parent; // nothing claims the parent as a child: it is the root
      record = this.records.get(next);
    }
    return undefined; // no end in sight (a cycle, or a chain deeper than any real run)
  }

  private readRecords(): void {
    this.reads += 1;
    this.recordsAt = this.options.now?.() ?? Date.now();
    const records = new Map<string, Record_>();
    const byChild = new Map<string, string>();
    for (const project of this.dir(join(this.agentDir, "projects"))) {
      const tasks = join(this.agentDir, "projects", project, "senpi-task", "tasks");
      for (const file of this.dir(tasks)) {
        if (!file.endsWith(".json")) continue;
        const raw = this.record(join(tasks, file));
        const task = text(raw?.["task_id"]) ?? file.slice(0, -".json".length);
        if (raw === undefined) continue;
        records.set(task, { task, parent: text(raw["parent_session_id"]), root: text(raw["root_session_id"]) });
        const child = text(raw["child_session_id"]);
        if (child !== undefined) byChild.set(child, task);
      }
    }
    this.records = records;
    this.byChild = byChild;
  }

  /** `<session uuid>` -> the task whose directory keeps that journal. Names only: no file is opened. */
  private readJournalNames(): void {
    this.layoutReads += 1;
    this.layoutAt = this.options.now?.() ?? Date.now();
    const byJournal = new Map<string, string>();
    for (const project of this.dir(join(this.agentDir, "projects"))) {
      const children = join(this.agentDir, "projects", project, "senpi-task", "children");
      for (const task of this.dir(children)) {
        const sessions = join(children, task, "sessions");
        for (const holder of this.dir(sessions)) {
          for (const file of this.dir(join(sessions, holder))) {
            const session = JOURNAL.exec(file)?.[1];
            if (session !== undefined) byJournal.set(session, task);
          }
        }
      }
    }
    this.byJournal = byJournal;
  }

  private dir(path: string): string[] {
    try {
      return readdirSync(path);
    } catch {
      return []; // no registry in this environment (yet): nothing is claimed, and nothing throws
    }
  }

  private record(path: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined; // half-written or not ours: the other records still answer
    }
  }
}
