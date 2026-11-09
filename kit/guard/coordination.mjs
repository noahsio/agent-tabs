// Service-owned coordination. No plugin liveness inference: ruling C1 defines activity by arriving hook calls.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { coordinationOf } from "./classify.mjs";

const execute = promisify(execFile);
export const LIVE_MS = 10 * 60_000;
export const LEASE_MS = 15 * 60_000;
export const CONSENT_MS = 2 * 60_000;
const HANDOFF_MS = 15 * 60_000;
const RETAIN_MS = 24 * 60 * 60_000;
const overlaps = (left, right) => left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);

async function git(cwd, args) {
  try {
    return (await execute("git", ["-C", cwd, ...args], { timeout: 1500, maxBuffer: 1024 * 1024 })).stdout;
  } catch (error) {
    // Non-repositories and unborn HEADs are ordinary inputs; unexpected infrastructure failures reach P44.
    if (error.code === 128 && /not a git repository|does not exist|unknown revision|bad revision|ambiguous argument|Needed a single revision/.test(error.stderr)) return null;
    throw error;
  }
}

/** Resolve existing ancestors as well as existing files, so symlinks do not create a second lease namespace. */
function canonical(file) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonical(parent), path.basename(file));
  }
}

function existingDirectory(file) {
  let directory = path.dirname(file);
  while (!fs.existsSync(directory) && directory !== path.dirname(directory)) directory = path.dirname(directory);
  return directory;
}

export class Coordination {
  constructor(now = Date.now) {
    this.now = now;
    this.roots = new Map();
    this.sessions = new Map();
    this.leases = new Map();
    this.titles = new Map();
    this.activity = new Map();
    this.requests = new Map();
    this.outbox = new Map();
  }

  prune() {
    const now = this.now();
    const expired = new Set();
    for (const [root, sessions] of this.sessions) {
      for (const [session, at] of sessions) if (now - at >= LIVE_MS) {
        sessions.delete(session);
        expired.add(session);
      }
      if (sessions.size === 0) this.sessions.delete(root);
    }
    for (const session of expired) {
      if (![...this.sessions.values()].some((sessions) => sessions.has(session))) this.close(session, "не проявляла активности десять минут");
    }
    for (const [file, lease] of this.leases) {
      if (lease.until <= now || !this.sessions.get(lease.root)?.has(lease.session)) this.leases.delete(file);
    }
    for (const [cwd, entry] of this.roots) if (now - entry.at >= LIVE_MS) this.roots.delete(cwd);
    for (const [id, request] of this.requests) {
      if (now - request.createdAt >= RETAIN_MS) {
        this.requests.delete(id);
        for (const [key, message] of this.outbox) if (message.request === id) this.outbox.delete(key);
      } else if (request.state === "postponed" && now >= request.resumeAt) {
        request.state = "waiting";
        request.responses = {};
        request.round += 1;
        request.deadline = now + CONSENT_MS;
        this.ask(request);
      } else if (request.state === "waiting" && now >= request.deadline) {
        request.state = request.kind === "proposal" ? "deferred" : request.kind === "handoff" ? "unanswered" : "waiting-owner";
        request.reason = "Сосед не ответил вовремя";
        this.notify(request, request.session, `timeout-${request.round}`,
          request.kind === "proposal" ? "Ответ не получен за две минуты. Нужен человек; продолжайте независимую работу."
            : "Ответ не получен. Подождите освобождения файла или возьмите другую задачу; человека не вызываем.");
      }
    }
  }

  label(session) {
    const title = this.titles.get(session);
    return title ? `${title} (${session.slice(0, 8)})` : session.slice(0, 8);
  }

  close(session, reason = "закрыта") {
    for (const sessions of this.sessions.values()) sessions.delete(session);
    for (const [file, lease] of this.leases) if (lease.session === session) this.leases.delete(file);
    for (const request of this.requests.values()) {
      if (["done", "rejected", "unanswered", "cancelled"].includes(request.state)) continue;
      if (request.session !== session && !request.participants.includes(session)) continue;
      for (const [id, message] of this.outbox) if (message.request === request.id) this.outbox.delete(id);
      if (request.session === session) request.state = "cancelled";
      else if (request.participants.includes(session)) {
        request.state = request.kind === "handoff" ? "unanswered" : "cancelled";
        request.reason = `Сессия ${this.label(session)} ${reason}; повторите согласование`;
        this.notify(request, request.session, "closed", request.reason);
      }
    }
    for (const [id, message] of this.outbox) if (message.session === session) this.outbox.delete(id);
    this.activity.delete(session);
  }

