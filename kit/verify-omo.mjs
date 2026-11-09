#!/usr/bin/env node
// No-token verification of an OmO environment provisioned by setup-omo.
// Copies the environment's config into /tmp/omo-verify-<env>/agent (0700), starts a bare host there and checks over RPC:
// curated + superpowers skills, MCP codegraph connected, kit hooks trusted. Never touches the user's running hosts.
// Usage: node kit/verify-omo.mjs --env system|second [--home <dir>] [--settings <vscode settings.json>] [--keep]
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveEnv } from "./lib/envs.mjs";
import { parseJsonc } from "./lib/jsonc.mjs";
import { sourceKeyHash, trustedHash } from "./lib/trust.mjs";

const CONFIG_FILES = ["mcp.json", "settings.json", "hooks.json", "models.json", "auth.json", "config-identity.key", "state.json"];
const SETTINGS_BY_ENV = {
  system: (home) => path.join(home, "Library/Application Support/Code/User/settings.json"),
  second: (home) => path.resolve(home, process.env.AGENT_TABS_SECOND_VSCODE ?? ".vscode-portable", "code-portable-data/user-data/User/settings.json"),
};
const CLEAN_PREFIX = /^(ANTHROPIC_|OPENAI_|CLAUDE_|OMO_|SENPI_|PI_|GW_)/;
export const REQUIRED_SUPERPOWERS = ["skill:systematic-debugging", "skill:brainstorming", "skill:test-driven-development"];
export const REQUIRED_CURATED = ["skill:repo-task-proof-loop", "skill:prompt-master", "skill:security-audit"];

/** A check result: `ok` plus a human-readable `detail` (never contains secrets). */
const check = (name, ok, detail) => ({ name, ok, detail });

/** Pure: skills present in a get_commands payload. */
export function checkCommands(commands, required = [...REQUIRED_CURATED, ...REQUIRED_SUPERPOWERS]) {
  const names = new Set((Array.isArray(commands) ? commands : []).map((row) => row?.name));
  const missing = required.filter((name) => !names.has(name));
  return check("skills", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${required.length} required skills present`);
}

/** Pure: the `/hooks list` notification shows both kit hooks as trusted (status:trusted, disabled:false). */
export function checkHooksListing(text) {
  const lines = String(text).split("\n").filter((line) => line.includes("kit/") || line.includes("codegraph"));
  const trusted = lines.filter((line) => /status:trusted\b/.test(line) && /disabled:false/.test(line));
  return check("hooks (OmO view)", lines.length >= 2 && trusted.length === lines.length, `kit hook lines: ${lines.length}, trusted: ${trusted.length}`);
}

/** Pure: MCP server `name` is connected with at least one tool. */
export function checkMcp(surfaces, name = "codegraph") {
  const list = Array.isArray(surfaces?.mcpServers) ? surfaces.mcpServers : Array.isArray(surfaces?.mcp) ? surfaces.mcp : Array.isArray(surfaces) ? surfaces : [];
  const row = list.find((item) => item?.name === name);
  return check(
    `mcp ${name}`,
    row?.status === "connected" && row.toolCount >= 1,
    row ? `status=${row.status} tools=${row.toolCount}` : "not listed",
  );
}

/** Pure: every own hook record in hooks-state.json matches the hash OmO computes for `hooksFile`. */
export function checkTrustRecords(hooksConfig, state, hooksFile, isOwn) {
  const skh = sourceKeyHash("global", hooksFile);
  const problems = [];
  let seen = 0;
  for (const [event, groups] of Object.entries(hooksConfig.hooks ?? {})) {
    groups.forEach((group, groupIndex) =>
      (group.hooks ?? []).forEach((handler, handlerIndex) => {
        if (!isOwn(handler.command)) return;
        seen++;
        const id = `hk_${skh}_${event}_${groupIndex}_${handlerIndex}`;
        const record = state?.hooks?.[id];
        const expected = trustedHash({ event, handler, matcher: group.matcher, skh });
        if (!record) problems.push(`${id} has no record`);
        else if (record.enabled === false) problems.push(`${id} disabled`);
        else if (record.trustedHash !== expected) problems.push(`${id} hash mismatch`);
      }),
    );
  }
  if (seen === 0) problems.push("no kit hooks found");
  return check(`trust records (${path.basename(path.dirname(hooksFile))})`, problems.length === 0, problems.length ? problems.join("; ") : `${seen} kit hooks trusted for ${hooksFile}`);
}

export function readEnvSetting(settingsFile, name) {
  const settings = parseJsonc(fs.readFileSync(settingsFile, "utf8"));
  return (settings["agentTabs.environmentVariables"] ?? []).find((item) => item?.name === name)?.value;
}

export function readGatewayKey(settingsFile) {
  const value = readEnvSetting(settingsFile, "GW_API_KEY");
  if (!value) throw new Error(`GW_API_KEY not found in ${settingsFile}`);
  return value;
}

/** Pure: hook trust is bound to the exact OMO_CODING_AGENT_DIR spelling, so it must equal the path setup-omo hashed. */
export function checkAgentDirSpelling(configured, agentDir) {
  return check(
    "OMO_CODING_AGENT_DIR spelling",
    configured === agentDir,
    configured === agentDir ? `settings value equals ${agentDir}` : `settings value ${JSON.stringify(configured)} differs from ${agentDir}; hook trust would not match`,
  );
}

/** Pure: process exit code for a list of check results (0 only when there is at least one and all pass). */
export function exitCode(results) {
  return results.length > 0 && results.every((result) => result.ok) ? 0 : 1;
}

/** Create a private scratch root (mode 0700, unique name). */
export function makeScratchRoot(envName) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omo-verify-${envName}-`));
}

