import type { Block } from "../src/chat/model";
import { applyTodo, type TodoCall, type TodoPhase, type TodoTask } from "../src/chat/todo";
import { el } from "./dom";

/** A plan longer than this shows its first rows and the rest behind «ещё N». */
const PLAN_ROWS = 5;
const MARKS: Record<Exclude<TodoCall["op"], "init" | "view">, string> = { done: "✓", start: "→", drop: "✕", rm: "−", append: "+" };

type ToolBlock = Extract<Block, { kind: "tool" }>;

/** A todo step drawn compactly: a call the feed understands that did not fail (a failed one keeps its error box). */
export function isTodoStep(block: Block): block is ToolBlock & { todo: TodoCall } {
  return block.kind === "tool" && block.name === "todo" && block.todo !== undefined && block.state !== "error";
}

/** The list after each todo step, in order (a failed call changes nothing, as in OmO). */
export function todoStates(blocks: readonly Block[]): Map<string, TodoPhase[]> {
  const states = new Map<string, TodoPhase[]>();
  let phases: TodoPhase[] = [];
  for (const block of blocks) {
    if (!isTodoStep(block)) continue;
    phases = applyTodo(phases, block.todo);
    states.set(block.id, phases);
  }
  return states;
}

const tasksOf = (phases: TodoPhase[]): TodoTask[] => phases.flatMap((phase) => phase.tasks);
const isOpen = (task: TodoTask): boolean => task.status === "pending" || task.status === "in_progress";

function item(task: TodoTask): HTMLElement {
  const row = el("li", { class: `todo-item ${task.status}`, "data-todo-item": "", "data-status": task.status }, el("span", { class: "box", "aria-hidden": "true" }, task.status === "completed" ? "☑" : "☐"), task.content);
  row.classList.toggle("current", task.status === "in_progress");
  return row;
}

/** «План» and the checklist as it stood after this step: ☐ open, ☑ done, the current one bold; long ones fold. */
export function todoPlan(phases: TodoPhase[]): HTMLElement {
  const tasks = tasksOf(phases);
  const list = el("ul", { class: "todo-list" }, ...tasks.slice(0, PLAN_ROWS).map(item));
  const plan = el("div", { class: "step todo-plan" }, el("div", { class: "todo-head" }, "План"), list);
  if (tasks.length > PLAN_ROWS) {
    const rest = tasks.slice(PLAN_ROWS);
    plan.append(el("details", { class: "todo-more" }, el("summary", {}, `ещё ${rest.length}`), el("ul", { class: "todo-list" }, ...rest.map(item))));
  }
  return plan;
}

/** One muted line for an update: «✓ task», «→ task», «✕ task», «− task», «+ a, b». */
export function todoMark(call: TodoCall): HTMLElement {
  const op = call.op as keyof typeof MARKS;
  const what = op === "append" ? (call.items ?? []).join(", ") : (call.task ?? call.phase ?? "все задачи");
  return el("div", { class: "step todo-mark muted" }, `${MARKS[op]} ${what}`);
}

/** The latest plan over the composer while a turn runs: «План closed/all» and the current task; hidden with nothing open. */
export class TodoStrip {
  readonly element = el("div", { class: "todo-strip", "data-role": "todo-strip", role: "status" });

  constructor() {
    this.element.hidden = true;
  }

  update(blocks: readonly Block[], running: boolean): void {
    const tasks = tasksOf([...todoStates(blocks).values()].at(-1) ?? []);
    const current = tasks.find((task) => task.status === "in_progress") ?? tasks.find(isOpen);
    this.element.hidden = !running || current === undefined;
    if (current === undefined) return;
    const closed = tasks.filter((task) => !isOpen(task)).length;
    this.element.replaceChildren(el("span", { class: "todo-count" }, `План ${closed}/${tasks.length}`), el("span", { class: "current" }, current.content));
    this.element.title = tasks.map((task) => `${task.status === "completed" ? "☑" : "☐"} ${task.content}`).join("\n");
  }
}
