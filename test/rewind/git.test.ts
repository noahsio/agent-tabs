import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git, GitError, gitEnv, physicalPath, REPO_ROOT_TIMEOUT_MS, repoRoot } from "../../src/rewind/git";
import { makeRepo } from "../helpers/gitRepo";

describe("rewind git", () => {
  it("git_env_drops_inherited_git_variables", () => {
    const env = gitEnv({ GIT_DIR: "/x", GIT_INDEX_FILE: "/y", PATH: "/bin" });
    expect(env["GIT_DIR"]).toBeUndefined();
    expect(env["GIT_INDEX_FILE"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin");
    expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    expect(env["GIT_AUTHOR_NAME"]).toBe("agent-tabs");
    expect(env["GIT_COMMITTER_EMAIL"]).toBe("agent-tabs@localhost");
    expect(gitEnv({}, { GIT_INDEX_FILE: "/tmp/i" })["GIT_INDEX_FILE"]).toBe("/tmp/i");
  });

  it("repo_root_is_physical_and_undefined_outside_git", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const link = join(tmpdir(), `link-${randomUUID()}`);
    await symlink(repo, link);
    expect(await repoRoot(join(link, "missing/dir"))).toBe(realpathSync(repo));
    expect(await repoRoot(join(repo, "a.txt"))).toBe(realpathSync(repo));
    expect(await repoRoot(mkdtempSync(join(tmpdir(), "plain-")))).toBeUndefined();
  });

  it("physical_path_resolves_the_existing_part_and_keeps_the_rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phys-"));
    mkdirSync(join(dir, "real"));
    const link = join(dir, "link");
    await symlink(join(dir, "real"), link);
    expect(await physicalPath(join(link, "a/b.txt"))).toBe(join(realpathSync(dir), "real/a/b.txt"));
    expect(await physicalPath(link)).toBe(join(realpathSync(dir), "real"));
  });

  it("git_failure_rejects_with_stderr", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    await expect(git(repo, ["rev-parse", "--verify", "no-such-ref"])).rejects.toBeInstanceOf(GitError);
    await expect(git(repo, ["cat-file", "-p", "deadbeef"])).rejects.toThrow(/deadbeef|Not a valid/);
  });

  it("a_hung_git_is_killed_after_its_timeout_and_repo_root_gives_up", async () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-git-"));
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path ?? ""}`;
    try {
      const started = Date.now();
      await expect(git(bin, ["status"], { timeoutMs: 200 })).rejects.toBeInstanceOf(GitError);
      expect(Date.now() - started).toBeLessThan(5_000);
      const rootStarted = Date.now();
      expect(await repoRoot(bin)).toBeUndefined();
      expect(Date.now() - rootStarted).toBeLessThan(REPO_ROOT_TIMEOUT_MS + 2_000);
    } finally {
      process.env["PATH"] = path;
    }
  }, 15_000);
});
