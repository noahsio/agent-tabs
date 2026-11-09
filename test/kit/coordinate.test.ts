import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeScratchRepo } from "../helpers/scratchRepo";
import { makeClock, makeSvcDir, removeSvcDirs, send, start } from "./serviceHelpers";

const cwd = path.resolve(import.meta.dirname, "../..");
let service: Awaited<ReturnType<typeof start>>;
let clock: ReturnType<typeof makeClock>;
const write = (session: string, file = "coordination-owned.txt"): Promise<Record<string, unknown>> =>
  send(service.paths.hookSock, { op: "evaluate", call: { tool: "write", input: { path: file }, cwd, session } });
const coordinate = (session: string, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  send(service.paths.hookSock, { op: "coordinate", call: { tool: "coordinate", cwd, session, input } });
const checkout = (session = "requester"): Promise<Record<string, unknown>> =>
  send(service.paths.hookSock, { op: "evaluate", call: { tool: "bash", input: { command: "git checkout feature" }, cwd, session } });

beforeEach(async () => {
  clock = makeClock();
  service = await start(makeSvcDir({ decider: { mode: "deny" }, groups: { "git-push": false, history: false, secrets: false, "external-ip": false, "global-install": false } }), { now: clock.now });
});
afterEach(async () => { await service.close(); removeSvcDirs(); vi.unstubAllEnvs(); });

it("deduplicates a handoff and admits only the addressed owner without transferring the lease", async () => {
  await write("owner");
  const input = { action: "handoff", file: "coordination-owned.txt", what: "Add the requested validation" };
  const first = await coordinate("requester", input);
  expect(first["state"]).toBe("waiting");
  expect((await coordinate("requester", input))["id"]).toBe(first["id"]);
  expect((await coordinate("intruder", { action: "accept", id: first["id"] }))["ok"]).toBe(false);
  expect((await coordinate("owner", { action: "accept", id: first["id"], result: "Validation added" }))["state"]).toBe("done");
  expect((await write("requester"))["decision"]).toBe("deny");
  await coordinate("owner", { action: "release", file: "coordination-owned.txt" });
  expect((await write("requester"))["decision"]).toBe("allow");
});

it("does not treat decline or a delivery failure as a release", async () => {
  await write("owner");
  const request = await coordinate("requester", { action: "handoff", file: "coordination-owned.txt", what: "Update validation" });
  expect((await coordinate("owner", { action: "decline", id: request["id"], reason: "Still editing" }))["state"]).toBe("rejected");
  expect((await write("requester"))["decision"]).toBe("deny");
  expect((await coordinate("owner", { action: "release", file: "coordination-owned.txt" }))["ok"]).toBe(true);
  expect((await write("requester"))["decision"]).toBe("allow");
});

it("requires every neighbour's explicit consent and invalidates it when another neighbour arrives", async () => {
  await write("owner");
  const pending = await checkout();
  expect(pending["decision"]).toBe("deny");
  expect(pending["coordination"]).toMatchObject({ state: "waiting", kind: "proposal" });
  const proposal = await coordinate("requester", { action: "status" });
  const items = proposal["items"];
  if (!Array.isArray(items) || items.length !== 1) throw new Error("Expected one proposal");
  const id: unknown = items[0].id;
  expect((await coordinate("intruder", { action: "agree", id }))["ok"]).toBe(false);
  await coordinate("owner", { action: "agree", id });
  await write("third", "coordination-third.txt");
  expect((await checkout())["decision"]).toBe("deny");
});

it("allows the exact action once after consent, then asks again", async () => {
  await write("owner");
  const pending = await checkout();
  const state = pending["coordination"];
  if (typeof state !== "object" || state === null || !("id" in state)) throw new Error("Expected proposal");
  await coordinate("owner", { action: "agree", id: state.id });
  expect((await checkout())["decision"]).toBe("allow");
  expect((await checkout())["decision"]).toBe("deny");
});

it("defers silence after two minutes and lets only the admin grant permission", async () => {
  await write("owner");
  const pending = await checkout();
  const state = pending["coordination"];
  if (typeof state !== "object" || state === null || !("id" in state)) throw new Error("Expected proposal");
  clock.advance(119_999);
  expect((await coordinate("requester", { action: "status", id: state.id }))["state"]).toBe("waiting");
  clock.advance(1);
  const status = await coordinate("requester", { action: "status" });
  expect(status["items"]).toMatchObject([{ state: "deferred" }]);
  expect((await checkout())["decision"]).toBe("deny");
  expect((await send(service.paths.adminSock, { op: "coordination.answer", id: state.id, decision: "allow" })).ok).toBe(true);
  expect((await checkout())["decision"]).toBe("allow");
});

it("keeps one objection above every agreement and requires its reason", async () => {
  await write("owner");
  await write("third", "coordination-third.txt");
  const pending = await checkout();
  const state = pending["coordination"];
  if (typeof state !== "object" || state === null || !("id" in state)) throw new Error("Expected proposal");
  expect((await coordinate("owner", { action: "object", id: state.id }))["ok"]).toBe(false);
  await coordinate("owner", { action: "object", id: state.id, reason: "Uncommitted work" });
  expect((await coordinate("third", { action: "agree", id: state.id }))["state"]).toBe("rejected");
  expect((await checkout())["decision"]).toBe("deny");
});

it("re-proposes after the requested wait and bounds the wait to thirty minutes", async () => {
  await write("owner");
  const pending = await checkout();
  const state = pending["coordination"];
  if (typeof state !== "object" || state === null || !("id" in state)) throw new Error("Expected proposal");
  expect((await coordinate("owner", { action: "wait", id: state.id, minutes: 31 }))["ok"]).toBe(false);
  expect((await coordinate("owner", { action: "wait", id: state.id, minutes: 3 }))["state"]).toBe("postponed");
  clock.advance(180_000);
  expect((await coordinate("owner", { action: "status", id: state.id }))["state"]).toBe("waiting");
  await coordinate("owner", { action: "agree", id: state.id });
  expect((await checkout())["decision"]).toBe("allow");
});

it("times out a handoff after fifteen minutes without asking the person", async () => {
  await write("owner");
  const request = await coordinate("requester", { action: "handoff", file: "coordination-owned.txt", what: "Update validation" });
  clock.advance(540_000);
  await coordinate("owner", { action: "hello" });
  await coordinate("requester", { action: "hello" });
  clock.advance(359_999);
  expect((await coordinate("requester", { action: "status", id: request["id"] }))["state"]).toBe("waiting");
  clock.advance(1);
  expect((await coordinate("requester", { action: "status", id: request["id"] }))["state"]).toBe("unanswered");
  expect((await send(service.paths.adminSock, { op: "pending" })).items).toEqual([]);
});

it("lists named neighbours and requests a lease without handing off work", async () => {
  await coordinate("owner", { action: "hello", title: "Validation owner", activity: "Testing" });
  await write("owner");
  const who = await coordinate("requester", { action: "who" });
  expect(who["neighbours"]).toMatchObject([{ session: "owner", label: "Validation owner (owner)", files: [{ file: expect.stringContaining("coordination-owned.txt") }] }]);
  const request = await coordinate("requester", { action: "request", file: "coordination-owned.txt" });
  expect(request["kind"]).toBe("lease");
  expect((await coordinate("owner", { action: "agree", id: request["id"] }))["state"]).toBe("approved");
  expect((await write("requester"))["decision"]).toBe("allow");
  expect((await write("owner"))["decision"]).toBe("deny");
});

it("defers a silent proposal at night without opening a daytime question", async () => {
  clock.t = new Date(2026, 10, 4, 23, 0, 0).getTime();
  await write("owner");
  await checkout();
  clock.advance(120_000);
  expect((await send(service.paths.adminSock, { op: "pending" })).items).toEqual([]);
  const deferred = await send(service.paths.adminSock, { op: "deferred" });
  expect(deferred.items).toHaveLength(1);
  expect((await send(service.paths.adminSock, { op: "answer", id: deferred.items[0].id, decision: "allow-once", by: "agent-tabs" })).ok).toBe(true);
  expect((await checkout())["decision"]).toBe("allow");
});

it("consents automatically only for an idle neighbour with a clean affected copy", async () => {
  const scratch = makeScratchRepo(path.dirname(service.paths.dir));
  fs.mkdirSync(path.join(scratch, "info"));
  fs.writeFileSync(path.join(scratch, "info/exclude"), "/HEAD\n/config\n/index\n/index.lock\n/objects/\n/refs/\n/info/\n");
  vi.stubEnv("GIT_DIR", ".");
  const call = (session: string, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
    send(service.paths.hookSock, { op: "coordinate", call: { tool: "coordinate", cwd: scratch, session, input } });
  const attempt = (): Promise<Record<string, unknown>> => send(service.paths.hookSock,
    { op: "evaluate", call: { tool: "bash", cwd: scratch, session: "requester", input: { command: "git checkout feature" } } });
  await call("owner", { action: "hello", idle: true });
  expect((await attempt())["decision"]).toBe("allow");
  fs.writeFileSync(path.join(scratch, "uncommitted.txt"), "Work in progress");
  expect((await attempt())["decision"]).toBe("deny");
});

it("releases on real shutdown, keeps leases on reload, and uses titles in conflicts", async () => {
  await coordinate("owner", { action: "hello", title: "Validation owner" });
  await write("owner");
  expect((await write("requester"))["reason"]).toContain("Validation owner");
  await coordinate("owner", { action: "close", reason: "reload" });
  expect((await write("requester"))["decision"]).toBe("deny");
  await coordinate("owner", { action: "close", reason: "quit" });
  expect((await write("requester"))["decision"]).toBe("allow");
});

it.each(["quit", "expired"])("removes pending human proposals when the owner is %s", async (end) => {
  clock.t = new Date(2026, 10, 4, 23, 0, 0).getTime();
  await write("owner");
  const proposal = await checkout();
  const state = proposal["coordination"];
  if (typeof state !== "object" || state === null || !("id" in state)) throw new Error("Expected proposal");
  clock.advance(120_000);
  expect((await send(service.paths.adminSock, { op: "deferred" })).items).toHaveLength(1);
  await coordinate("requester", { action: "hello" });
  if (end === "quit") await coordinate("owner", { action: "close", reason: "quit" });
  else clock.advance(480_000);
  expect((await coordinate("requester", { action: "status", id: state.id }))["state"]).toBe("cancelled");
  expect((await send(service.paths.adminSock, { op: "deferred" })).items).toEqual([]);
  expect((await write("requester"))["decision"]).toBe("allow");
});

it("ends a handoff when its owner loses liveness before the response deadline", async () => {
  await write("owner");
  const request = await coordinate("requester", { action: "handoff", file: "coordination-owned.txt", what: "Update validation" });
  clock.advance(599_999);
  expect((await coordinate("requester", { action: "status", id: request["id"] }))["state"]).toBe("waiting");
  clock.advance(1);
  expect((await coordinate("requester", { action: "status", id: request["id"] }))["state"]).toBe("unanswered");
  expect((await write("requester"))["decision"]).toBe("allow");
});
