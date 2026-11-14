import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { RpcError, type RpcClient } from "../../src/rpc/client";
import { liveModel, modelsSource, readLiveKey, sourceEnv } from "./config";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
type Frame = Record<string, unknown>;

function recordMeasurement(text: string): void {
  console.log(text);
  const path = process.env["AGENT_TABS_COMPACT_LOG"];
  if (path) appendFileSync(path, `${text}\n`);
}

function object(value: unknown): Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/** Subscribe before sending: the measurement must not miss a fast lifecycle or delivery. */
function nextFrame(client: RpcClient, sessionId: string, matches: (frame: Frame) => boolean, timeoutMs = 120_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("frame", receive);
      reject(new Error(`No matching frame for ${sessionId} in ${timeoutMs} ms`));
    }, timeoutMs);
    function receive(frame: Frame): void {
      if (frame["sessionId"] !== sessionId || !matches(frame)) return;
      clearTimeout(timer);
      client.off("frame", receive);
      resolve(frame);
    }
    client.on("frame", receive);
  });
}

describe.runIf(LIVE)("stopping a compaction (live scratch OmO, cheapest model)", () => {
  const root = LIVE ? realpathSync(mkdtempSync("/tmp/at-compact-")) : "";
  const agentDir = join(root, "agent");
  let manager: DaemonManager | undefined;

  beforeAll(() => {
    const key = readLiveKey();
    chmodSync(root, 0o700);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    copyFileSync(modelsSource, join(agentDir, "models.json"));
    const model = liveModel();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: model.provider, defaultModel: model.id, permissionPreset: "full-access", compaction: { keepRecentTokens: 100 },
    }));
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: agentDir },
        { name: "CLAUDE_CONFIG_DIR", value: sourceEnv.claudeDir },
        { name: "GW_API_KEY", value: key },
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`Incomplete environment: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
  });

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(agentDir);
    if (LIVE) rmSync(root, { recursive: true, force: true });
  }, 30_000);


  // Measures the «Стоп» for a compaction the person started: OmO's documented compaction_end carries `aborted`; this
  // checks that a plain `abort` sent while it runs is what sets it.
  it("abort_stops_a_running_compaction", async () => {
    if (!manager) throw new Error("Scratch host was not initialized");
    const client = await manager.client();
    const cwd = join(root, "compact");
    mkdirSync(cwd);
    const opened = await client.request<Frame>("open_session", { cwd, retain_on_disconnect: true, promptSurface: "app" });
    const sessionId = String(opened["sessionId"]);
    const request = (type: string, fields: Frame = {}): Promise<Frame> => client.request(type, { sessionId, ...fields });
    await request("set_model", { provider: liveModel().provider, modelId: liveModel().id });
    for (const word of ["first", "second"]) {
      const ended = nextFrame(client, sessionId, (frame) => frame["type"] === "agent_end");
      await request("prompt", { message: `Scratch protocol test. Write three short paragraphs about the colour ${word === "first" ? "blue" : "green"}. No tools.` });
      await ended;
    }
    const started = nextFrame(client, sessionId, (frame) => frame["type"] === "compaction_start");
    const ended = nextFrame(client, sessionId, (frame) => frame["type"] === "compaction_end");
    const compacting = request("compact").then((data) => ({ ok: true, data }), (error: unknown) => ({ ok: false, error: error instanceof RpcError ? { code: error.code, message: error.message } : String(error) }));
    await started;
    const at = Date.now();
    recordMeasurement(`COMPACT abort ${JSON.stringify(await request("abort"))}`);
    const end = await ended;
    recordMeasurement(`COMPACT end after ${Date.now() - at} ms ${JSON.stringify({ aborted: end["aborted"], result: end["result"] === null ? null : "summary", errorMessage: end["errorMessage"] })}`);
    recordMeasurement(`COMPACT response ${JSON.stringify(await compacting)}`);
    const state = await request("get_state");
    recordMeasurement(`COMPACT state isCompacting=${String(state["isCompacting"])} isStreaming=${String(state["isStreaming"])}`);
    expect(end["aborted"]).toBe(true);
  }, 300_000);
});
