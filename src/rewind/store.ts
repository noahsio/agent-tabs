import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** How a message went out while the agent was running (no checkpoint can exist for it). */
export type SentMode = "steer" | "followUp";

export type CheckpointPoint = { id: string; clientMessageId: string; repo: string; commit: string; skipped: string[]; at: number };

/** `after.path` is an absolute physical path; `hash` is sha256 hex, `null` when the file was absent. */
export type CheckpointRecord =
  | ({ type: "point" } & CheckpointPoint)
  | { type: "sent"; clientMessageId: string; mode: SentMode }
  | { type: "after"; path: string; hash: string | null; at: number };

/** Folded log: points and sent marks by clientMessageId, the latest after-hash by path. */
export type CheckpointLog = { points: Map<string, CheckpointPoint>; sent: Map<string, SentMode>; after: Map<string, string | null> };

const isString = (value: unknown): value is string => typeof value === "string";

function parseRecord(line: string): CheckpointRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  switch (record["type"]) {
    case "point": {
      const { id, clientMessageId, repo, commit, skipped, at } = record;
      if (!isString(id) || !isString(clientMessageId) || !isString(repo) || !isString(commit)) return undefined;
      if (!Array.isArray(skipped) || !skipped.every(isString) || typeof at !== "number") return undefined;
      return { type: "point", id, clientMessageId, repo, commit, skipped, at };
    }
    case "sent": {
      const { clientMessageId, mode } = record;
      if (!isString(clientMessageId) || (mode !== "steer" && mode !== "followUp")) return undefined;
      return { type: "sent", clientMessageId, mode };
    }
    case "after": {
      const { path, hash, at } = record;
      if (!isString(path) || !(hash === null || isString(hash)) || typeof at !== "number") return undefined;
      return { type: "after", path, hash, at };
    }
    default:
      return undefined;
  }
}

/**
 * Append-only JSONL log per session at `<agentDir>/agent-tabs/checkpoints/<sessionUuid>.jsonl`.
 * Several windows may append to one log; each append is a single write, and a torn last line is skipped on read.
 */
export class CheckpointStore {
  private readonly dir: string;

  constructor(agentDir: string) {
    this.dir = join(agentDir, "agent-tabs", "checkpoints");
  }

  file(sessionUuid: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(sessionUuid)) throw new Error(`invalid session id: ${sessionUuid}`);
    return join(this.dir, `${sessionUuid}.jsonl`);
  }

  async append(sessionUuid: string, records: CheckpointRecord[]): Promise<void> {
    const file = this.file(sessionUuid);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (records.length === 0) return;
    await appendFile(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
  }

  async read(sessionUuid: string): Promise<CheckpointLog> {
    const log: CheckpointLog = { points: new Map(), sent: new Map(), after: new Map() };
    for (const record of await this.records(this.file(sessionUuid))) {
      if (record.type === "point") {
        const { type: _type, ...point } = record;
        log.points.set(point.clientMessageId, point);
      } else if (record.type === "sent") log.sent.set(record.clientMessageId, record.mode);
      else log.after.set(record.path, record.hash);
    }
    return log;
  }

  /** Seeds a fork's log: points and sent marks of the copied messages, every after-hash. */
  async copyForFork(from: string, to: string, clientMessageIds: ReadonlySet<string>): Promise<void> {
    const records = (await this.records(this.file(from))).filter(
      (record) => record.type === "after" || clientMessageIds.has(record.clientMessageId),
    );
    await this.append(to, records);
  }

  /** Every repo named by a point in any log, sorted. */
  async repos(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const repos = new Set<string>();
    for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
      for (const record of await this.records(join(this.dir, name))) if (record.type === "point") repos.add(record.repo);
    }
    return [...repos].sort();
  }

  private async records(file: string): Promise<CheckpointRecord[]> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    return text.split("\n").flatMap((line) => {
      const record = line.trim() === "" ? undefined : parseRecord(line);
      return record === undefined ? [] : [record];
    });
  }
}