  view(request) {
    return {
      id: request.id, kind: request.kind, session: request.session, state: request.state,
      label: this.label(request.session), file: request.file, subject: request.subject,
      reason: request.reason, createdAt: request.createdAt, deadline: request.deadline, resumeAt: request.resumeAt,
      participants: request.participants.map((session) => ({ session, label: this.label(session), response: request.responses[session] })),
    };
  }

  snapshot(session) {
    this.prune();
    return [...this.requests.values()]
      .filter((request) => session === undefined || request.session === session || request.participants.includes(session))
      .map((request) => this.view(request));
  }

  notify(request, session, event, text) {
    const id = `coordinate-${request.id}-${session}-${event}`;
    if (!this.outbox.has(id)) this.outbox.set(id, { id, request: request.id, session, text: `[coordinate #${request.id}] ${text}`, delivered: false });
  }

  ask(request) {
    for (const session of request.participants) {
      if (request.responses[session] === "idle") continue;
      const instruction = request.kind === "handoff"
        ? `Выполните задачу, затем coordinate {action:"accept", id:"${request.id}", result:"итог"}. Если не можете — action:"decline", reason:"причина".`
        : `Ответьте coordinate {action:"agree"|"object"|"wait", id:"${request.id}", reason:"причина возражения", minutes:5}. Молчание не считается согласием.`;
      this.notify(request, session, `request-${request.round}`,
        `${this.label(request.session)} ${request.kind === "handoff" ? "передаёт задачу" : request.kind === "lease" ? "просит освободить файл" : "предлагает действие над общей рабочей копией"}: ` +
        `${request.file ? `${request.file}: ` : ""}${request.subject}. ${instruction}`);
    }
  }

  proposal(call, plan) {
    const key = createHash("sha256").update(JSON.stringify([call.session, call.cwd, call.tool, call.input, plan.neighbours])).digest("hex");
    let request = [...this.requests.values()].find((entry) => entry.kind === "proposal" && entry.key === key && !["done", "cancelled"].includes(entry.state));
    if (!request) {
      // Consent belongs to one exact participant set, never to a later incarnation of the same action.
      for (const entry of this.requests.values()) if (entry.kind === "proposal" && entry.session === call.session && entry.state === "approved") entry.state = "cancelled";
      request = {
        id: randomUUID(), key, kind: "proposal", session: call.session, participants: plan.neighbours,
        state: "waiting", responses: {}, subject: JSON.stringify(call.input).slice(0, 2000),
        createdAt: this.now(), deadline: this.now() + CONSENT_MS, reason: "", round: 0, cwd: call.cwd, tool: call.tool,
      };
      this.requests.set(request.id, request);
      for (const session of plan.safeNeighbours) request.responses[session] = "idle";
      this.ask(request);
    }
    for (const session of request.participants) {
      if (request.responses[session] === "idle" && !plan.safeNeighbours.includes(session)) delete request.responses[session];
    }
    if (!request.humanApproved && ["waiting", "approved"].includes(request.state)) request.state = request.participants.every((session) => ["agree", "idle"].includes(request.responses[session])) ? "approved" : "waiting";
    return request;
  }

