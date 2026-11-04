/**
 * OmO's `todo` tool (schema from its binary: `{op?, list?: [{phase, items}], task?, phase?, items?}`, ops init · start ·
 * done · drop · rm · append · view) as the feed shows it: the call reduced to what a step needs, and the list it leaves,
 * replayed with OmO's own rules (exact task text; after every op one task is in progress — the first pending one when
 * none is). OmO fuzzy-matches a mistyped task; here an unknown one changes nothing.
 */

export type TodoOp = "init" | "start" | "done" | "drop" | "rm" | "append" | "view";
export type TodoCall = { op: TodoOp; task?: string; phase?: string; list?: Array<{ phase: string; items: string[] }>; items?: string[] };
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
export type TodoTask = { content: string; status: TodoStatus };
export type TodoPhase = { name: string; tasks: TodoTask[] };

const OPS: readonly TodoOp[] = ["init", "start", "done", "drop", "rm", "append", "view"];
/** OmO's phase for an init or append that names none. */
const DEFAULT_PHASE = "Tasks";
/** A step never carries more than this: the list is for reading, not a payload. */
const MAX_ITEMS = 100;
const MAX_TEXT = 300;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_TEXT) : undefined);
const texts = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.flatMap((item) => text(item) ?? []).slice(0, MAX_ITEMS) : undefined);

/** The call's own fields, checked; undefined when it is not a todo call this view knows. */
export function todoCall(args: unknown): TodoCall | undefined {
  if (!isObject(args)) return undefined;
  const list = Array.isArray(args["list"])
    ? args["list"].flatMap((entry) => (isObject(entry) && text(entry["phase"]) !== undefined ? [{ phase: text(entry["phase"]) as string, items: texts(entry["items"]) ?? [] }] : [])).slice(0, MAX_ITEMS)
    : undefined;
  const op = OPS.includes(args["op"] as TodoOp) ? (args["op"] as TodoOp) : args["op"] === undefined && list !== undefined ? "init" : undefined;
  if (op === undefined) return undefined;
  const task = text(args["task"]);
  const phase = text(args["phase"]);
  const items = texts(args["items"]);
  return { op, ...(list !== undefined ? { list } : {}), ...(task !== undefined ? { task } : {}), ...(phase !== undefined ? { phase } : {}), ...(items !== undefined ? { items } : {}) };
}

const clone = (phases: TodoPhase[]): TodoPhase[] => phases.map((phase) => ({ name: phase.name, tasks: phase.tasks.map((task) => ({ ...task })) }));

/** The tasks a done/drop/rm names: one task, a whole phase, or (neither) all of them; [] when the name is unknown. */
function targets(phases: TodoPhase[], call: TodoCall): TodoTask[] | undefined {
  if (call.task !== undefined) {
    const hit = phases.flatMap((phase) => phase.tasks).find((task) => task.content === call.task);
    return hit === undefined ? undefined : [hit];
  }
  if (call.phase !== undefined) return phases.find((phase) => phase.name === call.phase)?.tasks;
  return phases.flatMap((phase) => phase.tasks);
}

function normalize(phases: TodoPhase[]): TodoPhase[] {
  const all = phases.flatMap((phase) => phase.tasks);
  const running = all.filter((task) => task.status === "in_progress");
  for (const task of running.slice(1)) task.status = "pending";
  if (running.length === 0) {
    const next = all.find((task) => task.status === "pending");
    if (next !== undefined) next.status = "in_progress";
  }
  return phases;
}

/** The list after `call` (a new array; `phases` is not touched). A call OmO would refuse leaves the list as it was. */
export function applyTodo(phases: TodoPhase[], call: TodoCall): TodoPhase[] {
  if (call.op === "view") return phases;
  const next = clone(phases);
  switch (call.op) {
    case "init": {
      const list = call.list ?? (call.items !== undefined ? [{ phase: call.phase ?? DEFAULT_PHASE, items: call.items }] : []);
      const built: TodoPhase[] = [];
      for (const entry of list) {
        let phase = built.find((candidate) => candidate.name === entry.phase);
        if (phase === undefined) built.push((phase = { name: entry.phase, tasks: [] }));
        for (const content of entry.items) if (!built.some((other) => other.tasks.some((task) => task.content === content))) phase.tasks.push({ content, status: "pending" });
      }
      return normalize(built);
    }
    case "start": {
      const hit = call.task === undefined ? undefined : targets(next, call)?.[0];
      if (hit === undefined) return phases;
      for (const task of next.flatMap((phase) => phase.tasks)) if (task.status === "in_progress") task.status = "pending";
      hit.status = "in_progress";
      return normalize(next);
    }
    case "done":
    case "drop": {
      const hit = targets(next, call);
      if (hit === undefined) return phases;
      for (const task of hit) task.status = call.op === "done" ? "completed" : "abandoned";
      return normalize(next);
    }
    case "rm": {
      const hit = targets(next, call);
      if (hit === undefined) return phases;
      for (const phase of next) phase.tasks = phase.tasks.filter((task) => !hit.includes(task));
      return normalize(next);
    }
    case "append": {
      const items = call.items ?? [];
      const all = next.flatMap((phase) => phase.tasks);
      if (items.length === 0 || items.some((content, index) => items.indexOf(content) !== index || all.some((task) => task.content === content))) return phases;
      const current = next.find((phase) => phase.tasks.some((task) => task.status === "in_progress" || task.status === "pending"));
      const name = call.phase ?? current?.name ?? next.at(-1)?.name ?? DEFAULT_PHASE;
      let phase = next.find((candidate) => candidate.name === name);
      if (phase === undefined) next.push((phase = { name, tasks: [] }));
      for (const content of items) phase.tasks.push({ content, status: "pending" });
      return normalize(next);
    }
  }
}
