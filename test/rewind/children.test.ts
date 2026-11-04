import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { agentTouches, childSessionFiles } from "../../src/rewind/children";
import type { Entry } from "../../src/rewind/edits";

type Call = { id: string; name: string; arguments: unknown; result?: Record<string, unknown> };

/** Assistant entries with one tool call each, followed by a successful result. */
function turn(calls: Call[]): Entry[] {
  return calls.flatMap((call) => [
    { type: "message", id: `a-${call.id}`, message: { role: "assistant", content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments }] } },
    { type: "message", id: `r-${call.id}`, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, ...(call.result ?? {}) } },
  ]);
}

function writeChild(agentDir: string, taskId: string, cwd: string, entries: Entry[]): string {
  const dir = join(agentDir, "projects", "proj-x", "senpi-task", "children", taskId, "sessions", taskId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-11-04T10-00-00-000Z_0b9a.jsonl");
  const header = { type: "session", version: 3, id: "0b9a", timestamp: "2026-11-04T10:00:00.000Z", cwd };
  writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n{torn");
  return file;
}

describe("rewind children", () => {
  let agentDir: string;
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "agent-tabs-children-"));
  });

  it("child_touches_come_from_the_task_session_file", async () => {
    const file = writeChild(agentDir, "st_1", "/p", turn([
      { id: "c1", name: "write", arguments: { path: "sub.txt", content: "x" } },
      { id: "c2", name: "edit", arguments: { path: "sub.txt", edits: [] } },
    ]));
    expect(await childSessionFiles(agentDir, "st_1")).toEqual([file]);
    expect(await childSessionFiles(agentDir, "st_none")).toEqual([]);
    await expect(childSessionFiles(agentDir, "../x")).rejects.toThrow();
    const chain = turn([{ id: "m1", name: "task", arguments: {}, result: { details: { task_id: "st_1" } } }]);
    expect(await agentTouches({ agentDir, chain, fromIndex: -1, cwd: "/main" })).toEqual({
      touches: [
        { path: "/p/sub.txt", op: "write" },
        { path: "/p/sub.txt", op: "modify" },
      ],
      unknownTools: [],
    });
  });

  it("agent_touches_expand_tasks_in_place", async () => {
    writeChild(agentDir, "st_1", "/p", turn([{ id: "c1", name: "write", arguments: { path: "b", content: "" } }]));
    const chain = turn([
      { id: "m1", name: "write", arguments: { path: "a", content: "" } },
      { id: "m2", name: "task", arguments: {}, result: { details: { task_id: "st_1" } } },
      { id: "m3", name: "write", arguments: { path: "c", content: "" } },
    ]);
    const { touches } = await agentTouches({ agentDir, chain, fromIndex: -1, cwd: "/p" });
    expect(touches.map((touch) => touch.path)).toEqual(["/p/a", "/p/b", "/p/c"]);
  });

  it("nested_tasks_expand_recursively", async () => {
    writeChild(agentDir, "st_2", "/p", turn([{ id: "c2", name: "write", arguments: { path: "deep", content: "" } }]));
    writeChild(agentDir, "st_1", "/p", turn([{ id: "c1", name: "task", arguments: {}, result: { details: { task_id: "st_2" } } }]));
    const chain = turn([{ id: "m1", name: "task", arguments: {}, result: { details: { task_id: "st_1" } } }]);
    expect((await agentTouches({ agentDir, chain, fromIndex: -1, cwd: "/p" })).touches).toEqual([{ path: "/p/deep", op: "write" }]);
  });

  it("unknown_tools_are_reported_not_dropped", async () => {
    const chain = turn([
      { id: "m1", name: "apply_patch", arguments: { nothing: true } },
      { id: "m2", name: "task", arguments: {}, result: { details: { task_id: "st_missing" } } },
    ]);
    expect(await agentTouches({ agentDir, chain, fromIndex: -1, cwd: "/p" })).toEqual({ touches: [], unknownTools: ["apply_patch", "task"] });
  });
});
