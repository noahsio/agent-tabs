import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FakeDaemon } from "../helpers/fakeDaemon";

const { deliverCoordination } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../kit/guard/coordinationHost.mjs")).href);
let daemon: FakeDaemon;
const message = { id: "coordinate-request-owner", session: "durable-owner", text: "Please update the leased file" };

beforeEach(async () => {
  daemon = await FakeDaemon.start();
  fs.symlinkSync(daemon.socketPath, path.join(daemon.agentDir, "rpc/agent-tabs.sock"));
  daemon.on("list_sessions", () => ({ data: { sessions: [
    { sessionId: "rpc-owner", durableSessionId: "durable-owner", sessionPath: "/sessions/owner.jsonl", status: "idle", attachments: 0 },
  ] } }));
  daemon.on("open_session", () => ({ data: { sessionId: "rpc-owner", durableSessionId: "durable-owner" } }));
  daemon.on("get_state", () => ({ data: { isStreaming: false } }));
  daemon.on("release_attachment", () => ({}));
});
afterEach(async () => { await daemon.stop(); });

it("delivers to a retained session without a tab and waits for admission", async () => {
  const admitted: string[] = [];
  daemon.on("steer", (frame) => {
    admitted.push(String(frame["message"]));
    return { data: { disposition: "started" } };
  });
  await deliverCoordination(daemon.agentDir, message);
  expect(admitted).toEqual([message.text]);
  expect(daemon.requests.some((frame) => frame["type"] === "release_attachment")).toBe(true);
});

it("uses steer during background work and preserves the admission id on retry", async () => {
  const admitted = new Map<string, string>();
  let first = true;
  daemon.on("get_state", () => ({ data: { isStreaming: true, lifecycle: { state: "running" } } }));
  daemon.on("steer", (frame) => {
    admitted.set(String(frame["clientMessageId"]), String(frame["message"]));
    if (first) { first = false; daemon.dropConnections(); return { silent: true }; }
    return { data: { disposition: "queued" } };
  });
  await expect(deliverCoordination(daemon.agentDir, message)).rejects.toThrow();
  await deliverCoordination(daemon.agentDir, message);
  expect([...admitted]).toEqual([[message.id, message.text]]);
  expect(daemon.requests.filter((frame) => frame["type"] === "steer")).toHaveLength(2);
});

it("does not send to a different durable session after a host replacement", async () => {
  daemon.on("open_session", () => ({ data: { sessionId: "rpc-owner", durableSessionId: "someone-else" } }));
  await expect(deliverCoordination(daemon.agentDir, message)).rejects.toThrow(/identity/);
  expect(daemon.requests.some((frame) => frame["type"] === "steer")).toBe(false);
});

it("rejects a host that does not prove its identity", async () => {
  daemon.badServerProof = true;
  await expect(deliverCoordination(daemon.agentDir, message)).rejects.toThrow(/identity/);
  expect(daemon.requests).toEqual([]);
});
