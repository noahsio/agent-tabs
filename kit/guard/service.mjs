#!/usr/bin/env node
// Decision service: one background process per agent dir, outside the sandbox. It owns the rules, the decider cache,
// the open requests and their answers (in memory), the decider key and Telegram.
//   node service.mjs --agent-dir <dir> [--omo <omo path>] [--tg-env <tg.env>]
// Hook socket <agentDir>/guard/hook.sock (reachable from the sandbox), one request per connection, one JSON line each way:
//   {op:"evaluate", call:{tool, input, cwd, session}} -> {decision:"allow"|"deny", reason} | {decision:"pending", id, ticket}
//   {op:"wait", id, ticket} -> {decision:"allow"|"deny", reason}   (held until answered, timed out or the service stops)
//     The ticket binds the wait to the evaluating call: a wrong or missing one gets {error} and consumes nothing.
// Admin socket <agentDir>/guard/admin.sock (closed to the sandbox), any number of JSON lines:
//   {op:"pending"} -> {items: PendingView[]};  {op:"answer", id, decision:"allow-once"|"deny", by, message?} -> {ok} | {ok:false, error}
//     message: a deny only, the person's words to the agent (non-blank, <= 2000 chars, redacted); the hook's deny reason
//     becomes «[guard] Человек: <message>».
//   {op:"rules.get"} -> {rules, errors?};  {op:"rules.set", rules} -> {ok} | {ok:false, errors: FieldError[]} | {ok:false, error}
//   {op:"status"} -> {version, rulesOk}
//   {op:"subscribe"} -> {ok:true}, the open requests as "pending" events, then
//     {event:"pending", item} | {event:"resolved", id, decision:"allow"|"deny", by, session, decider?, item?, message?}
//     (by: agent-tabs | cli | telegram | timeout | decider; a decider's final verdict carries `item`, there was no card)
// PendingView = {id, session, cwd, tool, command (redacted, <= 4096 chars; an eval: its shell commands, one per line),
//   code? (an eval's code when commands were extracted, redacted, <= 4096), reasons, decider?: {model, decision, reason, ms}, createdAt}
// Everything the sandbox can reach is bounded: open requests per session and in total, concurrent decider calls (identical
// calls share one), Telegram sends, idle hook connections, hook connections, line length.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { classify, commandsOf, FILE_WRITE_TOOLS, fileWriteTargets } from "./classify.mjs";
import { askDecider, catReferencePath, DEFAULT_OMO_PATH, readCache, resolveDeciderTransport, writeCache, writeJsonAtomic } from "./decider.mjs";
import { commandText, guardStateReason, protectedTarget } from "./protect.mjs";
import { loadDefaultRules, parseRules, validateRules } from "./rules.mjs";
import { checkSocketPath, ensurePrivateDir, listen, LOCK_STARTING_MS, readLines, servicePaths, socketAlive, writeLine } from "./sockets.mjs";
import { createTelegram, DEFAULT_TG_ENV, httpTransport, loadTelegramConfig, resolveTelegramConfig, telegramKeyFile } from "./telegram.mjs";

export { servicePaths };
export const SERVICE_VERSION = 1;
export const LIMITS = {
  openPerSession: 10,
  openTotal: 50,
  deciderConcurrent: 2,
  deciderQueue: 8,
  hookConnections: 64,
  ticketsPerRequest: 16,
};
const MAX_VIEW_COMMAND = 4096;
const MAX_REASON = 300;
const MAX_ANSWER_MESSAGE = 2000;
const REDACTED = "‹redacted›";
const MIN_SECRET_LENGTH = 4;
const MAX_ACCOUNT_FILE = 256 * 1024;
const ANSWERERS = new Set(["agent-tabs", "cli", "telegram"]);
const SECRET_FIELD = /token|key|secret|access|refresh|password|credential/i;
const CLOSE_GRACE_MS = 500;
const SECRETS_TTL_MS = 30_000;
// A human answer serves the same call (key, session) again for this long.
const ANSWER_REUSE_MS = 60_000;

