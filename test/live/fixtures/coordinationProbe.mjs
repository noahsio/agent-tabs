// Test-only extension, copied to a disposable agent dir by coordination.live.test.ts.
import fs from "node:fs";
import net from "node:net";
import { runThinHook } from "__GUARD_MODULE__";

export default function coordinationProbe(pi) {
  const record = (event) => fs.appendFileSync(process.env.AGENT_TABS_COORDINATION_LOG, `${JSON.stringify(event)}\n`);
  pi.registerTool({
    name: "coordination_probe",
    label: "Проверка сокета",
    description: "Проверить связь с hook-сокетом службы защиты. Ничего не меняет.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const started = performance.now();
      const reply = await new Promise((resolve, reject) => {
        const socket = net.createConnection(process.env.AGENT_TABS_PROBE_SOCKET);
        let text = "";
        socket.setTimeout(1500, () => socket.destroy(new Error("Probe timed out")));
        socket.on("connect", () => socket.write('{"op":"coordination.feasibility-probe"}\n'));
        socket.on("error", reject);
        socket.on("data", (chunk) => {
          text += chunk;
          if (!text.includes("\n")) return;
          socket.destroy();
          resolve(JSON.parse(text.slice(0, text.indexOf("\n"))));
        });
      });
      record({ kind: "probe", reply, ms: performance.now() - started });
      return { content: [{ type: "text", text: JSON.stringify(reply) }], details: reply };
    },
  });
  pi.on("session_start", (_event, ctx) => {
    pi.setActiveTools(["read", "write", "edit", "coordination_probe"]);
    record({ kind: "registered", session: ctx.sessionManager.getSessionId(), tools: pi.getAllTools().filter((tool) => tool.name === "coordination_probe").map((tool) => tool.name) });
  });
  pi.on("tool_call", async (event, ctx) => {
    const raw = { tool_name: event.toolName, tool_input: event.input, cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId() };
    const result = await runThinHook(raw, { agentDir: process.env.OMO_CODING_AGENT_DIR });
    record({ kind: "guard", session: raw.session_id, tool: raw.tool_name, input: raw.tool_input, result });
    if (result.hookSpecificOutput?.permissionDecision === "deny") return { block: true, reason: result.hookSpecificOutput.permissionDecisionReason };
    return undefined;
  });
}
