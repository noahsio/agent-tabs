import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_REF_PREFIX,
  MAX_UNTRACKED_BYTES,
  pruneSnapshots,
  snapshotExists,
  takeSnapshot,
  dropSnapshot,
} from "../../src/rewind/snapshot";
import { gitText, gitWith, makeRepo, userGitState } from "../helpers/gitRepo";

describe("rewind snapshots", () => {
  it("snapshot_holds_tracked_changes_and_untracked_files", async () => {
    const repo = await makeRepo({ "a.txt": "a", ".gitignore": "dist/\n" });
    writeFileSync(join(repo, "a.txt"), "a2");
    writeFileSync(join(repo, "new.txt"), "n");
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist/x"), "x");
    const { commit, skipped } = await takeSnapshot(repo, "p1");
    expect(gitText(repo, "show", `${commit}:a.txt`)).toBe("a2");
    expect(gitText(repo, "show", `${commit}:new.txt`)).toBe("n");
    expect(gitText(repo, "ls-tree", "-r", "--name-only", commit)).not.toContain("dist/x");
    expect(gitText(repo, "rev-parse", `${CHECKPOINT_REF_PREFIX}p1`).trim()).toBe(commit);
    expect(gitText(repo, "rev-list", "--parents", "-n1", commit).trim()).toBe(commit);
    expect(skipped).toEqual([]);
  });

  it("snapshot_skips_untracked_files_over_5_mb", async () => {
    const repo = await makeRepo({ "tracked.bin": Buffer.alloc(6 * 1024 * 1024, 1) });
    writeFileSync(join(repo, "tracked.bin"), Buffer.alloc(6 * 1024 * 1024, 2));
    mkdirSync(join(repo, "dir with space"));
    writeFileSync(join(repo, "dir with space/big.bin"), Buffer.alloc(MAX_UNTRACKED_BYTES + 1, 3));
    writeFileSync(join(repo, "small.txt"), "s");
    const { commit, skipped } = await takeSnapshot(repo, "p1");
    expect(skipped).toEqual(["dir with space/big.bin"]);
    const names = gitText(repo, "ls-tree", "-r", "--name-only", commit).split("\n");
    expect(names).not.toContain("dir with space/big.bin");
    expect(names).toContain("small.txt");
    expect(names).toContain("tracked.bin");
    const blob = gitText(repo, "rev-parse", `${commit}:tracked.bin`).trim();
    expect(blob).not.toBe(gitText(repo, "rev-parse", "HEAD:tracked.bin").trim());
  });

  it("snapshot_sees_a_same_size_edit_made_in_the_second_the_index_was_written", async () => {
    // start of a fresh second, so the commit and the edit share it and the snapshot runs a second later
    await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 20));
    const repo = await makeRepo({ "same.txt": "aaaa" });
    writeFileSync(join(repo, "same.txt"), "bbbb");
    await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 50));
    const { commit } = await takeSnapshot(repo, "p1");
    expect(gitText(repo, "show", `${commit}:same.txt`)).toBe("bbbb");
  });

  it("snapshot_leaves_user_git_state_alone", async () => {
    const repo = await makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    writeFileSync(join(repo, "c.txt"), "stashed\n");
    gitText(repo, "stash", "-q");
    writeFileSync(join(repo, "a.txt"), "a1\n");
    gitText(repo, "add", "a.txt");
    writeFileSync(join(repo, "a.txt"), "a2\n");
    writeFileSync(join(repo, "b.txt"), "b2\n");
    writeFileSync(join(repo, "u.txt"), "u\n");
    const before = userGitState(repo);
    await takeSnapshot(repo, "p1");
    expect(userGitState(repo)).toEqual(before);
  });

  it("snapshot_works_without_commits_and_in_a_worktree", async () => {
    const fresh = await makeRepo({ "x.txt": "x", "sub/y.txt": "y" }, { commit: false });
    const first = await takeSnapshot(fresh, "p0");
    expect(gitText(fresh, "ls-tree", "-r", "--name-only", first.commit).trim().split("\n")).toEqual(["sub/y.txt", "x.txt"]);

    const repo = await makeRepo({ "a.txt": "a" });
    const worktree = join(mkdtempSync(join(tmpdir(), "agent-tabs-wt-")), "wt");
    gitText(repo, "worktree", "add", "-q", "-b", "side", worktree);
    writeFileSync(join(worktree, "a.txt"), "from worktree");
    const before = userGitState(worktree);
    const { commit } = await takeSnapshot(worktree, "p1");
    expect(gitText(repo, "show", `${CHECKPOINT_REF_PREFIX}p1:a.txt`)).toBe("from worktree");
    expect(gitText(repo, "rev-parse", `${CHECKPOINT_REF_PREFIX}p1`).trim()).toBe(commit);
    expect(userGitState(worktree)).toEqual(before);
  });

  it("prune_removes_only_refs_older_than_14_days", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const tree = gitText(repo, "write-tree").trim();
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const oldCommit = gitWith(repo, { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old }, "commit-tree", tree, "-m", "old").trim();
    gitText(repo, "update-ref", `${CHECKPOINT_REF_PREFIX}old`, oldCommit);
    await takeSnapshot(repo, "fresh");
    expect(await pruneSnapshots(repo, Date.now())).toBe(1);
    expect(await snapshotExists(repo, "old")).toBe(false);
    expect(await snapshotExists(repo, "fresh")).toBe(true);
  });

  it("snapshot_leaves_out_untracked_nested_repos", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    mkdirSync(join(repo, "empty"));
    gitText(join(repo, "empty"), "init", "-q");
    mkdirSync(join(repo, "full"));
    gitText(join(repo, "full"), "init", "-q");
    writeFileSync(join(repo, "full/f.txt"), "f");
    gitText(join(repo, "full"), "add", "-A");
    gitText(join(repo, "full"), "commit", "-q", "-m", "f");
    writeFileSync(join(repo, "b.txt"), "b");
    const { commit, skipped } = await takeSnapshot(repo, "p1");
    expect(gitText(repo, "ls-tree", "--name-only", commit).trim().split("\n")).toEqual(["a.txt", "b.txt"]);
    expect(skipped).toEqual([]);
  });

  it("drop_removes_the_ref_and_bad_point_ids_are_refused", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    await takeSnapshot(repo, "p1");
    await dropSnapshot(repo, "p1");
    expect(await snapshotExists(repo, "p1")).toBe(false);
    await expect(takeSnapshot(repo, "../HEAD")).rejects.toThrow();
    await expect(snapshotExists(repo, "a/b")).rejects.toThrow();
  });
});