const allow = (reason) => ({ decision: "allow", reason });
const deny = (reason) => ({ decision: "deny", reason });
const iso = (ms) => new Date(ms).toISOString();
const capReason = (text) => (text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text);
const TOO_MANY = "[guard] слишком много ожидающих решений — дождитесь ответа на открытые запросы";

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJsonObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Secret-named string fields of a JSON value, or the whole text when it is one bare token. */
function accountSecrets(text, add) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    if (!/\s/.test(text.trim())) add(text);
    return;
  }
  // An array inherits its field's name: {"tokens": ["…"]} is as secret as {"token": "…"}.
  const visit = (node, depth, secretField) => {
    if (depth > 6 || !node || typeof node !== "object") return;
    for (const [field, child] of Object.entries(node)) {
      const secret = Array.isArray(node) ? secretField : SECRET_FIELD.test(field);
      if (typeof child === "string" && secret) add(child);
      else visit(child, depth + 1, secret);
    }
  };
  visit(value, 0, false);
}

function walkFiles(dir, depth, onFile) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) walkFiles(file, depth - 1, onFile);
    else if (entry.isFile()) onFile(file);
  }
}

/**
 * Secrets the service can see: the guard key, key files, auth.json credentials, models.json keys (`!cat` files, literals,
 * `$ENV` values), tokens in `<provider>-accounts/`, the Telegram bot token.
 */
function knownSecrets(agentDir, tgEnvPath) {
  const secrets = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH) secrets.add(value.trim());
  };
  add(readText(path.join(agentDir, "guard", "key")));
  walkFiles(path.join(agentDir, "keys"), 0, (file) => add(readText(file)));
  for (const entry of Object.values(readJsonObject(path.join(agentDir, "auth.json")))) {
    for (const field of ["key", "access", "refresh"]) add(entry?.[field]);
  }
  for (const provider of Object.values(readJsonObject(path.join(agentDir, "models.json")).providers ?? {})) {
    const apiKey = provider?.apiKey;
    if (typeof apiKey !== "string") continue;
    const file = catReferencePath(apiKey);
    const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(apiKey)?.[1];
    if (file) add(readText(file));
    else if (variable) add(process.env[variable]);
    else if (!apiKey.startsWith("!")) add(apiKey);
  }
  let names = [];
  try {
    names = fs.readdirSync(agentDir).filter((name) => name.endsWith("-accounts"));
  } catch {
    // no agent dir listing
  }
  for (const name of names) {
    walkFiles(path.join(agentDir, name), 3, (file) => {
      try {
        if (fs.statSync(file).size <= MAX_ACCOUNT_FILE) accountSecrets(readText(file), add);
      } catch {
        // vanished
      }
    });
  }
  add(loadTelegramConfig(tgEnvPath)?.token);
  return [...secrets].sort((left, right) => right.length - left.length);
}

/** src/env.ts `redact` semantics: every known secret, longest first, becomes ‹redacted›. */
const redactWith = (secrets) => (text) => secrets.reduce((result, secret) => result.split(secret).join(REDACTED), String(text ?? ""));

/** A hook-socket call: non-empty tool, cwd and session strings; input an object, a string or absent. */
function isCall(call) {
  return (
    call !== null &&
    typeof call === "object" &&
    typeof call.tool === "string" &&
    call.tool !== "" &&
    typeof call.cwd === "string" &&
    typeof call.session === "string" &&
    (call.input === undefined || typeof call.input === "object" || typeof call.input === "string")
  );
}

function loadRulesState(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, rules: loadDefaultRules() };
    return { ok: false, rules: null, errors: [{ field: "rules", message: "rules.json не прочитать как JSON" }] };
  }
  try {
    return { ok: true, rules: parseRules(raw) };
  } catch (error) {
    return { ok: false, rules: raw, errors: error?.errors ?? [{ field: "rules", message: String(error?.message ?? error) }] };
  }
}

/**
 * One service per agent dir (ruling P28): `service.lock` is created with link() from a temp file holding {pid, startedAt,
 * token}. A lock younger than 10 s belongs to a service that is starting; an older one is held only while its hook socket
 * accepts connections (a pid alone can be reused after a reboot). A stale lock is moved aside — only if it is still the
 * file that was judged stale — and the link is tried again. Returns the token that close() checks before removing it.
 */
