import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sessionTitle, stampOf, textOf } from "../sessions/history";
import { DeferredStore } from "./store";

export type DeferredQuestion = {
  kind: "question";
  id: string;
  sessionPath: string;
  sessionTitle: string;
  /** The session's folder (its journal header): a window shows its own projects first. */
  cwd?: string;
  /** The session's durable id: a window that has it open in a tab owns the item whatever the folder. */
  session?: string;
  createdAt: number;
  deferredAt: number;
  questions: DeferredPrompt[];
  decided?: string;
};
export type DeferredPrompt = { header: string; question: string; options: { label: string }[]; multiSelect: boolean };
type Question = { id: string; createdAt: number; questions: DeferredPrompt[]; deferredAt?: number; deferred?: boolean; decided?: string };
type Journal = { size: number; tail: string; decoder: StringDecoder; id?: string; cwd?: string; name?: string; firstUser?: string; questions: Map<string, Question> };
const WEEK = 7 * 86400_000;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prompts(value: unknown): DeferredPrompt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: unknown) => {
    if (!object(raw) || typeof raw["question"] !== "string" || raw["question"].trim() === "") return [];
    const options = Array.isArray(raw["options"]) ? raw["options"].flatMap((option: unknown) =>
      object(option) && typeof option["label"] === "string" ? [{ label: option["label"] }] : []) : [];
    return [{ header: typeof raw["header"] === "string" ? raw["header"] : "", question: raw["question"], options, multiSelect: raw["multiSelect"] === true }];
  });
}

async function journalPaths(agentDir: string): Promise<string[]> {
  const root = join(agentDir, "sessions");
  let folders;
  try { folders = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (object(error) && error["code"] === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    for (const file of await readdir(join(root, folder.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".jsonl")) files.push(join(root, folder.name, file.name));
    }
  }
  return files;
}

/** Guard requests name durable IDs, including sessions outside this window's project. */
export async function findSessionPath(agentDir: string, durableId: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9-]+$/.test(durableId)) return undefined;
  return (await journalPaths(agentDir)).find((file) => file.endsWith(`_${durableId}.jsonl`));
}

