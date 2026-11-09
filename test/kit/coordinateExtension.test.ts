import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeSvcDir, removeSvcDirs, send, start } from "./serviceHelpers";

const { default: extension } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../kit/guard/coordinate-extension.mjs")).href);
type Context = { cwd: string; isIdle(): boolean; sessionManager: { getSessionId(): string; getSessionName(): string } };
type EventHandler = (event: Record<string, unknown>, ctx: Context) => Promise<void>;
type Tool = { name: string; parameters: { properties: Record<string, unknown> }; execute(id: string, input: Record<string, unknown>, signal: undefined, update: undefined, ctx: Context): Promise<{ details: Record<string, unknown> }> };
let service: Awaited<ReturnType<typeof start>>;
let registered: Tool;
let handlers: Map<string, EventHandler>;
const cwd = path.resolve(import.meta.dirname, "../..");
const context = (session: string): Context => ({ cwd, isIdle: () => false, sessionManager: { getSessionId: () => session, getSessionName: () => "File owner" } });

beforeEach(async () => {
  const agentDir = makeSvcDir();
  vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
  service = await start(agentDir);
  handlers = new Map();
  extension({ registerTool: (tool: Tool) => { registered = tool; }, on: (event: string, handler: EventHandler) => handlers.set(event, handler) });
});
afterEach(async () => { await service.close(); removeSvcDirs(); vi.unstubAllEnvs(); });

it("uses the runtime durable identity for answers rather than any caller-supplied field", async () => {
  await send(service.paths.hookSock, { op: "evaluate", call: { session: "owner", cwd, tool: "write", input: { path: "owned.txt" } } });
  const invoke = async (session: string, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await registered.execute("call", input, undefined, undefined, context(session))).details;
  const handoff = await invoke("requester", { action: "handoff", file: "owned.txt", what: "Add validation" });
  expect(registered.name).toBe("coordinate");
  expect(registered.parameters.properties).not.toHaveProperty("session");
  expect((await invoke("intruder", { action: "accept", id: handoff["id"], session: "owner" }))["ok"]).toBe(false);
  expect((await invoke("owner", { action: "accept", id: handoff["id"] }))["state"]).toBe("done");
});

it("reports the session title and releases only on a real session shutdown", async () => {
  await handlers.get("session_start")?.({}, context("owner"));
  await send(service.paths.hookSock, { op: "evaluate", call: { session: "owner", cwd, tool: "write", input: { path: "owned.txt" } } });
  const attempt = (): Promise<Record<string, unknown>> => send(service.paths.hookSock, { op: "evaluate", call: { session: "requester", cwd, tool: "write", input: { path: "owned.txt" } } });
  expect((await attempt())["reason"]).toContain("File owner");
  await handlers.get("session_shutdown")?.({ reason: "reload" }, context("owner"));
  expect((await attempt())["decision"]).toBe("deny");
  await handlers.get("session_shutdown")?.({ reason: "quit" }, context("owner"));
  expect((await attempt())["decision"]).toBe("allow");
});
