// Thin PreToolUse hook logic (guard v2, spec §4.3): a client of the decision service. hook.mjs is the entry that loads
// this module and fails closed; one hooks.json group without a matcher, so every tool call comes here.
// A call the rules allow outright (same test the service makes) passes as `{}` without touching the socket; a call
// shape with no readable command is denied here; everything else goes to <agentDir>/guard/hook.sock:
// evaluate -> allow | deny | pending {id, ticket} -> wait {id, ticket}.
// Ruling P44: when the service cannot answer — not running, dropped connection, bad reply, no answer in time — the
// hook does NOT guess. It has the same rules and the same classifier, so it decides locally: a deny pattern still
// denies, the guard's own decision surface still denies, and anything that was merely going to be ASKED is allowed.
// A failure of ours is not evidence about the command.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { classify, commandsOf, coordinationOf, FILE_WRITE_TOOLS, fileWriteTargets, isReadTool } from "./classify.mjs";
import { commandText, guardStateReason, protectedTarget } from "./protect.mjs";
import { loadDefaultRules, loadRules } from "./rules.mjs";
import { readLines, servicePaths, writeLine } from "./sockets.mjs";

// OmO kills the hook at the group's timeout (330 s); the human wait itself is at most 300 s (rules.human.waitSeconds).
export const HOOK_TIMEOUT_SECONDS = 330;
const BUDGET_MS = 320_000;
const NOT_RUNNING = "[guard] служба защиты не запущена — включите защиту в настройках Agent Tabs → Безопасность";
// P31: our group is in hooks.json only while protection is on, so every session that gets this runs in the sandbox.
export const SANDBOX_NOTE =
  "[guard] Защита Agent Tabs включена: команды выполняются в песочнице macOS, а вложенная песочница запрещена ядром. " +
  "Swift: `swift build|test|run --disable-sandbox`. xcodebuild (Swift-пакеты): добавляйте " +
  "`-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePackageSandbox=YES`. " +
  "Конфигурация и хуки git закрыты: `git clone`, `git init`, `git remote add`, `git config` (и `push -u`) не " +
  "сработают, как и `brew install` и глобальные установки, — попросите человека выполнить их.";

const prefixed = (reason) => (reason.startsWith("[guard]") ? reason : `[guard] ${reason}`);
const output = (decision, reason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: prefixed(reason) },
});
const deny = (reason) => output("deny", reason);

class Unreachable extends Error {}

/** One JSON line to the socket, the first line back. Unreachable when connecting fails or takes over `connectTimeoutMs`. */
function exchange(file, message, { connectTimeoutMs, replyTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    let connected = false;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settle(value);
    };
    let timer = setTimeout(() => finish(reject, new Unreachable("connect timeout")), connectTimeoutMs);
    socket.on("connect", () => {
      connected = true;
      clearTimeout(timer);
      timer = setTimeout(() => finish(reject, new Error(`нет ответа службы защиты за ${Math.round(replyTimeoutMs / 1000)} с`)), replyTimeoutMs);
      writeLine(socket, message);
    });
    readLines(socket, (reply) => (reply === undefined ? finish(reject, new Error("ответ службы защиты не JSON")) : finish(resolve, reply)));
    socket.on("error", (error) =>
      finish(reject, connected ? new Error(`соединение со службой защиты прервано (${error.code ?? error.message})`) : new Unreachable(error.code ?? error.message)),
    );
    socket.on("close", () => finish(reject, new Error("соединение со службой защиты прервано")));
  });
}

/** The service's reply as hook output, or null when the reply is not one (the caller then decides locally, P44). */
function fromReply(reply) {
  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) return null;
  if (reply.error !== undefined) return null;
  if (reply.decision !== "allow" && reply.decision !== "deny") return null;
  return output(reply.decision, typeof reply.reason === "string" ? reply.reason : "служба защиты не указала причину");
}

/** True when the rules let the call through without the service (the service's own allow test, minus the decider). */
function allowedLocally(call, rules, where) {
  const tool = call.tool.toLowerCase();
  if (FILE_WRITE_TOOLS.has(tool)) {
    return fileWriteTargets({ tool_name: tool, tool_input: call.input }).every((target) => !protectedTarget(target, where));
  }
  const verdict = classify({ tool_name: call.tool, tool_input: call.input, cwd: call.cwd, agent_dir: where.agentDir, home: where.home }, rules);
  return verdict.tier === "allow" && !guardStateReason(commandText(tool, call.input), where, isReadTool(tool));
}

/** Rules for the local check: no file -> defaults; unreadable or invalid -> null (the service decides). */
function readRulesOrNull(file) {
  try {
    return loadRules(file);
  } catch (error) {
    return error?.code === "ENOENT" ? loadDefaultRules() : null;
  }
}