  async command(call) {
    const input = call.input;
    if (!call.session || !input || typeof input !== "object") return { ok: false, error: "Некорректный вызов coordinate" };
    this.prune();
    if (input.action === "close") {
      if (["quit", "new", "resume", "fork"].includes(input.reason)) this.close(call.session);
      return { ok: true };
    }
    await this.prepare({ ...call, tool: "coordinate", input: {} });
    if (input.action === "hello") {
      if (typeof input.title === "string" && input.title.trim()) this.titles.set(call.session, input.title.trim().slice(0, 160));
      this.activity.set(call.session, { idle: input.idle === true, text: typeof input.activity === "string" ? input.activity.slice(0, 200) : "" });
      return { ok: true };
    }
    if (input.action === "who") {
      const root = await this.root(call.cwd);
      return { ok: true, neighbours: [...(this.sessions.get(root)?.keys() ?? [])].filter((session) => session !== call.session).map((session) => ({
        session, label: this.label(session), activity: this.activity.get(session)?.text ?? "",
        files: [...this.leases].filter(([, lease]) => lease.session === session && lease.root === root).map(([file, lease]) => ({ file, until: lease.until })),
      })) };
    }
    if (input.action === "status") {
      const items = this.snapshot(call.session);
      if (input.id === undefined) return { ok: true, items };
      const item = items.find((entry) => entry.id === input.id);
      return item ? { ok: true, ...item } : { ok: false, error: "Нет доступного вам запроса" };
    }
    if (["accept", "decline", "agree", "object", "wait"].includes(input.action)) return this.reply(call.session, input);
    if (!["handoff", "request", "release"].includes(input.action)) return { ok: false, error: "Неизвестное действие coordinate" };
    if (typeof input.file !== "string" || !input.file.trim()) return { ok: false, error: "Нужен путь файла" };
    const file = canonical(path.resolve(call.cwd, input.file));
    const owned = [...this.leases].filter(([target]) => overlaps(target, file));
    if (input.action === "release") {
      for (const [target, lease] of owned) if (lease.session === call.session) this.leases.delete(target);
      return { ok: true };
    }
    if (input.action === "handoff" && (typeof input.what !== "string" || !input.what.trim() || input.what.length > 2000)) return { ok: false, error: "Опишите задачу, не больше 2000 символов" };
    const owner = owned.find(([, lease]) => lease.session !== call.session)?.[1].session;
    if (!owner) {
      if (input.action === "handoff") return { ok: false, error: "Файл не занят другой сессией; перечитайте его перед изменением" };
      const plan = await this.prepare({ ...call, tool: "write", input: { path: file } });
      const conflict = this.reserve(call, plan);
      return conflict ? { ok: false, error: conflict } : { ok: true, message: "Файл доступен; аренда получена" };
    }
    const kind = input.action === "handoff" ? "handoff" : "lease";
    const subject = kind === "handoff" ? input.what.trim() : "Нужна аренда для своей правки";
    let request = [...this.requests.values()].find((entry) => entry.kind === kind && entry.session === call.session &&
      entry.file === file && entry.subject === subject && entry.participants[0] === owner && !["done", "rejected", "unanswered", "cancelled"].includes(entry.state));
    if (!request) {
      request = { id: randomUUID(), kind, session: call.session, participants: [owner], file,
        state: "waiting", responses: {}, subject, createdAt: this.now(),
        deadline: this.now() + (kind === "handoff" ? HANDOFF_MS : CONSENT_MS), reason: "", round: 0 };
      this.requests.set(request.id, request);
      this.ask(request);
    }
    return { ok: true, ...this.view(request) };
  }

  reply(session, input) {
    const request = this.requests.get(input.id);
    if (!request || !request.participants.includes(session)) return { ok: false, error: "Ответить может только адресат этого запроса" };
    const response = input.action;
    if (request.responses[session] === response) return { ok: true, ...this.view(request) };
    if (["done", "unanswered", "cancelled"].includes(request.state)) return { ok: false, error: "Запрос уже закрыт" };
    const allowed = request.kind === "handoff" ? ["accept", "decline"] : ["agree", "object", "wait"];
    if (!allowed.includes(response)) return { ok: false, error: "Неверный ответ для этого запроса" };
    if (["decline", "object"].includes(response) && (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2000)) return { ok: false, error: "Нужна причина, не больше 2000 символов" };
    if (response === "wait" && (!Number.isFinite(input.minutes) || input.minutes <= 0 || input.minutes > 30)) return { ok: false, error: "Ожидание должно быть больше нуля и не дольше 30 минут" };
    if (request.state === "rejected") return { ok: true, ...this.view(request) };
    request.responses[session] = response;
    const reason = typeof input.reason === "string" ? input.reason.slice(0, 2000) : typeof input.result === "string" ? input.result.slice(0, 2000) : "";
    if (reason) request.reason = reason;
    if (request.kind === "handoff") {
      request.state = response === "accept" ? "done" : "rejected";
    } else if (response === "object") {
      request.state = "rejected";
    } else if (response === "wait") {
      request.state = "postponed";
      request.resumeAt = Math.max(request.resumeAt ?? 0, this.now() + input.minutes * 60_000);
    } else {
      if (request.participants.every((who) => ["agree", "idle"].includes(request.responses[who]))) request.state = "approved";
      if (request.kind === "lease" && request.state === "approved") {
        for (const [file, lease] of this.leases) if (lease.session === session && overlaps(file, request.file)) {
          this.leases.set(file, { ...lease, session: request.session, until: this.now() + LEASE_MS });
        }
      }
    }
    const description = { accept: "задача выполнена", decline: "задача отклонена", agree: "согласен", object: "возражает", wait: `просит подождать ${input.minutes} мин.` }[response];
    this.notify(request, request.session, `${session}-${response}-${request.round}`,
      `${this.label(session)}: ${description}${reason ? ` — ${reason}` : ""}. ` +
      (request.state === "approved" ? "Согласовано; повторите исходное действие, состав соседей будет проверен снова." : "Продолжайте независимую работу."));
    return { ok: true, ...this.view(request) };
  }

