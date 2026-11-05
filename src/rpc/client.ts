import { EventEmitter } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { clientProof, serverProof } from "./auth";
import { JsonlDecoder, MAX_RECORD_CHARS } from "./jsonl";

export class RpcError extends Error {
  readonly code: string;
  /** The refusal's own `errorData`, when the host sent one: who holds a path, when to ask again. */
  readonly data: Record<string, unknown> | undefined;

  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

type Frame = Record<string, unknown>;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: RpcError) => void;
  timer: NodeJS.Timeout;
}

interface AuthOffer {
  launch_id: string;
  server_nonce: string;
  server_proof: string;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CLIENT_CAPABILITIES = ["extension_events", "question"];

function isFrame(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuthOffer(data: unknown): AuthOffer {
  const auth = isFrame(data) ? data["auth"] : undefined;
  if (
    !isFrame(auth) ||
    typeof auth["launch_id"] !== "string" ||
    typeof auth["server_nonce"] !== "string" ||
    typeof auth["server_proof"] !== "string"
  ) {
    throw new RpcError("auth_unavailable", "daemon did not offer socket authentication");
  }
  return {
    launch_id: auth["launch_id"],
    server_nonce: auth["server_nonce"],
    server_proof: auth["server_proof"],
  };
}

async function readKey(agentDir: string, launchId: string): Promise<Buffer> {
  // launch_id comes from the wire: refuse anything that could leave the keys directory.
  if (!/^[A-Za-z0-9._-]+$/.test(launchId) || launchId === "." || launchId === "..") {
    throw new RpcError("auth_failed", "daemon sent a malformed launch id");
  }
  let raw: string;
  try {
    raw = await readFile(join(agentDir, "rpc", "keys", launchId), "utf8");
  } catch {
    throw new RpcError("auth_failed", `no key file for launch ${launchId}`);
  }
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new RpcError("auth_failed", "key file is not valid JSON");
  }
  const keyHex = isFrame(record) ? record["key"] : undefined;
  if (typeof keyHex !== "string" || !/^[0-9a-fA-F]+$/.test(keyHex) || keyHex.length % 2 !== 0) {
    throw new RpcError("auth_failed", "key file has no usable key");
  }
  return Buffer.from(keyHex, "hex");
}

function proofsEqual(expectedHex: string, actualHex: string): boolean {
  // Buffer.from(.., "hex") silently truncates at the first invalid char: validate strictly first.
  if (!/^[0-9a-f]{64}$/i.test(actualHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Authenticated JSONL client for the omo daemon unix socket.
 * Events: "frame" (every non-response frame), "close" (optional Error), "warning" (text: a record was skipped).
 */
export class RpcClient extends EventEmitter {
  private readonly decoder = new JsonlDecoder(MAX_RECORD_CHARS, (chars) =>
    this.emit("warning", `Пропущена запись omo длиной ${chars} символов (предел ${MAX_RECORD_CHARS})`),
  );
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;
  private host: string | undefined;

  private constructor(private readonly socket: Socket) {
    super();
    this.setMaxListeners(0); // every tab's controller listens for "frame" on the one shared client
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error: Error) => this.onClosed(error));
    socket.on("close", () => this.onClosed(undefined));
  }

  static async connect(socketPath: string, agentDir: string): Promise<RpcClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = netConnect(socketPath);
      candidate.once("connect", () => {
        candidate.removeListener("error", reject);
        resolve(candidate);
      });
      candidate.once("error", reject);
    });
    const client = new RpcClient(socket);
    try {
      await client.handshake(agentDir);
      await client.request("set_client_info", { capabilities: CLIENT_CAPABILITIES });
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  /** Sends a request and resolves with the response `data`. */
  request<T = unknown>(
    type: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    return this.send(`r${this.nextId++}`, type, fields, timeoutMs) as Promise<T>;
  }

  /** Fire-and-forget frame without an id. */
  notify(type: string, fields: Record<string, unknown>): void {
    if (this.closed) throw new RpcError("closed", "connection is closed");
    this.write({ ...fields, type });
  }

  /** The host's own `instanceId` from the handshake: what tells it apart from another copy of the host. */
  get instanceId(): string | undefined {
    return this.host;
  }

  close(): void {
    this.socket.destroy();
  }

  private async handshake(agentDir: string): Promise<void> {
    const clientNonce = randomBytes(32).toString("hex");
    const info = await this.send(
      `auth-${this.nextId++}`,
      "get_protocol_info",
      { auth: { client_nonce: clientNonce } },
      HANDSHAKE_TIMEOUT_MS,
    );
    // The handshake's own `get_protocol_info` already carries who the host is: no second round trip for it.
    if (isFrame(info) && typeof info["instanceId"] === "string") this.host = info["instanceId"];
    const offer = parseAuthOffer(info);
    const key = await readKey(agentDir, offer.launch_id);
    const expected = serverProof(key, offer.launch_id, clientNonce, offer.server_nonce);
    if (!proofsEqual(expected, offer.server_proof)) {
      throw new RpcError("host_identity_unproven", "daemon failed to prove its identity");
    }
    await this.send(
      `auth-${this.nextId++}`,
      "authenticate",
      { client_proof: clientProof(key, offer.launch_id, offer.server_nonce, clientNonce) },
      HANDSHAKE_TIMEOUT_MS,
    );
  }

  private send(
    id: string,
    type: string,
    fields: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new RpcError("closed", "connection is closed"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("timeout", `${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...fields, id, type });
    });
  }

  private write(frame: Frame): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  private onData(chunk: Buffer): void {
    let records: unknown[];
    try {
      records = this.decoder.push(chunk);
    } catch (error) {
      this.onClosed(error instanceof Error ? error : new Error(String(error)));
      this.socket.destroy();
      return;
    }
    for (const record of records) {
      if (isFrame(record)) this.dispatch(record);
    }
  }

  private dispatch(frame: Frame): void {
    if (frame["type"] === "queued") return;
    if (frame["type"] !== "response") {
      this.emit("frame", frame);
      return;
    }
    const id = frame["id"];
    const entry = typeof id === "string" ? this.pending.get(id) : undefined;
    if (typeof id !== "string" || entry === undefined) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (frame["success"] === true) {
      entry.resolve(frame["data"]);
      return;
    }
    const code = typeof frame["errorCode"] === "string" ? frame["errorCode"] : "error";
    const message = typeof frame["error"] === "string" ? frame["error"] : "request failed";
    const data = isFrame(frame["errorData"]) ? frame["errorData"] : undefined;
    entry.reject(new RpcError(code, message, data));
  }

  private onClosed(error: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcError("closed", "connection closed"));
      this.pending.delete(id);
    }
    this.emit("close", error);
  }
}
