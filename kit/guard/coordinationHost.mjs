// Service-owned, acknowledged delivery. A window is never a sender.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { readLines, writeLine } from "./sockets.mjs";

/** Deliver to an existing durable session, including one retained without any editor attachments. */
export async function deliverCoordination(agentDir, message) {
  const protectedSocket = path.join(agentDir, "guard/host/agent-tabs.sock");
  const socketPath = fs.existsSync(protectedSocket) ? protectedSocket : path.join(agentDir, "rpc/agent-tabs.sock");
  const socket = net.createConnection(socketPath);
  const pending = new Map();
  let sequence = 0;
  let attached;
  const fail = (error) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Host connection closed before acknowledgement")));
  readLines(socket, (frame) => {
    const waiter = pending.get(frame?.id);
    if (!waiter || frame.type !== "response") return;
    pending.delete(frame.id);
    clearTimeout(waiter.timer);
    if (frame.success) waiter.resolve(frame.data);
    else waiter.reject(new Error(`${frame.errorCode}: ${frame.error}`));
  });
  const request = (type, fields = {}) => new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new Error("Host connection closed"));
    const id = `coord-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Host ${type} acknowledgement timed out`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    writeLine(socket, { id, type, ...fields });
  });
  try {
    const clientNonce = randomBytes(32).toString("hex");
    const info = await request("get_protocol_info", { auth: { client_nonce: clientNonce } });
    const auth = info?.auth;
    if (!auth || !/^[A-Za-z0-9_-]+$/.test(auth.launch_id) || !/^[a-f0-9]{64}$/i.test(auth.server_proof)) throw new Error("Host identity is unproven");
    const key = Buffer.from(JSON.parse(fs.readFileSync(path.join(agentDir, "rpc/keys", auth.launch_id), "utf8")).key, "hex");
    const proof = (label, parts) => createHmac("sha256", key).update([label, ...parts].join("\n")).digest("hex");
    const expected = proof("senpi-rpc-server", [auth.launch_id, clientNonce, auth.server_nonce]);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(auth.server_proof, "hex"))) throw new Error("Host identity is unproven");
    await request("authenticate", { client_proof: proof("senpi-rpc-client", [auth.launch_id, auth.server_nonce, clientNonce]) });
    const listing = await request("list_sessions", { observe: true, include_workers: true });
    const target = listing?.sessions?.find((session) => session.durableSessionId === message.session);
    if (!target || typeof target.sessionPath !== "string") throw new Error("Addressed session is not available on the host");
    const opened = await request("open_session", { sessionPath: target.sessionPath, retain_on_disconnect: true });
    attached = opened?.sessionId;
    if (!attached || opened.durableSessionId !== message.session) throw new Error("Attached session identity changed");
    // The host chooses idle/start vs running/queue atomically; a get_state -> prompt choice would race.
    const admitted = await request("steer", { sessionId: attached, message: message.text, clientMessageId: message.id, whenIdle: "start" });
    if (!["started", "queued"].includes(admitted?.disposition)) throw new Error("Host did not admit the coordination message");
  } finally {
    if (attached && !socket.destroyed) {
      // Admission already belongs to the retained session; releasing this attachment cannot cancel it.
      try { await request("release_attachment", { sessionId: attached }); }
      catch (error) { if (!socket.destroyed) console.error(`[coordinate] attachment release: ${error.message}`); }
    }
    socket.destroy();
  }
}
