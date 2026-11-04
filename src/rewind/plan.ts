import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FileOp, FileTouch } from "./edits";
import { git, physicalFile, physicalPath, repoRoot } from "./git";
import type { CheckpointPoint } from "./store";

export type RewindAction = "restore" | "delete" | "skip";
export type ChangedMark = "yes" | "no" | "unknown";

/** `path` is repo-relative with `/`, or absolute when outside the repo; `changed` is "no" for skips. */
export type RewindItem = { path: string; action: RewindAction; reason?: string; changed: ChangedMark };
/** `absolute` is the file as it is on disk now; `current` its hash when planned. */
export type PlannedFile = { item: RewindItem; absolute: string; current: string | null; mode?: string; blob?: string };
export type RewindPlan = { repo: string; commit: string; items: RewindItem[]; files: PlannedFile[]; fingerprint: string };

export const SKIP = {
  tooBig: "не откатить: файл больше 5 МБ",
  outside: "не откатить: вне проекта",
  ignored: "не откатить: файл игнорируется git",
  otherRepo: "не откатить: другой репозиторий",
  notCreated: "не откатить: создан не агентом",
  unknown: "не откатить: не удалось определить файл",
} as const;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** sha256 hex of the file's bytes (a symlink: of its target text); `null` when nothing is there. */
export async function fileHash(absolute: string): Promise<string | null> {
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return sha256(await readlink(absolute));
    if (info.isDirectory()) return sha256("\0directory");
    return sha256(await readFile(absolute));
  } catch {
    return null;
  }
}

type TreeEntry = { mode: string; type: string; object: string; path: string };

function parseTree(out: string): TreeEntry[] {
  return out.split("\0").flatMap((record) => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(record);
    return match ? [{ mode: match[1] as string, type: match[2] as string, object: match[3] as string, path: match[4] as string }] : [];
  });
}

const foldName = (name: string): string => name.normalize("NFC").toLowerCase();

/**
 * The snapshot's entry for `rel`. On a case-insensitive file system (git's core.ignorecase) a name that differs only
 * by case matches too, so the snapshot's own spelling is what gets restored.
 */
