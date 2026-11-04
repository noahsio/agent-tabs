import { stat } from "node:fs/promises";
import { pruneSnapshots } from "./snapshot";
import type { CheckpointStore } from "./store";

/** Drops checkpoint refs older than 14 days in every repo the logs name; a missing or broken repo is skipped. */
export async function pruneCheckpoints(store: CheckpointStore, now: number): Promise<number> {
  let removed = 0;
  for (const repo of await store.repos()) {
    try {
      if (!(await stat(repo)).isDirectory()) continue;
      removed += await pruneSnapshots(repo, now);
    } catch {
      // gone or not a repo any more: nothing to prune there
    }
  }
  return removed;
}
