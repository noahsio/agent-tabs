import fs from "node:fs";
import net from "node:net";
import path from "node:path";
// @ts-expect-error plain ESM without types
import { startService } from "../../kit/guard/service.mjs";
// @ts-expect-error plain ESM without types
import { loadDefaultRules } from "../../kit/guard/rules.mjs";

export const KEY = "fixture-service-key-0123456789abcdef";
export const SESSION = "0f8e2c1a-5b7d-4e3f-9a21-c4d5e6f70812";
export const CWD = "/work/proj";
export const DECIDER_MODEL = "gw/claude-haiku-test";

export type Verdict = "allow" | "deny" | "ask" | "status500";

/** Anthropic-messages look-alike as a fetch function; no network. */
export class FakeGateway {
  verdict: Verdict = "ask";
  requests: { url: string; init: RequestInit; body: any }[] = [];
  /** While true, answers wait until release(). */
  hold = false;
  private held: (() => void)[] = [];
  release(): void {
    this.hold = false;
    for (const resume of this.held.splice(0)) resume();
  }
  fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    this.requests.push({ url: String(url), init, body: JSON.parse(String(init.body ?? "{}")) });
    if (this.hold) await new Promise<void>((resume) => this.held.push(resume));
    if (this.verdict === "status500") return new Response("boom", { status: 500 });
    const text = JSON.stringify({ decision: this.verdict, reason: `решатель: ${this.verdict}` });
    return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text }] }), { status: 200 });
  };
}

export interface Clock {
  t: number;
  now: () => number;
  advance(ms: number): void;
}

export function makeClock(start = Date.parse("2026-11-04T10:00:00Z")): Clock {
  const clock: Clock = { t: start, now: () => clock.t, advance: (ms) => void (clock.t += ms) };
  return clock;
}

const roots: string[] = [];

/** Agent dir under /tmp (macOS $TMPDIR is too long for unix sockets) with a gateway, its key file and v2 rules. */
export function makeSvcDir(rulesPatch: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync("/tmp/ags-");
  roots.push(root);
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(agentDir, "keys"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"));
  const keyFile = path.join(agentDir, "keys", "gw.key");
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { gw: { baseUrl: "http://gw.test/api", api: "anthropic-messages", apiKey: `!cat '${keyFile}'` } } }),
  );
  writeRules(agentDir, rulesPatch);
  return agentDir;
}

export function removeSvcDirs(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

export const homeOf = (agentDir: string) => path.join(path.dirname(agentDir), "home");
export const rulesFile = (agentDir: string) => path.join(agentDir, "guard", "rules.json");

export function writeRules(agentDir: string, patch: Record<string, any> = {}): void {
  const defaults = loadDefaultRules();
  const rules = {
    ...defaults,
    ...patch,
    decider: { ...defaults.decider, model: DECIDER_MODEL, ...(patch.decider ?? {}) },
    human: { ...defaults.human, waitSeconds: 180, ...(patch.human ?? {}) },
  };
  fs.mkdirSync(path.join(agentDir, "guard"), { recursive: true });
  fs.writeFileSync(rulesFile(agentDir), JSON.stringify(rules, null, 2));
}

export function readRules(agentDir: string): string {
  return fs.readFileSync(rulesFile(agentDir), "utf8");
}

export async function start(agentDir: string, options: Record<string, unknown> = {}) {
  return startService({ agentDir, home: homeOf(agentDir), telegram: null, tickMs: 10, ...options });
}

/** One JSON line out, the first JSON line back. */
export function send(sock: string, message: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        resolve(JSON.parse(buffer.slice(0, newline)));
        socket.destroy();
      }
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error(`connection closed without a reply: ${buffer}`)));
  });
}

/**
 * Subscribes on the admin socket; resolves after the acknowledgement. A claim round is answered «no» — a window with no
 * tab for the session — so the request falls through to every window and `events` holds only the events themselves.
 */
export function subscribe(sock: string): Promise<{ events: any[]; close(): void }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    const events: any[] = [];
    let buffer = "";
    let acked = false;
    socket.on("connect", () => socket.write(`${JSON.stringify({ op: "subscribe", protocol: 2 })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (!acked) {
          acked = true;
          resolve({ events, close: () => socket.destroy() });
        } else if (message?.event === "claim") {
          socket.write(`${JSON.stringify({ op: "claim", id: message.id, verdict: "no" })}\n`);
        } else events.push(message);
      }
    });
    socket.on("error", reject);
  });
}

export async function until<T>(predicate: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const bash = (command: string, session = SESSION) => ({ tool: "bash", input: { command }, cwd: CWD, session });
export const evalCall = (code: string, session = SESSION) => ({ tool: "eval", input: { language: "js", summary: "x", code }, cwd: CWD, session });
export const evaluate = (command: string, session = SESSION) => ({ op: "evaluate", call: bash(command, session) });
export const monitorCall = (command: string, session = SESSION) => ({ tool: "monitor", input: { type: "command", command }, cwd: CWD, session });
export const evaluateMonitor = (command: string, session = SESSION) => ({ op: "evaluate", call: monitorCall(command, session) });
