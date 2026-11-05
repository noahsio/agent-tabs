/**
 * The ration for restarting a wedged turn by itself. A session may be restarted automatically at most once in this
 * window, and the extension process is what remembers it: a reloaded webview, or a second tab on the same session,
 * therefore cannot start the count over. Past the ration the person is offered the manual way out instead — nothing
 * here ever retries.
 */
export const AUTO_UNWEDGE_COOLDOWN_MS = 120_000;

/** When each durable session was last restarted automatically; entries past the cooldown are dropped on the next claim. */
const lastAttempt = new Map<string, number>();

/** True when this session may be restarted automatically now; the claim starts its cooldown. */
export function claimAutoUnwedge(durableId: string, now: number = Date.now()): boolean {
  for (const [id, at] of lastAttempt) if (now - at >= AUTO_UNWEDGE_COOLDOWN_MS) lastAttempt.delete(id);
  if (lastAttempt.has(durableId)) return false;
  lastAttempt.set(durableId, now);
  return true;
}

/** Forgets every cooldown (tests start from a clean process). */
export function resetAutoUnwedge(): void {
  lastAttempt.clear();
}