/**
 * Create a scratch root, copy the env's config into it, start a bare host there and run `body(context)`.
 * Cleanup starts the moment the root exists: whatever throws (copy, spawn ENOENT, body) or whichever signal arrives,
 * the host is stopped (only our child), awaited, and the root with its credential copies is removed.
 * `body` receives { scratchRoot, agentDir, connectClient() }.
 */
export async function withScratchHost({ envName, envInfo, kitMarker, omoBinary, extraEnv = {}, keep = false }, body) {
  const scratchRoot = makeScratchRoot(envName);
  let host;
  let spawnError = null;
  let disposing;
  const dispose = () => {
    disposing ??= (async () => {
      try {
        if (host?.pid !== undefined && host.exitCode === null && host.signalCode === null) {
          const exited = new Promise((resolve) => host.once("exit", resolve));
          host.kill("SIGTERM");
          const timer = setTimeout(() => host.kill("SIGKILL"), 5000);
          await exited;
          clearTimeout(timer);
        }
        if (!keep) fs.rmSync(scratchRoot, { recursive: true, force: true });
      } finally {
        // Handlers stay until cleanup has settled, so a repeated signal cannot fall to Node's default mid-cleanup.
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    })();
    return disposing;
  };
  // dispose is memoized: a repeated signal only re-awaits the cleanup already running.
  const onSignal = () => void dispose().finally(() => process.exit(130));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const agentDir = await makeScratch(envInfo, scratchRoot, kitMarker);
    const socketPath = path.join(agentDir, "rpc", "agent-tabs.sock");
    const env = cleanEnv(process.env, {
      OMO_CODING_AGENT_DIR: agentDir,
      OMO_MEMORY_HOME: path.join(scratchRoot, "memory"),
      OMO_DISABLE_TELEMETRY: "1",
      SENPI_MEMORY_REFLECTION: "1",
      SENPI_MEMORY_FACTS: "1",
      ...extraEnv,
    });
    host = spawn(omoBinary, ["--mode", "rpc", "--listen", `unix://${socketPath}`], { env, cwd: scratchRoot, stdio: "ignore" });
    host.on("error", (error) => {
      spawnError = new Error(`omo host could not start: ${error.message}`);
    });
    return await body({
      scratchRoot,
      agentDir,
      connectClient: () => connect(socketPath, agentDir, 60000, () => spawnError),
    });
  } finally {
    await dispose();
  }
}