async function dirs(dir: string): Promise<string[]> {
  try { return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch (error) {
    if (object(error) && error["code"] === "ENOENT") return [];
    throw error;
  }
}

/**
 * The session a request belongs to, as the person knows it. A task child (measured, OmO 5.1.59) keeps its journal under
 * projects/<p>/senpi-task/children/<st>/sessions/<st>/ — not under sessions/ — with a header cwd that may be the home dir,
 * and its task record (projects/<p>/senpi-task/tasks/<st>.json) names the root session that spawned it: that session
 * shows the request and receives the answer. `task` is set when the request came from a child.
 */
export async function ownerSession(agentDir: string, durableId: string): Promise<{ durableId: string; file: string; task?: string } | undefined> {
  const own = await findSessionPath(agentDir, durableId);
  if (own !== undefined || !/^[A-Za-z0-9-]+$/.test(durableId)) return own === undefined ? undefined : { durableId, file: own };
  const projects = join(agentDir, "projects");
  for (const project of await dirs(projects)) {
    const tasks = join(projects, project, "senpi-task");
    for (const task of await dirs(join(tasks, "children"))) {
      const journals = await readdir(join(tasks, "children", task, "sessions", task)).catch(() => [] as string[]);
      if (!journals.some((name) => name.endsWith(`_${durableId}.jsonl`))) continue;
      let record: unknown;
      try { record = JSON.parse(await readFile(join(tasks, "tasks", `${task}.json`), "utf8")); }
      catch { return undefined; }
      const root = object(record) ? record["root_session_id"] : undefined;
      if (typeof root !== "string" || root === durableId) return undefined;
      const file = await findSessionPath(agentDir, root);
      return file === undefined ? undefined : { durableId: root, file, task };
    }
  }
  return undefined;
}

/** Append-only journals are parsed once; incomplete final records stay buffered for the next scan. */
export class DeferredQuestions {
  private readonly journals = new Map<string, Journal>();
  private readonly store: DeferredStore;

  constructor(private readonly agentDir: string) {
    this.store = new DeferredStore(agentDir);
  }

  async scan(now: number = Date.now()): Promise<DeferredQuestion[]> {
    const paths = await journalPaths(this.agentDir);
    const seen = new Set(paths);
    const answered = this.store.read().questions;
    const items: DeferredQuestion[] = [];
    for (const file of paths) {
      const info = await stat(file);
      if (info.mtimeMs < now - WEEK) continue;
      let journal = this.journals.get(file);
      if (journal === undefined || info.size < journal.size) {
        journal = { size: 0, tail: "", decoder: new StringDecoder("utf8"), questions: new Map() };
        this.journals.set(file, journal);
      }
      if (info.size > journal.size) {
        for await (const chunk of createReadStream(file, { start: journal.size, end: info.size - 1 })) {
          const text = journal.tail + journal.decoder.write(chunk);
          const lines = text.split("\n");
          journal.tail = lines.pop() ?? "";
          for (const line of lines) this.consume(journal, line, info.mtimeMs);
        }
        journal.size = info.size;
      }
      for (const question of journal.questions.values()) {
        if (!question.deferred || question.deferredAt === undefined || Object.hasOwn(answered, question.id)) continue;
        items.push({ kind: "question", id: question.id, sessionPath: file, sessionTitle: sessionTitle(journal.name, journal.firstUser),
          ...(journal.cwd !== undefined ? { cwd: journal.cwd } : {}),
          ...(journal.id !== undefined ? { session: journal.id } : {}),
          createdAt: question.createdAt, deferredAt: question.deferredAt, questions: question.questions,
          ...(question.decided !== undefined ? { decided: question.decided } : {}) });
      }
    }
    for (const file of this.journals.keys()) if (!seen.has(file)) this.journals.delete(file);
    return items.sort((left, right) => right.deferredAt - left.deferredAt);
  }

  /** Read afresh, so a different window's answered IDs are retained by this synchronous atomic write. */
  markAnswered(id: string, text: string, at: number = Date.now()): void {
    this.store.markAnswered(id, text, at);
  }

  isAnswered(id: string): boolean {
    return Object.hasOwn(this.store.read().questions, id);
  }

  title(file: string): string | undefined {
    const journal = this.journals.get(file);
    return journal === undefined ? undefined : sessionTitle(journal.name, journal.firstUser);
  }

  /** The folder a scanned journal's header names. */
  cwd(file: string): string | undefined {
    return this.journals.get(file)?.cwd;
  }

  private consume(journal: Journal, line: string, fallbackTime: number): void {
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch { return; } // A malformed complete journal record cannot become valid on a later append.
    if (!object(entry)) return;
    const message = object(entry["message"]) ? entry["message"] : undefined;
    const at = stampOf({ timestamp: entry["timestamp"], ...(message !== undefined ? { message } : {}) }) ?? fallbackTime;
    if (entry["type"] === "session" && typeof entry["cwd"] === "string") journal.cwd = entry["cwd"];
    if (entry["type"] === "session" && typeof entry["id"] === "string") journal.id = entry["id"];
    if (entry["type"] === "session_info" && typeof entry["name"] === "string" && entry["name"].trim()) journal.name = entry["name"].trim();
    if (entry["type"] === "custom" && entry["customType"] === "ask-user:settlement" && object(entry["data"])) {
      const data = entry["data"];
      const question = typeof data["requestId"] === "string" ? journal.questions.get(data["requestId"]) : undefined;
      if (question !== undefined) {
        question.deferredAt = at;
        question.deferred = data["status"] === "timed_out";
      }
    }
    if (entry["type"] !== "message" || message === undefined) return;
    const text = textOf(message["content"]).trim();
    if (message["role"] === "user" && journal.firstUser === undefined && text) journal.firstUser = text;
    if (message["role"] === "toolResult" && typeof message["toolCallId"] === "string") {
      const question = journal.questions.get(message["toolCallId"]);
      const result = text + JSON.stringify(message["details"] ?? "");
      if (question !== undefined && question.deferredAt !== undefined && result.includes("Человек отложил вопрос")) question.deferred = true;
    }
    if (message["role"] !== "assistant") return;
    for (const question of journal.questions.values()) {
      if (question.deferredAt !== undefined && question.decided === undefined && text) question.decided = text.slice(0, 300);
    }
    if (!Array.isArray(message["content"])) return;
    for (const part of message["content"]) {
      if (!object(part) || part["type"] !== "toolCall" || typeof part["id"] !== "string" ||
        (part["name"] !== "ask_user_question" && part["name"] !== "request_user_input") || !object(part["arguments"])) continue;
      const questions = prompts(part["arguments"]["questions"]);
      if (questions.length > 0) journal.questions.set(part["id"], { id: part["id"], questions, createdAt: at });
    }
  }
}
