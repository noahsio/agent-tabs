import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientProof, serverProof } from "../../src/rpc/auth";
import { JsonlDecoder } from "../../src/rpc/jsonl";

export type Frame = Record<string, unknown>;

/** What a handler answers. `frames` are written before the response; `silent` suppresses it. */
export interface HandlerResult {
  data?: unknown;
  error?: string;
  errorCode?: string;
  /** The refusal's own `errorData`: who holds a path, when to ask again. */
  errorData?: Record<string, unknown>;
  frames?: Frame[];
  delayMs?: number;
  silent?: boolean;
}

export type Handler = (request: Frame) => HandlerResult | Promise<HandlerResult>;

export interface FakeDaemonOptions {
  /** Present a wrong server proof during the handshake. */
  badServerProof?: boolean;
  /** Append this to the (otherwise correct) server proof. */
  serverProofSuffix?: string;
}

/** Scriptable stand-in for the omo daemon socket with the real HMAC handshake. */
export class FakeDaemon {
  readonly agentDir: string;
  readonly socketPath: string;
  launchId: string;
  instanceId: string;
  /** Authenticated-phase requests in arrival order (handshake frames excluded). */
  readonly requests: Frame[] = [];
  /** Handshake frames (get_protocol_info, authenticate) in arrival order. */
  readonly authFrames: Frame[] = [];
  readonly handlers = new Map<string, Handler>();
  badServerProof: boolean;
  serverProofSuffix: string;

  private server: Server | undefined;
  private key: Buffer = Buffer.alloc(0);
  private readonly sockets = new Set<Socket>();
  private readonly rootDir: string;

  private constructor(rootDir: string, options: FakeDaemonOptions) {
    this.rootDir = rootDir;
    this.agentDir = join(rootDir, "agent");
    this.socketPath = join(rootDir, "d.sock");
    this.launchId = randomUUID();
    this.instanceId = randomUUID();
    this.badServerProof = options.badServerProof ?? false;
    this.serverProofSuffix = options.serverProofSuffix ?? "";
    this.handlers.set("set_client_info", () => ({}));
  }

  static async start(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
    const rootDir = await mkdtemp(join(tmpdir(), "fd-"));
    const daemon = new FakeDaemon(rootDir, options);
    await daemon.listen();
    return daemon;
  }

  /** Register (or replace) the handler for a request type. */
  on(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  /** Push an arbitrary frame to every connected client. */
  push(frame: Frame): void {
    for (const socket of this.sockets) socket.write(`${JSON.stringify(frame)}\n`);
  }

  /** Drop every client connection; the server keeps listening. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /** Stop and start again on the same socket path with a new launch id (and instance id). */
  async restart(): Promise<void> {
    await this.closeServer();
    this.launchId = randomUUID();
    this.instanceId = randomUUID();
    await this.listen();
  }

  async stop(): Promise<void> {
    await this.closeServer();
    await rm(this.rootDir, { recursive: true, force: true });
  }

  private async listen(): Promise<void> {
    this.key = randomBytes(32);
    const keysDir = join(this.agentDir, "rpc", "keys");
    await mkdir(keysDir, { recursive: true });
    await writeFile(
      join(keysDir, this.launchId),
      JSON.stringify({ version: 1, launch_id: this.launchId, key: this.key.toString("hex"), pid: process.pid }),
    );
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) => this.onConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
  }

  private async closeServer(): Promise<void> {
    this.dropConnections();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    const decoder = new JsonlDecoder();
    const state = { clientNonce: "", serverNonce: "", authenticated: false };
    socket.on("data", (chunk: Buffer) => {
      for (const record of decoder.push(chunk)) {
        void this.onFrame(socket, record as Frame, state);
      }
    });
  }

  private write(socket: Socket, frame: Frame): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  }

  private async onFrame(
    socket: Socket,
    frame: Frame,
    state: { clientNonce: string; serverNonce: string; authenticated: boolean },
  ): Promise<void> {
    const id = frame["id"];
    if (frame["type"] === "get_protocol_info" && !state.authenticated) {
      this.authFrames.push(frame);
      const auth = frame["auth"] as { client_nonce: string };
      state.clientNonce = auth.client_nonce;
      state.serverNonce = randomBytes(32).toString("hex");
      const proof = serverProof(this.key, this.launchId, state.clientNonce, state.serverNonce);
      this.write(socket, {
        id,
        type: "response",
        command: "get_protocol_info",
        success: true,
        data: {
          protocolVersion: 1,
          instanceId: this.instanceId,
          auth: {
            launch_id: this.launchId,
            server_nonce: state.serverNonce,
            server_proof: this.badServerProof ? "00".repeat(32) : proof + this.serverProofSuffix,
          },
        },
      });
      return;
    }
    if (frame["type"] === "authenticate" && !state.authenticated) {
      this.authFrames.push(frame);
      const expected = clientProof(this.key, this.launchId, state.serverNonce, state.clientNonce);
      state.authenticated = frame["client_proof"] === expected;
      this.write(
        socket,
        state.authenticated
          ? { id, type: "response", command: "authenticate", success: true }
          : { id, type: "response", command: "authenticate", success: false, error: "bad proof", errorCode: "auth_failed" },
      );
      return;
    }
    if (!state.authenticated) {
      socket.destroy();
      return;
    }
    this.requests.push(frame);
    const type = String(frame["type"]);
    const handler = this.handlers.get(type);
    if (handler === undefined) {
      this.write(socket, { id, type: "response", command: type, success: false, error: `unknown command ${type}`, errorCode: "unknown_command" });
      return;
    }
    const result = await handler(frame);
    if (result.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    for (const extra of result.frames ?? []) this.write(socket, extra);
    if (result.silent === true || id === undefined) return;
    this.write(
      socket,
      result.error !== undefined || result.errorCode !== undefined
        ? {
            id,
            type: "response",
            command: type,
            success: false,
            error: result.error ?? "error",
            errorCode: result.errorCode,
            ...(result.errorData !== undefined ? { errorData: result.errorData } : {}),
          }
        : { id, type: "response", command: type, success: true, data: result.data },
    );
  }
}
