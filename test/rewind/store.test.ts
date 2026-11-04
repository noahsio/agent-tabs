import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, type CheckpointPoint, type CheckpointRecord } from "../../src/rewind/store";

function pointFields(clientMessageId: string, repo = "/r"): CheckpointPoint {
  return { id: `p-${clientMessageId}`, clientMessageId, repo, commit: "abc", skipped: [], at: 1 };
}
const point = (clientMessageId: string, repo?: string): CheckpointRecord => ({ type: "point", ...pointFields(clientMessageId, repo) });
const after = (path: string, hash: string | null): CheckpointRecord => ({ type: "after", path, hash, at: 2 });

describe("checkpoint store", () => {
  let agentDir: string;
  let store: CheckpointStore;
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "agent-tabs-store-"));
    store = new CheckpointStore(agentDir);
  });

  it("append_then_read_folds_points_sent_and_latest_after_hash", async () => {
    await store.append("s1", [point("c1"), { type: "sent", clientMessageId: "c2", mode: "steer" }, after("/r/a", "h1"), after("/r/a", null)]);
    const log = await store.read("s1");
    expect(log.points.get("c1")?.commit).toBe("abc");
    expect(log.points.get("c1")).toEqual(pointFields("c1"));
    expect(log.sent.get("c2")).toBe("steer");
    expect(log.after.get("/r/a")).toBeNull();
    expect(store.file("s1")).toBe(join(agentDir, "agent-tabs", "checkpoints", "s1.jsonl"));
  });

  it("missing_log_reads_empty", async () => {
    const log = await store.read("nothing");
    expect([log.points.size, log.sent.size, log.after.size]).toEqual([0, 0, 0]);
  });

  it("malformed_and_torn_lines_are_skipped", async () => {
    await store.append("s0", []);
    writeFileSync(
      store.file("s1"),
      `${JSON.stringify({ type: "point", ...pointFields("c1") })}\nnot json\n${JSON.stringify({ type: "point", id: "x" })}\n${JSON.stringify({ type: "sent", clientMessageId: "c9", mode: "bogus" })}\n{"type":"point","id":`,
    );
    const log = await store.read("s1");
    expect([...log.points.keys()]).toEqual(["c1"]);
    expect(log.sent.size).toBe(0);
  });

  it("two_writers_interleave_without_losing_records", async () => {
    const other = new CheckpointStore(agentDir);
    await Promise.all(Array.from({ length: 50 }, (_, index) => (index % 2 ? store : other).append("s1", [after(`/r/${index}`, "h")])));
    expect((await store.read("s1")).after.size).toBe(50);
  });

  it("session_uuid_with_path_characters_is_refused", async () => {
    await expect(store.append("../x", [])).rejects.toThrow();
    await expect(store.read("a/b")).rejects.toThrow();
  });

  it("files_are_private", async () => {
    await store.append("s1", [point("c1")]);
    expect(statSync(dirname(store.file("s1"))).mode & 0o777).toBe(0o700);
    expect(statSync(store.file("s1")).mode & 0o777).toBe(0o600);
  });

  it("fork_copy_takes_points_and_sent_marks_of_the_chain_and_every_after_hash", async () => {
    await store.append("s1", [point("c1"), point("c2"), { type: "sent", clientMessageId: "c3", mode: "steer" }, after("/r/a", "h")]);
    await store.copyForFork("s1", "s2", new Set(["c1", "c3"]));
    const log = await store.read("s2");
    expect([...log.points.keys()]).toEqual(["c1"]);
    expect(log.sent.get("c3")).toBe("steer");
    expect(log.after.get("/r/a")).toBe("h");
  });

  it("repos_lists_every_repo_named_by_a_point", async () => {
    await store.append("s1", [point("c1", "/r2"), point("c2", "/r1")]);
    await store.append("s2", [point("c3", "/r2"), after("/r3/x", "h")]);
    expect(await store.repos()).toEqual(["/r1", "/r2"]);
    expect(await new CheckpointStore(mkdtempSync(join(tmpdir(), "agent-tabs-empty-"))).repos()).toEqual([]);
  });
});