/** Copy the environment's config into scratchRoot/agent and re-trust the kit hooks for the scratch hooks.json path. */
export async function makeScratch(envInfo, scratchRoot, kitMarker) {
  const agent = path.join(scratchRoot, "agent");
  fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
  fs.chmodSync(scratchRoot, 0o700);
  fs.chmodSync(agent, 0o700);
  for (const name of CONFIG_FILES) {
    const source = path.join(envInfo.agentDir, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(agent, name));
  }
  const coordinate = path.join(envInfo.agentDir, "extensions/coordinate.ts");
  if (fs.existsSync(coordinate)) {
    fs.mkdirSync(path.join(agent, "extensions"), { recursive: true });
    fs.copyFileSync(coordinate, path.join(agent, "extensions/coordinate.ts"));
  }
  const { buildHooksState } = await import("./lib/trust.mjs");
  const hooksFile = path.join(agent, "hooks.json");
  const config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  const state = buildHooksState(config, hooksFile, {}, undefined, { isOwn: (command) => command.includes(kitMarker) });
  fs.writeFileSync(path.join(agent, "hooks-state.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  return agent;
}

export function cleanEnv(base, extra) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (!CLEAN_PREFIX.test(key)) env[key] = value;
  return { ...env, ...extra };
}

export class RpcClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.frames = [];
    this.waiters = [];
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          this.frames.push(frame);
          for (const waiter of this.waiters.slice()) waiter(frame);
        } catch {
          /* ignore non-JSON */
        }
      }
    });
  }
  wait(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const hit = this.frames.find(predicate);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const waiter = (frame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        resolve(frame);
      };
      this.waiters.push(waiter);
    });
  }
  async request(frame, timeoutMs = 30000) {
    const id = `v${Math.random().toString(36).slice(2, 8)}`;
    this.socket.write(JSON.stringify({ ...frame, id }) + "\n");
    return this.wait((item) => item.type === "response" && item.id === id, timeoutMs);
  }
}

