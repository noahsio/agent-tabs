import { taskTouches } from "./children";
import { EDIT_TOOLS, toolTouches, type FileTouch } from "./edits";
import { physicalFile, repoRoot } from "./git";
import { fileHash } from "./plan";
import { dropSnapshot, takeSnapshot, type Snapshot } from "./snapshot";
import type { CheckpointRecord, CheckpointStore, SentMode } from "./store";

/** OmO holds writing tools at most this long when the barrier is never released. */
export const BARRIER_DEADLINE_MS = 35_000;
/**
 * A snapshot that finishes later than this is dropped: once OmO's deadline passes, writing tools run,
 * so a later snapshot could already hold the agent's edits. The 5 s margin covers the release round trip.
 */
export const SNAPSHOT_BUDGET_MS = 30_000;

type Frame = Record<string, unknown>;

const isObject = (value: unknown): value is Frame => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What a session controller calls around a prompt: snapshot before the agent may write, sent marks for
 * messages that can have no snapshot, and the hash of every file after each of the agent's edits.
 */
export class Checkpointer {
  readonly store: CheckpointStore;
  readonly agentDir: string;
  private readonly snapshot: (repo: string, pointId: string) => Promise<Snapshot>;
  private readonly budgetMs: number;
  private readonly repos = new Map<string, Promise<string | undefined>>();
  private readonly startedArgs = new Map<string, { tool: string; args: unknown }>();
  private pending: Promise<void> = Promise.resolve();

  constructor(deps: { store: CheckpointStore; agentDir: string; snapshot?: (repo: string, pointId: string) => Promise<Snapshot>; budgetMs?: number }) {
    this.store = deps.store;
    this.agentDir = deps.agentDir;
    this.snapshot = deps.snapshot ?? takeSnapshot;
    this.budgetMs = deps.budgetMs ?? SNAPSHOT_BUDGET_MS;
  }

  /**
   * The git top level for a session cwd, `undefined` outside git. A found repo is cached; «none» is asked again next
   * time (the folder may become a repo, or the lookup timed out), each lookup bounded by its own timeout.
   */
  repoFor(cwd: string): Promise<string | undefined> {
    const known = this.repos.get(cwd);
    if (known !== undefined) return known;
    const repo = repoRoot(cwd);
    this.repos.set(cwd, repo);
    void repo.then((found) => {
      if (found === undefined && this.repos.get(cwd) === repo) this.repos.delete(cwd);
    });
    return repo;
  }

  /**
   * True only when the snapshot finished within the budget and its point is recorded. Never rejects. The budget runs
   * from `startedAt` (when the barrier was asked for: OmO's deadline counts from there), else from now.
   */
  async capture(input: { sessionUuid: string; repo: string; clientMessageId: string; pointId: string; startedAt?: number }): Promise<boolean> {
    let late = false;
    let timer: NodeJS.Timeout | undefined;
    const remaining = this.budgetMs - (Date.now() - (input.startedAt ?? Date.now()));
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        late = true;
        resolve(undefined);
      }, Math.max(0, remaining));
    });
    const taking = this.snapshot(input.repo, input.pointId).then(
      async (snapshot) => {
        if (!late) return snapshot;
        await dropSnapshot(input.repo, input.pointId).catch(() => undefined);
        return undefined;
      },
      () => undefined,
    );
    const snapshot = await Promise.race([taking, deadline]);
    clearTimeout(timer);
    if (snapshot === undefined) return false;
    try {
      const { commit, skipped } = snapshot;
      await this.store.append(input.sessionUuid, [
        { type: "point", id: input.pointId, clientMessageId: input.clientMessageId, repo: input.repo, commit, skipped, at: Date.now() },
      ]);
      return true;
    } catch {
      await dropSnapshot(input.repo, input.pointId).catch(() => undefined);
      return false;
    }
  }

  /** Records that a message went out while the agent was running. Never rejects. */
  async markSent(sessionUuid: string, clientMessageId: string, mode: SentMode): Promise<void> {
    await this.store.append(sessionUuid, [{ type: "sent", clientMessageId, mode }]).catch(() => undefined);
  }

  /** Watches one session's frames: after each successful edit (or subagent task), records the touched files' hashes. */
  observe(sessionUuid: string, cwd: string, frame: Frame): void {
    const toolCallId = typeof frame["toolCallId"] === "string" ? frame["toolCallId"] : undefined;
    const tool = typeof frame["toolName"] === "string" ? frame["toolName"] : undefined;
    if (toolCallId === undefined || tool === undefined) return;
    if (frame["type"] === "tool_execution_start") {
      if (EDIT_TOOLS.has(tool)) this.startedArgs.set(toolCallId, { tool, args: frame["args"] });
      return;
    }
    if (frame["type"] !== "tool_execution_end") return;
    const started = this.startedArgs.get(toolCallId);
    this.startedArgs.delete(toolCallId);
    if (frame["isError"] === true) return;
    let touches: () => Promise<FileTouch[]>;
    if (tool === "task") {
      const result = frame["result"];
      const details = isObject(result) ? result["details"] : undefined;
      const taskId = isObject(details) ? details["task_id"] : undefined;
      if (typeof taskId !== "string") return;
      touches = async () => (await taskTouches(this.agentDir, taskId, cwd)).touches;
    } else if (started !== undefined) {
      const found = toolTouches(started.tool, started.args ?? frame["args"], cwd) ?? [];
      touches = async () => found;
    } else return;
    this.pending = this.pending.then(() => this.recordAfter(sessionUuid, touches)).catch(() => undefined);
  }

  /** Resolves when every observed edit has been recorded. */
  settled(): Promise<void> {
    return this.pending;
  }

  private async recordAfter(sessionUuid: string, touches: () => Promise<FileTouch[]>): Promise<void> {
    const paths = new Set<string>();
    for (const touch of await touches()) paths.add(await physicalFile(touch.path));
    if (paths.size === 0) return;
    const records: CheckpointRecord[] = [];
    for (const path of paths) records.push({ type: "after", path, hash: await fileHash(path), at: Date.now() });
    await this.store.append(sessionUuid, records);
  }
}
