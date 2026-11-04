import { copyFile, lstat, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git";

export const CHECKPOINT_REF_PREFIX = "refs/agent-tabs/checkpoints/";
export const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
export const CHECKPOINT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** A checkpoint commit and the untracked files (repo-relative, `/`-separated) left out of it for size. */
export type Snapshot = { commit: string; skipped: string[] };

function refFor(pointId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(pointId)) throw new Error(`invalid checkpoint id: ${pointId}`);
  return `${CHECKPOINT_REF_PREFIX}${pointId}`;
}

const text = (bytes: Buffer): string => bytes.toString("utf8").trim();

/**
 * Commits the work tree (tracked changes and non-ignored untracked files up to MAX_UNTRACKED_BYTES)
 * through a temporary copy of the index, parentless, under CHECKPOINT_REF_PREFIX + pointId.
 * The person's index, HEAD, branches, stash and work tree are not touched.
 */
export async function takeSnapshot(repo: string, pointId: string): Promise<Snapshot> {
  const ref = refFor(pointId);
  const temp = await mkdtemp(join(tmpdir(), "agent-tabs-index-"));
  try {
    const indexFile = join(temp, "index");
    const realIndex = resolve(repo, text(await git(repo, ["rev-parse", "--git-path", "index"])));
    try {
      await copyFile(realIndex, indexFile);
      // Same mtime as the real index: git's racy-entry check (entry mtime >= index mtime) must see what it would see
      // there, or a same-size edit made in the second the index was written would be taken as unchanged.
      const { atime, mtime } = await stat(realIndex);
      await utimes(indexFile, atime, mtime);
    } catch {
      // No index yet (fresh repo): git starts from an empty one.
    }
    const env = { GIT_INDEX_FILE: indexFile };
    const untracked = (await git(repo, ["ls-files", "-z", "--others", "--exclude-standard"], { env }))
      .toString("utf8")
      .split("\0")
      .filter((path) => path !== "");
    const skipped: string[] = [];
    // git lists an untracked nested repository as `dir/`; it is another repo, never part of a checkpoint.
    const nested = untracked.filter((path) => path.endsWith("/"));
    for (const path of untracked) {
      if (path.endsWith("/")) continue;
      try {
        const info = await lstat(join(repo, path));
        if (info.isFile() && info.size > MAX_UNTRACKED_BYTES) skipped.push(path);
      } catch {
        // Vanished since the listing: add -A will not see it either.
      }
    }
    const excluded = [...skipped, ...nested.map((path) => path.slice(0, -1))];
    const pathspecs = [".", ...excluded.map((path) => `:(exclude,literal)${path}`)].join("\0");
    await git(repo, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: pathspecs });
    const tree = text(await git(repo, ["write-tree"], { env }));
    const commit = text(await git(repo, ["commit-tree", "--no-gpg-sign", tree, "-m", `agent-tabs checkpoint ${pointId}`]));
    await git(repo, ["update-ref", ref, commit]);
    return { commit, skipped };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function snapshotExists(repo: string, pointId: string): Promise<boolean> {
  const ref = refFor(pointId);
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function dropSnapshot(repo: string, pointId: string): Promise<void> {
  await git(repo, ["update-ref", "-d", refFor(pointId)]);
}

/** Deletes checkpoint refs whose commit is older than CHECKPOINT_MAX_AGE_MS; returns how many. */
export async function pruneSnapshots(repo: string, now: number): Promise<number> {
  const listing = (await git(repo, ["for-each-ref", "--format=%(refname)%00%(committerdate:unix)", CHECKPOINT_REF_PREFIX]))
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
  let removed = 0;
  for (const line of listing) {
    const [ref, seconds] = line.split("\0");
    if (ref === undefined || seconds === undefined) continue;
    if (Number(seconds) * 1000 >= now - CHECKPOINT_MAX_AGE_MS) continue;
    await git(repo, ["update-ref", "-d", ref]);
    removed++;
  }
  return removed;
}
