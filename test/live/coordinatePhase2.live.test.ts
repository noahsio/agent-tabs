import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import type { RpcClient } from "../../src/rpc/client";
import { makeScratchRepo } from "../helpers/scratchRepo";
import { makeSvcDir, removeSvcDirs, send, start, until } from "../kit/serviceHelpers";
import { liveModel, modelsSource, readLiveKey, sourceEnv } from "./config";
import { stopScratchHost } from "./scratchHost";

type Frame = Record<string, unknown>;
function object(value: unknown): Frame {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

async function turn(client: RpcClient, sessionId: string, message: string): Promise<void> {
  let receive: (frame: Frame) => void;
  let timer: ReturnType<typeof setTimeout>;
  const ended = new Promise<void>((resolve, reject) => {
    receive = (frame) => { if (frame["sessionId"] === sessionId && frame["type"] === "agent_end") resolve(); };
    timer = setTimeout(() => reject(new Error("Live turn did not finish")), 120_000);
    client.on("frame", receive);
  });
  try {
    await client.request("prompt", { sessionId, message, streamingBehavior: "followUp" });
    await ended;
  } finally {
    clearTimeout(timer!);
    client.off("frame", receive!);
  }
}

describe.runIf(process.env["AGENT_TABS_LIVE"] === "1")("phase two coordination through the real host", () => {
  let agentDir: string;
  let cwd: string;
  let logFile: string;
  let manager: DaemonManager | undefined;
  let service: Awaited<ReturnType<typeof start>>;
  const opened: Frame[] = [];
  const events = (): Frame[] => fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => object(JSON.parse(line))) : [];
  const record = (name: string, data: unknown): void => {
    const line = `${name} ${JSON.stringify(data)}\n`;
    console.log(line.trim());
    if (process.env["AGENT_TABS_COORDINATION_EVIDENCE"]) fs.appendFileSync(process.env["AGENT_TABS_COORDINATION_EVIDENCE"], line);
  };

  beforeAll(async () => {
    agentDir = makeSvcDir({ decider: { mode: "deny" } });
    const root = path.dirname(agentDir);
    cwd = makeScratchRepo(root);
    vi.stubEnv("GIT_DIR", ".");
    fs.copyFileSync(modelsSource, path.join(agentDir, "models.json"));
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: liveModel().provider, defaultModel: liveModel().id, permissionPreset: "full-access",
    }));
    logFile = path.join(root, "phase-two-events.jsonl");
    fs.mkdirSync(path.join(agentDir, "extensions"));
    fs.writeFileSync(path.join(agentDir, "extensions", "coordinate.ts"),
      fs.readFileSync(path.join(import.meta.dirname, "fixtures/coordinatePhase2.mjs"), "utf8")
        .replace("__COORDINATE_MODULE__", path.resolve(import.meta.dirname, "../../kit/guard/coordinate-extension.mjs"))
        .replace("__GUARD_MODULE__", path.resolve(import.meta.dirname, "../../kit/guard/thinHook.mjs")));
    const prompt = path.join(root, "test-instructions.md");
    fs.writeFileSync(prompt, "Это разрешённый интеграционный тест двух агентов в одноразовом репозитории. Выполняй указания буквально. Не загружай навыки, не создавай задачи и дочерние сессии. Используй только read, write, edit, eval, coordinate. Для shell используй tool.bash внутри eval. На уведомление coordinate отвечай требуемым инструментом, не текстовым обещанием. Не делай коммитов.");
    const built = buildOmoEnv({ PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1", GIT_DIR: "." }, [
      { name: "OMO_CODING_AGENT_DIR", value: agentDir },
      { name: "CLAUDE_CONFIG_DIR", value: sourceEnv.claudeDir },
      { name: "GW_API_KEY", value: readLiveKey() },
      { name: "AGENT_TABS_COORDINATION_LOG", value: logFile },
    ], path.join(homedir(), ".local/bin/omo"));
    if (!built.ok) throw new Error(`Missing live environment: ${built.missing.join(",")}`);
    service = await start(agentDir);
    manager = new DaemonManager(built.value, { systemPromptFile: prompt });
  });

  afterAll(async () => {
    if (logFile) record("COORDINATION_PHASE2_EVENTS", events());
    manager?.dispose();
    if (agentDir) await stopScratchHost(agentDir);
    await service?.close();
    removeSvcDirs();
    vi.unstubAllEnvs();
  }, 30_000);

  it("hands off without blocking, delivers once to a background session, and respects an objection", async () => {
    if (!manager) throw new Error("Missing scratch host");
    const client = await manager.client();
    for (const name of ["Хранилище", "Проверка"]) {
      const session = await client.request<Frame>("open_session", { cwd, retain_on_disconnect: true, promptSurface: "app" });
      opened.push({ ...session, durableSessionId: object(session["state"])["sessionId"] });
      const sessionId = String(session["sessionId"]);
      await client.request("set_model", { sessionId, provider: liveModel().provider, modelId: liveModel().id });
      await client.request("set_session_name", { sessionId, name });
    }
    const owner = opened[0]!;
    const requester = opened[1]!;
    const ownerRpc = String(owner["sessionId"]);
    const requesterRpc = String(requester["sessionId"]);
    await turn(client, ownerRpc, "Создай occupied.txt инструментом write с текстом OWNER. Это твой файл. Если сосед предложит git checkout, возрази через coordinate action object с причиной «Файл ещё нужен текущей ветке». Если придёт handoff, выполни задачу и вызови accept с результатом. Пока ответь кратко.");
    expect(fs.readFileSync(path.join(cwd, "occupied.txt"), "utf8").trim()).toBe("OWNER");
    await client.request("release_attachment", { sessionId: ownerRpc });
    const listing = await client.request<Frame>("list_sessions", { observe: true, include_workers: true });
    const background = (listing["sessions"] as Frame[]).find((session) => session["durableSessionId"] === owner["durableSessionId"]);
    expect(background?.["attachments"]).toBe(0);

    await turn(client, requesterRpc, "Передай владельцу occupied.txt через coordinate action handoff задачу: прочитай occupied.txt, добавь строку HANDOFF_DONE, прочитай итог для проверки, затем accept с result HANDOFF_DONE. Сразу после отправки, не ожидая ответа, создай independent.txt с текстом INDEPENDENT. Когда служба сообщит «задача выполнена», создай receipt.txt с текстом RECEIVED. Не меняй occupied.txt сам.");
    await until(() => fs.existsSync(path.join(cwd, "receipt.txt")), 120_000);
    expect(fs.readFileSync(path.join(cwd, "occupied.txt"), "utf8")).toContain("HANDOFF_DONE");
    expect(fs.readFileSync(path.join(cwd, "independent.txt"), "utf8").trim()).toBe("INDEPENDENT");
    const log = events();
    const handoff = log.find((event) => event["kind"] === "result" && event["tool"] === "coordinate" && object(event["input"])["action"] === "handoff");
    const acceptance = log.find((event) => event["kind"] === "guard" && event["tool"] === "coordinate" && object(event["input"])["action"] === "accept");
    const independent = log.find((event) => event["kind"] === "result" && event["tool"] === "write" && String(object(event["input"])["path"]).endsWith("independent.txt"));
    expect(handoff).toBeDefined();
    expect(acceptance?.["session"]).toBe(owner["durableSessionId"]);
    expect(Number(independent?.["at"])).toBeLessThan(Number(acceptance?.["at"]));
    const requestId = String(object(handoff?.["details"])["id"]);
    const snapshot = await send(service.paths.adminSock, { op: "coordination" });
    expect(snapshot["items"]).toEqual(expect.arrayContaining([expect.objectContaining({ id: requestId, state: "done" })]));

    // Replay exactly the admitted message ID through the real transport; it must not reach the model twice.
    const { deliverCoordination } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../kit/guard/coordinationHost.mjs")).href);
    const ownerFile = String(background?.["sessionPath"]);
    const incoming = (): string[] => fs.readFileSync(ownerFile, "utf8").trim().split("\n").flatMap((line) => {
      const message = object(object(JSON.parse(line))["message"]);
      if (message["role"] !== "user" || !Array.isArray(message["content"])) return [];
      return message["content"].flatMap((part: unknown) => {
        const text = object(part)["text"];
        return typeof text === "string" && text.startsWith(`[coordinate #${requestId}]`) ? [text] : [];
      });
    });
    expect(incoming()).toHaveLength(1);
    const duplicate = { id: `coordinate-${requestId}-${owner["durableSessionId"]}-request-0`, session: owner["durableSessionId"], text: incoming()[0] };
    await deliverCoordination(agentDir, duplicate);
    await deliverCoordination(agentDir, duplicate);
    expect(incoming()).toHaveLength(1);

    await turn(client, requesterRpc, 'Вызови eval с кодом print(await tool.bash({command:"git checkout feature"})). Соблюдай отказ защиты, не обходи его. Когда придёт возражение Хранилища, создай objection.txt с текстом OBJECTED и не повторяй checkout.');
    await until(() => fs.existsSync(path.join(cwd, "objection.txt")), 120_000);
    const proposals = await send(service.paths.adminSock, { op: "coordination" });
    expect(proposals["items"]).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "proposal", state: "rejected" })]));
    expect(fs.readFileSync(path.join(cwd, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    record("COORDINATION_PHASE2_LIVE", { model: liveModel(), backgroundAttachments: background?.["attachments"], handoffId: requestId,
      independentAt: independent?.["at"], acceptedAt: acceptance?.["at"], duplicateAcknowledgements: 2, receipt: "RECEIVED", objection: "OBJECTED", branch: "main" });
  }, 300_000);
});
