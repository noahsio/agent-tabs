import { request, servicePaths } from "./sockets.mjs";

/** The tool cannot choose its caller id: identity is supplied only by the session runtime. */
export default function coordinateExtension(pi) {
  const call = (ctx, input) => request(servicePaths(process.env.OMO_CODING_AGENT_DIR).hookSock, {
    op: "coordinate",
    call: { tool: "coordinate", input, cwd: ctx.cwd, session: ctx.sessionManager.getSessionId() },
  }, 1500);
  const hello = async (ctx) => {
    try { await call(ctx, { action: "hello", title: ctx.sessionManager.getSessionName() ?? "", idle: ctx.isIdle(), activity: ctx.isIdle() ? "Ожидает задачи" : "Выполняет задачу" }); }
    catch (error) { console.error(`[coordinate] registration unavailable: ${error.message}`); }
  };
  pi.registerTool({
    name: "coordinate",
    label: "Согласование",
    description: "Согласование с соседями по рабочей копии. who: имена, занятие и аренды соседей; handoff(file,what): передать задачу владельцу файла; " +
      "accept(id,result): задача уже выполнена; decline(id,reason): отказаться с причиной; request(file): попросить аренду; release(file): отпустить аренду; " +
      "agree(id), object(id,reason), wait(id,minutes ≤30): ответ на предложение; status(id): состояние. Молчание не означает согласие; продолжайте независимую работу.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["who", "handoff", "accept", "decline", "request", "release", "agree", "object", "wait", "status"] },
        file: { type: "string", description: "Путь файла, относительно текущего каталога или абсолютный" },
        what: { type: "string", maxLength: 2000, description: "Что сделать владельцу файла" },
        id: { type: "string", description: "Идентификатор запроса из сообщения службы" },
        result: { type: "string", maxLength: 2000, description: "Итог выполненной задачи" },
        reason: { type: "string", maxLength: 2000 },
        minutes: { type: "number", exclusiveMinimum: 0, maximum: 30 },
      },
    },
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      try {
        const result = await call(ctx, input);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: `Служба координации недоступна: ${error.message}. Согласие не получено; продолжайте независимую работу.` }], details: { ok: false } };
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => hello(ctx));
  pi.on("tool_call", async (_event, ctx) => hello(ctx));
  pi.on("agent_start", async (_event, ctx) => hello(ctx));
  pi.on("agent_end", async (_event, ctx) => hello(ctx));
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    try { await call(ctx, { action: "close", reason: event.reason }); }
    catch (error) { console.error(`[coordinate] close unavailable; leases expire by TTL: ${error.message}`); }
  });
}
