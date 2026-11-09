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
//   {op:"subscribe"} -> {ok:true}, then the open requests, routed as below, and from then on
//     {event:"pending", item, only?:true, outside?:{owner}} | {event:"claim", id, session}
//     | {event:"resolved", id, decision:"allow"|"deny", by, session, decider?, item?, message?}
//     (by: agent-tabs | cli | telegram | timeout | decider; a decider's final verdict carries `item`, there was no card)
//   {op:"claim", id, verdict:"own"|"knows"|"no", owner?} -> no reply; the answer to a "claim" event.
//     WHO SHOWS A REQUEST IS DECIDED HERE, once, because only the service sees every window: a new request goes out to
//     the subscribers as "claim", and the first window that has the asking session open («own») gets the request alone
//     («only»). Failing that, the first window that knows whose session it is but has no tab for it («knows») is asked
//     to raise it outside the chats («outside»), so no unrelated chat shows a card. If nobody claims it within
//     `claimMs`, every window gets it — the only case where a chat sees a request it did not ask for. Nothing is held
//     for the round: the hook is already waiting on its ticket, and the human deadline runs from when the request
//     opened. A window that subscribes later is asked to claim the requests that are already placed, and joins a
//     request that went out to everyone.
// PendingView = {id, session, cwd, tool, command (redacted, <= 4096 chars; an eval: its shell commands, one per line),
//   code? (an eval's code when commands were extracted, redacted, <= 4096), reasons, decider?: {model, decision, reason, ms}, createdAt}
// Everything the sandbox can reach is bounded: open requests per session and in total, concurrent decider calls (identical
// calls share one), Telegram sends, idle hook connections, hook connections, line length.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { classify, commandsOf, FILE_WRITE_TOOLS, fileWriteTargets, isReadTool } from "./classify.mjs";
import { Coordination } from "./coordination.mjs";
import { deliverCoordination } from "./coordinationHost.mjs";
import { askDecider, catReferencePath, DEFAULT_OMO_PATH, readCache, resolveDeciderTransport, writeCache, writeJsonAtomic } from "./decider.mjs";
import { commandText, guardStateReason, protectedTarget } from "./protect.mjs";
import { loadDefaultRules, makeWhitelistEntry, parseRules, validateRules } from "./rules.mjs";
import { checkSocketPath, ensurePrivateDir, listen, LOCK_STARTING_MS, readLines, servicePaths, socketAlive, writeLine } from "./sockets.mjs";
import { createTelegram, DEFAULT_TG_ENV, httpTransport, loadTelegramConfig, resolveTelegramConfig, telegramKeyFile } from "./telegram.mjs";

export { servicePaths };
export const SERVICE_VERSION = 1;
/**
 * The admin protocol this service speaks. 2 added the claim round (who shows a request). A window that subscribes
 * without `protocol` cannot take part in a round, so it is never shown a request the round placed elsewhere — it would
 * decide locally and put a card in whatever chat it has open, which is the whole bug the round exists to stop.
 */
export const SERVICE_PROTOCOL = 2;
/** The least protocol a subscriber must speak to be routed to rather than broadcast at. */
const CLAIM_PROTOCOL = 2;
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

/** The kit directory this service was loaded from: its content hash is the extension build that installed it. */
const ownGuardDir = () => path.dirname(fileURLToPath(import.meta.url));

const allow = (reason) => ({ decision: "allow", reason });
const deny = (reason) => ({ decision: "deny", reason });
const iso = (ms) => new Date(ms).toISOString();
const capReason = (text) => (text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text);
const TOO_MANY = "[guard] слишком много ожидающих решений — дождитесь ответа на открытые запросы";
/** How long a later «allow» of a deferred request stays usable for that exact call. */
const ALLOWANCE_MS = 24 * 3_600_000;
/** What the agent reads when nobody answered in time: deferred, not refused — and not to be worked around. */
const deferredReason = (id) =>
  `[guard] команда отложена до решения человека (#${id}): его сейчас нет. Не обходи её другими командами; делай остальную работу. Если без неё никак — доведи, что можешь, и опиши, что ждёт одобрения. Когда человек решит, ты получишь сообщение.`;

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

