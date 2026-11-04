import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { editSteps, type Entry, type FileTouch } from "./edits";

/** Session files of a subagent: `<agentDir>/projects/*\/senpi-task/children/<taskId>/sessions/**\/*.jsonl`, sorted. */
export async function childSessionFiles(agentDir: string, taskId: string): Promise<string[]> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
  const projects = join(agentDir, "projects");
  let slugs: string[];
  try {
    slugs = await readdir(projects);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const slug of slugs) {
    const sessions = join(projects, slug, "senpi-task", "children", taskId, "sessions");
    let names: string[];
    try {
      names = await readdir(sessions, { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith(".jsonl")) files.push(join(sessions, name));
  }
  return files.sort();
}

async function readSession(file: string): Promise<{ cwd: string | undefined; entries: Entry[] }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { cwd: undefined, entries: [] };
  }
  const parsed: Entry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed.push(value as Entry);
    } catch {
      // A torn or malformed line carries nothing we can use.
    }
  }
  const header = parsed[0]?.["type"] === "session" ? parsed[0] : undefined;
  return { cwd: typeof header?.["cwd"] === "string" ? header["cwd"] : undefined, entries: header ? parsed.slice(1) : parsed };
}

async function childSessions(agentDir: string, taskId: string): Promise<{ cwd: string | undefined; entries: Entry[] }[]> {
  const sessions = [];
  for (const file of await childSessionFiles(agentDir, taskId)) sessions.push(await readSession(file));
  return sessions;
}

/** What one finished subagent (and its own subagents) touched; `cwd` stands in when its session file names none. */
export async function taskTouches(agentDir: string, taskId: string, cwd: string): Promise<{ touches: FileTouch[]; unknownTools: string[] }> {
  const toolCallId = "task";
  const chain: Entry[] = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "task" }] } },
    { type: "message", message: { role: "toolResult", toolCallId, details: { task_id: taskId } } },
  ];
  return agentTouches({ agentDir, chain, fromIndex: -1, cwd });
}

/**
 * Every file the agent's edit tools touched after `fromIndex` in `chain`, in order, with each `task`
 * call expanded in place into its subagent's own edits (recursively). Calls whose files cannot be
 * told (no path argument, no subagent session file) are reported by tool name.
 */
export async function agentTouches(input: { agentDir: string; chain: Entry[]; fromIndex: number; cwd: string }): Promise<{ touches: FileTouch[]; unknownTools: string[] }> {
  const touches: FileTouch[] = [];
  const unknownTools: string[] = [];
  const visited = new Set<string>();
  const walk = async (chain: Entry[], fromIndex: number, cwd: string): Promise<void> => {
    for (const step of editSteps(chain, fromIndex, cwd)) {
      if (step.kind === "touch") touches.push(...step.touches);
      else if (step.kind === "unknown") unknownTools.push(step.tool);
      else {
        if (visited.has(step.taskId)) continue;
        visited.add(step.taskId);
        const children = await childSessions(input.agentDir, step.taskId);
        if (children.length === 0) unknownTools.push("task");
        for (const child of children) await walk(child.entries, -1, child.cwd ?? cwd);
      }
    }
  };
  await walk(input.chain, input.fromIndex, input.cwd);
  return { touches, unknownTools };
}