async function takeLock(file, hookSock) {
  const token = randomBytes(8).toString("hex");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }), { mode: 0o600 });
    try {
      fs.linkSync(temp, file);
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(temp, { force: true });
    }
    let held;
    try {
      held = fs.statSync(file);
    } catch {
      continue; // released meanwhile
    }
    if (Date.now() - held.mtimeMs < LOCK_STARTING_MS || (await socketAlive(hookSock))) {
      throw new Error(`служба защиты уже запущена или запускается: ${file}`);
    }
    const aside = `${file}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      continue; // someone else moved it
    }
    const moved = fs.statSync(aside);
    if (moved.ino !== held.ino || moved.mtimeMs !== held.mtimeMs) {
      // Another starter replaced the stale lock first: give its lock back and step aside.
      try {
        fs.linkSync(aside, file);
      } catch {
        // a third starter holds it now
      }
      fs.rmSync(aside, { force: true });
      throw new Error(`служба защиты уже запущена или запускается: ${file}`);
    }
    fs.rmSync(aside, { force: true });
  }
  throw new Error(`служба защиты уже запущена или запускается: ${file}`);
}

/** Counting semaphore with a bounded queue: acquire() -> true (slot taken) | false (queue full or closed). */
function semaphore(slots, queueLimit) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      if (active < slots) {
        active += 1;
        return Promise.resolve(true);
      }
      if (queue.length >= queueLimit) return Promise.resolve(false);
      return new Promise((resolve) => queue.push(resolve));
    },
    release() {
      const next = queue.shift();
      if (next) next(true);
      else active -= 1;
    },
    drain() {
      for (const resolve of queue.splice(0)) resolve(false);
    },
  };
}

/**
 * Starts both sockets; resolves when they listen. Throws when a socket path is too long or another service owns the dir.
 * options: { agentDir, now?, fetchFn?, spawnFn?, telegram? (answerer | null = off; undefined = from keys/telegram.key and
 * the rules' chat, else tg.env, when the rules ask for it), tgEnvPath?, omoPath?, home?, tickMs?, telegramPollMs?, telegramSendMs?,
 * requestDeadlineMs? (a hook connection must deliver its request line within it), secretsTtlMs? }
 */
export async function startService({
  agentDir,
  now = Date.now,
  fetchFn = fetch,
  spawnFn,
  telegram,
  tgEnvPath = DEFAULT_TG_ENV,
  omoPath = DEFAULT_OMO_PATH,
  home = os.homedir(),
  tickMs = 500,
  telegramPollMs = 2000,
  telegramSendMs = 2000,
  requestDeadlineMs = 5000,
  secretsTtlMs = SECRETS_TTL_MS,
}) {
  const paths = servicePaths(agentDir);
  checkSocketPath(paths.hookSock);
  checkSocketPath(paths.adminSock);
  ensurePrivateDir(paths.dir);
  const lockToken = await takeLock(paths.lock, paths.hookSock);

  let rulesState = loadRulesState(paths.rules);
  // id -> { id, key, session, view, deadline, waitSeconds, answer, used, tickets: Map<ticket, {tool, waiting}>, waiters, telegramSent }
  const requests = new Map();
  const subscribers = new Set();
  const connections = new Set();
  const deciderSlots = semaphore(LIMITS.deciderConcurrent, LIMITS.deciderQueue);
  const deciderInFlight = new Map(); // key -> Promise<{answer, ms} | null>
  const telegramQueue = []; // request ids, oldest first
  let loadedTelegram;
  let polling = false;
  let nextPoll = 0;
  let nextSend = 0;
  let closed = false;
  let secretsCache = { at: -Infinity, redact: (text) => String(text ?? "") };

  /** Redaction with the known secrets, re-read at most every `secretsTtlMs`. */
  function redactor() {
    if (performance.now() - secretsCache.at >= secretsTtlMs) secretsCache = { at: performance.now(), redact: redactWith(knownSecrets(agentDir, tgEnvPath)) };
    return secretsCache.redact;
  }

  const broadcast = (event) => {
    for (const socket of subscribers) writeLine(socket, event);
  };
  const newId = () => {
    let id;
    do id = randomBytes(6).toString("hex");
    while (requests.has(id));
    return id;
  };
  const openRecords = () => [...requests.values()].filter((record) => !record.answer);
  const openViews = () => openRecords().map((record) => record.view);

  /** The answerer for the current setting: the key file and the rules are read each time, the bot kept while they hold. */
  function telegramFor(rules) {
    if (!rules?.human.telegram) return null;
    if (telegram !== undefined) return telegram;
    const config = resolveTelegramConfig({ keyFile: telegramKeyFile(agentDir), tgEnvPath, human: rules.human });
    const key = config ? JSON.stringify([config.token, config.chatId, config.userId ?? ""]) : "";
    if (loadedTelegram?.key !== key) loadedTelegram = { key, answerer: config ? createTelegram(config, httpTransport(config.token, fetchFn)) : null };
    return loadedTelegram.answerer;
  }

  /** At most one send per `telegramSendMs`; a request whose call (key) already went out is not sent again. */
  function pumpTelegram() {
    if (telegramQueue.length === 0 || performance.now() < nextSend) return;
    const answerer = rulesState.ok ? telegramFor(rulesState.rules) : null;
    while (telegramQueue.length > 0) {
      const record = requests.get(telegramQueue.shift());
      if (!record || record.answer || !answerer) continue;
      if (openRecords().some((other) => other.telegramSent && other.key === record.key)) continue;
      record.telegramSent = true;
      nextSend = performance.now() + telegramSendMs;
      const { id, cwd, command, reasons, decider } = record.view;
      answerer.sendRequest({ id, cwd, command, reasons, decider_reason: decider?.reason }, 10_000).catch(() => false);
      return;
    }
  }

  /** "Allow once": one call, or exactly the eval -> its bash pair (ANSWER_REUSE_MS window, checked by the caller). */
  function consume(record, tool) {
    if (record.used.length === 0) {
      record.used.push(tool);
      return true;
    }
    if (record.used.length === 1 && record.used[0] === "eval" && tool === "bash") {
      record.used.push(tool);
      return true;
    }
    return false;
  }

  /** A human deny: the person's words to the agent when they gave some. */
  function humanDeny(answer) {
    return deny(answer.message !== undefined ? `[guard] Человек: ${answer.message}` : `[guard] человек запретил (${answer.by})`);
  }

  function settle(record, tool) {
    const { decision, by } = record.answer;
    if (decision === "deny") return humanDeny(record.answer);
    return consume(record, tool)
      ? allow(`[guard] человек разрешил один раз (${by})`)
      : deny("[guard] разрешение человека уже использовано — повторите команду, чтобы спросить снова");
  }

  /** Answers every waiter: `result(tool)` per waiter, then forgets their tickets. */
  function release(record, result) {
    for (const waiter of record.waiters) {
      record.tickets.delete(waiter.ticket);
      waiter.reply(result(waiter.tool));
    }
    record.waiters.clear();
  }

  function issueTicket(record, tool) {
    if (record.tickets.size >= LIMITS.ticketsPerRequest) return deny("[guard] слишком много вызовов ждут этот запрос — повторите позже");
    const ticket = randomBytes(16).toString("hex");
    record.tickets.set(ticket, { tool, waiting: false });
    return { decision: "pending", id: record.id, ticket };
  }

  /** A recent human answer or an open request for the same call (key) in the same session. */
  function reuse(key, session, tool) {
    if (!session) return null;
    const candidates = [...requests.values()].filter((record) => record.key === key && record.session === session).reverse();
    for (const record of candidates) {
      if (!record.answer) return issueTicket(record, tool);
      if (now() - record.answer.at > ANSWER_REUSE_MS) continue;
      if (record.answer.decision === "deny") return humanDeny(record.answer);
      if (consume(record, tool)) return allow(`[guard] человек разрешил один раз (${record.answer.by})`);
    }
    return null;
  }

  /** A decider allow (the only verdict it can make final). */
  function decided(view, decider) {
    const id = newId();
    const item = { id, ...view, decider, createdAt: iso(now()) };
    broadcast({ event: "resolved", id, decision: "allow", by: "decider", session: view.session, decider, item });
    return allow(`[guard] решатель разрешил: ${decider.reason}${decider.cached ? " (кэш)" : ""}`);
  }

  function openRequest(rules, key, tool, view, decider) {
    const open = openRecords();
    if (open.length >= LIMITS.openTotal || open.filter((record) => record.session === view.session).length >= LIMITS.openPerSession) {
      return deny(TOO_MANY);
    }
    const id = newId();
    const createdAt = now();
    const item = { id, ...view, ...(decider ? { decider } : {}), createdAt: iso(createdAt) };
    const waitSeconds = rules.human.waitSeconds;
    const record = { id, key, session: view.session, view: item, deadline: createdAt + waitSeconds * 1000, waitSeconds, answer: null, used: [], tickets: new Map(), waiters: new Set(), telegramSent: false };
    requests.set(id, record);
    broadcast({ event: "pending", item });
    if (telegramFor(rules)) {
      telegramQueue.push(id);
      pumpTelegram();
    }
    return issueTicket(record, tool);
  }

  /** One decider call per key at a time (identical calls share it), at most LIMITS.deciderConcurrent at once; null = overflow. */
  function askShared(key, request, config) {
    let call = deciderInFlight.get(key);
    if (!call) {
      call = (async () => {
        if (!(await deciderSlots.acquire())) return null;
        const started = performance.now();
        try {
          return { answer: await askDecider(request, config), ms: Math.round(performance.now() - started) };
        } finally {
          deciderSlots.release();
        }
      })().finally(() => deciderInFlight.delete(key));
      deciderInFlight.set(key, call);
    }
    return call;
  }

  async function evaluate(call) {
    if (!isCall(call)) return deny("[guard] некорректный вызов");
    if (!rulesState.ok) return deny("[guard] правила защиты невалидны — исправьте их в настройках");
    const rules = rulesState.rules;
    const tool = call.tool.toLowerCase();
    const where = { cwd: call.cwd, agentDir, home };

    if (FILE_WRITE_TOOLS.has(tool)) {
      for (const target of fileWriteTargets({ tool_name: tool, tool_input: call.input })) {
        const root = protectedTarget(target, where);
        if (root) return deny(`[guard] жёсткий запрет: агенту нельзя менять файлы решателя и хуков (${target} → ${root})`);
      }
      return allow("[guard] разрешено");
    }

    // The hook's own verdict is never trusted: classify again with the service's rules (the name as given: camelCase words).
    const verdict = classify({ tool_name: call.tool, tool_input: call.input, cwd: call.cwd, agent_dir: agentDir, home }, rules);
    const text = commandText(tool, call.input);
    const guardState = guardStateReason(text, where);
    if (verdict.tier === "allow" && !guardState) return allow("[guard] разрешено");

    const redact = redactor();
    const shown = (reason) => capReason(redact(reason));
    if (verdict.tier === "deny") return deny(`[guard] жёсткий запрет: ${verdict.reasons.map(shown).join("; ")}`);
    // P38: a container mounting home, /, ~/.omo, LaunchAgents or the agent dir runs outside the sandbox — the person decides
    const humanOnly = Boolean(guardState) || verdict.reasons.some((reason) => reason.startsWith("docker-mount"));
    const reasons = (guardState ? [...verdict.reasons, `guard-state: ${guardState} — решает только человек`] : verdict.reasons).map(shown);
    // B2: an eval shows the shell commands it runs; its code goes apart (the key and guard-state above use the whole code)
    const extracted = tool === "eval" ? commandsOf(tool, call.input) : undefined;
    const commands = Array.isArray(extracted) && extracted.length > 0 ? extracted.join("\n") : text;
    const capped = (value) => redact(value).slice(0, MAX_VIEW_COMMAND);
    const view = {
      session: call.session,
      cwd: capped(call.cwd),
      tool,
      command: capped(commands),
      ...(commands !== text ? { code: capped(text) } : {}),
      reasons,
    };

    const reused = reuse(verdict.key, call.session, tool);
    if (reused) return reused;
    if (humanOnly || rules.decider.mode === "ask-me") return openRequest(rules, verdict.key, tool, view);
    if (rules.decider.mode === "deny") return deny("[guard] спорная команда запрещена настройками защиты");

    const model = rules.decider.model;
    if (!model) return openRequest(rules, verdict.key, tool, view); // none chosen: the person decides, no old verdicts
    const cached = readCache(paths.cache, verdict.key, now());
    if (cached) {
      const decider = { model, decision: cached.decision, reason: shown(cached.reason), ms: 0, cached: true };
      // the decider may only allow or ask: an older cached deny is a question for the person
      return cached.decision === "allow" ? decided(view, decider) : openRequest(rules, verdict.key, tool, view, decider);
    }
    const transport = resolveDeciderTransport(model, agentDir, { omoPath });
    if (!transport) return openRequest(rules, verdict.key, tool, view);
    const result = await askShared(
      verdict.key,
      { command: view.command, ...(view.code !== undefined ? { code: view.code } : {}), normalized: redact(verdict.normalized), cwd: view.cwd, reasons },
      { ...transport, agentDir, timeoutMs: rules.decider.timeoutMs, rules, fetchFn, ...(spawnFn ? { spawnFn } : {}) },
    );
    if (closed) return deny("[guard] служба защиты остановлена — команда не выполнена");
    if (!result) return openRequest(rules, verdict.key, tool, view);
    const { answer, ms } = result;
    const decider = { model, decision: answer.decision, reason: shown(answer.reason), ms };
    // A decider deny is never final: the person decides, with the decider's verdict on the card (rule denies are above).
    if (answer.decision !== "allow") return reuse(verdict.key, call.session, tool) ?? openRequest(rules, verdict.key, tool, view, decider);
    writeCache(paths.cache, verdict.key, answer, now());
    return decided(view, decider);
  }

  function answerRequest(id, decision, by, message) {
    if (!ANSWERERS.has(by)) return { ok: false, error: "by: agent-tabs | cli | telegram" };
    if (decision !== "allow-once" && decision !== "deny") return { ok: false, error: "decision: allow-once | deny" };
    if (message !== undefined) {
      if (decision !== "deny") return { ok: false, error: "message: only with a deny" };
      if (typeof message !== "string" || message.trim() === "" || message.length > MAX_ANSWER_MESSAGE) {
        return { ok: false, error: `message: non-blank text, at most ${MAX_ANSWER_MESSAGE} characters` };
      }
    }
    const record = typeof id === "string" ? requests.get(id) : undefined;
    if (!record) return { ok: false, error: "запрос не найден" };
    if (record.answer) return { ok: false, error: "запрос уже отвечен" };
    const words = message !== undefined ? redactor()(message.trim()) : undefined;
    record.answer = { decision: decision === "allow-once" ? "allow" : "deny", by, at: now(), ...(words !== undefined ? { message: words } : {}) };
    release(record, (tool) => settle(record, tool));
    broadcast({
      event: "resolved",
      id,
      decision: record.answer.decision,
      by,
      session: record.session,
      ...(record.view.decider ? { decider: record.view.decider } : {}),
      ...(words !== undefined ? { message: words } : {}),
    });
    return { ok: true };
  }

  function tick() {
    for (const record of [...requests.values()]) {
      if (!record.answer && now() >= record.deadline) {
        requests.delete(record.id);
        release(record, () => deny(`[guard] человек не ответил за ${record.waitSeconds} с — команда не выполнена`));
        broadcast({ event: "resolved", id: record.id, decision: "deny", by: "timeout", session: record.session });
      } else if (record.answer && now() - record.answer.at > ANSWER_REUSE_MS) requests.delete(record.id);
    }
    pumpTelegram();
    const answerer = rulesState.ok ? telegramFor(rulesState.rules) : null;
    if (!answerer || polling || performance.now() < nextPoll || openRecords().length === 0) return;
    polling = true;
    answerer
      .pollOnce((id, decision) => answerRequest(id, decision === "allow" ? "allow-once" : "deny", "telegram").ok, 5000)
      .catch(() => undefined)
      .finally(() => {
        polling = false;
        nextPoll = performance.now() + telegramPollMs;
      });
  }

  function track(socket) {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => undefined);
  }

  function waitOn(message, socket, reply) {
    const record = typeof message.id === "string" ? requests.get(message.id) : undefined;
    if (!record) return reply(deny("[guard] запрос не найден или уже закрыт — повторите команду"));
    const entry = typeof message.ticket === "string" ? record.tickets.get(message.ticket) : undefined;
    if (!entry || entry.waiting) return reply({ error: "unknown ticket" });
    if (record.answer) {
      record.tickets.delete(message.ticket);
      return reply(settle(record, entry.tool));
    }
    entry.waiting = true;
    const waiter = { reply, tool: entry.tool, ticket: message.ticket };
    record.waiters.add(waiter);
    socket.on("close", () => {
      if (record.waiters.delete(waiter)) entry.waiting = false;
    });
    return undefined;
  }

  function onHook(socket) {
    track(socket);
    // An absolute deadline for the request line (a byte trickle does not extend it); a held `wait` has none.
    const deadline = setTimeout(() => socket.destroy(), requestDeadlineMs);
    socket.on("close", () => clearTimeout(deadline));
    let handled = false;
    const reply = (value) => {
      writeLine(socket, value);
      socket.end();
    };
    readLines(socket, async (message) => {
      if (handled) return;
      handled = true;
      clearTimeout(deadline);
      try {
        if (!message || typeof message !== "object") return reply({ error: "bad request" });
        if (message.op === "evaluate") return reply(await evaluate(message.call));
        if (message.op === "wait") return waitOn(message, socket, reply);
        return reply({ error: "unknown op" });
      } catch (error) {
        return reply(deny(`[guard] внутренняя ошибка службы защиты: ${capReason(redactor()(error?.message ?? error))}`));
      }
    });
  }

  function adminReply(message, socket) {
    switch (message.op) {
      case "pending":
        return { items: openViews() };
      case "answer":
        return answerRequest(message.id, message.decision, message.by, message.message);
      case "rules.get":
        return rulesState.ok ? { rules: rulesState.rules } : { rules: rulesState.rules, errors: rulesState.errors };
      case "rules.set": {
        const errors = validateRules(message.rules);
        if (errors.length > 0) return { ok: false, errors };
        writeJsonAtomic(paths.rules, message.rules);
        rulesState = { ok: true, rules: message.rules };
        return { ok: true };
      }
      case "status":
        return { version: SERVICE_VERSION, rulesOk: rulesState.ok };
      case "subscribe":
        subscribers.add(socket);
        socket.on("close", () => subscribers.delete(socket));
        writeLine(socket, { ok: true });
        for (const item of openViews()) writeLine(socket, { event: "pending", item });
        return undefined;
      default:
        return { error: "unknown op" };
    }
  }

  function onAdmin(socket) {
    track(socket);
    readLines(socket, (message) => {
      if (!message || typeof message !== "object") return writeLine(socket, { error: "bad request" });
      let reply;
      try {
        reply = adminReply(message, socket);
      } catch (error) {
        reply = { ok: false, error: String(error?.message ?? error) };
      }
      if (reply !== undefined) writeLine(socket, reply);
      return undefined;
    });
  }

  /** Removes the lock only while it still holds our token (read and unlink in one synchronous step). */
  const releaseLock = () => {
    if (readJsonObject(paths.lock).token === lockToken) fs.rmSync(paths.lock, { force: true });
  };

  let hookServer;
  let adminServer;
  try {
    hookServer = await listen(paths.hookSock, onHook);
    hookServer.maxConnections = LIMITS.hookConnections;
    adminServer = await listen(paths.adminSock, onAdmin);
    // The extension writes rules.json itself only while no service may run (serviceMayRun); a write that landed after the
    // first read, during this start, is read now — from here on every writer sees the sockets and goes through them.
    rulesState = loadRulesState(paths.rules);
  } catch (error) {
    if (hookServer) await new Promise((resolve) => hookServer.close(resolve));
    releaseLock();
    throw error;
  }
  const timer = setInterval(tick, tickMs);
  timer.unref();

  return {
    paths,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      deciderSlots.drain();
      for (const record of requests.values()) if (!record.answer) release(record, () => deny("[guard] служба защиты остановлена — команда не выполнена"));
      requests.clear();
      for (const socket of subscribers) socket.destroy();
      const servers = [hookServer, adminServer].map((server) => new Promise((resolve) => server.close(resolve)));
      const grace = setTimeout(() => {
        for (const socket of connections) socket.destroy();
      }, CLOSE_GRACE_MS);
      for (const socket of connections) if (!socket.writableEnded) socket.destroy();
      // server.close() unlinks the socket files at once (libuv); unlinking them again after the wait below could
      // remove the sockets of a service that started meanwhile.
      await Promise.all(servers);
      clearTimeout(grace);
      releaseLock();
    },
  };
}

// ---------- process entry ----------

function parseArgs(argv) {
  const options = { agentDir: "", omoPath: DEFAULT_OMO_PATH, tgEnvPath: DEFAULT_TG_ENV };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--agent-dir") options.agentDir = argv[(index += 1)] ?? "";
    else if (argv[index] === "--omo") options.omoPath = argv[(index += 1)] ?? "";
    else if (argv[index] === "--tg-env") options.tgEnvPath = argv[(index += 1)] ?? "";
  }
  return options;
}

function isEntryPoint() {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.agentDir || !path.isAbsolute(options.agentDir)) {
    console.error("usage: service.mjs --agent-dir <absolute dir> [--omo <path>] [--tg-env <file>]");
    process.exit(2);
  }
  try {
    const service = await startService(options);
    const stop = () => service.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (error) {
    console.error(`служба защиты не запустилась: ${error?.message ?? error}`);
    process.exit(1);
  }
}
