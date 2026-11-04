import { describe, expect, it } from "vitest";
import { applyTodo, todoCall, type TodoPhase } from "../../src/chat/todo";

/** Every op shape OmO's `todo` tool takes (its schema in the binary: {op, list|items|task|phase}). */
describe("todoCall", () => {
  it("keeps_each_op_shape_and_drops_everything_else", () => {
    expect(todoCall({ op: "init", list: [{ phase: "Execution", items: ["Run tests", "Reply"] }] })).toEqual({ op: "init", list: [{ phase: "Execution", items: ["Run tests", "Reply"] }] });
    expect(todoCall({ op: "init", items: ["A"], phase: "P" })).toEqual({ op: "init", items: ["A"], phase: "P" });
    expect(todoCall({ op: "start", task: "Run tests" })).toEqual({ op: "start", task: "Run tests" });
    expect(todoCall({ op: "done", task: "Run tests" })).toEqual({ op: "done", task: "Run tests" });
    expect(todoCall({ op: "done", phase: "Listing" })).toEqual({ op: "done", phase: "Listing" });
    expect(todoCall({ op: "drop", task: "x", junk: 1 })).toEqual({ op: "drop", task: "x" });
    expect(todoCall({ op: "rm" })).toEqual({ op: "rm" });
    expect(todoCall({ op: "append", items: ["B", 7, "C"] })).toEqual({ op: "append", items: ["B", "C"] });
    expect(todoCall({ op: "view" })).toEqual({ op: "view" });
    expect(todoCall({ list: [{ phase: "P", items: ["A"] }] })).toEqual({ op: "init", list: [{ phase: "P", items: ["A"] }] }); // no op: a list is an init
    expect(todoCall({ op: "explode" })).toBeUndefined();
    expect(todoCall("init")).toBeUndefined();
  });
});

const tasks = (phases: TodoPhase[]): string[] => phases.flatMap((phase) => phase.tasks.map((task) => `${task.content}:${task.status}`));

describe("applyTodo (OmO's semantics)", () => {
  const init = applyTodo([], { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }, { phase: "B", items: ["b1"] }] });

  it("init_replaces_the_list_and_the_first_task_is_current", () => {
    expect(tasks(init)).toEqual(["a1:in_progress", "a2:pending", "b1:pending"]);
    expect(tasks(applyTodo(init, { op: "init", items: ["x"] }))).toEqual(["x:in_progress"]);
  });

  it("done_and_drop_close_a_task_a_phase_or_everything_and_the_next_one_starts", () => {
    expect(tasks(applyTodo(init, { op: "done", task: "a1" }))).toEqual(["a1:completed", "a2:in_progress", "b1:pending"]);
    expect(tasks(applyTodo(init, { op: "drop", phase: "A" }))).toEqual(["a1:abandoned", "a2:abandoned", "b1:in_progress"]);
    expect(tasks(applyTodo(init, { op: "done" }))).toEqual(["a1:completed", "a2:completed", "b1:completed"]);
  });

  it("start_moves_the_current_task", () => {
    expect(tasks(applyTodo(init, { op: "start", task: "b1" }))).toEqual(["a1:pending", "a2:pending", "b1:in_progress"]);
  });

  it("rm_and_append_change_the_list", () => {
    expect(tasks(applyTodo(init, { op: "rm", task: "a1" }))).toEqual(["a2:in_progress", "b1:pending"]);
    expect(tasks(applyTodo(init, { op: "append", items: ["a3"] }))).toEqual(["a1:in_progress", "a2:pending", "a3:pending", "b1:pending"]); // the active phase
    expect(tasks(applyTodo(init, { op: "append", items: ["c1"], phase: "C" }))).toEqual(["a1:in_progress", "a2:pending", "b1:pending", "c1:pending"]);
  });

  it("a_call_naming_an_unknown_task_changes_nothing", () => {
    expect(applyTodo(init, { op: "done", task: "nope" })).toEqual(init);
    expect(tasks(init)).toEqual(["a1:in_progress", "a2:pending", "b1:pending"]); // never mutated
  });
});