  override(id, decision) {
    const request = this.requests.get(id);
    if (!request || request.kind !== "proposal" || request.state !== "deferred" || !["allow", "deny"].includes(decision)) return { ok: false, error: "Нет отложенного предложения" };
    request.state = decision === "allow" ? "approved" : "cancelled";
    request.humanApproved = decision === "allow";
    this.notify(request, request.session, "human", `Человек ${decision === "allow" ? "разрешил повторить исходное действие один раз" : "отклонил предложение"}.`);
    return { ok: true };
  }

  async root(cwd) {
    if (!fs.existsSync(cwd)) return null;
    const directory = canonical(cwd);
    let entry = this.roots.get(directory);
    if (!entry) {
      entry = { at: this.now(), result: git(directory, ["rev-parse", "--show-toplevel"]).then((value) => value ? canonical(value.trim()) : null) };
      this.roots.set(directory, entry);
      entry.result.catch(() => this.roots.delete(directory));
    }
    return entry.result;
  }

  async prepare(call) {
    this.prune();
    const intent = coordinationOf({ tool_name: call.tool, tool_input: call.input, cwd: call.cwd });
    const writes = [];
    for (const target of intent.writes) {
      const file = canonical(target);
      const root = await this.root(existingDirectory(file));
      if (root) writes.push({ file, root });
    }
    const roots = new Set();
    const current = call.cwd ? await this.root(call.cwd) : null;
    if (current) roots.add(current);
    const whole = new Set();
    for (const cwd of intent.whole) {
      const root = await this.root(cwd);
      if (root) whole.add(root);
    }
    for (const root of whole) roots.add(root);
    for (const { root } of writes) roots.add(root);
    if (call.session) for (const root of roots) {
      if (!this.sessions.has(root)) this.sessions.set(root, new Map());
      this.sessions.get(root).set(call.session, this.now());
    }
    const heads = new Map();
    for (const root of roots) {
      if (!writes.some((write) => write.root === root) && ![...this.leases.values()].some((lease) => lease.root === root)) continue;
      const head = (await git(root, ["rev-parse", "--verify", "HEAD"]))?.trim() ?? null;
      heads.set(root, head);
      if (!head) continue;
      for (const [file, lease] of this.leases) {
        if (lease.root !== root || lease.head === head) continue;
        const relative = path.relative(root, file);
        const changed = await git(root, ["log", "-1", "--format=%H", lease.head ? `${lease.head}..${head}` : head, "--", relative]);
        if (!changed?.trim()) continue;
        const dirty = await git(root, ["status", "--porcelain", "-z", "--", relative]);
        if (dirty === "" && this.leases.get(file) === lease) this.leases.delete(file);
      }
    }
    const neighbours = [...new Set([...whole].flatMap((root) => [...(this.sessions.get(root)?.keys() ?? [])].filter((session) => session !== call.session)))].sort();
    const idle = neighbours.filter((session) => this.activity.get(session)?.idle === true);
    const clean = idle.length > 0 && (await Promise.all([...whole].map((root) => git(root, ["status", "--porcelain", "-z"])))).every((status) => status === "");
    return { writes, heads, neighbours, safeNeighbours: clean ? idle : [], whole: whole.size > 0 };
  }

  conflict(session, plan) {
    this.prune();
    for (const { file } of plan.writes) {
      for (const [leased, lease] of this.leases) {
        if (lease.session === session) continue;
        if (!overlaps(file, leased)) continue;
        const until = new Date(lease.until).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false });
        return `[guard] файл правит сессия «${this.label(lease.session)}» до ${until}: ${file}. ` +
          `Передайте задачу владельцу через coordinate {action:"handoff", file:"${file}", what:"..."}; продолжайте независимую работу, не обходите аренду.`;
      }
    }
    return null;
  }

  /** Synchronous check-and-reserve: two concurrent authorizations cannot both acquire the same file. */
  reserve(call, plan) {
    const conflict = this.conflict(call.session, plan);
    if (conflict) return conflict;
    if (call.session) for (const { file, root } of plan.writes) {
      this.leases.set(file, { root, session: call.session, until: this.now() + LEASE_MS, head: plan.heads.get(root) ?? null });
    }
    return null;
  }
}
