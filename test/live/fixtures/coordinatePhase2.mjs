// Observes production tools and applies the production guard in a disposable live environment.
import fs from "node:fs";
import coordinate from "__COORDINATE_MODULE__";
import { runThinHook } from "__GUARD_MODULE__";

export default function phaseTwo(pi) {
  coordinate(pi);
  const record = (event) => fs.appendFileSync(process.env.AGENT_TABS_COORDINATION_LOG, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  pi.on("session_start", (_event, ctx) => {
    pi.setActiveTools(["read", "write", "edit", "eval", "coordinate"]);
    record({ kind: "start", session: ctx.sessionManager.getSessionId(), tools: pi.getActiveTools() });
  });
  pi.on("tool_call", async (event, ctx) => {
    const raw = { tool_name: event.toolName, tool_input: event.input, cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId() };
    const result = await runThinHook(raw, { agentDir: process.env.OMO_CODING_AGENT_DIR });
    record({ kind: "guard", session: raw.session_id, tool: raw.tool_name, input: raw.tool_input, result });
    if (result.hookSpecificOutput?.permissionDecision === "deny") return { block: true, reason: result.hookSpecificOutput.permissionDecisionReason };
    return undefined;
  });
  pi.on("tool_result", (event, ctx) => {
    record({ kind: "result", session: ctx.sessionManager.getSessionId(), tool: event.toolName, input: event.input, details: event.details });
  });
  pi.on("agent_end", (event, ctx) => {
    record({ kind: "end", session: ctx.sessionManager.getSessionId(), messages: event.messages
      .filter((message) => message.role === "assistant").slice(-2).map((message) =>
        message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")) });
  });
}
