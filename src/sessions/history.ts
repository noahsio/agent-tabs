import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type PastSession = { sessionPath: string; durableId: string; title: string; updatedAt: number };

/** Parsed summaries by session file path, valid while the file keeps its mtime and size. */
export type SummaryCache = Map<string, { mtimeMs: number; size: number; id: string | undefined; title: string; used: boolean; updatedAt: number }>;

const FALLBACK_TITLE = "Без названия";
const TITLE_MAX = 60;
const MAX_LINE_CHARS = 16_777_216;

/** Yields lines split on "\n" only (trailing "\r" stripped); an over-long line is dropped, never buffered. */
async function* readLines(file: string): AsyncGenerator<string> {
  const utf8 = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  const take = function* (text: string): Generator<string> {
    const parts = text.split("\n");
    const last = parts.pop() ?? "";
    for (const part of parts) {
      const wasDropping = dropping;
      dropping = false;
      const line = pending + part;
      pending = "";
      if (wasDropping || line.length > MAX_LINE_CHARS) continue;
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    if (dropping || pending.length + last.length > MAX_LINE_CHARS) {
      dropping = true;
      pending = "";
    } else {
      pending += last;
    }
  };
  for await (const chunk of createReadStream(file)) yield* take(utf8.write(chunk as Buffer));
  const rest = pending + utf8.end();
  if (!dropping && rest.length > 0 && rest.length <= MAX_LINE_CHARS) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
}

export function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join(" ");
}

/** A record's time: the message's own epoch-ms stamp, else the journal entry's ISO one. */
export function stampOf(entry: { timestamp?: unknown; message?: { timestamp?: unknown } }): number | undefined {
  const own = entry.message?.timestamp;
  if (typeof own === "number" && Number.isFinite(own)) return own;
  const iso = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isNaN(iso) ? undefined : iso;
}

/**
 * `used`: the session has a user message; one without is a tab that was opened and never written to.
 * `updatedAt`: when the last user or assistant message was written (else the session's creation); never the file's mtime, which any attach moves.
 */
async function readSession(file: string): Promise<{ id: string | undefined; title: string; used: boolean; updatedAt: number | undefined }> {
  let id: string | undefined;
  let name: string | undefined;
  let firstUser: string | undefined;
  let used = false;
  let created: number | undefined;
  let lastMessageAt: number | undefined;
  for await (const line of readLines(file)) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const entry = record as { type?: unknown; id?: unknown; name?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown; timestamp?: unknown } };
    if (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
      const stamp = stampOf(entry);
      if (stamp !== undefined && (lastMessageAt === undefined || stamp > lastMessageAt)) lastMessageAt = stamp;
    }
    if (entry.type === "session" && id === undefined && typeof entry.id === "string") {
      id = entry.id;
      created = stampOf(entry);
    }
    else if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
    else if (entry.type === "message" && entry.message?.role === "user") {
      used = true;
      if (firstUser !== undefined) continue;
      const text = textOf(entry.message.content).trim();
      if (text) firstUser = text.slice(0, TITLE_MAX);
    }
  }
  return { id, title: sessionTitle(name, firstUser), used, updatedAt: lastMessageAt ?? created };
}

/** The journal's latest explicit name, else its first user text. */
export function sessionTitle(name: string | undefined, firstUser: string | undefined): string {
  return name ?? firstUser?.slice(0, TITLE_MAX) ?? FALLBACK_TITLE;
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * This project's saved sessions that have a user message, newest first. With a `cache`, a file whose mtime and size are unchanged is not read
 * again (a session file only grows), and files that are gone leave the cache.
 */
export async function listPastSessions(agentDir: string, folder: string, cache: SummaryCache = new Map()): Promise<PastSession[]> {
  const spellings = new Set([await safeRealpath(folder), folder]);
  const byId = new Map<string, PastSession>();
  const seen = new Set<string>();
  for (const spelling of spellings) {
    const dir = join(agentDir, "sessions", encodeCwd(spelling));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionPath = join(dir, name);
      try {
        const info = await stat(sessionPath);
        seen.add(sessionPath);
        let summary = cache.get(sessionPath);
        if (summary === undefined || summary.mtimeMs !== info.mtimeMs || summary.size !== info.size) {
          const read = await readSession(sessionPath);
          summary = { mtimeMs: info.mtimeMs, size: info.size, ...read, updatedAt: read.updatedAt ?? info.mtimeMs };
          cache.set(sessionPath, summary);
        }
        if (!summary.used) continue; // empty: never listed, never trusted as a session to open or rename
        const durableId = summary.id ?? name.replace(/\.jsonl$/, "").split("_").pop() ?? name;
        if (!byId.has(durableId)) byId.set(durableId, { sessionPath, durableId, title: summary.title, updatedAt: summary.updatedAt });
      } catch {
        continue;
      }
    }
  }
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
