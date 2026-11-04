import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileOp, FileTouch } from "../../src/rewind/edits";
import { toolTouches } from "../../src/rewind/edits";
import { applyRewind, fileHash, planRewind } from "../../src/rewind/plan";
import { takeSnapshot } from "../../src/rewind/snapshot";
import type { CheckpointPoint } from "../../src/rewind/store";
import { gitText, makeRepo, userGitState } from "../helpers/gitRepo";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function pointFor(repo: string, extraSkipped: string[] = []): Promise<CheckpointPoint> {
  const pointId = randomUUID();
  const { commit, skipped } = await takeSnapshot(repo, pointId);
  return { id: pointId, clientMessageId: "c1", repo: realpathSync(repo), commit, skipped: [...skipped, ...extraSkipped], at: Date.now() };
}

describe("rewind plan", () => {
  const touch = (repo: string, path: string, op: FileOp): FileTouch => ({ path: join(repo, path), op });

  it("restores_modified_files_and_deletes_files_the_agent_created", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const point = await pointFor(repo);
    writeFileSync(join(repo, "a.txt"), "agent");
    writeFileSync(join(repo, "new.txt"), "n");
    const plan = await planRewind({ repo, point, touches: [touch(repo, "a.txt", "modify"), touch(repo, "new.txt", "write"), touch(repo, "a.txt", "write")], unknownTools: [], after: new Map() });
    expect(plan.items).toEqual([
      { path: "a.txt", action: "restore", changed: "unknown" },
      { path: "new.txt", action: "delete", changed: "unknown" },
    ]);
    expect(await applyRewind(plan)).toMatchObject({ count: 2 });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  });

  it("file_existing_before_with_write_as_first_action_is_restored_not_deleted", async () => {
    const repo = await makeRepo({ "old.txt": "before" });
    const point = await pointFor(repo);
    writeFileSync(join(repo, "old.txt"), "agent");
    const plan = await planRewind({ repo, point, touches: [touch(repo, "old.txt", "write")], unknownTools: [], after: new Map() });
    expect(plan.items).toEqual([{ path: "old.txt", action: "restore", changed: "unknown" }]);
  });

  it("untracked_file_in_the_snapshot_is_restored", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    writeFileSync(join(repo, "draft.txt"), "mine");
    const point = await pointFor(repo);
    writeFileSync(join(repo, "draft.txt"), "agent");
    const plan = await planRewind({ repo, point, touches: [touch(repo, "draft.txt", "modify")], unknownTools: [], after: new Map() });
    await applyRewind(plan);
    expect(readFileSync(join(repo, "draft.txt"), "utf8")).toBe("mine");
  });

  it("file_created_by_someone_else_is_skipped", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const point = await pointFor(repo);
    writeFileSync(join(repo, "other.txt"), "person");
    const plan = await planRewind({ repo, point, touches: [touch(repo, "other.txt", "modify"), touch(repo, "other.txt", "write")], unknownTools: [], after: new Map() });
    expect(plan.items).toEqual([{ path: "other.txt", action: "skip", reason: "не откатить: создан не агентом", changed: "no" }]);
  });

  it("outside_ignored_nested_and_oversized_files_are_skipped_with_reasons", async () => {
    const repo = await makeRepo({ ".gitignore": "dist/\n", "a.txt": "a" });
    mkdirSync(join(repo, "sub"));
    gitText(join(repo, "sub"), "init", "-q");
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    const point = await pointFor(repo, ["big.bin"]);
    const plan = await planRewind({
      repo,
      point,
      touches: [
        { path: join(elsewhere, "x"), op: "write" },
        touch(repo, "dist/x", "write"),
        touch(repo, "sub/x", "write"),
        touch(repo, "big.bin", "modify"),
      ],
      unknownTools: ["apply_patch"],
      after: new Map(),
    });
    expect(plan.items.map((item) => item.reason)).toEqual([
      "не откатить: вне проекта",
      "не откатить: файл игнорируется git",
      "не откатить: другой репозиторий",
      "не откатить: файл больше 5 МБ",
      "не откатить: не удалось определить файл",
    ]);
    expect(plan.items[0]?.path).toBe(join(realpathSync(elsewhere), "x"));
    expect(plan.items[4]).toEqual({ path: "apply_patch", action: "skip", reason: "не откатить: не удалось определить файл", changed: "no" });
    expect(plan.items.every((item) => item.action === "skip" && item.changed === "no")).toBe(true);
    expect(await applyRewind(plan)).toEqual({ count: 0, done: [], after: [], failures: [] });
  });

  it("changed_mark_compares_with_the_hash_after_the_agent", async () => {
    const repo = await makeRepo({ "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    const real = realpathSync(repo);
    const point = await pointFor(repo);
    writeFileSync(join(repo, "a.txt"), "agent");
    writeFileSync(join(repo, "b.txt"), "user");
    const after = new Map<string, string | null>([
      [join(real, "a.txt"), sha256("agent")],
      [join(real, "b.txt"), sha256("agent")],
    ]);
    const plan = await planRewind({ repo, point, touches: ["a.txt", "b.txt", "c.txt"].map((path) => touch(repo, path, "modify")), unknownTools: [], after });
    expect(plan.items.map((item) => item.changed)).toEqual(["no", "yes", "unknown"]);
  });

  it("agent_created_file_edited_later_is_deleted_with_changed_mark", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const point = await pointFor(repo);
    writeFileSync(join(repo, "new.txt"), "v1");
    const after = new Map<string, string | null>([[join(realpathSync(repo), "new.txt"), sha256("v1")]]);
    writeFileSync(join(repo, "new.txt"), "v2");
    const plan = await planRewind({ repo, point, touches: [touch(repo, "new.txt", "write")], unknownTools: [], after });
    expect(plan.items).toEqual([{ path: "new.txt", action: "delete", changed: "yes" }]);
  });

  it("paths_through_a_symlinked_cwd_count_as_inside_the_repo", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const link = join(tmpdir(), `link-${randomUUID()}`);
    symlinkSync(repo, link);
    const point = await pointFor(repo);
    writeFileSync(join(repo, "a.txt"), "agent");
    const touches = toolTouches("edit", { path: "dir with space/../a.txt" }, link) as FileTouch[];
    const plan = await planRewind({ repo: link, point, touches, unknownTools: [], after: new Map() });
    expect(plan.items[0]).toEqual({ path: "a.txt", action: "restore", changed: "unknown" });
    await applyRewind(plan);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a");
  });

  it("apply_restores_bytes_mode_and_symlinks_and_reports_new_hashes", async () => {
    const repo = await makeRepo({ "run.sh": "#!/bin/sh\necho hi\n", "target.txt": "t" });
    chmodSync(join(repo, "run.sh"), 0o755);
    symlinkSync("target.txt", join(repo, "link"));
    gitText(repo, "add", "-A");
    gitText(repo, "commit", "-q", "-m", "exec and link");
    const point = await pointFor(repo);
    unlinkSync(join(repo, "run.sh"));
    unlinkSync(join(repo, "link"));
    writeFileSync(join(repo, "link"), "agent replaced the link with a file");
    const plan = await planRewind({ repo, point, touches: [touch(repo, "run.sh", "delete"), touch(repo, "link", "write")], unknownTools: [], after: new Map() });
    expect(plan.items.map((item) => item.action)).toEqual(["restore", "restore"]);
    const result = await applyRewind(plan);
    expect(result.count).toBe(2);
    expect(readFileSync(join(repo, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(statSync(join(repo, "run.sh")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(repo, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(repo, "link"))).toBe("target.txt");
    const real = realpathSync(repo);
    for (const { path, hash } of result.after) expect(hash).toBe(await fileHash(path));
    expect(result.after.map((entry) => entry.path)).toEqual([join(real, "run.sh"), join(real, "link")]);
    expect(await fileHash(join(real, "link"))).toBe(sha256("target.txt"));
    expect(await fileHash(join(real, "missing"))).toBeNull();
  });

  it("apply_writes_through_no_symlink_the_agent_left_in_place", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const point = await pointFor(repo);
    const victim = join(mkdtempSync(join(tmpdir(), "victim-")), "v.txt");
    writeFileSync(victim, "keep");
    rmSync(join(repo, "a.txt"));
    symlinkSync(victim, join(repo, "a.txt"));
    const plan = await planRewind({ repo, point, touches: [touch(repo, "a.txt", "modify")], unknownTools: [], after: new Map() });
    await applyRewind(plan);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(lstatSync(join(repo, "a.txt")).isFile()).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a");
  });

  it("apply_leaves_index_and_head_alone", async () => {
    const repo = await makeRepo({ "a.txt": "a\n", "b.txt": "b\n" });
    writeFileSync(join(repo, "b.txt"), "staged\n");
    gitText(repo, "add", "b.txt");
    const point = await pointFor(repo);
    writeFileSync(join(repo, "a.txt"), "agent\n");
    writeFileSync(join(repo, "new.txt"), "n\n");
    const before = userGitState(repo);
    const plan = await planRewind({ repo, point, touches: [touch(repo, "a.txt", "modify"), touch(repo, "new.txt", "write")], unknownTools: [], after: new Map() });
    await applyRewind(plan);
    const { status: _statusAfter, ...rest } = userGitState(repo);
    const { status: _statusBefore, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(gitText(repo, "status", "--porcelain").trim()).toBe("M  b.txt");
  });

  describe("review fixes", () => {
    const caseInsensitive = (dir: string): boolean => existsSync(join(dir, ".GIT"));

    it("an_agent_write_to_a_differently_cased_name_restores_the_tracked_file_and_deletes_nothing", async () => {
      const repo = await makeRepo({ "foo.txt": "before" });
      if (!caseInsensitive(repo)) return; // only meaningful on a case-insensitive file system (macOS default APFS)
      const point = await pointFor(repo);
      writeFileSync(join(repo, "Foo.txt"), "agent"); // lands in foo.txt
      const plan = await planRewind({ repo, point, touches: [touch(repo, "Foo.txt", "write")], unknownTools: [], after: new Map() });
      expect(plan.items).toEqual([{ path: "foo.txt", action: "restore", changed: "unknown" }]);
      await applyRewind(plan);
      expect(readdirSync(repo).filter((name) => name !== ".git")).toEqual(["foo.txt"]);
      expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("before");
    });

    it("a_case_renamed_file_matches_its_snapshot_path_and_is_restored_under_it", async () => {
      const repo = await makeRepo({ "foo.txt": "before" });
      if (!caseInsensitive(repo)) return;
      const point = await pointFor(repo);
      renameSync(join(repo, "foo.txt"), join(repo, "FOO.txt"));
      writeFileSync(join(repo, "FOO.txt"), "agent");
      const plan = await planRewind({ repo, point, touches: [touch(repo, "FOO.txt", "write")], unknownTools: [], after: new Map() });
      expect(plan.items).toEqual([{ path: "foo.txt", action: "restore", changed: "unknown" }]);
      await applyRewind(plan);
      expect(readdirSync(repo).filter((name) => name !== ".git")).toEqual(["foo.txt"]);
      expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("before");
    });

    it("restore_goes_through_git_filters", async () => {
      const repo = await makeRepo({ ".gitattributes": "*.txt eol=crlf\n", "a.txt": "a\r\nb\r\n" });
      const point = await pointFor(repo);
      writeFileSync(join(repo, "a.txt"), "agent\r\n");
      const plan = await planRewind({ repo, point, touches: [touch(repo, "a.txt", "modify")], unknownTools: [], after: new Map() });
      await applyRewind(plan);
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\r\nb\r\n");
    });

    it("an_unreadable_snapshot_blob_leaves_the_current_file_in_place", async () => {
      const repo = await makeRepo({ "a.txt": "a" });
      const point = await pointFor(repo);
      writeFileSync(join(repo, "a.txt"), "agent");
      const plan = await planRewind({ repo, point, touches: [touch(repo, "a.txt", "modify")], unknownTools: [], after: new Map() });
      const broken = { ...plan, files: plan.files.map((file) => ({ ...file, blob: "0".repeat(40) })) };
      const result = await applyRewind(broken);
      expect(result.failures).toHaveLength(1);
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("agent");
    });

    it("restore_keeps_the_files_own_permissions", async () => {
      const repo = await makeRepo({ "secret.txt": "s" });
      chmodSync(join(repo, "secret.txt"), 0o600);
      const point = await pointFor(repo);
      writeFileSync(join(repo, "secret.txt"), "agent");
      const plan = await planRewind({ repo, point, touches: [touch(repo, "secret.txt", "modify")], unknownTools: [], after: new Map() });
      await applyRewind(plan);
      expect(statSync(join(repo, "secret.txt")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(repo, "secret.txt"), "utf8")).toBe("s");
    });

    it("a_partial_failure_reports_what_was_done_and_its_hashes", async () => {
      const repo = await makeRepo({ "a.txt": "a" });
      const point = await pointFor(repo);
      writeFileSync(join(repo, "a.txt"), "agent");
      mkdirSync(join(repo, "ro"));
      writeFileSync(join(repo, "ro/new.txt"), "n");
      chmodSync(join(repo, "ro"), 0o555);
      try {
        const plan = await planRewind({ repo, point, touches: [touch(repo, "a.txt", "modify"), touch(repo, "ro/new.txt", "write")], unknownTools: [], after: new Map() });
        const result = await applyRewind(plan);
        expect(result.count).toBe(1);
        expect(result.done).toEqual(["a.txt"]);
        expect(result.failures.map((failure) => failure.path)).toEqual(["ro/new.txt"]);
        expect(result.after).toEqual([{ path: join(realpathSync(repo), "a.txt"), hash: sha256("a") }]);
      } finally {
        chmodSync(join(repo, "ro"), 0o755);
      }
    });

    it("a_name_starting_with_two_dots_at_the_root_is_inside_the_project", async () => {
      const repo = await makeRepo({ "a.txt": "a" });
      const point = await pointFor(repo);
      writeFileSync(join(repo, "..foo"), "agent");
      const plan = await planRewind({ repo, point, touches: [touch(repo, "..foo", "write")], unknownTools: [], after: new Map() });
      expect(plan.items).toEqual([{ path: "..foo", action: "delete", changed: "unknown" }]);
    });

    it("the_fingerprint_changes_when_a_file_or_the_list_changes", async () => {
      const repo = await makeRepo({ "a.txt": "a" });
      const point = await pointFor(repo);
      writeFileSync(join(repo, "a.txt"), "agent");
      const input = { repo, point, touches: [touch(repo, "a.txt", "modify")], unknownTools: [], after: new Map<string, string | null>() };
      const first = (await planRewind(input)).fingerprint;
      expect((await planRewind(input)).fingerprint).toBe(first);
      writeFileSync(join(repo, "a.txt"), "person");
      const edited = (await planRewind(input)).fingerprint;
      expect(edited).not.toBe(first);
      writeFileSync(join(repo, "b.txt"), "b");
      expect((await planRewind({ ...input, touches: [...input.touches, touch(repo, "b.txt", "write")] })).fingerprint).not.toBe(edited);
    });
  });
});
