import { basename } from "node:path";
import type { GuardAdmin, DeferredView } from "../guard/admin";
import type { DeferredAction, DeferredHostMessage, DeferredItem, DeferredQuestion } from "../panel/protocol";
import type { SessionController } from "../sessions/controller";
import { DeferredQuestions, ownerSession } from "./questions";
import { DeferredStore, type OutboxEntry } from "./store";

export type DeliverySession = Pick<SessionController, "send" | "release">;
type InboxDeps = {
  protectionOn(): Promise<boolean>;
  connect(): Promise<Pick<GuardAdmin, "deferred" | "answer" | "close">>;
  open(sessionPath: string): Pick<DeliverySession, "send"> | undefined;
  attach(sessionPath: string): Promise<DeliverySession>;
  publish(message: DeferredHostMessage): void;
  log(message: string): void;
  now?: () => number;
};
const WEEK = 7 * 86400_000;
const NOT_SENT = "Ответ сохранён, но не доставлен. Обновите список, чтобы повторить.";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One window's inbox. Guard events only refresh it; only a person's answer creates a delivery intent. */
export class DeferredInbox {
  private readonly questions: DeferredQuestions;
  private readonly store: DeferredStore;
  private readonly now: () => number;
  private lastScan = Number.NEGATIVE_INFINITY;
  private scanned: DeferredQuestion[] = [];
  private approvals: DeferredView[] = [];
  private items: DeferredItem[] = [];
  private readonly failures = new Map<string, string>();
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly agentDir: string, private readonly deps: InboxDeps) {
    this.questions = new DeferredQuestions(agentDir);
    this.store = new DeferredStore(agentDir);
    this.now = deps.now ?? Date.now;
  }

  /** Used on activation, popover open, and guard changes. Concurrent panels share one ordered queue. */
  refresh(): Promise<void> {
    return this.schedule(async () => {
      await this.retry();
      try {
        const now = this.now();
        if (now - this.lastScan >= 60_000) {
          this.scanned = await this.questions.scan(now);
          this.lastScan = now;
        }
        this.approvals = [];
        if (await this.deps.protectionOn()) {
          try {
            const admin = await this.deps.connect();
            try { this.approvals = await admin.deferred(); }
            finally { admin.close(); }
          } catch { /* An unreachable protection service contributes no approvals and no warning. */ }
        }
        const answers = this.store.read().questions;
        this.items = this.scanned.filter((item) => !Object.hasOwn(answers, item.id));
        for (const approval of this.approvals) {
          const owner = await ownerSession(this.agentDir, approval.session);
          const cwd = (owner === undefined ? undefined : this.questions.cwd(owner.file)) ?? approval.cwd;
          this.items.push({ kind: "approval", id: approval.id, sessionTitle: approval.sessionLabel ?? (owner === undefined ? undefined : this.questions.title(owner.file)) ?? basename(cwd),
            cwd, session: owner?.durableId ?? approval.session,
            command: approval.command, createdAt: Date.parse(approval.createdAt), deferredAt: Date.parse(approval.deferredAt),
            ...(approval.coordinationId ? { coordination: approval.reasons.join("\n") } : {}) });
        }
        this.publish();
      } catch (error) {
        this.deps.publish({ type: "deferred", items: this.items, error: reason(error) });
      }
    });
  }

  answer(action: DeferredAction): Promise<void> {
    return this.schedule(async () => {
      const kind = action.type === "answerDeferredApproval" ? "approval" : "question";
      try {
        const key = `deferred-${kind}-${action.id}`;
        const saved = this.store.read();
        const queued = saved.outbox[key];
        if (queued !== undefined) {
          if (!(await this.deliver(queued))) throw new Error(this.failures.get(key) ?? NOT_SENT);
        } else if (kind === "question" && Object.hasOwn(saved.questions, action.id)) {
          // A second click (or another window) cannot replace an already accepted question answer.
        } else {
          const item = this.items.find((item) => item.kind === kind && item.id === action.id);
          if (item === undefined) throw new Error("Запрос больше не находится в отложенных");
          if (action.type === "dismissDeferredQuestion") {
            this.store.markAnswered(action.id, "", this.now());
          } else {
            let entry: OutboxEntry | undefined;
            if (action.type === "answerDeferredQuestion" && item.kind === "question") {
              if (action.answers.length !== item.questions.length) throw new Error("Ответьте на каждый вопрос");
              const time = new Date(item.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
              const text = item.questions.map((question, index) => `Ответ на отложенный вопрос от ${time} «${question.question}»: ${action.answers[index]}.`).join("\n") +
                (item.decided ? ` Тогда ты продолжил сам: «${item.decided}» — сверь допущение и поправь, что изменилось.` : "");
              entry = { kind: "question", sessionPath: item.sessionPath, text, clientMessageId: key, createdAt: this.now() };
              this.store.enqueue(entry, { id: action.id, text: action.answers.join("\n") });
            } else if (action.type === "answerDeferredApproval" && item.kind === "approval") {
              const approval = this.approvals.find((approval) => approval.id === action.id);
              if (approval === undefined) throw new Error("Разрешение больше не находится в отложенных");
              const text = action.decision === "allow-once"
                ? `Человек разрешил отложенную команду (#${item.id}): \`${item.command}\` — выполни её сейчас, если она ещё нужна.`
                : `Человек запретил отложенную команду (#${item.id}): \`${item.command}\`${action.message ? ` — ${action.message}` : ""}`;
              entry = { kind: "approval", sessionId: approval.session, text, clientMessageId: key, createdAt: this.now() };
              const admin = await this.deps.connect();
              try {
                await admin.answer(action.id, action.decision, action.message);
                // Accepted risk: a crash between guard's OK and this synchronous outbox write can lose the notification.
                // Keep the guard contract unchanged; every persisted retry uses OmO's stable admission ID.
                if (approval.coordinationId) entry = undefined; // The coordination service owns this notification and its admission ID.
                else this.store.enqueue(entry);
              } finally { admin.close(); }
            } else throw new Error("Тип ответа не соответствует запросу");
            if (entry !== undefined && !(await this.deliver(entry))) throw new Error(this.failures.get(key) ?? NOT_SENT);
          }
        }
        this.items = this.items.filter((item) => item.kind !== kind || item.id !== action.id);
        this.deps.publish({ type: "deferredResult", kind, id: action.id, ok: true });
        this.publish();
      } catch (error) {
        this.deps.publish({ type: "deferredResult", kind, id: action.id, ok: false, reason: reason(error) });
      }
    });
  }

  private schedule(operation: () => Promise<void>): Promise<void> {
    this.work = this.work.then(operation).catch((error: unknown) => {
      this.deps.log(`Отложенные: ${reason(error)}`);
      this.deps.publish({ type: "deferred", items: this.items, error: reason(error) });
    });
    return this.work;
  }

  private async retry(): Promise<void> {
    for (const entry of Object.values(this.store.read().outbox)) {
      if (this.now() - entry.createdAt > WEEK) {
        this.store.remove(entry.clientMessageId);
        this.failures.delete(entry.clientMessageId);
        this.deps.log(`Отложенный ответ ${entry.clientMessageId} удалён из очереди: прошло больше 7 дней`);
      } else await this.deliver(entry);
    }
  }

  private async deliver(entry: OutboxEntry): Promise<boolean> {
    try {
      const owner = entry.kind === "question" ? undefined : await ownerSession(this.agentDir, entry.sessionId);
      const file = entry.kind === "question" ? entry.sessionPath : owner?.file;
      if (file === undefined) throw new Error("Файл сессии для доставки не найден");
      // a subagent's command is answered to the session that spawned it, which can resume or re-run that work
      const text = owner?.task === undefined ? entry.text : `${entry.text} Её запускал субагент ${owner.task}.`;
      const open = this.deps.open(file);
      let sent: boolean;
      if (open !== undefined) sent = await open.send(text, "auto", [], entry.clientMessageId);
      else {
        const session = await this.deps.attach(file);
        try { sent = await session.send(text, "auto", [], entry.clientMessageId); }
        finally { await session.release(); }
      }
      if (!sent) throw new Error(NOT_SENT);
      this.store.remove(entry.clientMessageId);
      this.failures.delete(entry.clientMessageId);
      return true;
    } catch (error) {
      this.failures.set(entry.clientMessageId, reason(error));
      return false;
    }
  }

  private publish(): void {
    const deliveries = Object.values(this.store.read().outbox).map((entry) => ({
      id: entry.clientMessageId.slice(`deferred-${entry.kind}-`.length), kind: entry.kind, text: entry.text, createdAt: entry.createdAt,
      reason: this.failures.get(entry.clientMessageId) ?? NOT_SENT,
    }));
    this.deps.publish({ type: "deferred", items: this.items.filter((item) => !deliveries.some((entry) => entry.id === item.id && entry.kind === item.kind))
      .sort((left, right) => right.deferredAt - left.deferredAt), deliveries });
  }
}
