import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const PAIRS = 12;
const REPLY_MAX = 150;
const AGENT_TAIL = 120;
const FILES_MAX = 8;
const TAIL_BYTES = 2_000_000;
const TTL_MS = 10 * 60_000;
/** A token, a key or a hash, or words around one: such a pair never leaves its own session. */
const SECRETISH = /[A-Za-z0-9+/_=-]{24,}|парол|password|passwd|token|secret|api[ _-]?key/i;

export type ReplyPair = { agent: string; user: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

/**
 * The person's short replies in one OmO journal, oldest first, each with the end of the agent's text it answered.
 * Left out: long messages (pastes, briefs), notices and card answers (they start with «<» or «[»), a reply with no agent
 * text before it, and any pair that looks like it holds a secret. «[картинка N]» marks are dropped from a reply.
 */
export function replyPairs(journal: string): ReplyPair[] {
  const pairs: ReplyPair[] = [];
  let agent: string | undefined;
  for (const line of journal.split("\n")) {
    if (!line.includes('"type":"message"')) continue;
    let entry: { message?: { role?: unknown; content?: unknown } } | undefined;
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const role = entry?.message?.role;
    const text = textOf(entry?.message?.content).trim();
    if (role === "assistant") {
      if (text !== "") agent = text;
      continue;
    }
    if (role !== "user") continue;
    const reply = text.replace(/\[картинка \d+\]/g, "").replace(/\s+/g, " ").trim();
    const answered = agent?.replace(/\s+/g, " ").slice(-AGENT_TAIL);
    agent = undefined;
    if (answered === undefined || reply === "" || reply.length > REPLY_MAX || /^[<[]/.test(reply) || SECRETISH.test(reply) || SECRETISH.test(answered)) continue;
    pairs.push({ agent: answered, user: reply });
  }
  return pairs;
}

/** The pairs as the next-message guess reads them, in one <style_examples> block; undefined when there are none. */
export function styleExamples(pairs: readonly ReplyPair[]): string | undefined {
  if (pairs.length === 0) return undefined;
  const examples = pairs.map((pair) => `<example>\n<agent>…${pair.agent}</agent>\n<user>${pair.user}</user>\n</example>`);
  return `<style_examples>\n${examples.join("\n")}\n</style_examples>`;
}

/** A journal's last two megabytes (OmO journals of long sessions run to tens), from its first whole line on. */
async function journalTail(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

const cache = new Map<string, { at: number; examples: string | undefined }>();

/**
 * How the person replies in this project's other sessions (the journals beside `sessionPath`, newest first): their last
 * 12 short replies as style examples. Read once per ten minutes per session; undefined when there are none.
 */
export async function projectStyleExamples(sessionPath: string, now: number = Date.now()): Promise<string | undefined> {
  const hit = cache.get(sessionPath);
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.examples;
  const dir = dirname(sessionPath);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl") && join(dir, name) !== sessionPath);
  const files = (await Promise.all(names.map(async (name) => ({ file: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs }))))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, FILES_MAX);
  const chunks: ReplyPair[][] = [];
  let count = 0;
  for (const { file } of files) {
    const pairs = replyPairs(await journalTail(file));
    chunks.unshift(pairs);
    count += pairs.length;
    if (count >= PAIRS) break;
  }
  const examples = styleExamples(chunks.flat().slice(-PAIRS));
  cache.set(sessionPath, { at: now, examples });
  return examples;
}