/**
 * What the hook decides on its own when the service cannot answer (P44): the local verdict, with only a deny or the
 * guard's own decision surface refused. Rules it could not read fall back to the defaults, which are stricter than
 * any edited copy, so a corrupted rules file cannot buy more than a fresh install has.
 */
function withoutTheService(call, rules, where, reason) {
  const tool = call.tool.toLowerCase();
  const usable = rules ?? loadDefaultRules();
  if (FILE_WRITE_TOOLS.has(tool)) {
    const hit = fileWriteTargets({ tool_name: tool, tool_input: call.input }).find((target) => protectedTarget(target, where));
    return hit ? deny(`жёсткий запрет: агенту нельзя менять файлы решателя и хуков (${hit}); ${reason}`) : {};
  }
  const verdict = classify({ tool_name: call.tool, tool_input: call.input, cwd: call.cwd, agent_dir: where.agentDir, home: where.home }, usable);
  if (verdict.tier === "deny") return deny(`жёсткий запрет: ${verdict.reasons.join("; ")}; ${reason}`);
  const guardState = guardStateReason(commandText(tool, call.input), where, isReadTool(tool));
  if (guardState) return deny(`${guardState} — решает только человек, а ${reason}`);
  return {};
}

/**
 * rawInput: the hook's stdin (string) or its parsed object -> the hook's stdout object. SessionStart gets the sandbox
 * note; everything else is a PreToolUse call.
 * Options: agentDir (required), connectTimeoutMs, home (default: the user's home), budgetMs (whole decision, default 320 s).
 */
export async function runThinHook(rawInput, { agentDir, connectTimeoutMs = 1500, home = os.homedir(), budgetMs = BUDGET_MS }) {
  const started = Date.now();
  let raw;
  try {
    raw = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
  } catch (error) {
    return deny(`внутренняя ошибка хука: на stdin не JSON (${error.message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return deny("внутренняя ошибка хука: на stdin не JSON-объект");
  if (raw.hook_event_name === "SessionStart") return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: SANDBOX_NOTE } };
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) return deny("внутренняя ошибка хука: нет --agent-dir");

  const toolInput = raw.tool_input ?? {};
  // The name as given (camelCase humps are word breaks for isUnknownWriteTool); the service lower-cases it itself.
  const call = {
    tool: String(raw.tool_name ?? ""),
    input: typeof toolInput === "object" || typeof toolInput === "string" ? toolInput : {},
    cwd: String(raw.cwd ?? ""),
    // F7: the durable session UUID (get_state.sessionId), not the RPC handle.
    session: String(raw.session_id ?? ""),
  };
  if (!call.tool) return deny("внутренняя ошибка хука: нет tool_name");
  // P45: an unknown write-like name used to be denied right here, because the service would have denied it too. It is
  // an ASK now, and an ask belongs to the service — the person has to be able to answer it. The name still travels
  // as given, so camelCase humps stay word breaks when the service classifies it.
  if (commandsOf(call.tool, call.input) === "invalid") return deny("некорректный вызов инструмента");

  const paths = servicePaths(agentDir);
  const rules = readRulesOrNull(paths.rules);
  if (rules && allowedLocally(call, rules, { cwd: call.cwd, agentDir, home }) &&
    !coordinationOf({ tool_name: call.tool, tool_input: call.input, cwd: call.cwd, home }).needed) return {};

  const remaining = () => Math.max(0, budgetMs - (Date.now() - started));
  const ask = (message) => exchange(paths.hookSock, message, { connectTimeoutMs, replyTimeoutMs: remaining() });
  try {
    const local = (why) => withoutTheService(call, rules, { cwd: call.cwd, agentDir, home }, why);
    const reply = await ask({ op: "evaluate", call });
    if (reply?.decision !== "pending") return fromReply(reply) ?? local("служба защиты ответила не по протоколу");
    if (typeof reply.id !== "string" || typeof reply.ticket !== "string") return local("служба защиты ответила не по протоколу");
    return fromReply(await ask({ op: "wait", id: reply.id, ticket: reply.ticket })) ?? local("служба защиты ответила не по протоколу");
  } catch (error) {
    return withoutTheService(call, rules, { cwd: call.cwd, agentDir, home }, error instanceof Unreachable ? NOT_RUNNING : error.message);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

/** The hook process: `--agent-dir <dir>`, stdin -> the stdout object (hook.mjs prints it). */
export async function hookMain(argv) {
  const at = argv.indexOf("--agent-dir");
  return runThinHook(await readStdin(), { agentDir: at >= 0 ? argv[at + 1] : undefined });
}
