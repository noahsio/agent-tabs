import { resolve } from "node:path";

/** One journal entry as OmO stores it (`type`, `id`, `parentId`, …). */
export type Entry = Record<string, unknown>;

/** `write` may create or overwrite; `create`/`delete` come from patches; `modify` from `edit` and patch updates. */
export type FileOp = "write" | "create" | "modify" | "delete";

/** `path` is absolute, lexically resolved against the call's cwd. */
export type FileTouch = { path: string; op: FileOp };

export type EditStep = { kind: "touch"; touches: FileTouch[] } | { kind: "task"; taskId: string } | { kind: "unknown"; tool: string };

export const EDIT_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The entry and its parents, root first and the entry itself last; `[]` when the id is unknown. */
export function ancestors(entries: Entry[], entryId: string): Entry[] {
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    const id = asString(entry["id"]);
    if (id !== undefined) byId.set(id, entry);
  }
  const chain: Entry[] = [];
  const seen = new Set<string>();
  let id: string | undefined = entryId;
  while (id !== undefined && !seen.has(id)) {
    const entry = byId.get(id);
    if (entry === undefined) break;
    seen.add(id);
    chain.push(entry);
    id = asString(entry["parentId"]);
  }
  return chain.reverse();
}

function userMessage(entry: Entry): Record<string, unknown> | undefined {
  const message = entry["message"];
  return entry["type"] === "message" && isObject(message) && message["role"] === "user" ? message : undefined;
}

/** The user entry behind a feed block id: its `clientMessageId`, or `u:<timestamp>` for messages sent elsewhere. */
export function findUserEntry(entries: Entry[], blockId: string): Entry | undefined {
  const byClientId = entries.find((entry) => userMessage(entry)?.["clientMessageId"] === blockId);
  if (byClientId) return byClientId;
  return entries.find((entry) => {
    const message = userMessage(entry);
    return message !== undefined && asString(message["clientMessageId"]) === undefined && `u:${String(message["timestamp"])}` === blockId;
  });
}

/** File operations named by one patch in the `*** Begin Patch` format. */
export function patchTouches(patch: string, cwd: string): FileTouch[] {
  const touches: FileTouch[] = [];
  const lines = patch.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (!header) continue;
    const path = resolve(cwd, (header[2] as string).trim());
    if (header[1] === "Add") touches.push({ path, op: "create" });
    else if (header[1] === "Delete") touches.push({ path, op: "delete" });
    else {
      const move = /^\*\*\* Move to: (.+)$/.exec(lines[index + 1] ?? "");
      if (move) {
        touches.push({ path, op: "delete" }, { path: resolve(cwd, (move[1] as string).trim()), op: "create" });
        index++;
      } else touches.push({ path, op: "modify" });
    }
  }
  return touches;
}

/** Files one edit-tool call touches; `undefined` when its arguments name no file. */
export function toolTouches(tool: string, args: unknown, cwd: string): FileTouch[] | undefined {
  if (tool === "apply_patch") {
    const text = typeof args === "string" ? args : isObject(args) ? [args["input"], args["patch"], args["patchText"]].find((value) => typeof value === "string") : undefined;
    if (typeof text !== "string") return undefined;
    const touches = patchTouches(text, cwd);
    return touches.length > 0 ? touches : undefined;
  }
  if (!isObject(args)) return undefined;
  const path = asString(args["path"]) ?? asString(args["file_path"]);
  if (path === undefined || path === "") return undefined;
  if (tool === "write") return [{ path: resolve(cwd, path), op: "write" }];
  if (tool === "edit") return [{ path: resolve(cwd, path), op: "modify" }];
  return undefined;
}

/**
 * Edit-tool and `task` calls in assistant messages after `fromIndex`, in order. A call whose result
 * reports an error is left out; a `task` without a `details.task_id` in its result is left out too.
 */
export function editSteps(chain: Entry[], fromIndex: number, cwd: string): EditStep[] {
  const results = new Map<string, Record<string, unknown>>();
  chain.forEach((entry, index) => {
    const message = entry["message"];
    if (index <= fromIndex || !isObject(message) || message["role"] !== "toolResult") return;
    const id = asString(message["toolCallId"]);
    if (id !== undefined) results.set(id, message);
  });
  const steps: EditStep[] = [];
  chain.forEach((entry, index) => {
    const message = entry["message"];
    if (index <= fromIndex || !isObject(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) return;
    for (const part of message["content"]) {
      if (!isObject(part) || part["type"] !== "toolCall") continue;
      const tool = asString(part["name"]) ?? "";
      const result = results.get(asString(part["id"]) ?? "");
      if (result?.["isError"] === true) continue;
      if (tool === "task") {
        const details = result?.["details"];
        const taskId = isObject(details) ? asString(details["task_id"]) : undefined;
        if (taskId !== undefined) steps.push({ kind: "task", taskId });
        continue;
      }
      if (!EDIT_TOOLS.has(tool)) continue;
      const touches = toolTouches(tool, part["arguments"], cwd);
      steps.push(touches === undefined ? { kind: "unknown", tool } : { kind: "touch", touches });
    }
  });
  return steps;
}
