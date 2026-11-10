import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_IMAGE_CHARS, MAX_IMAGES } from "../panel/protocol";
import type { OutgoingImage } from "../sessions/controller";
import { ancestors, type Entry } from "./edits";

/** What the fork tab puts into its composer: the forked message's text and images. */
export type ForkDraft = { text: string; images: OutgoingImage[] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The session header: the file's first line, which must be `type: "session"`. */
export async function readSessionHeader(sessionPath: string): Promise<Entry> {
  const handle = await open(sessionPath, "r");
  try {
    let text = "";
    for await (const line of handle.readLines({ encoding: "utf8" })) {
      text = line;
      break;
    }
    const header: unknown = JSON.parse(text);
    if (!isObject(header) || header["type"] !== "session") throw new Error(`${sessionPath}: no session header`);
    return header;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isUserEntry(entry: Entry | undefined): entry is Entry {
  const message = entry?.["message"];
  return entry?.["type"] === "message" && isObject(message) && message["role"] === "user";
}

/**
 * The fork file OmO's own `fork` would write: the source header with a new id, timestamp and
 * `parentSession`, then the selected user entry's ancestors (root first, the entry itself left out), verbatim.
 */
export function buildFork(
  header: Entry,
  entries: Entry[],
  selectedEntryId: string,
  id: string,
  now: Date,
  sourcePath: string,
  raw?: ReadonlyMap<string, string>,
): { text: string; chain: Entry[] } {
  const lineage = ancestors(entries, selectedEntryId);
  if (!isUserEntry(lineage[lineage.length - 1])) throw new Error(`entry ${selectedEntryId} is not a user message`);
  const chain = lineage.slice(0, -1);
  return { text: forkText(header, chain, id, now, sourcePath, raw), chain };
}

/** The fork of the conversation as it stands: the leaf's ancestors, root first, the leaf itself included. */
export function buildSessionFork(
  header: Entry,
  entries: Entry[],
  leafId: string,
  id: string,
  now: Date,
  sourcePath: string,
  raw?: ReadonlyMap<string, string>,
): { text: string; chain: Entry[] } {
  const chain = ancestors(entries, leafId);
  if (chain.length === 0) throw new Error(`entry ${leafId} is not in the session file`);
  return { text: forkText(header, chain, id, now, sourcePath, raw), chain };
}

function forkText(header: Entry, chain: Entry[], id: string, now: Date, sourcePath: string, raw?: ReadonlyMap<string, string>): string {
  const head = JSON.stringify({ ...header, id, timestamp: now.toISOString(), parentSession: sourcePath });
  const lines = chain.map((entry) => raw?.get(entry["id"] as string) ?? JSON.stringify(entry));
  return [head, ...lines].join("\n") + "\n";
}

/** The session file: its header and every entry with the exact line it was stored as (a torn or malformed line is skipped). */
async function readSessionFile(sessionPath: string): Promise<{ header: Entry; entries: Entry[]; raw: Map<string, string> }> {
  const [first = "", ...rest] = (await readFile(sessionPath, "utf8")).split("\n");
  const header: unknown = JSON.parse(first);
  if (!isObject(header) || header["type"] !== "session") throw new Error(`${sessionPath}: no session header`);
  const entries: Entry[] = [];
  const raw = new Map<string, string>();
  for (const line of rest) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || typeof entry["id"] !== "string") continue;
    entries.push(entry);
    raw.set(entry["id"], line);
  }
  return { header, entries, raw };
}

const FORK_MARK = / \(fork(?: (\d+))?\)$/;

/** The fork's name: the source's with « (fork)», a second fork « (fork 2)», and so on; an untitled source is a new session. */
export function forkTitle(title: string): string {
  const base = title.trim() === "" ? "Новая сессия" : title.trim();
  const mark = FORK_MARK.exec(base);
  if (mark === null) return `${base} (fork)`;
  return `${base.slice(0, mark.index)} (fork ${Number(mark[1] ?? 1) + 1})`;
}

export function forkFileName(id: string, now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
}

/** The entry's text parts joined and its image parts (as the journal stores them), within the composer's limits. */
export function forkDraft(entry: Entry): ForkDraft {
  const message = entry["message"];
  const content = isObject(message) ? message["content"] : undefined;
  if (typeof content === "string") return { text: content, images: [] };
  const parts = Array.isArray(content) ? content.filter(isObject) : [];
  const text = parts.map((part) => (part["type"] === "text" && typeof part["text"] === "string" ? part["text"] : "")).join("");
  const images: OutgoingImage[] = [];
  for (const part of parts) {
    if (part["type"] !== "image" || typeof part["data"] !== "string" || typeof part["mimeType"] !== "string") continue;
    if (part["data"].length > MAX_IMAGE_CHARS || images.length >= MAX_IMAGES) continue;
    images.push({ data: part["data"], mimeType: part["mimeType"] });
  }
  return { text, images };
}

/**
 * Writes the fork file next to the source session (temp file, then rename) and returns where it is. The entries come
 * from the source file itself, line for line as stored — exactly what OmO's own fork copies.
 */
export async function writeFork(
  sourcePath: string,
  selectedEntryId: string,
  now: Date = new Date(),
): Promise<{ sessionPath: string; sessionUuid: string; chain: Entry[]; draft: ForkDraft }> {
  const { header, entries, raw } = await readSessionFile(sourcePath);
  const sessionUuid = randomUUID();
  const { text, chain } = buildFork(header, entries, selectedEntryId, sessionUuid, now, sourcePath, raw);
  const selected = entries.find((entry) => entry["id"] === selectedEntryId) as Entry;
  const sessionPath = await writeForkFile(sourcePath, sessionUuid, now, text);
  return { sessionPath, sessionUuid, chain, draft: forkDraft(selected) };
}

/** Writes the fork of the whole conversation up to `leafId` (that entry included) next to the source session. */
export async function writeSessionFork(
  sourcePath: string,
  leafId: string,
  now: Date = new Date(),
): Promise<{ sessionPath: string; sessionUuid: string; chain: Entry[] }> {
  const { header, entries, raw } = await readSessionFile(sourcePath);
  const sessionUuid = randomUUID();
  const { text, chain } = buildSessionFork(header, entries, leafId, sessionUuid, now, sourcePath, raw);
  const sessionPath = await writeForkFile(sourcePath, sessionUuid, now, text);
  return { sessionPath, sessionUuid, chain };
}

/** Temp file, then rename: the fork appears whole or not at all. */
async function writeForkFile(sourcePath: string, sessionUuid: string, now: Date, text: string): Promise<string> {
  const sessionPath = join(dirname(sourcePath), forkFileName(sessionUuid, now));
  const temp = `${sessionPath}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await rename(temp, sessionPath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return sessionPath;
}