export async function connect(socketPath, agentDir, timeoutMs, abort = () => null) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stop = abort();
    if (stop) throw stop;
    try {
      const socket = await new Promise((resolve, reject) => {
        const candidate = net.createConnection(socketPath);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", reject);
      });
      socket.setEncoding("utf8");
      const client = new RpcClient(socket);
      const nonce = crypto.randomBytes(32).toString("hex");
      const info = await client.request({ type: "get_protocol_info", auth: { client_nonce: nonce } }, 15000);
      const auth = info?.data?.auth;
      if (!auth) throw new Error("no auth info");
      const key = Buffer.from(JSON.parse(fs.readFileSync(path.join(agentDir, "rpc", "keys", auth.launch_id), "utf8")).key, "hex");
      const proof = crypto.createHmac("sha256", key).update(["senpi-rpc-client", auth.launch_id, auth.server_nonce, nonce].join("\n")).digest("hex");
      const reply = await client.request({ type: "authenticate", client_proof: proof }, 15000);
      if (!reply?.success) throw new Error("authentication refused");
      return client;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`host did not become ready: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = { env: null, home: os.homedir(), settings: null, keep: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env") options.env = args[++i];
    else if (args[i] === "--home") options.home = path.resolve(args[++i]);
    else if (args[i] === "--settings") options.settings = path.resolve(args[++i]);
    else if (args[i] === "--keep") options.keep = true;
    else throw new Error(`unknown argument ${args[i]}`);
  }
  if (!options.env || !SETTINGS_BY_ENV[options.env]) throw new Error("--env system|second is required");
  const envInfo = resolveEnv(options.env, options.home);
  const kitMarker = path.join(options.home, ".omo/kit") + path.sep;
  const isOwn = (command) => typeof command === "string" && command.includes(kitMarker);
  const results = [];

  // Real-path trust: the provisioned hooks-state matches the hashes for the real hooks.json path.
  const realHooks = path.join(envInfo.agentDir, "hooks.json");
  const realState = path.join(envInfo.agentDir, "hooks-state.json");
  results.push(
    checkTrustRecords(JSON.parse(fs.readFileSync(realHooks, "utf8")), JSON.parse(fs.readFileSync(realState, "utf8")), realHooks, isOwn),
  );
  const canonical = fs.realpathSync(realHooks);
  results.push(check("real path is canonical", canonical === realHooks, canonical === realHooks ? "no symlink in agent dir path" : `realpath differs: ${canonical}`));

  const settingsFile = options.settings ?? SETTINGS_BY_ENV[options.env](options.home);
  results.push(checkAgentDirSpelling(readEnvSetting(settingsFile, "OMO_CODING_AGENT_DIR"), envInfo.agentDir));
  const gatewayKey = readGatewayKey(settingsFile);
  try {
    await withScratchHost(
      {
        envName: options.env,
        envInfo,
        kitMarker,
        omoBinary: path.join(options.home, ".local/bin/omo"),
        extraEnv: { GW_API_KEY: gatewayKey, ...(options.env === "second" ? { CLAUDE_CONFIG_DIR: envInfo.claudeDir } : {}) },
        keep: options.keep,
      },
      async ({ scratchRoot, connectClient }) => {
    const client = await connectClient();
    const opened = await client.request({ type: "open_session", cwd: scratchRoot });
    const sessionId = opened?.data?.sessionId;
    if (process.env.VERIFY_DEBUG) console.log("open_session:", JSON.stringify(opened)?.slice(0, 300));
    results.push(check("open_session", Boolean(sessionId), sessionId ? "session opened" : String(opened?.error)));
    const commands = await client.request({ type: "get_commands", sessionId });
    if (process.env.VERIFY_DEBUG) console.log("get_commands:", JSON.stringify(commands)?.slice(0, 600));
    results.push(checkCommands(commands?.data?.commands));
    // MCP servers connect lazily after startup: poll briefly.
    let surfaces;
    for (let attempt = 0; attempt < 20; attempt++) {
      surfaces = (await client.request({ type: "get_loaded_surfaces", sessionId }))?.data;
      if (checkMcp(surfaces).ok) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    results.push(checkMcp(surfaces));
    const extensions = (Array.isArray(surfaces?.extensions) ? surfaces.extensions : []).map((item) => item?.name);
    results.push(check("coordinate extension", extensions.includes("coordinate"), extensions.includes("coordinate") ? "coordinate discovered" : "coordinate missing"));
    const mark = client.frames.length;
    const listed = await client.request({ type: "prompt", message: "/hooks list", sessionId });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const text = client.frames
      .slice(mark)
      .filter((frame) => frame.type === "extension_ui_request" && frame.method === "notify")
      .map((frame) => String(frame.message ?? ""))
      .join("\n");
    if (process.env.VERIFY_DEBUG) console.log("hooks list:", JSON.stringify(listed)?.slice(0, 200), text.slice(0, 3000));
    results.push(checkHooksListing(text));
    // the superpowers package loads: its bootstrap extension (<clone>/.pi/extensions/superpowers.ts) is named superpowers
    results.push(check("hooks extension and superpowers package", extensions.includes("hooks") && extensions.includes("superpowers"), `extensions loaded: ${extensions.length}`));
    if (process.env.VERIFY_DEBUG) console.log("surface keys:", Object.keys(surfaces ?? {}), JSON.stringify(Object.fromEntries(Object.entries(surfaces ?? {}).filter(([key]) => key !== "extensions"))).slice(0, 3000));
      },
    );
  } catch (error) {
    results.push(check("host", false, error.message));
  }

  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}: ${result.detail}`);
  process.exit(exitCode(results));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`verify-omo: ${error.message}`);
    process.exit(1);
  });
}
