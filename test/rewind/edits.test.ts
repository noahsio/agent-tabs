import { describe, expect, it } from "vitest";
import { ancestors, editSteps, findUserEntry, patchTouches, toolTouches, type Entry } from "../../src/rewind/edits";

const user = (id: string, parentId: string | null, text: string, extra: Record<string, unknown> = {}): Entry => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: [{ type: "text", text }], ...extra },
});
const assistant = (id: string, parentId: string, calls: { id: string; name: string; arguments: unknown }[]): Entry => ({
  type: "message",
  id,
  parentId,
  message: { role: "assistant", content: calls.map((call) => ({ type: "toolCall", ...call })) },
});
const result = (id: string, parentId: string, toolCallId: string, toolName: string, extra: Record<string, unknown> = {}): Entry => ({
  type: "message",
  id,
  parentId,
  message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError: false, ...extra },
});

const ENTRIES: Entry[] = [
  { type: "model_change", id: "m0", parentId: null, provider: "p", modelId: "m" },
  user("u1", "m0", "first", { timestamp: 1793741855221 }),
  assistant("a1", "u1", []),
  user("u2", "a1", "second", { clientMessageId: "cmid-2", timestamp: 1793741855999 }),
  user("u3", "a1", "branch", { clientMessageId: "cmid-3" }),
];

describe("rewind edits", () => {
  it("ancestors_walks_parent_ids_root_first", () => {
    expect(ancestors(ENTRIES, "u2").map((entry) => entry["id"])).toEqual(["m0", "u1", "a1", "u2"]);
    expect(ancestors(ENTRIES, "u3").map((entry) => entry["id"])).toEqual(["m0", "u1", "a1", "u3"]);
    expect(ancestors(ENTRIES, "missing")).toEqual([]);
  });

  it("ancestors_stops_on_a_parent_cycle", () => {
    const looped: Entry[] = [
      { type: "x", id: "a", parentId: "b" },
      { type: "x", id: "b", parentId: "a" },
    ];
    expect(ancestors(looped, "a").map((entry) => entry["id"])).toEqual(["b", "a"]);
  });

  it("find_user_entry_by_client_message_id_then_timestamp_id", () => {
    expect(findUserEntry(ENTRIES, "cmid-2")?.["id"]).toBe("u2");
    expect(findUserEntry(ENTRIES, "u:1793741855221")?.["id"]).toBe("u1");
    expect(findUserEntry(ENTRIES, "u:1793741855999")).toBeUndefined(); // has a clientMessageId: the block id is that
    expect(findUserEntry(ENTRIES, "nope")).toBeUndefined();
  });

  it("write_and_edit_args_resolve_relative_to_cwd", () => {
    expect(toolTouches("write", { path: "dir/a b.txt", content: "x" }, "/p")).toEqual([{ path: "/p/dir/a b.txt", op: "write" }]);
    expect(toolTouches("edit", { file_path: "/abs/x.ts", edits: [] }, "/p")).toEqual([{ path: "/abs/x.ts", op: "modify" }]);
    expect(toolTouches("write", { path: "a/../b.txt" }, "/p")).toEqual([{ path: "/p/b.txt", op: "write" }]);
    expect(toolTouches("write", { content: "x" }, "/p")).toBeUndefined();
    expect(toolTouches("write", "nonsense", "/p")).toBeUndefined();
  });

  it("patch_touches_cover_add_update_delete_and_move", () => {
    const patch =
      "*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: b.txt\n*** Move to: c.txt\n@@\n-x\n+y\n*** Update File: e.txt\n@@\n-1\n+2\n*** Delete File: d.txt\n*** End Patch\n";
    expect(patchTouches(patch, "/p")).toEqual([
      { path: "/p/a.txt", op: "create" },
      { path: "/p/b.txt", op: "delete" },
      { path: "/p/c.txt", op: "create" },
      { path: "/p/e.txt", op: "modify" },
      { path: "/p/d.txt", op: "delete" },
    ]);
    expect(toolTouches("apply_patch", { input: patch }, "/p")).toHaveLength(5);
    expect(toolTouches("apply_patch", { patch }, "/p")).toHaveLength(5);
    expect(toolTouches("apply_patch", { patchText: patch }, "/p")).toHaveLength(5);
    expect(toolTouches("apply_patch", { something: 1 }, "/p")).toBeUndefined();
    expect(toolTouches("apply_patch", { input: "no headers here" }, "/p")).toBeUndefined();
  });

  it("edit_steps_after_a_message_skip_failed_calls_and_keep_task_positions", () => {
    const chain: Entry[] = [
      user("u1", null, "one", { clientMessageId: "c1" }),
      assistant("a1", "u1", [{ id: "t1", name: "write", arguments: { path: "x", content: "" } }]),
      result("r1", "a1", "t1", "write"),
      user("u2", "r1", "two", { clientMessageId: "c2" }),
      assistant("a2", "u2", [{ id: "t2", name: "edit", arguments: { path: "y", edits: [] } }]),
      result("r2", "a2", "t2", "edit", { isError: true }),
      assistant("a3", "r2", [{ id: "t3", name: "task", arguments: { prompt: "go" } }]),
      result("r3", "a3", "t3", "task", { details: { task_id: "st_1", status: "completed" } }),
      assistant("a4", "r3", [
        { id: "t4", name: "write", arguments: { path: "z", content: "" } },
        { id: "t5", name: "bash", arguments: { command: "rm -rf x" } },
        { id: "t6", name: "task", arguments: { prompt: "no id" } },
        { id: "t7", name: "apply_patch", arguments: { foo: 1 } },
      ]),
      result("r4", "a4", "t4", "write"),
      result("r6", "r4", "t6", "task", { details: {} }),
    ];
    expect(editSteps(chain, 3, "/p")).toEqual([
      { kind: "task", taskId: "st_1" },
      { kind: "touch", touches: [{ path: "/p/z", op: "write" }] },
      { kind: "unknown", tool: "apply_patch" },
    ]);
    expect(editSteps(chain, -1, "/p")[0]).toEqual({ kind: "touch", touches: [{ path: "/p/x", op: "write" }] });
  });
});
