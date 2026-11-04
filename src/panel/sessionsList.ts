import type { PastSession } from "../sessions/history";
import type { SessionItem } from "./protocol";

export type LiveSession = { sessionPath: string; durableSessionId: string; status: string; attachments: number };

type Requester = { request(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };

/** A hint for the list, never worth holding the panel up. */
const LIVE_TIMEOUT_MS = 3_000;

/** Pinned first, then most recent last message (never opening or attaching); pins and archive marks of sessions that no longer exist are simply not shown. Pure. */
export function buildSessionItems(
  past: PastSession[],
  live: LiveSession[],
  pinned: ReadonlySet<string>,
  currentPath: string | undefined,
  archived: ReadonlySet<string> = new Set(),
): SessionItem[] {
  const items = past.map((session): SessionItem => {
    const running = live.some(
      (item) => (item.sessionPath === session.sessionPath || item.durableSessionId === session.durableId) && item.status === "running",
    );
    return {
      sessionPath: session.sessionPath,
      durableId: session.durableId,
      title: session.title,
      updatedAt: session.updatedAt,
      running,
      pinned: pinned.has(session.durableId),
      archived: archived.has(session.durableId),
      current: session.sessionPath === currentPath,
    };
  });
  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

/**
 * The daemon's live sessions of this project. `list_sessions` (observe: it must not reset the host's idle timer) carries no running flag, so each one, in parallel, is asked with
 * `get_state {observe}` (not an attachment) and reported as "running" when its turn is in progress. Any failure
 * means "not live": the list still shows the saved sessions.
 */
export async function fetchLiveSessions(client: Requester, cwds: readonly string[]): Promise<LiveSession[]> {
  let data: unknown;
  try {
    data = await client.request("list_sessions", { observe: true }, LIVE_TIMEOUT_MS);
  } catch {
    return [];
  }
  const sessions = typeof data === "object" && data !== null ? (data as { sessions?: unknown }).sessions : undefined;
  if (!Array.isArray(sessions)) return [];
  const candidates: { sessionId: string; sessionPath: string; durableSessionId: string; status: unknown; attachments: number }[] = [];
  for (const raw of sessions as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as { sessionId?: unknown; sessionPath?: unknown; durableSessionId?: unknown; cwd?: unknown; status?: unknown; attachments?: unknown };
    if (typeof item.sessionId !== "string" || typeof item.sessionPath !== "string" || typeof item.durableSessionId !== "string") continue;
    if (typeof item.cwd !== "string" || !cwds.includes(item.cwd)) continue;
    candidates.push({
      sessionId: item.sessionId,
      sessionPath: item.sessionPath,
      durableSessionId: item.durableSessionId,
      status: item.status,
      attachments: typeof item.attachments === "number" ? item.attachments : 0,
    });
  }
  return Promise.all(
    candidates.map(async ({ sessionId, status, ...rest }): Promise<LiveSession> => ({ ...rest, status: await liveStatus(client, sessionId, status) })),
  );
}

/** Flips one pin in an already built list and restores the order, without asking anyone. */
export function withPin(items: SessionItem[], durableId: string, pinned: boolean): SessionItem[] {
  return items
    .map((item) => (item.durableId === durableId ? { ...item, pinned } : item))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

/** Flips one archive mark in an already built list; the order does not depend on it. */
export function withArchived(items: SessionItem[], durableId: string, archived: boolean): SessionItem[] {
  return items.map((item) => (item.durableId === durableId ? { ...item, archived } : item));
}

/**
 * Working directories of the host's sessions whose turn is running now (any project). Rejects when the list cannot be
 * had: «unknown» must not read as «none» (a rewind would then change files under a running turn).
 */
export async function runningCwds(client: Requester): Promise<string[]> {
  const data = await client.request("list_sessions", { observe: true }, LIVE_TIMEOUT_MS);
  const sessions = typeof data === "object" && data !== null ? (data as { sessions?: unknown }).sessions : undefined;
  if (!Array.isArray(sessions)) throw new Error("list_sessions: no sessions list");
  const rows = (sessions as unknown[]).flatMap((raw) => {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as { sessionId?: unknown; cwd?: unknown; status?: unknown };
    return typeof item.sessionId === "string" && typeof item.cwd === "string" ? [{ sessionId: item.sessionId, cwd: item.cwd, status: item.status }] : [];
  });
  const statuses = await Promise.all(rows.map((row) => liveStatus(client, row.sessionId, row.status)));
  return rows.filter((_, index) => statuses[index] === "running").map((row) => row.cwd);
}

async function liveStatus(client: Requester, sessionId: string, listed: unknown): Promise<string> {
  try {
    const state = (await client.request("get_state", { sessionId, observe: true }, LIVE_TIMEOUT_MS)) as {
      isStreaming?: unknown;
      lifecycle?: { state?: unknown };
    } | null;
    if (state?.isStreaming === true || state?.lifecycle?.state === "running") return "running";
  } catch {
    // fall through to the listed status
  }
  return typeof listed === "string" ? listed : "unknown";
}