/** Deferred requests and the allowances later allows left; anything malformed in the file is dropped, not trusted. */
function loadDeferred(file) {
  const raw = readJsonObject(file);
  const items = Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item.id === "string" && typeof item.key === "string") : [];
  const allowances = Array.isArray(raw.allowances)
    ? raw.allowances.filter((entry) => entry && typeof entry.id === "string" && typeof entry.key === "string" && Number.isFinite(entry.expiresAt))
    : [];
  return { items, allowances };
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
  claimMs = 400,
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
  // One line to stderr, which the LaunchAgent captures (src/guard/launchAgent.ts StandardErrorPath): the place a
  // failure of ours is recorded instead of being put to the person as a question (P44).
  const log = (line) => console.error(`[guard ${iso(now())}] ${line}`);
  // id -> { id, key, session, view, deadline, waitSeconds, answer, used, tickets: Map<ticket, {tool, waiting}>, waiters, telegramSent }
  const requests = new Map();
  const coordination = new Coordination(now);
  let coordinationSnapshot = "";
  let deliveringCoordination = false;
  let nextCoordinationDelivery = 0;
  async function pumpCoordination() {
    if (deliveringCoordination || closed || now() < nextCoordinationDelivery) return;
    if (![...coordination.outbox.values()].some((message) => !message.delivered)) return;
    deliveringCoordination = true;
    try {
      for (const message of coordination.outbox.values()) {
        if (closed) break;
        if (message.delivered) continue;
        try {
          await deliverCoordination(agentDir, { ...message, text: redactor()(message.text) });
          message.delivered = true;
        } catch (error) {
          log(`coordination-delivery-pending id=${message.id} reason=${capReason(redactor()(error.message))}`);
        }
      }
    } finally {
      deliveringCoordination = false;
      nextCoordinationDelivery = now() + 10_000;
    }
  }
  function publishCoordination() {
    const items = JSON.parse(redactor()(JSON.stringify(coordination.snapshot())));
    const snapshot = JSON.stringify(items);
    if (snapshot === coordinationSnapshot) return;
    coordinationSnapshot = snapshot;
    for (const [socket, subscriber] of subscribers) if (subscriber.coordination) writeLine(socket, { event: "coordination", items });
  }
  function escalateCoordination() {
    coordination.prune();
    if (!rulesState.ok) return;
    for (const proposal of coordination.requests.values()) {
      if (proposal.kind !== "proposal" || proposal.state !== "deferred" || proposal.humanId) continue;
      const view = {
        session: proposal.session, cwd: proposal.cwd, tool: proposal.tool, command: proposal.subject,
        reasons: [`Соседи не ответили за две минуты: ${proposal.participants.map((session) => coordination.label(session)).join(", ")}. Молчание не означает согласие.`],
        coordinationId: proposal.id,
      };
      const hour = new Date(now()).getHours();
      const key = `coordination:${proposal.id}`;
      if (hour >= 22 || hour < 8) {
        proposal.humanId = newId();
        deferredState.items.push({ id: proposal.humanId, ...view, key, createdAt: iso(now()), deferredAt: iso(now()) });
        saveDeferred();
      } else {
        const pending = openRequest(rulesState.rules, key, proposal.tool, view);
        if (pending.decision === "pending") proposal.humanId = pending.id;
      }
    }
  }
  // Spec 2026-11-08: a request nobody answered in time is deferred, not lost. The person answers it later; an allow
  // becomes a one-time allowance for exactly that call (its key: command, heredoc bodies and cwd) for ALLOWANCE_MS.
  const deferredFile = path.join(paths.dir, "deferred.json");
  const deferredState = loadDeferred(deferredFile);
  const saveDeferred = () => writeJsonAtomic(deferredFile, deferredState);
  /** socket -> { protocol }: what each connected window can be asked. */
  const subscribers = new Map();
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

  /** Every window, whatever it speaks: an end (`resolved`) must reach an old window too, or its card never closes. */
  const broadcast = (event) => {
    for (const socket of subscribers.keys()) writeLine(socket, event);
  };
  /** The windows that answer claim rounds. */
  const claimers = () => [...subscribers].filter(([, who]) => who.protocol >= CLAIM_PROTOCOL).map(([socket]) => socket);
  /** Who a request goes to when nobody claimed it: the windows that could have, or — if there are none — everybody. */
  const fallbackAudience = () => (claimers().length > 0 ? "claimers" : "everyone");
  /** The sockets of an audience, now. */
  const audienceOf = (audience) => (audience === "everyone" ? [...subscribers.keys()] : audience === "claimers" ? claimers() : Array.isArray(audience) ? audience : []);

  /**
   * The claim round for one request: every window is asked whose session it is, and the answers decide who shows it.
   * `record.audience` is the sockets that were given it («all» = every window, the unattributable fan-out), so a window
   * that subscribes later can be slotted in without handing it somebody else's request.
   */
  function route(record) {
    if (subscribers.size === 0) return; // no window to ask; a later subscriber picks it up from openRecords()
    const asked = claimers();
    if (asked.length === 0) return give(record, "everyone", {}); // only old windows: they decide for themselves, as always
    const claims = new Map();
    const timer = setTimeout(() => settleRoute(record), claimMs);
    if (typeof timer.unref === "function") timer.unref();
    record.routing = { claims, timer };
    for (const socket of asked) writeLine(socket, { event: "claim", id: record.id, session: record.session });
  }

  /** A window's answer to a claim. The owner ends the round at once; anything else waits for the rest or the timer. */
  function claimed(record, socket, verdict, owner) {
    if (!record.routing || !subscribers.has(socket)) return;
    record.routing.claims.set(socket, { verdict, owner: typeof owner === "string" && owner !== "" ? owner : undefined });
    if (verdict === "own" || record.routing.claims.size >= claimers().length) settleRoute(record);
  }

  function settleRoute(record) {
    const routing = record.routing;
    if (!routing) return;
    clearTimeout(routing.timer);
    record.routing = undefined;
    if (record.answer || !requests.has(record.id)) return; // answered or timed out while the windows were answering
    const live = [...routing.claims].filter(([socket]) => subscribers.has(socket));
    const own = live.find(([, claim]) => claim.verdict === "own");
    if (own) return give(record, [own[0]], { only: true });
    const knows = live.find(([, claim]) => claim.verdict === "knows");
    if (knows) return give(record, [knows[0]], { outside: { owner: knows[1].owner ?? null } });
    give(record, fallbackAudience(), {});
  }

  /** Hands a request to the windows that will show it, and remembers which those are. */
  function give(record, audience, extra) {
    record.audience = audience;
    const event = { event: "pending", item: record.view, ...extra };
    for (const socket of audienceOf(audience)) writeLine(socket, event);
  }

  /**
   * A new subscriber and the requests already waiting: it joins one that went out to everyone, is asked to claim one
   * that is placed with another window, and starts the round for one that opened while no window was connected.
   */
  function offerOpen(socket, protocol) {
    const claims = protocol >= CLAIM_PROTOCOL;
    for (const record of openRecords()) {
      if (record.audience === "everyone") writeLine(socket, { event: "pending", item: record.view });
      else if (record.audience === "claimers" && claims) writeLine(socket, { event: "pending", item: record.view });
      else if (record.audience === undefined && !record.routing) route(record);
      else if (claims) writeLine(socket, { event: "claim", id: record.id, session: record.session });
      // an old window is never handed a request a round placed elsewhere: it would decide for itself and show it
    }
  }

  /**
   * A claim on a request already placed: an owner is added (a window that opened the tab since), and a window that
   * gives one up is dropped — if that leaves nobody, the round runs again, so the request never goes quiet while a
   * window could still show it.
   */
  function reclaim(record, socket, verdict) {
    if (!Array.isArray(record.audience) || !subscribers.has(socket)) return;
    const audience = Array.isArray(record.audience) ? record.audience : [];
    if (verdict === "own") {
      if (audience.includes(socket)) return;
      record.audience = [...audience, socket];
      writeLine(socket, { event: "pending", item: record.view, only: true });
      return;
    }
    if (!audience.includes(socket)) return;
    dropFromAudience(record, socket);
  }

  /** Takes a window off a request's audience; with nobody left the request is routed again. */
  function dropFromAudience(record, socket) {
    if (!Array.isArray(record.audience)) return; // a shared audience follows the subscribers by itself
    const left = record.audience.filter((other) => other !== socket && subscribers.has(other));
    record.audience = left;
    if (left.length === 0 && !record.routing) route(record);
  }
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

  /**
   * "Allow once": one call, or exactly the eval -> the one tool call it makes (ANSWER_REUSE_MS, checked by the caller).
   *
   * Ruling P42: one action costs one question. An eval that runs `tool.bash({command})` or `tool.monitor({command})`
   * reaches the hook twice — once as the eval, once as the inner call — and the person was paying for both. The pair
   * is proved by the request key: a hash of the command the CLASSIFIER read, plus the heredoc bodies and the cwd. The
   * model cannot choose it, and a different inner command hashes differently and asks for itself. Exactly one inner
   * call is covered, so an eval that runs the same command twice still asks again for the second.
   */
  function consume(record, tool) {
    if (record.used.length === 0) {
      record.used.push(tool);
      return true;
    }
    if (record.used.length === 1 && record.used[0] === "eval" && (tool === "bash" || tool === "monitor")) {
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

  /**
   * Ruling P44: our own infrastructure failing is not evidence about the command. A decider that is not configured,
   * unreachable, slow, broken or off-contract, and a service shutting down mid-decision, all end in an allow we log —
   * never in a question. A call that matched a
   * deny pattern never gets here (deny returns above), and a guard-state call never consults the decider at all, so
   * nothing this covers is a verdict about the command itself.
   */
  function deciderFailed(view, reason) {
    log(`decider-failed session=${view.session || "-"} tool=${view.tool} reason=${reason}`);
    return allow(`[guard] разрешено: решатель недоступен (${reason})`);
  }

  /** A decider allow (the only verdict it can make final). */
  function decided(view, decider) {
    const id = newId();
    const item = { id, ...view, decider, createdAt: iso(now()) };
    broadcast({ event: "resolved", id, decision: "allow", by: "decider", session: view.session, decider, item });
    return allow(`[guard] решатель разрешил: ${decider.reason}${decider.cached ? " (кэш)" : ""}`);
  }

  /**
   * An allow the person's own whitelist made — no card, no decider. It is published to the feed as its own step (by
   * "whitelist"), so it reads apart from a one-time or a decider allow, and the hook's reason names the matched shape.
   */
  function allowedByWhitelist(call, verdict) {
    const redact = redactor();
    const scopes = verdict.whitelisted.map((hit) => hit.scope ?? hit.label);
    const toolName = call.tool.toLowerCase();
    const id = newId();
    const item = {
      id,
      session: call.session,
      cwd: redact(call.cwd).slice(0, MAX_VIEW_COMMAND),
      tool: toolName,
      command: redact(commandText(toolName, call.input)).slice(0, MAX_VIEW_COMMAND),
      reasons: [],
      createdAt: iso(now()),
    };
    broadcast({ event: "resolved", id, decision: "allow", by: "whitelist", session: call.session, whitelist: { scopes }, item });
    return allow(`[guard] разрешено по вашему вайтлисту: ${scopes.join(", ")}`);
  }

  /**
   * Writes one «always allow» entry per proposed shape (as the card showed it) into the v2 `allow` list and persists the
   * rules, skipping shapes already present. Returns the scopes written, or null when nothing could be saved. The shapes
   * come from classify, which never proposes a deny shape — and the deny set runs before the allow list in any case.
   */
  function saveWhitelist(record) {
    const proposal = record.view.proposal;
    if (!rulesState.ok || !Array.isArray(proposal) || proposal.length === 0) return null;
    const present = new Set(rulesState.rules.allow.filter((entry) => typeof entry?.scope === "string").map((entry) => entry.scope));
    const entries = proposal.filter((item) => !present.has(item.scope)).map((item) => makeWhitelistEntry({ scope: item.scope, session: record.session, now }));
    const rules = { ...rulesState.rules, allow: [...rulesState.rules.allow, ...entries] };
    if (validateRules(rules).length > 0) return null;
    writeJsonAtomic(paths.rules, rules);
    rulesState = { ok: true, rules };
    return proposal.map((item) => item.scope);
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
    const record = { id, key, session: view.session, view: item, deadline: createdAt + waitSeconds * 1000, waitSeconds, answer: null, used: [], tickets: new Map(), waiters: new Set(), telegramSent: false, audience: undefined, routing: undefined };
    requests.set(id, record);
    route(record);
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

  async function prepareCoordination(call) {
    try {
      return await coordination.prepare(call);
    } catch (error) {
      // C1: coordination is guaranteed only while its service can answer. Ordinary rule checks still run.
      log(`coordination-failed session=${call.session || "-"} reason=${capReason(error.message)}`);
      return null;
    }
  }

  async function authorizeWrites(call, result, plan, consent) {
    if (result.decision !== "allow") return result;
    const current = plan && !plan.whole ? plan : await prepareCoordination(call);
    if (!current) return result;
    const approved = consent ?? plan?.neighbours;
    if (approved && current.neighbours.some((session) => !approved.includes(session))) {
      return deny("[guard] состав соседей изменился после запроса — повторите команду для согласования с актуальным списком");
    }
    const conflict = coordination.reserve(call, current);
    return conflict ? deny(conflict) : result;
  }

  async function evaluate(call) {
    if (!isCall(call)) return deny("[guard] некорректный вызов");
    const plan = await prepareCoordination(call);
    const conflict = plan && coordination.conflict(call.session, plan);
    if (conflict) return deny(conflict);
    const result = await decide(call, plan);
    if (result.decision === "pending") {
      const ticket = requests.get(result.id).tickets.get(result.ticket);
      ticket.call = call;
      ticket.neighbours = plan?.neighbours;
      return result;
    }
    return authorizeWrites(call, result, plan);
  }

  async function decide(call, plan) {
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
    const guardState = guardStateReason(text, where, isReadTool(tool));
    // A whitelist entry is consulted inside classify, after the deny set — so a guard-state touch still overrides it here
    // (guardState keeps the call for the person however `allow` it looked): a whitelist can never bypass guard-state.
    let shared = plan?.neighbours.length > 0;
    if (shared) verdict.key = createHash("sha256").update(`${verdict.key}\0${plan.neighbours.join("\0")}`).digest("hex").slice(0, 32);
    if (shared && verdict.tier !== "deny" && !guardState) {
      const proposal = coordination.proposal(call, plan);
      if (proposal.state !== "approved") {
        publishCoordination();
        return {
          ...deny(`[guard] ${proposal.state === "deferred" ? "Предложение отложено" : "Ждём согласия соседей"} (#${proposal.id}): ` +
            `${plan.neighbours.map((session) => coordination.label(session)).join(", ")}. ` +
            "Молчание не разрешает действие. Продолжайте независимую работу."),
          coordination: coordination.view(proposal),
        };
      }
      proposal.state = "done";
      shared = false;
      publishCoordination();
    }
    if (verdict.tier === "allow" && !guardState && !shared) {
      return Array.isArray(verdict.whitelisted) && verdict.whitelisted.length > 0 ? allowedByWhitelist(call, verdict) : allow("[guard] разрешено");
    }

    const redact = redactor();
    const shown = (reason) => capReason(redact(reason));
    if (verdict.tier === "deny") return deny(`[guard] жёсткий запрет: ${verdict.reasons.map(shown).join("; ")}`);
    // P38: a container mounting home, /, ~/.omo, LaunchAgents or the agent dir runs outside the sandbox — the person decides
    const humanOnly = shared || Boolean(guardState) || verdict.reasons.some((reason) => reason.startsWith("docker-mount"));
    const reasons = (guardState ? [...verdict.reasons, `guard-state: ${guardState} — решает только человек`] : verdict.reasons).map(shown);
    if (shared) reasons.push(...plan.neighbours.map((session) => `Общая рабочая копия: активна сессия «${redact(coordination.label(session))}». Действие затронет её работу; решает человек.`));
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
      // The legible «always allow» shapes the card offers; written to the whitelist on an «allow-always» answer. Program
      // and flags only (operands hidden as `*`), so there is nothing secret to redact.
      ...(!shared && Array.isArray(verdict.proposal) && verdict.proposal.length > 0 ? { proposal: verdict.proposal } : {}),
    };

    const allowance = takeAllowance(verdict.key);
    if (allowance) return allow(`[guard] разрешено человеком (отложенный запрос #${allowance.id})`);
    const reused = reuse(verdict.key, call.session, tool);
    if (reused) return reused;
    if (humanOnly || rules.decider.mode === "ask-me") return openRequest(rules, verdict.key, tool, view);
    if (rules.decider.mode === "deny") return deny("[guard] спорная команда запрещена настройками защиты");

    const model = rules.decider.model;
    // No model chosen is a configuration gap, not a verdict (P44): allow and log, as with any other decider failure.
    if (!model) return deciderFailed(view, "модель решателя не выбрана");
    const cached = readCache(paths.cache, verdict.key, now());
    if (cached) {
      const decider = { model, decision: cached.decision, reason: shown(cached.reason), ms: 0, cached: true };
      // the decider may only allow or ask: an older cached deny is a question for the person
      return cached.decision === "allow" ? decided(view, decider) : openRequest(rules, verdict.key, tool, view, decider);
    }
    const transport = resolveDeciderTransport(model, agentDir, { omoPath });
    if (!transport) return deciderFailed(view, `нет транспорта для модели ${model}`);
    const result = await askShared(
      verdict.key,
      { command: view.command, ...(view.code !== undefined ? { code: view.code } : {}), normalized: redact(verdict.normalized), cwd: view.cwd, reasons },
      { ...transport, agentDir, timeoutMs: rules.decider.timeoutMs, rules, fetchFn, ...(spawnFn ? { spawnFn } : {}) },
    );
    if (closed) return deciderFailed(view, "служба защиты остановлена во время решения");
    if (!result) return deciderFailed(view, "решатель не вернул ответ");
    const { answer, ms } = result;
    const decider = { model, decision: answer.decision, reason: shown(answer.reason), ms };
    // Our failure, not its verdict: allow and log (P44).
    if (answer.failed) return deciderFailed(view, shown(answer.reason));
    // A decider deny is never final: the person decides, with the decider's verdict on the card (rule denies are above).
    if (answer.decision !== "allow") return reuse(verdict.key, call.session, tool) ?? openRequest(rules, verdict.key, tool, view, decider);
    writeCache(paths.cache, verdict.key, answer, now());
    return decided(view, decider);
  }

  function answerRequest(id, decision, by, message) {
    if (!ANSWERERS.has(by)) return { ok: false, error: "by: agent-tabs | cli | telegram" };
    // «allow-always» (the card's «Разрешать такое впредь») writes the whitelist entry, then allows this call once.
    if (decision !== "allow-once" && decision !== "deny" && decision !== "allow-always") return { ok: false, error: "decision: allow-once | allow-always | deny" };
    if (message !== undefined) {
      if (decision !== "deny") return { ok: false, error: "message: only with a deny" };
      if (typeof message !== "string" || message.trim() === "" || message.length > MAX_ANSWER_MESSAGE) {
        return { ok: false, error: `message: non-blank text, at most ${MAX_ANSWER_MESSAGE} characters` };
      }
    }
    const record = typeof id === "string" ? requests.get(id) : undefined;
    if (!record) return answerDeferred(id, decision, by, message);
    if (record.answer) return { ok: false, error: "запрос уже отвечен" };
    if (record.view.coordinationId) {
      if (decision === "allow-always") return { ok: false, error: "Согласование действует только один раз" };
      const result = coordination.override(record.view.coordinationId, decision === "deny" ? "deny" : "allow");
      if (!result.ok) return result;
      publishCoordination();
    }
    if (decision === "allow-always" && saveWhitelist(record) === null) return { ok: false, error: "нечего внести в вайтлист или правила не сохранить" };
    const words = message !== undefined ? redactor()(message.trim()) : undefined;
    record.answer = { decision: decision === "deny" ? "deny" : "allow", by, at: now(), ...(words !== undefined ? { message: words } : {}) };
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

  /** A deferred request answered later: an allow leaves a one-time allowance for that exact call, a deny only a record. */
  function answerDeferred(id, decision, by, message) {
    const index = deferredState.items.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, error: "запрос не найден" };
    const item = deferredState.items[index];
    const allowed = decision !== "deny";
    if (item.coordinationId) {
      if (decision === "allow-always") return { ok: false, error: "Согласование действует только один раз" };
      const result = coordination.override(item.coordinationId, allowed ? "allow" : "deny");
      if (!result.ok) return result;
      publishCoordination();
    } else if (allowed) deferredState.allowances.push({ id, key: item.key, expiresAt: now() + ALLOWANCE_MS });
    deferredState.items.splice(index, 1);
    saveDeferred();
    const words = message !== undefined ? redactor()(message.trim()) : undefined;
    broadcast({ event: "resolved", id, decision: allowed ? "allow" : "deny", by, session: item.session, deferred: true, ...(words !== undefined ? { message: words } : {}) });
    return { ok: true };
  }

  /** The allowance a deferred-then-allowed request left for this exact call, spent on use; expired ones are dropped. */
  function takeAllowance(key) {
    const live = deferredState.allowances.filter((entry) => entry.expiresAt > now());
    const index = live.findIndex((entry) => entry.key === key);
    const taken = index < 0 ? undefined : live.splice(index, 1)[0];
    if (taken !== undefined || live.length !== deferredState.allowances.length) {
      deferredState.allowances = live;
      saveDeferred();
    }
    return taken;
  }

  function tick() {
    escalateCoordination();
    publishCoordination();
    void pumpCoordination();
    for (const record of [...requests.values()]) {
      if (!record.answer && now() >= record.deadline) {
        requests.delete(record.id);
        deferredState.items.push({ ...record.view, key: record.key, deferredAt: iso(now()) });
        saveDeferred();
        release(record, () => deny(deferredReason(record.id)));
        broadcast({ event: "resolved", id: record.id, decision: "deny", by: "timeout", session: record.session, deferred: true });
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
    // The lease may have changed while a human or the decider was answering. A ticket never bypasses acquisition.
    const answer = (result) => {
      if (!entry.call || result.decision !== "allow") return reply(result);
      void authorizeWrites(entry.call, result, undefined, entry.neighbours).then(reply);
    };
    if (record.answer) {
      record.tickets.delete(message.ticket);
      return answer(settle(record, entry.tool));
    }
    entry.waiting = true;
    const waiter = { reply: answer, tool: entry.tool, ticket: message.ticket };
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
        if (message.op === "coordinate") {
          if (!isCall(message.call)) return reply({ ok: false, error: "Некорректный вызов coordinate" });
          const result = await coordination.command(message.call);
          publishCoordination();
          return reply(JSON.parse(redactor()(JSON.stringify(result))));
        }
        return reply({ error: "unknown op" });
      } catch (error) {
        return reply(deny(`[guard] внутренняя ошибка службы защиты: ${capReason(redactor()(error?.message ?? error))}`));
      }
    });
  }

  function adminReply(message, socket) {
    tick();
    switch (message.op) {
      case "coordination":
        return { items: JSON.parse(redactor()(JSON.stringify(coordination.snapshot()))) };
      case "coordination.answer": {
        const result = coordination.override(message.id, message.decision);
        publishCoordination();
        return result;
      }
      case "pending":
        escalateCoordination();
        return { items: openViews() };
      case "deferred":
        escalateCoordination();
        return { items: deferredState.items.map(({ key: _key, ...view }) => view) };
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
        // `protocol` and `kit` let a window tell whether the service running is the one its own build installed:
        // a service older than the extension cannot route, and the window says so instead of pretending it is routed.
        return { version: SERVICE_VERSION, protocol: SERVICE_PROTOCOL, kit: ownGuardDir(), rulesOk: rulesState.ok };
      case "subscribe": {
        const protocol = Number.isInteger(message.protocol) && message.protocol > 0 ? message.protocol : 1;
        subscribers.set(socket, { protocol, coordination: message.coordination === true });
        socket.on("close", () => {
          subscribers.delete(socket);
          // a window that went away shows nothing: its requests are routed again rather than waiting out the deadline
          for (const record of openRecords()) if (Array.isArray(record.audience) && record.audience.includes(socket)) dropFromAudience(record, socket);
        });
        writeLine(socket, { ok: true, protocol: SERVICE_PROTOCOL });
        if (message.coordination === true) writeLine(socket, { event: "coordination", items: JSON.parse(redactor()(JSON.stringify(coordination.snapshot()))) });
        offerOpen(socket, protocol);
        return undefined;
      }
      case "claim": {
        const record = typeof message.id === "string" ? requests.get(message.id) : undefined;
        if (!record || record.answer) return undefined;
        if (record.routing) claimed(record, socket, message.verdict, message.owner);
        else reclaim(record, socket, message.verdict);
        return undefined;
      }
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
      for (const socket of subscribers.keys()) socket.destroy();
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
