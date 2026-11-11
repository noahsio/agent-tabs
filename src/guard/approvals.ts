import type { GuardHostMessage } from "../panel/protocol";
import type { ClaimVerdict, CoordinationView, GuardAdmin, GuardEvent, GuardSubscription, PendingView } from "./admin";

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
  /**
   * The session of the chat that owns `session` (OmO's task registry for THIS environment), or `undefined` when
   * nothing claims it. Never asked for a session a tab already answers for.
   */
  rootOf: (session: string) => string | undefined;
  /**
   * Nobody has this request's session open anywhere: raise it where the person will see it without a chat showing a
   * card it was never asked for — a notification in this window, and whatever else is configured. `owner` is whose
   * session it is. The returned function takes the notification down once the request ends.
   */
  outside: (request: PendingView, owner: string | undefined) => (() => void) | void;
  log: (text: string) => void;
  /** Waits between failed connects (a starting service); after the last one the window gives up. */
  retryDelaysMs: readonly number[];
  /** Inbox refresh only: an event from another window must never create a delivery. */
  changed?: () => void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The window's one subscription to the decision service: open requests become approval cards in the tab whose session
 * asked (by durable id, or the tab whose agent runs that child session; no such tab → every tab, labelled with the cwd),
 * decider verdicts become «Решатель» steps in the same tabs. A request's end — answered, timed out, or lost by the service
 * — goes back only to the tabs its card reached, so no other chat hears of a decision it was never offered. Cards are
 * shown only while the rules' `human.card` is on (P27; read before subscribing, so the replayed open requests obey it);
 * steps always. Answers go over the admin socket, one per request however often it is clicked, and only from a tab that
 * was shown the card.
 */
export class GuardApprovals {
  private admin: GuardAdminPort | undefined;
  private subscription: GuardSubscription | undefined;
  /** `human.card` as last read; unknown (no card) until the service answered `rules.get`. */
  private card: boolean | undefined;
  private silent = false;
  private connectFailures = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private syncing: Promise<void> = Promise.resolve();
  /** Requests waiting for a human, as the service published them. */
  private readonly open = new Map<string, PendingView>();
  private coordination: CoordinationView[] = [];
  private readonly coordinationShown = new WeakSet<ApprovalPanel>();
  /** The tabs each open request's card was posted to: the only tabs whose answer counts. */
  private readonly shownTo = new Map<string, Set<ApprovalPanel>>();
  /** Answers in flight: a second click, or a click in another tab, sends nothing. */
  private readonly answering = new Set<string>();
  /** Requests this window raised outside the chats: how to take that notice down when they end. */
  private readonly raised = new Map<string, () => void>();

  constructor(private readonly deps: GuardApprovalsDeps) {}

