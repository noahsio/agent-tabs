import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import type { RpcClient } from "../../src/rpc/client";
import { AUTONOMY_RULE } from "../../src/sessions/autonomyRule";
import { makeScratchRepo } from "../helpers/scratchRepo";
import { makeSvcDir, removeSvcDirs, start } from "../kit/serviceHelpers";
import { liveModel, modelsSource, readLiveKey, sourceEnv } from "./config";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
type Frame = Record<string, unknown>;
function object(value: unknown): Frame {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

async function turn(client: RpcClient, sessionId: string, message: string): Promise<string> {
  const messages: string[] = [];
  const ended = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { client.off("frame", receive); reject(new Error("Live turn did not finish")); }, 120_000);
    function receive(frame: Frame): void {
      if (frame["sessionId"] !== sessionId) return;
      if (frame["type"] === "message_end") {
        const message = object(frame["message"]);
        if (message["role"] === "assistant" && Array.isArray(message["content"])) {
          for (const item of message["content"].map(object)) if (item["type"] === "text") messages.push(String(item["text"]));
        }
      }
      if (frame["type"] === "agent_end") { clearTimeout(timer); client.off("frame", receive); resolve(); }
    }
    client.on("frame", receive);
  });
  await client.request("prompt", { sessionId, message });
  await ended;
  return messages.join("\n");
}

describe.runIf(LIVE)("coordination feasibility (two live scratch sessions, cheapest model)", () => {
  let agentDir: string;
  let cwd: string;
  let logFile: string;
  let manager: DaemonManager | undefined;
  let service: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    agentDir = makeSvcDir({ decider: { mode: "deny" } });
    const root = path.dirname(agentDir);
    cwd = makeScratchRepo(root);
    vi.stubEnv("GIT_DIR", ".");
    fs.copyFileSync(modelsSource, path.join(agentDir, "models.json"));
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: liveModel().provider, defaultModel: liveModel().id, permissionPreset: "full-access",
    }));
    logFile = path.join(root, "events.jsonl");
    fs.mkdirSync(path.join(agentDir, "extensions"));
    fs.writeFileSync(path.join(agentDir, "extensions", "coordination.ts"),
      fs.readFileSync(path.join(import.meta.dirname, "fixtures/coordinationProbe.mjs"), "utf8")
        .replace("__GUARD_MODULE__", path.resolve(import.meta.dirname, "../../kit/guard/thinHook.mjs")));
    const prompt = path.join(root, "autonomy.md");
    fs.writeFileSync(prompt, AUTONOMY_RULE);
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1", GIT_DIR: "." },
      [
        { name: "OMO_CODING_AGENT_DIR", value: agentDir },
        { name: "CLAUDE_CONFIG_DIR", value: sourceEnv.claudeDir },
        { name: "GW_API_KEY", value: readLiveKey() },
        { name: "AGENT_TABS_COORDINATION_LOG", value: logFile },
        { name: "AGENT_TABS_PROBE_SOCKET", value: process.env["AGENT_TABS_PROBE_SOCKET"] ?? path.join(process.env["OMO_CODING_AGENT_DIR"] ?? sourceEnv.agentDir, "guard/hook.sock") },
      ],
      path.join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`Missing live environment: ${built.missing.join(",")}`);
    service = await start(agentDir);
    manager = new DaemonManager(built.value, { systemPromptFile: prompt });
  });
  afterAll(async () => {
    manager?.dispose();
    if (agentDir) await stopScratchHost(agentDir);
    await service?.close();
    removeSvcDirs();
    vi.unstubAllEnvs();
  }, 30_000);

  it("loads a callable tool, reaches the socket, and respects a neighbour's lease and request", async () => {
    if (!manager) throw new Error("Scratch host was not initialized");
    const client = await manager.client();
    const sessions: string[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const opened = await client.request<Frame>("open_session", { cwd, retain_on_disconnect: true, promptSurface: "app" });
        const sessionId = String(opened["sessionId"]);
        sessions.push(sessionId);
        await client.request("set_model", { sessionId, provider: liveModel().provider, modelId: liveModel().id });
      }
      const [owner, neighbour] = sessions;
      if (!owner || !neighbour) throw new Error("Two sessions are required");
      expect(fs.existsSync(logFile), "The extension must load before any model call").toBe(true);
      const intro = "Это разрешённый тест в одноразовом репозитории. Не читай навыки, не создавай goal/todo, не запускай фоновые задачи. ";
      const first = await turn(client, owner, `${intro}Вызови coordination_probe, затем инструментом write создай occupied.txt с содержимым OWNER. Оставь файл за собой для дальнейшей работы. Ответь кратко.`);
      expect(fs.readFileSync(path.join(cwd, "occupied.txt"), "utf8")).toContain("OWNER");
      const second = await turn(client, neighbour, `${intro}Инструментом write запиши NEIGHBOUR в occupied.txt. Если защита откажет, соблюдай правило общей копии. Независимая задача: запиши INDEPENDENT в independent.txt. Ответь кратко.`);
      expect(fs.readFileSync(path.join(cwd, "occupied.txt"), "utf8")).toContain("OWNER");
      expect(fs.readFileSync(path.join(cwd, "independent.txt"), "utf8")).toContain("INDEPENDENT");
      const request = await turn(client, owner, `${intro}Сообщение соседней сессии: «Мне нужен occupied.txt. Ты ещё правишь его? Можно ли передать мне файл?» Ответь соседу по правилу общей копии, без изменения файлов.`);
      expect(request.trim().length).toBeGreaterThan(0);
      const events = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => object(JSON.parse(line)));
      const measurement = `COORDINATION_LIVE ${JSON.stringify({ model: liveModel(), first, second, request, probes: events.filter((event) => event["kind"] === "probe"), denials: events.filter((event) => object(object(event["result"])["hookSpecificOutput"])["permissionDecision"] === "deny") })}`;
      console.log(measurement);
      if (process.env["AGENT_TABS_COORDINATION_EVIDENCE"]) fs.appendFileSync(process.env["AGENT_TABS_COORDINATION_EVIDENCE"], `${measurement}\n`);
      expect(events.some((event) => event["kind"] === "registered" && Array.isArray(event["tools"]) && event["tools"].includes("coordination_probe"))).toBe(true);
      expect(events.some((event) => event["kind"] === "probe" && object(event["reply"])["error"] === "unknown op")).toBe(true);
      expect(events.some((event) => object(object(event["result"])["hookSpecificOutput"])["permissionDecision"] === "deny")).toBe(true);
    } finally {
      const evidence = `COORDINATION_EVENTS ${fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "extension was not discovered"}`;
      console.log(evidence);
      if (process.env["AGENT_TABS_COORDINATION_EVIDENCE"]) fs.appendFileSync(process.env["AGENT_TABS_COORDINATION_EVIDENCE"], `${evidence}\n`);
      for (const sessionId of sessions) {
        await client.request("abort", { sessionId, awaitIdle: true, clearQueue: true });
        await client.request("release_attachment", { sessionId });
      }
    }
  }, 240_000);
});
