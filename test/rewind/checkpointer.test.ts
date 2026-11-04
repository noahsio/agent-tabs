import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BARRIER_DEADLINE_MS, Checkpointer, SNAPSHOT_BUDGET_MS } from "../../src/rewind/checkpointer";
import { snapshotExists, takeSnapshot } from "../../src/rewind/snapshot";
import { CheckpointStore } from "../../src/rewind/store";
import { gitText, makeRepo } from "../helpers/gitRepo";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("checkpointer", () => {
  let agentDir: string;
  let store: CheckpointStore;
  let checkpointer: Checkpointer;
  let repo: string;
  let realRepo: string;
  beforeEach(async () => {
    agentDir = mkdtempSync(join(tmpdir(), "agent-tabs-cp-"));
    store = new CheckpointStore(agentDir);
    checkpointer = new Checkpointer({ store, agentDir });
    repo = await makeRepo({ "a.txt": "a", "b.txt": "b" });
    realRepo = realpathSync(repo);
  });
  const input = (): { sessionUuid: string; repo: string; clientMessageId: string; pointId: string } => ({ sessionUuid: "s1", repo: realRepo, clientMessageId: "c1", pointId: "p1" });

  it("budget_is_below_the_barrier_deadline", () => {
    expect(BARRIER_DEADLINE_MS).toBe(35_000);
    expect(SNAPSHOT_BUDGET_MS).toBe(30_000);
  });

  it("repo_for_finds_the_physical_root_and_nothing_outside_git", async () => {
    expect(await checkpointer.repoFor(join(repo, "deep/er"))).toBe(realRepo);
    expect(await checkpointer.repoFor(mkdtempSync(join(tmpdir(), "plain-")))).toBeUndefined();
  });

  it("capture_records_a_point_when_the_snapshot_finishes_in_time", async () => {
    expect(await checkpointer.capture(input())).toBe(true);
    expect((await store.read("s1")).points.get("c1")).toMatchObject({ id: "p1", repo: realRepo, clientMessageId: "c1", skipped: [] });
    expect(await snapshotExists(realRepo, "p1")).toBe(true);
  });

  it("capture_after_the_budget_records_nothing_and_drops_the_late_ref", async () => {
    const slow = new Checkpointer({
      store,
      agentDir,
      budgetMs: 20,
      snapshot: async (target, id) => {
        await sleep(80);
        return takeSnapshot(target, id);
      },
    });
    expect(await slow.capture(input())).toBe(false);
    await sleep(400);
    expect(await snapshotExists(realRepo, "p1")).toBe(false);
    expect((await store.read("s1")).points.size).toBe(0);
  });

  it("capture_never_throws_when_git_fails", async () => {
    const failing = new Checkpointer({ store, agentDir, snapshot: async () => Promise.reject(new Error("index.lock exists")) });
    expect(await failing.capture(input())).toBe(false);
    expect((await store.read("s1")).points.size).toBe(0);
  });

  it("mark_sent_appends_and_never_throws", async () => {
    await checkpointer.markSent("s1", "c2", "followUp");
    expect((await store.read("s1")).sent.get("c2")).toBe("followUp");
    await expect(checkpointer.markSent("../bad", "c3", "steer")).resolves.toBeUndefined();
  });

  it("observe_records_the_hash_after_each_successful_edit", async () => {
    checkpointer.observe("s1", repo, { type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "a.txt" } });
    writeFileSync(join(repo, "a.txt"), "agent");
    checkpointer.observe("s1", repo, { type: "tool_execution_end", toolCallId: "t1", toolName: "write", isError: false });
    checkpointer.observe("s1", repo, { type: "tool_execution_start", toolCallId: "t2", toolName: "edit", args: { path: "b.txt" } });
    checkpointer.observe("s1", repo, { type: "tool_execution_end", toolCallId: "t2", toolName: "edit", isError: true });
    checkpointer.observe("s1", repo, { type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: { command: "touch c" } });
    checkpointer.observe("s1", repo, { type: "tool_execution_end", toolCallId: "t3", toolName: "bash", isError: false });
    await checkpointer.settled();
    const after = (await store.read("s1")).after;
    expect(after.get(join(realRepo, "a.txt"))).toBe(sha256("agent"));
    expect(after.has(join(realRepo, "b.txt"))).toBe(false);
    expect(after.size).toBe(1);
  });

  it("observe_hashes_subagent_files_at_the_end_of_task", async () => {
    const dir = join(agentDir, "projects", "proj", "senpi-task", "children", "st_1", "sessions", "st_1");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "session", id: "x", cwd: repo },
      { type: "message", id: "a", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "sub.txt" } }] } },
      { type: "message", id: "r", message: { role: "toolResult", toolCallId: "c1", toolName: "write", isError: false } },
    ];
    writeFileSync(join(dir, "2026-11-04T10-00-00-000Z_x.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    writeFileSync(join(repo, "sub.txt"), "from subagent");
    checkpointer.observe("s1", repo, { type: "tool_execution_start", toolCallId: "t9", toolName: "task", args: { prompt: "go" } });
    checkpointer.observe("s1", repo, { type: "tool_execution_end", toolCallId: "t9", toolName: "task", isError: false, result: { details: { task_id: "st_1" } } });
    await checkpointer.settled();
    expect((await store.read("s1")).after.get(join(realRepo, "sub.txt"))).toBe(sha256("from subagent"));
  });

  it("the_budget_counts_from_when_the_barrier_was_armed", async () => {
    const timed = new Checkpointer({ store, agentDir, budgetMs: 2_000 });
    expect(await timed.capture({ ...input(), startedAt: Date.now() - 1_990 })).toBe(false);
    await sleep(500);
    expect(await snapshotExists(realRepo, "p1")).toBe(false);
    expect(await timed.capture({ ...input(), pointId: "p2", startedAt: Date.now() })).toBe(true);
  });

  it("a_cwd_that_was_not_a_repo_is_asked_again", async () => {
    const plain = mkdtempSync(join(tmpdir(), "later-git-"));
    expect(await checkpointer.repoFor(plain)).toBeUndefined();
    gitText(plain, "init", "-q");
    expect(await checkpointer.repoFor(plain)).toBe(realpathSync(plain));
  });
});