  /** Protection or its rules may have changed: start or stop the subscription, re-read `human.card`. One at a time. */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(() => this.syncNow()).catch((error: unknown) => this.deps.log(`Карточки защиты: ${errorText(error)}`));
    return this.syncing;
  }

  /** The cards a (re)loaded webview should show; one raised outside the chats is not a card of any tab. */
  replay(panel: ApprovalPanel): void {
    this.postCoordination(panel);
    if (this.card !== true) return;
    for (const [id, request] of this.open) if (!this.raised.has(id)) this.postRequest(request, [panel]);
  }

  /**
   * «Разрешить один раз» / «Запретить» from `panel`. Only an open request whose card this tab was shown, and that is not
   * already being answered, reaches the service; any other click gets the reason back.
   */
  async answer(panel: ApprovalPanel, id: string, decision: "allow-once" | "allow-always" | "deny", message?: string): Promise<void> {
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

  /**
   * An answer given outside the chats (the notification's «Запретить»): there is no tab to hand a refusal back to, so a
   * request that is already gone or already being answered is simply let go, with a line in the channel.
   */
  async answerOutside(id: string, decision: "allow-once" | "deny"): Promise<void> {
    const admin = this.admin;
    if (admin === undefined || !this.open.has(id) || this.answering.has(id)) {
      this.deps.log(`Ответ вне чатов не отправлен: запрос ${id} уже не ждёт ответа`);
      return;
    }
    this.answering.add(id);
    try {
      await admin.answer(id, decision);
    } catch (error) {
      this.answering.delete(id);
      this.deps.log(`Ответ вне чатов не принят: ${errorText(error)}`);
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
    this.subscription = admin.subscribe(
      (event) => this.onEvent(event),
      () => this.gaveUp(),
      () => void this.reconcile(admin),
      true,
    );
    if (this.silent) {
      this.silent = false;
      for (const panel of this.deps.panels()) panel.postGuard({ type: "guardSilent", silent: false });
    }
  }

  /** Ends the subscription; every request a tab still shows is closed there (nobody can answer it through us now). */
  private stop(): void {
    this.coordination = [];
    for (const panel of this.deps.panels()) this.postCoordination(panel);
    for (const [id, panels] of this.shownTo) for (const panel of panels) panel.postGuard({ type: "guardClosed", id });
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connectFailures = 0;
    this.subscription?.stop();
    this.admin?.close();
    this.subscription = undefined;
    this.admin = undefined;
    this.card = undefined;
    this.open.clear();
    this.shownTo.clear();
    this.answering.clear();
    for (const take of this.raised.values()) take();
    this.raised.clear();
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
    if (turnedOn) for (const [id, request] of this.open) if (!this.raised.has(id)) this.postRequest(request);
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
      const shown = this.shown(id);
      this.forget(id);
      for (const panel of shown) panel.postGuard({ type: "guardClosed", id });
    }
  }

  /** The tabs a request's card was posted to: the only ones its end is news for. Read before `forget`. */
  private shown(id: string): ApprovalPanel[] {
    return [...(this.shownTo.get(id) ?? [])];
  }

  private forget(id: string): void {
    this.open.delete(id);
    this.shownTo.delete(id);
    this.answering.delete(id);
    this.raised.get(id)?.(); // the notice outside the chats goes with the request
    this.raised.delete(id);
  }

  private onEvent(event: GuardEvent): void {
    if (event.event === "coordination") {
      this.coordination = event.items;
      for (const panel of this.deps.panels()) this.postCoordination(panel);
      this.deps.changed?.();
      return;
    }
    if (event.event === "claim") {
      const { verdict, owner } = this.claimFor(event.session);
      this.subscription?.claim(event.id, verdict, owner);
      return;
    }
    this.deps.changed?.();
    if (event.event === "pending") {
      const request = event.item;
      if (this.open.has(request.id)) return; // a resubscription replays what is open
      this.open.set(request.id, request);
      if (event.outside !== undefined) {
        // nobody has the session open: no chat gets a card it did not ask for, the person is told outside the chats
        const take = this.deps.outside(request, event.outside.owner ?? undefined);
        if (typeof take === "function") this.raised.set(request.id, take);
        return;
      }
      if (request.decider !== undefined) this.postStep(request, request.decider);
      if (this.card === true) this.postRequest(request, undefined, event.only === true);
      return;
    }
    const request = this.open.get(event.id);
    if (request !== undefined) {
      const shown = this.shown(event.id);
      this.forget(event.id);
      const resolved = { type: "guardResolved" as const, id: event.id, decision: event.decision, by: event.by, ...(event.message !== undefined ? { message: event.message } : {}) };
      for (const panel of shown) panel.postGuard(resolved);
    } else if (event.by === "decider" && event.decider !== undefined && event.item !== undefined) {
      this.postStep(event.item, event.decider); // a final verdict without a human: no card came before it
    } else if (event.by === "whitelist" && event.whitelist !== undefined && event.item !== undefined) {
      this.postStep(event.item, undefined, event.whitelist); // the person's own whitelist allowed it: a feed step, no card
    }
  }

  /**
   * This window's answer to «whose session is this»: «own» when one of its tabs is the session or its owner, «knows»
   * when the task registry names an owner no tab of this window has open, «no» when nothing here claims it. The service
   * collects the answers of every window and places the request once.
   */
  private claimFor(session: string): { verdict: ClaimVerdict; owner?: string } {
    const all = [...this.deps.panels()];
    if (all.some((panel) => panel.durableId === session || panel.runsChild(session))) return { verdict: "own" };
    const owner = this.owner(session);
    if (owner === undefined) return { verdict: "no" };
    return all.some((panel) => panel.durableId === owner) ? { verdict: "own" } : { verdict: "knows", owner };
  }

  private postCoordination(panel: ApprovalPanel): void {
    const belongs = (session: string): boolean => panel.runsChild(session) ||
      (panel.durableId !== undefined && (panel.durableId === session || panel.durableId === this.owner(session)));
    const lines = this.coordination
      .filter((item) => ["waiting", "postponed", "deferred", "waiting-owner"].includes(item.state) &&
        (belongs(item.session) || item.participants.some((participant) => belongs(participant.session))))
      .map((item) => {
        const who = belongs(item.session) ? item.participants.map((participant) => participant.label).join(", ") : item.label;
        const state = item.state === "deferred" ? "Нужен человек · Отложенные"
          : item.state === "postponed" ? "Сосед попросил подождать"
            : item.kind === "handoff" ? "Передача задачи" : "Согласование";
        return `${state} · ${who}: ${item.subject}`;
      });
    if (lines.length === 0 && !this.coordinationShown.has(panel)) return;
    if (lines.length > 0) this.coordinationShown.add(panel);
    else this.coordinationShown.delete(panel);
    panel.postGuard({ type: "coordination", lines });
  }

  /**
   * A tab went away: a request this window was given and can no longer show goes back to the service, which asks the
   * windows again rather than letting it run down its deadline unseen.
   */
  panelsChanged(): void {
    for (const [id, request] of this.open) {
      if (this.raised.has(id)) continue; // not a card of ours
      if (this.shown(id).length === 0) continue; // already nobody's here
      if (this.claimFor(request.session).verdict === "own") continue;
      this.subscription?.claim(id, "no");
    }
  }

  /**
   * The tabs of this window a session's request belongs to, in order of how well we know it: the tab of that session;
   * the tab whose agents run it as a child session; the tab of the session that spawned it, from OmO's own task
   * registry for this environment (`rootOf`, a chain of any depth). None of those and the request goes to every tab
   * (`elsewhere`), because a request nobody is asked is denied at the guard's deadline, which is worse than one offered
   * in the wrong place. `claimed` — the service placed this request here because this window said it owns the session —
   * forbids that fan-out: the service has already decided, and an owner it cannot find now is given back (`panelsChanged`).
   */
  private targets(session: string, claimed = false): { panels: ApprovalPanel[]; elsewhere: boolean; owner?: string } {
    const all = [...this.deps.panels()];
    const own = all.filter((panel) => panel.durableId === session);
    if (own.length > 0) return { panels: own, elsewhere: false };
    const parents = all.filter((panel) => panel.runsChild(session));
    if (parents.length > 0) return { panels: parents, elsewhere: false };
    const owner = this.owner(session);
    const owning = owner === undefined ? [] : all.filter((panel) => panel.durableId === owner);
    if (owning.length > 0) return { panels: owning, elsewhere: false };
    if (claimed) return { panels: [], elsewhere: false }; // the tab went between the claim and the request
    return { panels: all, elsewhere: true, ...(owner !== undefined ? { owner } : {}) };
  }

  /** The registry's answer, never fatal: a window whose registry cannot be read falls back to the fan-out. */
  private owner(session: string): string | undefined {
    try {
      return this.deps.rootOf(session);
    } catch (error) {
      this.deps.log(`Чья это сессия, определить не удалось: ${errorText(error)}`);
      return undefined;
    }
  }

  private postRequest(request: PendingView, only?: ApprovalPanel[], claimed = false): void {
    const { panels, elsewhere, owner } = this.targets(request.session, claimed);
    if (claimed && panels.length === 0) {
      this.subscription?.claim(request.id, "no"); // we claimed it and lost the tab: the service asks the others
      return;
    }
    for (const panel of panels) {
      if (only !== undefined && !only.includes(panel)) continue;
      const shown = this.shownTo.get(request.id) ?? new Set<ApprovalPanel>();
      shown.add(panel);
      this.shownTo.set(request.id, shown);
      panel.postGuard({ type: "guardRequest", request, ...(elsewhere ? { elsewhere: true as const } : {}), ...(owner !== undefined ? { owner } : {}) });
    }
  }

  /**
   * A feed step with no card before it: a decider's verdict, or the person's own whitelist allowing a call. It is already
   * decided — nobody has to answer it — so it shows only in a tab of its own session (or the one running or owning it);
   * a session no tab of this window holds gets no step here, rather than a copy in every tab.
   */
  private postStep(request: PendingView, decider?: NonNullable<PendingView["decider"]>, whitelist?: { scopes: string[] }): void {
    const { panels, elsewhere } = this.targets(request.session);
    if (elsewhere) return;
    const step = {
      type: "guardStep" as const,
      id: request.id,
      tool: request.tool,
      command: request.command,
      at: request.createdAt,
      ...(decider !== undefined ? { decider } : {}),
      ...(whitelist !== undefined ? { whitelist } : {}),
    };
    for (const panel of panels) panel.postGuard(step);
  }
}
