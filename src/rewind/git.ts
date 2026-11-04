import { execFile } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const IDENTITY = { name: "agent-tabs", email: "agent-tabs@localhost" };
/** A git that hangs (network disk, a stuck credential helper) is killed after this long. */
const GIT_TIMEOUT_MS = 120_000;
/** Finding the repo is on the path of every prompt: it must never hold a message up for long. */
export const REPO_ROOT_TIMEOUT_MS = 5_000;

/** A git command that exited non-zero; `message` is its trimmed stderr. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** `base` without inherited GIT_* variables, plus optional-locks off, a fixed identity, then `extra`. */
export function gitEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!/^GIT_/.test(key)) env[key] = value;
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    ...extra,
  };
}

/** Runs git in `cwd` with a clean environment and auto-maintenance off; resolves stdout bytes. */
export function git(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string | Buffer; timeoutMs?: number } = {},
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
      { cwd, env: gitEnv(process.env, options.env), encoding: "buffer", maxBuffer: 1 << 30, timeout: options.timeoutMs ?? GIT_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (error) {
          const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : "";
          reject(new GitError(text || error.message));
          return;
        }
        resolvePromise(stdout);
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

/** The nearest ancestor of `path` (itself included) that exists, with the part below it. */
async function existingAncestor(path: string): Promise<{ existing: string; rest: string; isDir: boolean }> {
  let current = resolve(path);
  for (;;) {
    try {
      const info = await stat(current);
      return { existing: current, rest: relative(current, resolve(path)), isDir: info.isDirectory() };
    } catch {
      const parent = dirname(current);
      if (parent === current) return { existing: current, rest: relative(current, resolve(path)), isDir: true };
      current = parent;
    }
  }
}

/** Realpath of the nearest existing ancestor of `path`, joined with the part that does not exist yet. */
export async function physicalPath(path: string): Promise<string> {
  const { existing, rest } = await existingAncestor(path);
  const real = await realpath(existing);
  return rest === "" ? real : join(real, rest);
}

const foldName = (name: string): string => name.normalize("NFC").toLowerCase();

/**
 * Physical path of a file without following the file itself when it is a symlink (it is the tracked thing). On a
 * case-insensitive file system the name is the one on disk (`Foo.txt` written over `foo.txt` is `foo.txt`).
 */
export async function physicalFile(path: string): Promise<string> {
  const parent = await physicalPath(dirname(path));
  const name = basename(path);
  try {
    await lstat(join(parent, name));
    const names = await readdir(parent);
    if (!names.includes(name)) {
      const onDisk = names.filter((candidate) => foldName(candidate) === foldName(name));
      if (onDisk.length === 1) return join(parent, onDisk[0] as string);
    }
  } catch {
    // absent (or unreadable): the name as given
  }
  return join(parent, name);
}

/** Top level of the git work tree holding `dir` (or its nearest existing ancestor); `undefined` outside git. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  const { existing, isDir } = await existingAncestor(dir);
  const from = isDir ? existing : dirname(existing);
  try {
    const top = (await git(from, ["rev-parse", "--show-toplevel"], { timeoutMs: REPO_ROOT_TIMEOUT_MS })).toString("utf8").trim();
    return top === "" ? undefined : await realpath(top);
  } catch {
    return undefined;
  }
}
