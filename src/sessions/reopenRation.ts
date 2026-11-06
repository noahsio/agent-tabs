/**
 * The ration for reopening a session OmO keeps parking by itself. A session may be reopened automatically at most
 * `REOPEN_CAP` times in a row; past that the storm is stopped and the tab is handed to the person. The count resets
 * only after real quiet — a full `REOPEN_WINDOW_MS` with no further park — so a session that parks, reopens and parks
 * again without pause is caught, while a lone park minutes later starts from a clean slate.
 *
 * The extension process is what remembers it: a reloaded webview, or a second tab on the same session, cannot start
 * the count over. Keyed on the durable session id, which never rotates — the rpc handle does, so it would not do.
 */
export const REOPEN_CAP = 3;

/** A session quiet (no automatic reopen) this long has its count forgotten; the next park starts fresh. */
export const REOPEN_WINDOW_MS = 60_000;

/** Per durable session: how many reopens in the current run, and when the last one was asked for. */
const runs = new Map<string, { count: number; last: number }>();

/**
 * True when this session may be reopened automatically now. Every call counts — including one past the cap — so a storm
 * that keeps parking keeps the window from ever going quiet, and the cap holds until the parking actually stops.
 */
export function claimReopen(durableId: string, now: number = Date.now()): boolean {
  for (const [id, run] of runs) if (now - run.last >= REOPEN_WINDOW_MS) runs.delete(id);
  const run = runs.get(durableId);
  if (run === undefined) {
    runs.set(durableId, { count: 1, last: now });
    return true;
  }
  run.last = now;
  run.count += 1;
  return run.count <= REOPEN_CAP;
}

/** Clears a session's count so the next claim starts fresh: a person's own reopen is not a storm and must not be declined. */
export function releaseReopen(durableId: string): void {
  runs.delete(durableId);
}

/** Forgets every count (tests start from a clean process). */
export function resetReopenRation(): void {
  runs.clear();
}
