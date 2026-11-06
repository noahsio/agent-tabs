import { randomUUID } from "node:crypto";
import type { ModelRef } from "../chat/model";
import { lifecycleRunning } from "../chat/reducer";
import type { Ladder, Rung } from "../settings/ladder";
import type { OutgoingImage } from "./controller";
import { emptyAnswer, endFailure, frameAbort, lifecyclePolicyRejection, SILENCE_MS, tally, type AbortSource, type FailureClass, type TurnTally } from "./ladderFailure";
import { instantDeadTurn } from "./liveness";

/** A model the environment serves, as the ladder needs it: enough to match a rung and to name it. */
export type LadderModel = { provider: string; id: string; name?: string };

/** What the composer shows: the step in flight, or the model the walk ended on. */
export type LadderView =
  /** `rung` is the rung's own number on the ladder, 1-based, out of `total`. */
  | { state: "walking"; rung: number; total: number; label: string }
  /** The walk saved the message and the session stays here; `back` is the model it started on. */
  | { state: "settled"; model: string; back: { provider: string; id: string; label: string } };

/** Everything the walk is allowed to do to a session. `ModelLadder` touches nothing else. */
export interface LadderSession {
  /** This environment's ladder, read fresh at every step: the person may have just edited it. */
  ladder(): Ladder;
  /** The models the environment serves now; a rung naming anything else is skipped. */
  models(): Promise<LadderModel[]>;
  model(): ModelRef | undefined;
  /** Whether OmO still calls the turn running. */
  running(): boolean;
  /** `reason` names the failure and the rung it is stepping to, for the channel. */
  abort(reason: string): Promise<void>;
  /** The existing way out of a turn the abort did not end: unload the session and open it again. */
  unwedge(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  /** Sends under `id`; false when the message did not go out. */
  send(id: string, text: string, images: OutgoingImage[]): Promise<boolean>;
  note(level: "info" | "warn", text: string): void;
  view(view: LadderView | undefined): void;
}

/**
 * How long a step waits for the abort it asked for before it unloads the session instead. The same bound the composer
 * gives «Стоп» — past it OmO has answered the abort and the turn is running all the same.
 */
export const ABORT_WAIT_MS = 8_000;
/** How often the wait looks again; short enough that the usual case costs one tick. */
const ABORT_POLL_MS = 100;

/** Why the ladder moved, in the person's language; the feed line is built from it. */
const REASON: Record<FailureClass, string> = {
  refusal: "Модель отказалась",
  rejected: "Провайдер отклонил запрос",
  empty: "Модель ответила пусто",
  silence: "От модели не было ответа 5 минут",
  transport: "Связь с моделью оборвалась",
};

/** «1 модель», «2 модели», «5 моделей». */
function models(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return `${count} модель`;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return `${count} модели`;
  return `${count} моделей`;
}

/** One message the ladder is watching: the person's own, or the resend that stands in for it. */
type Walk = {
  /** The clientMessageId OmO is answering: the person's own at first, then each resend's. */
  id: string;
  /** The person's message, as it must be repeated. */
  text: string;
  images: OutgoingImage[];
  /** The model the session was on when the person sent it: what «вернуться на …» goes back to. */
  first: ModelRef | undefined;
  /** Rung ids that have already fired for this message: each fires at most once. */
  fired: Set<string>;
  /** Where on the ladder the session stands; -1 when its model is on no rung at all. */
  at: number;
  /** Models this message has been put to, the one it started on included. */
  tried: number;
  /** What the turn answering `id` has produced. */
  tally: TurnTally;
  /** A step was already taken for `id`: the sticky refusal signal must not step it again. */
  stepped: boolean;
  /** The turn answering `id` has produced a frame of its own. */
  started: boolean;
  /** The turn was killed by OmO itself as it started: not a provider failure, and no step of ours answers it. */
  dead: boolean;
  /** Who aborted the turn answering `id`, when a frame named it: a `"user"` abort disarms the walk, and an abort of
   *  any source is never read as an empty answer. Undefined until an abort frame arrives, and reset each new turn. */
  aborted: AbortSource | undefined;
  /** The last model the walk switched to. */
  rescuer: ModelRef | undefined;
};

function sameModel(a: { provider: string; id: string }, b: { provider: string; id: string }): boolean {
  return a.provider === b.provider && a.id === b.id;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The model ladder of one session: it watches the turn answering the person's own message, and when one of the four
 * failures ends that turn it moves the message to the next rung that answers that failure — aborting the turn first,
 * so a late answer from the queue can never become a second answer to one message.
 *
 * Two rules keep one failure from walking the whole ladder. A step is keyed to the clientMessageId being answered, so
 * the sticky `policy-rejection` lifecycle row (15–20 of them per refusal) steps once; and a rung fires at most once
 * per message. The person's own message is never *replayed* once the turn has called a tool — that would run it a
 * second time — so a pure model rung behaves as «остановиться и спросить» there, naming the reason. A rung carrying a
 * *continuation* phrase re-runs nothing, so it fires whatever the turn already did.
 */
export class ModelLadder {
  /** The person's message as it was sent, until a `message_start` shows it reached the conversation. */
  private waiting: { id: string; text: string; images: OutgoingImage[]; wasRunning: boolean } | undefined;
  private walk: Walk | undefined;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private shown: LadderView | undefined;
  /** Bumped whenever what the ladder watches changes: an answer still in flight for an older one is dropped. */
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly session: LadderSession,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** A message the person just sent: a fresh walk, keyed to its id, armed once it reaches the conversation. */
  armed(id: string, text: string, images: OutgoingImage[]): void {
    if (this.disposed) return;
    this.generation += 1;
    this.clearSilence();
    this.walk = undefined;
    this.show(undefined); // whatever the last walk left on screen is about the last message
    this.waiting = { id, text, images, wasRunning: this.session.running() };
  }

  /** Every frame of this session's own handle, after the state took it (so `running()` is current). */
  observe(frame: Record<string, unknown>): void {
    if (this.disposed) return;
    const type = frame["type"];
    const pending = this.waiting;
    if (pending !== undefined && type === "message_start" && isObject(frame["message"])) {
      const message = frame["message"];
      if (message["role"] === "user" && message["clientMessageId"] === pending.id) {
        this.waiting = undefined;
        this.walk = {
          id: pending.id,
          text: pending.text,
          images: pending.images,
          first: this.session.model(),
          fired: new Set(),
          at: this.rungOfCurrentModel(),
          tried: this.session.model() === undefined ? 0 : 1,
          // A message written into a running turn joins work already in progress: that turn is never repeated. Its
          // own `agent_start` (a queued message gets one) wipes this again — then the turn really is fresh.
          tally: { text: false, tools: pending.wasRunning },
          stepped: false,
          started: false,
          dead: false,
          aborted: undefined,
          rescuer: undefined,
        };
      }
    }
    const walk = this.walk;
    if (walk === undefined) return;
    if (type === "agent_start") {
      walk.started = true;
      walk.dead = false;
      walk.aborted = undefined;
      walk.tally = { text: false, tools: false };
    }
    // A turn OmO killed itself as it started answered nothing and failed nothing: the controller puts the message
    // back (and arms the ladder on its resend), so the only thing to do here is stop watching this one.
    if (type === "message_end" && instantDeadTurn(frame["message"])) walk.dead = true;
    if (type === "message_update" || type === "message_end" || type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      walk.started = true;
    }
    if (type === "session_lifecycle" && lifecycleRunning(frame["lifecycle"]) === true) walk.started = true;
    walk.tally = tally(walk.tally, frame);
    this.armSilence();
    const abort = frameAbort(frame);
    if (abort !== undefined) walk.aborted = abort;
    if (walk.aborted === "user") {
      // The person pressed «Стоп» (or OmO laid this abort at their feet): their own, deliberate end to the turn, never
      // a provider failure. Whatever shape it left the turn in — an aborted empty answer — the walk is cancelled right
      // here, so no failure path below can step the ladder, switch the model or send «продолжай». Stop means stop.
      this.walk = undefined;
      this.clearSilence();
      this.show(undefined);
      return;
    }
    if (walk.stepped) return;
    if (type === "message_end") {
      const failure = endFailure(frame["message"]);
      if (failure !== undefined) this.step(walk, failure);
      return;
    }
    if (type === "session_lifecycle" && lifecyclePolicyRejection(frame["lifecycle"])) {
      // OmO's own verdict on the turn that ended, gated on the turn having run at all: between a step and its resend
      // the row is still the old turn's, and the resend's turn has produced nothing yet.
      if (walk.started && !this.session.running()) this.step(walk, "refusal");
      return;
    }
    if (type === "agent_settled" || (type === "session_lifecycle" && lifecycleRunning(frame["lifecycle"]) === false)) {
      if (!walk.started) return;
      if (walk.dead) {
        this.walk = undefined;
        this.clearSilence();
        this.show(undefined);
      } else if (walk.aborted === undefined && emptyAnswer(walk.tally)) this.step(walk, "empty");
      // An aborted turn is never an empty answer: a `"user"` abort was already disarmed above, and a `"system"`
      // abort (compaction, a deadline, OmO's own liveness) has its own line and is no failure of any model.
      else this.settle(walk);
    }
  }

  /** «Прервать»: the session stays on the model it is on, and nothing is repeated. */
  interrupt(): void {
    this.generation += 1;
    this.clearSilence();
    this.waiting = undefined;
    this.walk = undefined;
    this.show(undefined);
  }

  /**
   * The person pressed «Стоп» in the composer. Their own, deliberate end to the turn: the walk is cancelled exactly as
   * «Прервать» cancels it, whatever aborted-empty shape the turn is about to take — so no failure path can step the
   * ladder, switch the model or send a continuation. A deterministic companion to reading `abortSource: "user"` off
   * the frames: the ladder stops watching the moment the click lands, before any frame for the abort arrives.
   */
  noteStop(): void {
    this.interrupt();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearSilence();
    this.waiting = undefined;
    this.walk = undefined;
  }

  // ---------- internals ----------

  /** The rung the session's model stands on, else -1: a model on no rung has nowhere below it, so the walk stops. */
  private rungOfCurrentModel(): number {
    const model = this.session.model();
    if (model === undefined) return -1;
    return this.session.ladder().rungs.findIndex((rung) => rung.action.kind === "model" && sameModel(rung.action, model));
  }

  private show(view: LadderView | undefined): void {
    if (view === undefined && this.shown === undefined) return;
    this.shown = view;
    this.session.view(view);
  }

  private clearSilence(): void {
    if (this.silence !== undefined) clearTimeout(this.silence);
    this.silence = undefined;
  }

  /** The silence clock: it runs only while a turn for the watched message is going, and every frame restarts it. */
  private armSilence(): void {
    this.clearSilence();
    const walk = this.walk;
    if (walk === undefined || walk.stepped || !this.session.running()) return;
    this.silence = setTimeout(() => {
      this.silence = undefined;
      if (this.walk === walk && !walk.stepped && this.session.running()) this.step(walk, "silence");
    }, SILENCE_MS);
  }

  /** The message was answered after a walk: the session stays here, with one click back to where it started. */
  private settle(walk: Walk): void {
    this.walk = undefined;
    this.clearSilence();
    const { rescuer, first } = walk;
    if (rescuer === undefined || first === undefined || sameModel(rescuer, first)) {
      this.show(undefined);
      return;
    }
    const generation = this.generation;
    void this.session
      .models()
      .then((served) => {
        if (this.disposed || generation !== this.generation) return; // the person has moved on
        const label = (model: ModelRef): string => served.find((item) => sameModel(item, model))?.name ?? model.id;
        this.show({ state: "settled", model: label(rescuer), back: { ...first, label: label(first) } });
      })
      .catch(() => undefined); // the line is cosmetic: a model list that will not load leaves it off
  }

  /** One failure, once per message. The replay/continuation decision is per rung and lives in `walkOn`. */
  private step(walk: Walk, failure: FailureClass): void {
    walk.stepped = true;
    this.clearSilence();
    void this.walkOn(walk, failure).catch(() => {
      if (this.walk === walk) this.walk = undefined;
      this.show(undefined);
      this.session.note("warn", `${REASON[failure]} — не удалось повторить сообщение`);
    });
  }

  private async walkOn(walk: Walk, failure: FailureClass): Promise<void> {
    if (walk.at < 0) {
      // The session's model is on no rung, so the ladder has no model *below* it to fall to. The walk only ever steps
      // down from where the session stands; with nowhere below it, it stops and asks rather than climbing from the top
      // to a model the person did not choose — «на Sol? не тащи меня в Claude».
      this.walk = undefined;
      this.show(undefined);
      this.session.note("warn", `${REASON[failure]} — текущая модель не на лесенке, дальше решайте сами`);
      return;
    }
    const { rungs } = this.session.ladder();
    const served = await this.session.models();
    if (this.walk !== walk) return; // interrupted, or another message took over
    const label = (rung: Extract<Rung["action"], { kind: "model" }>): string => served.find((item) => sameModel(item, rung))?.name ?? rung.id;
    for (let at = walk.at + 1; at < rungs.length; at++) {
      const rung = rungs[at] as Rung;
      if (walk.fired.has(rung.id) || !rung.on.includes(failure)) continue;
      if (rung.action.kind === "model" && !served.some((item) => sameModel(item, rung.action as LadderModel))) {
        walk.fired.add(rung.id);
        this.session.note("info", `Ступенька ${at + 1} пропущена: ${label(rung.action)} нет в этой среде`);
        continue;
      }
      // What this rung carries: a model to switch to, and the phrase to send. With no phrase, a model rung repeats the
      // person's own message — a replay. With a phrase, it sends that instead — a continuation, which re-runs nothing.
      const continuation = rung.action.kind === "ask" ? undefined : rung.action.text;
      if (continuation === undefined && rung.action.kind === "model" && walk.tally.tools) {
        // The turn called a tool, wrote a file or ran a command: replaying the message would do it a second time. This
        // rung has no phrase to carry on with, so it behaves as «остановиться и спросить», naming the reason.
        walk.fired.add(rung.id);
        this.walk = undefined;
        this.show(undefined);
        this.session.note("warn", `${REASON[failure]}, но ход уже выполнил действия — не повторяю, решите сами`);
        return;
      }
      walk.fired.add(rung.id);
      walk.at = at;
      if (rung.action.kind === "ask") {
        this.walk = undefined;
        this.show(undefined);
        this.session.note("warn", `${REASON[failure]} — дальше решайте сами`);
        return;
      }
      const name = rung.action.kind === "model" ? label(rung.action) : rung.action.text;
      this.show({ state: "walking", rung: at + 1, total: rungs.length, label: name });
      await this.stopTheTurn(`${REASON[failure]}, ступенька ${at + 1} (${name})`);
      if (this.walk !== walk) return;
      if (rung.action.kind === "model") {
        await this.session.setModel({ provider: rung.action.provider, id: rung.action.id });
        if (this.walk !== walk) return;
        walk.rescuer = { provider: rung.action.provider, id: rung.action.id };
        walk.tried += 1;
      }
      // The last look before the message leaves: «Прервать» must not be answered by one going out anyway. A
      // continuation is a genuinely new message under its own id, not a resend tied to the original.
      if (this.walk !== walk) return;
      const id = this.newId();
      const text = continuation ?? walk.text;
      const images = continuation === undefined ? walk.images : [];
      if (!(await this.session.send(id, text, images))) {
        if (this.walk === walk) this.walk = undefined;
        this.show(undefined);
        this.session.note("warn", `${REASON[failure]} — не удалось повторить сообщение`);
        return;
      }
      if (this.walk !== walk) return;
      walk.id = id;
      walk.stepped = false;
      walk.started = false;
      walk.dead = false;
      walk.aborted = undefined;
      walk.tally = { text: false, tools: false };
      this.session.note("info", this.stepNote(failure, rung.action, name));
      this.armSilence();
      return;
    }
    this.walk = undefined;
    this.show(undefined);
    this.session.note("warn", `Дальше некуда: перепробовал ${models(walk.tried)}`);
  }

  /** The feed line for a step that went out: the model it moved to, the phrase it sent, or both. */
  private stepNote(failure: FailureClass, action: Extract<Rung["action"], { kind: "model" | "text" }>, name: string): string {
    if (action.kind === "text") return `${REASON[failure]} — отправил «${action.text}»`;
    if (action.text === undefined) return `${REASON[failure]} — перешёл на ${name} и повторил`;
    return `${REASON[failure]} — перешёл на ${name} и отправил «${action.text}»`;
  }

  /**
   * The turn goes before anything else happens: the gateway holds the request in its queue, and an answer that
   * arrived after the switch would be a second answer to one message. An abort OmO answers but does not act on
   * leaves the existing way out — unload the session and open it again.
   *
   * The abort is sent whatever the tab's own state says. A refusal ends the turn *locally* — the reducer has already
   * drawn its line and put the composer back — while the request itself is still in the gateway's queue, so the one
   * case the abort exists for is exactly the one where the tab believes nothing is running.
   */
  private async stopTheTurn(reason: string): Promise<void> {
    await this.session.abort(reason);
    const deadline = Date.now() + ABORT_WAIT_MS;
    while (this.session.running() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, ABORT_POLL_MS));
    }
    if (this.session.running()) await this.session.unwedge();
  }
}
