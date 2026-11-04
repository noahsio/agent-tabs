import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Environment for test git calls: no inherited GIT_* variables, a fixed identity, no signing. */
export function testGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@localhost",
    ...extra,
  };
}

const CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main"];

/** Runs git in `repo` and returns stdout as text. */
export function gitText(repo: string, ...args: string[]): string {
  return execFileSync("git", [...CONFIG, ...args], { cwd: repo, env: testGitEnv(), encoding: "utf8", maxBuffer: 1 << 28 });
}

/** Runs git in `repo` with extra environment variables. */
export function gitWith(repo: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync("git", [...CONFIG, ...args], { cwd: repo, env: testGitEnv(env), encoding: "utf8" });
}

/** A temp git repo holding `files`, committed unless `commit: false`. Returns the (non-realpath'd) temp path. */
export async function makeRepo(files: Record<string, string | Buffer>, options: { commit?: boolean } = {}): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "agent-tabs-repo-"));
  gitText(repo, "init", "-q");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  if (options.commit !== false) {
    gitText(repo, "add", "-A");
    gitText(repo, "commit", "-q", "--allow-empty", "-m", "init");
  }
  return repo;
}

const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** Hashes of everything the person owns in the repo's git state; `refs` leaves out refs/agent-tabs/. */
export function userGitState(repo: string): { index: string; head: string; stash: string; status: string; refs: string } {
  const indexPath = resolve(repo, gitText(repo, "rev-parse", "--git-path", "index").trim());
  let index = "";
  try {
    index = sha(readFileSync(indexPath));
  } catch {
    index = "absent";
  }
  let head = "";
  try {
    head = gitText(repo, "rev-parse", "HEAD").trim();
  } catch {
    head = "unborn";
  }
  const refs = gitText(repo, "for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((line) => !line.startsWith("refs/agent-tabs/"))
    .join("\n");
  return {
    index,
    head: `${head} ${gitText(repo, "symbolic-ref", "-q", "HEAD").trim()}`,
    stash: sha(gitText(repo, "stash", "list", "--format=%H")),
    status: sha(gitText(repo, "status", "--porcelain=v1", "-uall")),
    refs: sha(refs),
  };
}