async function treeEntry(repo: string, commit: string, rel: string, ignoreCase: boolean): Promise<TreeEntry | undefined> {
  const exact = parseTree((await git(repo, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", rel])).toString("utf8")).find((entry) => entry.path === rel);
  if (exact !== undefined || !ignoreCase) return exact;
  const slash = rel.lastIndexOf("/");
  const dir = slash < 0 ? "" : rel.slice(0, slash + 1);
  const siblings = parseTree((await git(repo, ["--literal-pathspecs", "ls-tree", "-z", commit, ...(dir === "" ? [] : ["--", dir])])).toString("utf8"));
  const matches = siblings.filter((entry) => foldName(entry.path) === foldName(rel));
  return matches.length === 1 ? matches[0] : undefined;
}

async function isIgnored(repo: string, rel: string): Promise<boolean> {
  try {
    await git(repo, ["check-ignore", "-q", "--", rel]);
    return true;
  } catch {
    return false;
  }
}

async function ignoresCase(repo: string): Promise<boolean> {
  try {
    return (await git(repo, ["config", "--bool", "core.ignorecase"])).toString("utf8").trim() === "true";
  } catch {
    return false;
  }
}

function isOutside(rel: string): boolean {
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Classifies every file the agent touched since the point (first matching rule wins): outside the
 * repo, in another repo, ignored, too big for the snapshot, in the snapshot (restore), first touched
 * by a create (delete), otherwise created by someone else. The fingerprint covers the items and the
 * current bytes of every file the plan would change, so a confirmed plan can be told from a later one.
 */
export async function planRewind(input: {
  repo: string;
  point: CheckpointPoint;
  touches: FileTouch[];
  unknownTools: string[];
  after: ReadonlyMap<string, string | null>;
}): Promise<RewindPlan> {
  const repo = await physicalPath(input.repo);
  const ignoreCase = await ignoresCase(repo);
  const firstOps = new Map<string, FileOp>();
  for (const touch of input.touches) {
    const path = await physicalFile(touch.path);
    if (!firstOps.has(path)) firstOps.set(path, touch.op);
  }
  const files: PlannedFile[] = [];
  const skip = (path: string, reason: string): void => {
    files.push({ item: { path, action: "skip", reason, changed: "no" }, absolute: path, current: null });
  };
  for (const [absolute, firstOp] of firstOps) {
    const rel = relative(repo, absolute);
    if (isOutside(rel)) {
      skip(absolute, SKIP.outside);
      continue;
    }
    const onDisk = rel.split(sep).join("/");
    const entry = await treeEntry(repo, input.point.commit, onDisk, ignoreCase);
    if ((await repoRoot(dirname(absolute))) !== repo || entry?.mode === "160000") {
      skip(onDisk, SKIP.otherRepo);
      continue;
    }
    if (await isIgnored(repo, onDisk)) {
      skip(onDisk, SKIP.ignored);
      continue;
    }
    if (input.point.skipped.includes(onDisk)) {
      skip(onDisk, SKIP.tooBig);
      continue;
    }
    const current = await fileHash(absolute);
    const recorded = input.after.get(absolute);
    const changed: ChangedMark = recorded === undefined ? "unknown" : recorded === current ? "no" : "yes";
    if (entry !== undefined && entry.type === "blob") {
      files.push({ item: { path: entry.path, action: "restore", changed }, absolute, current, mode: entry.mode, blob: entry.object });
    } else if (firstOp === "write" || firstOp === "create") {
      files.push({ item: { path: onDisk, action: "delete", changed }, absolute, current });
    } else skip(onDisk, SKIP.notCreated);
  }
  for (const tool of input.unknownTools) skip(tool, SKIP.unknown);
  const fingerprint = sha256(JSON.stringify(files.map(({ item, current }) => [item.path, item.action, item.reason ?? "", item.changed, current])));
  return { repo, commit: input.point.commit, items: files.map((file) => file.item), files, fingerprint };
}

/** Restored permissions: the file's own when it is there (only the executable bits follow the snapshot), else the default. */
function restoredMode(existing: Stats | undefined, executable: boolean): { mode: number; keep: boolean } {
  if (existing === undefined || !existing.isFile()) return { mode: executable ? 0o755 : 0o644, keep: false };
  const mode = existing.mode & 0o7777;
  const hasExec = (mode & 0o111) !== 0;
  if (executable && !hasExec) return { mode: mode | ((mode & 0o444) >> 2), keep: true };
  if (!executable && hasExec) return { mode: mode & ~0o111, keep: true };
  return { mode, keep: true };
}

async function existing(absolute: string): Promise<Stats | undefined> {
  try {
    return await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Puts the snapshot's bytes at the item's path: read first (through git's filters, so eol/LFS/crypt attributes apply),
 * then written to a temporary file next to it and renamed over whatever is there (never written through a symlink).
 */
async function restore(repo: string, file: PlannedFile): Promise<string> {
  const target = join(repo, file.item.path);
  const symbolic = file.mode === "120000";
  const bytes = await git(repo, symbolic ? ["cat-file", "blob", file.blob as string] : ["cat-file", "--filters", `--path=${file.item.path}`, file.blob as string]);
  const now = await existing(file.absolute);
  if (now?.isDirectory() === true) throw new Error("на этом месте теперь папка");
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.agent-tabs-${randomUUID()}.tmp`);
  try {
    if (symbolic) await symlink(bytes.toString("utf8"), temp);
    else {
      const { mode, keep } = restoredMode(now, file.mode === "100755");
      await writeFile(temp, bytes, { flag: "wx", mode });
      if (keep) await chmod(temp, mode);
    }
    // Over the name on disk first (atomic replace), then a case-only rename to the snapshot's spelling: never a moment without the file.
    await rename(temp, now !== undefined ? file.absolute : target);
    if (now !== undefined && file.absolute !== target) await rename(file.absolute, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return target;
}

async function remove(absolute: string): Promise<void> {
  const now = await existing(absolute);
  if (now === undefined) return;
  if (now.isDirectory()) throw new Error("на этом месте теперь папка");
  await unlink(absolute);
}

/**
 * Restores and deletes the planned files; never touches the index, HEAD or refs. Every file is attempted: `done` and
 * `after` (the new hashes) cover the ones that went through, `failures` the rest.
 */
export async function applyRewind(plan: RewindPlan): Promise<{
  count: number;
  done: string[];
  after: { path: string; hash: string | null }[];
  failures: { path: string; reason: string }[];
}> {
  const done: string[] = [];
  const after: { path: string; hash: string | null }[] = [];
  const failures: { path: string; reason: string }[] = [];
  for (const file of plan.files) {
    if (file.item.action === "skip") continue;
    try {
      let path = file.absolute;
      if (file.item.action === "restore") path = await restore(plan.repo, file);
      else await remove(file.absolute);
      done.push(file.item.path);
      after.push({ path, hash: await fileHash(path) });
    } catch (error) {
      failures.push({ path: file.item.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { count: done.length, done, after, failures };
}
