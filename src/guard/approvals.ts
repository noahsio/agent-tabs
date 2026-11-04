import type { GuardHostMessage } from "../panel/protocol";
import type { GuardAdmin, GuardEvent, PendingView } from "./admin";

/** What the window needs of the service's admin socket (GuardAdmin; a fake in tests). */
export type GuardAdminPort = Pick<GuardAdmin, "rulesGet" | "subscribe" | "pending" | "answer" | "close">;

/** A chat tab as the approvals see it (ChatPanel). */
export interface ApprovalPanel {
  /** The durable id (UUID) of the tab's live session — what the hook reports as `session`, never the rpc handle. */
  readonly durableId: string | undefined;
  /** True when one of the tab's agents runs in the session `session` (a subagent's own calls carry its id). */
  runsChild(session: string): boolean;
  postGuard(message: GuardHostMessage): void;
}

export type GuardApprovalsDeps = {
  /** Protection is set up for this environment (state not «off»): the service may publish requests. */
  protectionOn: () => Promise<boolean>;
  /** The service's admin socket; rejects while it does not answer. */
  connect: () => Promise<GuardAdminPort>;
  panels: () => Iterable<ApprovalPanel>;
  log: (text: string) => void;
  /** Waits between failed connects (a starting service); after the last one the window gives up. */
  retryDelaysMs: readonly number[];
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The window's one subscription to the decision service: open requests become approval cards in the tab whose session
 * asked (by durable id, or the tab whose agent runs that child session; no such tab → every tab, labelled with the cwd),
 * decider verdicts become «Решатель» steps in the same tabs. Cards are shown only while the rules' `human.card` is on
 * (P27; read before subscribing, so the replayed open requests obey it); steps always. Answers go over the admin
 * socket, one per request however often it is clicked, and only from a tab that was shown the card.
 */
export class GuardApprovals {
  private admin: GuardAdminPort | undefined;
  private unsubscribe: (() => void) | undefined;
  /** `human.card` as last read; unknown (no card) until the service answered `rules.get`. */
  private card: boolean | undefined;
  private silent = false;
  private connectFailures = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private syncing: Promise<void> = Promise.resolve();
  /** Requests waiting for a human, as the service published them. */
  private readonly open = new Map<string, PendingView>();
  /** The tabs each open request's card was posted to: the only tabs whose answer counts. */
  private readonly shownTo = new Map<string, Set<ApprovalPanel>>();
  /** Answers in flight: a second click, or a click in another tab, sends nothing. */
  private readonly answering = new Set<string>();

  constructor(private readonly deps: GuardApprovalsDeps) {}

  /** Protection or its rules may have changed: start or stop the subscription, re-read `human.card`. One at a time. */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(() => this.syncNow()).catch((error: unknown) => this.deps.log(`Карточки защиты: ${errorText(error)}`));
    return this.syncing;
  }

  /** The cards a (re)loaded webview should show. */
  replay(panel: ApprovalPanel): void {
    if (this.card === true) for (const request of this.open.values()) this.postRequest(request, [panel]);
  }

  /**
   * «Разрешить один раз» / «Запретить» from `panel`. Only an open request whose card this tab was shown, and that is not
   * already being answered, reaches the service; any other click gets the reason back.
   */
  async answer(panel: ApprovalPanel, id: string, decision: "allow-once" | "deny", message?: string): Promise<void> {
    const admin = this.admin;
    const refusal =
      admin === undefined
        ? "служба защиты не подключена"
        : !this.open.has(id)
          ? "запрос больше не ждёт ответа"
          : this.shownTo.get(id)?.has(panel) !== true
            ? "этот запрос относится к другой вкладке"
            : this.answering.has(id)
              ? "ответ уже отправляется"
              : undefined;
    if (admin !== undefined && !this.open.has(id)) {
      panel.postGuard({ type: "guardClosed", id }); // nothing to answer any more: the panel lets it go
      return;
    }
    if (admin === undefined || refusal !== undefined) {
      panel.postGuard({ type: "guardAnswerFailed", id, error: refusal ?? "служба защиты не подключена" });
      return;
    }
    this.answering.add(id);
    try {
      await admin.answer(id, decision, message);
    } catch (error) {
      this.answering.delete(id);
      this.deps.log(`Ответ на запрос защиты не принят: ${errorText(error)}`);
      panel.postGuard({ type: "guardAnswerFailed", id, error: errorText(error) });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private async syncNow(): Promise<void> {
    if (this.disposed) return;
    if (!(await this.deps.protectionOn())) {
      this.stop();
      return;
    }
    if (this.admin === undefined) await this.start();
    else await this.refreshCard();
  }

  /**
   * Connects, reads `human.card`, then subscribes (the replayed open requests already know whether to show a card); a
   * service that does not answer is retried on the bounded delays, then given up.
   */
  private async start(): Promise<void> {
    clearTimeout(this.retryTimer);
    let admin: GuardAdminPort;
    try {
      admin = await this.deps.connect();
    } catch (error) {
      this.deps.log(`Служба защиты не отвечает: ${errorText(error)}`);
      const delay = this.deps.retryDelaysMs[this.connectFailures];
      this.connectFailures += 1;
      if (delay === undefined) this.gaveUp();
      else this.retryTimer = setTimeout(() => void this.sync(), delay);
      return;
    }
    this.connectFailures = 0;
    this.admin = admin;
    await this.refreshCard();
    if (this.disposed || this.admin !== admin) {
      admin.close();
      return;
    }
    this.unsubscribe = admin.subscribe(
      (event) => this.onEvent(event),
      () => this.gaveUp(),
      () => void this.reconcile(admin),
    );
    if (this.silent) {
      this.silent = false;
      for (const panel of this.deps.panels()) panel.postGuard({ type: "guardSilent", silent: false });
    }
  }

  /** Ends the subscription; every request a tab still shows is closed there (nobody can answer it through us now). */
  private stop(): void {
    for (const [id, panels] of this.shownTo) for (const panel of panels) panel.postGuard({ type: "guardClosed", id });
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connectFailures = 0;
    this.unsubscribe?.();
    this.admin?.close();
    this.unsubscribe = undefined;
    this.admin = undefined;
    this.card = undefined;
    this.open.clear();
    this.shownTo.clear();
    this.answering.clear();
  }

  /** Nothing retries until the next sync (a settings change); panels with open cards say the service is silent. */
  private gaveUp(): void {
    const withCards = new Set([...this.shownTo.values()].flatMap((panels) => [...panels]));
    this.stop();
    this.silent = true;
    for (const panel of withCards) panel.postGuard({ type: "guardSilent", silent: true });
  }

  private async refreshCard(): Promise<void> {
    const admin = this.admin;
    if (admin === undefined) return;
    let card: boolean;
    try {
      card = (await admin.rulesGet()).human.card;
    } catch (error) {
      this.deps.log(`Правила защиты не прочитаны, карточки как были: ${errorText(error)}`);
      return;
    }
    const turnedOn = card && this.card !== true;
    this.card = card;
    if (turnedOn) for (const request of this.open.values()) this.postRequest(request);
  }

  /**
   * A (re)subscription was confirmed: requests open before it that the service no longer has (it restarted, or they
   * ended while the connection was down) are closed in every tab. Taken before the replay, so new ones are kept.
   */
  private async reconcile(admin: GuardAdminPort): Promise<void> {
    const before = [...this.open.keys()];
    if (before.length === 0) return;
    let current: PendingView[];
    try {
      current = await admin.pending();
    } catch (error) {
      this.deps.log(`Открытые запросы защиты не сверены: ${errorText(error)}`);
      return;
    }
    if (admin !== this.admin) return;
    const still = new Set(current.map((request) => request.id));
    for (const id of before) {
      if (still.has(id) || !this.open.has(id)) continue;
      this.forget(id);
      for (const panel of this.deps.panels()) panel.postGuard({ type: "guardClosed", id });
    }
  }

  private forget(id: string): void {
    this.open.delete(id);
    this.shownTo.delete(id);
    this.answering.delete(id);
  }

  private onEvent(event: GuardEvent): void {
    if (event.event === "pending") {
      const request = event.item;
      if (this.open.has(request.id)) return; // a resubscription replays what is open
      this.open.set(request.id, request);
      if (request.decider !== undefined) this.postStep(request, request.decider);
      if (this.card === true) this.postRequest(request);
      return;
    }
    const request = this.open.get(event.id);
    if (request !== undefined) {
      this.forget(event.id);
      const resolved = { type: "guardResolved" as const, id: event.id, decision: event.decision, by: event.by, ...(event.message !== undefined ? { message: event.message } : {}) };
      for (const panel of this.deps.panels()) panel.postGuard(resolved);
    } else if (event.by === "decider" && event.decider !== undefined && event.item !== undefined) {
      this.postStep(event.item, event.decider); // a final verdict without a human: no card came before it
    }
  }

  /**
   * The tabs a session's request belongs to: the tab of that session; else the tab whose agent runs it as a child
   * session; else every tab of the window (`elsewhere`: the card names the cwd).
   */
  private targets(session: string): { panels: ApprovalPanel[]; elsewhere: boolean } {
    const all = [...this.deps.panels()];
    const own = all.filter((panel) => panel.durableId === session);
    if (own.length > 0) return { panels: own, elsewhere: false };
    const parents = all.filter((panel) => panel.runsChild(session));
    if (parents.length > 0) return { panels: parents, elsewhere: false };
    return { panels: all, elsewhere: true };
  }

  private postRequest(request: PendingView, only?: ApprovalPanel[]): void {
    const { panels, elsewhere } = this.targets(request.session);
    for (const panel of panels) {
      if (only !== undefined && !only.includes(panel)) continue;
      const shown = this.shownTo.get(request.id) ?? new Set<ApprovalPanel>();
      shown.add(panel);
      this.shownTo.set(request.id, shown);
      panel.postGuard({ type: "guardRequest", request, ...(elsewhere ? { elsewhere: true as const } : {}) });
    }
  }

  /** Goes where the request's card would: its session's tab, else every tab with the cwd. */
  private postStep(request: PendingView, decider: NonNullable<PendingView["decider"]>): void {
    const { panels, elsewhere } = this.targets(request.session);
    const step = { type: "guardStep" as const, id: request.id, tool: request.tool, command: request.command, decider, at: request.createdAt };
    for (const panel of panels) panel.postGuard(elsewhere ? { ...step, cwd: request.cwd } : step);
  }
}
