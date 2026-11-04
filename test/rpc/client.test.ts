import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcClient, RpcError } from "../../src/rpc/client";
import { FakeDaemon, type Frame } from "../helpers/fakeDaemon";

let daemon: FakeDaemon;
const clients: RpcClient[] = [];

async function connect(): Promise<RpcClient> {
  const client = await RpcClient.connect(daemon.socketPath, daemon.agentDir);
  clients.push(client);
  return client;
}

beforeEach(async () => {
  daemon = await FakeDaemon.start();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await daemon.stop();
});

describe("RpcClient", () => {
  it("serves_many_tabs_without_a_max_listeners_warning", async () => {
    const client = await connect();
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", onWarning);
    try {
      for (let tab = 0; tab < 12; tab++) client.on("frame", () => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings).not.toContain("MaxListenersExceededWarning");
  });

  it("handshake_then_set_client_info", async () => {
    await connect();
    const [info, authenticate] = daemon.authFrames;
    expect(info?.["type"]).toBe("get_protocol_info");
    const clientNonce = (info?.["auth"] as { client_nonce: string }).client_nonce;
    expect(clientNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(authenticate?.["type"]).toBe("authenticate");
    // The daemon only flips to authenticated (and accepts requests) on a correct HMAC client proof.
    expect(typeof authenticate?.["client_proof"]).toBe("string");
    expect(daemon.requests[0]).toMatchObject({ type: "set_client_info", capabilities: ["extension_events", "question"] });
  });

  it("rejects_bad_server_proof", async () => {
    await daemon.stop();
    daemon = await FakeDaemon.start({ badServerProof: true });
    await expect(RpcClient.connect(daemon.socketPath, daemon.agentDir)).rejects.toMatchObject({
      code: "host_identity_unproven",
    });
    expect(daemon.authFrames.map((frame) => frame["type"])).toEqual(["get_protocol_info"]);
  });

  it.each(["zz", "a"])("rejects_server_proof_with_trailing_garbage (%s)", async (suffix) => {
    await daemon.stop();
    daemon = await FakeDaemon.start({ serverProofSuffix: suffix });
    await expect(RpcClient.connect(daemon.socketPath, daemon.agentDir)).rejects.toMatchObject({
      code: "host_identity_unproven",
    });
  });

  it("correlates_out_of_order_responses", async () => {
    daemon.on("slow", () => ({ data: "slow", delayMs: 60 }));
    daemon.on("fast", () => ({ data: "fast" }));
    const client = await connect();
    const slow = client.request("slow");
    const fast = client.request("fast");
    expect(await fast).toBe("fast");
    expect(await slow).toBe("slow");
  });

  it("maps_error_to_RpcError", async () => {
    daemon.on("prompt", () => ({ error: "Agent is already processing", errorCode: "streaming" }));
    const client = await connect();
    const error = await client.request("prompt").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: "streaming", message: "Agent is already processing" });
  });

  it("ignores_queued_and_times_out_with_RpcError", async () => {
    daemon.on("never", () => ({ silent: true, frames: [{ type: "queued", for_request: "r2" }] }));
    const client = await connect();
    const frames: Frame[] = [];
    client.on("frame", (frame: Frame) => frames.push(frame));
    await expect(client.request("never", {}, 50)).rejects.toMatchObject({ code: "timeout" });
    expect(frames).toEqual([]);
  });

  it("emits_frames_and_close", async () => {
    const client = await connect();
    const frames: Frame[] = [];
    client.on("frame", (frame: Frame) => frames.push(frame));
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    daemon.push({ type: "extension_event", name: "omo.task.updated" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toEqual([{ type: "extension_event", name: "omo.task.updated" }]);
    daemon.dropConnections();
    await closed;
    await expect(client.request("get_state")).rejects.toMatchObject({ code: "closed" });
  });

  it("rejects_pending_requests_on_close", async () => {
    daemon.on("hang", () => ({ silent: true }));
    const client = await connect();
    const pending = client.request("hang");
    await new Promise((resolve) => setTimeout(resolve, 20));
    daemon.dropConnections();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
  });

  it("notify_sends_frame_without_id", async () => {
    const client = await connect();
    client.notify("extension_ui_response", { uiRequestId: "u1" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const last = daemon.requests.at(-1);
    expect(last).toMatchObject({ type: "extension_ui_response", uiRequestId: "u1" });
    expect(last).not.toHaveProperty("id");
  });
});
