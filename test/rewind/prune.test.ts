import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneCheckpoints } from "../../src/rewind/prune";
import { CHECKPOINT_REF_PREFIX, snapshotExists, takeSnapshot } from "../../src/rewind/snapshot";
import { CheckpointStore } from "../../src/rewind/store";
import { gitText, gitWith, makeRepo } from "../helpers/gitRepo";

async function repoWithOldRef(): Promise<string> {
  const repo = await makeRepo({ "a.txt": "a" });
  const tree = gitText(repo, "write-tree").trim();
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const commit = gitWith(repo, { GIT_COMMITTER_DATE: old }, "commit-tree", tree, "-m", "old").trim();
  gitText(repo, "update-ref", `${CHECKPOINT_REF_PREFIX}old`, commit);
  await takeSnapshot(repo, "fresh");
  return repo;
}

const point = (repo: string, clientMessageId: string) => ({ type: "point" as const, id: "p", clientMessageId, repo, commit: "abc", skipped: [], at: 1 });

describe("prune checkpoints", () => {
  it("prune_checkpoints_covers_every_repo_in_the_logs_and_skips_missing_ones", async () => {
    const store = new CheckpointStore(mkdtempSync(join(tmpdir(), "agent-tabs-prune-")));
    const first = await repoWithOldRef();
    const second = await repoWithOldRef();
    const gone = await makeRepo({ "x": "x" });
    rmSync(gone, { recursive: true, force: true });
    await store.append("s1", [point(first, "c1"), point(gone, "c2")]);
    await store.append("s2", [point(second, "c3")]);
    expect(await pruneCheckpoints(store, Date.now())).toBe(2);
    expect(await snapshotExists(first, "old")).toBe(false);
    expect(await snapshotExists(second, "fresh")).toBe(true);
  });
});
