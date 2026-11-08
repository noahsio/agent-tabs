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
  const path = process.env["AGENT_TABS_BACKGROUND_LOG"];
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

describe.runIf(LIVE)("background-only input admission (live scratch OmO, cheapest model)", () => {
  const root = LIVE ? realpathSync(mkdtempSync("/tmp/at-background-")) : "";
  const agentDir = join(root, "agent");
  let manager: DaemonManager | undefined;

  beforeAll(() => {
    const key = readLiveKey();
    chmodSync(root, 0o700);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    copyFileSync(modelsSource, join(agentDir, "models.json"));
    const model = liveModel();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: model.provider, defaultModel: model.id, permissionPreset: "full-access",
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

  it.each(["prompt", "steer", "follow_up", "cancel", "cancel-task"])("measures %s while only background work remains", async (command) => {
    if (!manager) throw new Error("Scratch host was not initialized");
    const client = await manager.client();
    const cwd = join(root, command);
    mkdirSync(cwd);
    const opened = await client.request<Frame>("open_session", { cwd, retain_on_disconnect: true, promptSurface: "app" });
    const sessionId = String(opened["sessionId"]);
    const request = (type: string, fields: Frame = {}): Promise<Frame> => client.request(type, { sessionId, ...fields });
    const record = (frame: Frame): void => {
      if (frame["sessionId"] === sessionId && ["session_lifecycle", "agent_start", "agent_end", "queue_update"].includes(String(frame["type"]))) {
        recordMeasurement(`BACKGROUND[${command}] frame ${JSON.stringify(frame["type"] === "agent_end" ? { type: "agent_end", aborted: frame["aborted"] } : frame)}`);
      }
    };
    client.on("frame", record);
    try {
      await request("set_model", { provider: liveModel().provider, modelId: liveModel().id });
      const waiting = nextFrame(client, sessionId, (frame) =>
        frame["type"] === "session_lifecycle" && ["waiting_background", "waiting_children"].includes(String(object(frame["lifecycle"])["state"])));
      const code = command === "cancel-task"
        ? `print(await tool.task(${JSON.stringify({ subagent_type: "explore", model: `${liveModel().provider}/${liveModel().id}`, prompt: "This is an authorized scratch protocol test. Run bash sleep 90 in the foreground, then reply DONE. Do not read or edit files.", description: "Scratch cancellation probe", task_summary: "Wait for cancellation in the scratch host", run_in_background: true })}))`
        : "print(await tool.bash({command: 'sleep 90', run_in_background: true}))";
      await request("prompt", { message: `This is an authorized RPC protocol test in a disposable scratch directory. Execute this exact eval JS cell: ${code}. Then end your turn immediately with BACKGROUND-STARTED. Do not ask questions, create a goal or todo, read skills, wait, poll, or monitor. The test harness owns cleanup and observation.` });
      await waiting;
      const before = await request("get_state");
      recordMeasurement(`BACKGROUND[${command}] before ${JSON.stringify(before)}`);
      expect(before["isStreaming"]).toBe(false);
      if (command === "cancel-task") {
        const data = await request("extension_request", { name: "omo.task.list", data: { parent_session_id: before["sessionId"] } });
        const tasks = Array.isArray(data["tasks"]) ? data["tasks"].map(object) : [];
        recordMeasurement(`BACKGROUND[cancel-task] list ${JSON.stringify(data)}`);
        expect(tasks.length).toBeGreaterThan(0);
        recordMeasurement(`BACKGROUND[cancel-task] abort ${JSON.stringify(await request("abort", { awaitIdle: true, graceMs: 1_000 }))}`);
        for (const task of tasks) {
          const result = await request("extension_request", { name: "omo.task.cancel", data: { task_id: task["task_id"], parent_session_id: before["sessionId"] } });
          recordMeasurement(`BACKGROUND[cancel-task] cancel ${JSON.stringify(result)}`);
          expect(result["kind"]).toBe("cancelled");
        }
        recordMeasurement(`BACKGROUND[cancel-task] after-cancel ${JSON.stringify(await request("get_state"))}`);
        return;
      }
      if (command === "cancel") {
        recordMeasurement(`BACKGROUND[cancel] abort ${JSON.stringify(await request("abort", { awaitIdle: true, graceMs: 1_000 }))}`);
        recordMeasurement(`BACKGROUND[cancel] after-abort ${JSON.stringify(await request("get_state"))}`);
        recordMeasurement(`BACKGROUND[cancel] abort_bash ${JSON.stringify(await request("abort_bash"))}`);
        const afterAbort = await request("get_state");
        recordMeasurement(`BACKGROUND[cancel] after-abort-bash ${JSON.stringify(afterAbort)}`);
        expect(object(afterAbort["lifecycle"])["waitingOn"]).toEqual(object(before["lifecycle"])["waitingOn"]);
        const unloaded = await request("unload_session", { force: true });
        recordMeasurement(`BACKGROUND[cancel] unload ${JSON.stringify(unloaded)}`);
        expect(unloaded["outcome"]).toBe("unloaded");
        const reopened = await client.request<Frame>("open_session", { sessionPath: before["sessionFile"], cwd, retain_on_disconnect: true });
        const state = await client.request<Frame>("get_state", { sessionId: reopened["sessionId"] });
        recordMeasurement(`BACKGROUND[cancel] after-reopen ${JSON.stringify(state)}`);
        expect(object(object(state["lifecycle"])["waitingOn"])["background"]).toEqual([]);
        await client.request("release_attachment", { sessionId: reopened["sessionId"] });
        return;
      }
      const clientMessageId = `background-${command}`;
      const began = performance.now();
      const delivered = nextFrame(client, sessionId, (frame) =>
        frame["type"] === "message_start" && object(frame["message"])["role"] === "user" &&
        (frame["clientMessageId"] === clientMessageId || object(frame["message"])["clientMessageId"] === clientMessageId));
      let admission: Frame;
      try {
        admission = await request(command, { message: `Reply exactly RECEIVED-${command}`, clientMessageId });
        recordMeasurement(`BACKGROUND[${command}] admission ${JSON.stringify(admission)}`);
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        recordMeasurement(`BACKGROUND[${command}] refusal ${error.code}: ${error.message}`);
        throw error;
      }
      recordMeasurement(`BACKGROUND[${command}] after-input ${JSON.stringify(await request("get_state"))}`);
      await delivered;
      recordMeasurement(`BACKGROUND[${command}] delivered-after-ms ${Math.round(performance.now() - began)}`);
      expect(admission["disposition"]).toBe(command === "prompt" ? "started" : "queued");
    } finally {
      client.off("frame", record);
      if (command !== "cancel") {
        await request("abort", { awaitIdle: true, clearQueue: true });
        await request("release_attachment");
      }
    }
  }, 240_000);
});
