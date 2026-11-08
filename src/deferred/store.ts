import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeOmoFile } from "../settings/files";

export type OutboxEntry = {
  text: string;
  clientMessageId: string;
  createdAt: number;
} & ({ kind: "question"; sessionPath: string } | { kind: "approval"; sessionId: string });
type DeferredState = { questions: Record<string, { at: number; text: string }>; outbox: Record<string, OutboxEntry> };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Synchronous read/modify/atomic-write operations preserve the other records in this environment's file. */
export class DeferredStore {
  private readonly file: string;

  constructor(agentDir: string) {
    this.file = join(agentDir, "agent-tabs", "deferred.json");
  }

  read(): DeferredState {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) {
      if (object(error) && error["code"] === "ENOENT") return { questions: {}, outbox: {} };
      throw error;
    }
    if (!object(raw) || !object(raw["questions"]) || (raw["outbox"] !== undefined && !object(raw["outbox"]))) throw new Error("Не удалось прочитать сохранённые ответы");
    const questions: DeferredState["questions"] = {};
    for (const [id, value] of Object.entries(raw["questions"])) {
      if (!object(value) || typeof value["at"] !== "number" || !Number.isFinite(value["at"]) || typeof value["text"] !== "string") throw new Error("Повреждён сохранённый ответ");
      Object.defineProperty(questions, id, { value: { at: value["at"], text: value["text"] }, enumerable: true, writable: true });
    }
    const outbox: DeferredState["outbox"] = {};
    for (const [id, value] of Object.entries(raw["outbox"] ?? {})) {
      if (!object(value) || typeof value["text"] !== "string" || value["clientMessageId"] !== id ||
        typeof value["createdAt"] !== "number" || !Number.isFinite(value["createdAt"])) throw new Error("Повреждена очередь ответов");
      const base = { text: value["text"], clientMessageId: id, createdAt: value["createdAt"] };
      if (value["kind"] === "question" && typeof value["sessionPath"] === "string") outbox[id] = { ...base, kind: "question", sessionPath: value["sessionPath"] };
      else if (value["kind"] === "approval" && typeof value["sessionId"] === "string") outbox[id] = { ...base, kind: "approval", sessionId: value["sessionId"] };
      else throw new Error("Повреждена очередь ответов");
    }
    return { questions, outbox };
  }

  markAnswered(id: string, text: string, at: number): void {
    const state = this.read();
    Object.defineProperty(state.questions, id, { value: { at, text }, enumerable: true, writable: true });
    this.write(state);
  }

  /** A question's answer and delivery intent commit in the same file replacement. */
  enqueue(entry: OutboxEntry, answer?: { id: string; text: string }): void {
    const state = this.read();
    if (answer !== undefined) Object.defineProperty(state.questions, answer.id, { value: { at: entry.createdAt, text: answer.text }, enumerable: true, writable: true });
    state.outbox[entry.clientMessageId] = entry;
    this.write(state);
  }

  remove(clientMessageId: string): void {
    const state = this.read();
    delete state.outbox[clientMessageId];
    this.write(state);
  }

  private write(state: DeferredState): void {
    writeOmoFile(this.file, JSON.stringify(state, null, 2) + "\n", { backup: "rolling" });
  }
}
