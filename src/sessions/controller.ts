import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import type { ChatState, ImageRef, ModelRef } from "../chat/model";
import { addOutgoing, applyEntries, applyFrame, applyLifecycle, applyTaskList, dropOutgoing, goalCardNotice, initialState, lifecycleRunning, resolveDialog, reviseQueued, stoppedGoalNotice, taskStatus } from "../chat/reducer";
import type { DaemonManager } from "../daemon";
import { redact } from "../env";
import { acceptsImageInput, type AgentDetails } from "../panel/protocol";
import { BARRIER_DEADLINE_MS, type Checkpointer } from "../rewind/checkpointer";
import { readSessionHeader } from "../rewind/fork";
import type { SentMode } from "../rewind/store";
import { RpcError, type RpcClient } from "../rpc/client";
import type { Ladder } from "../settings/ladder";
import { claimAutoUnwedge } from "./autoUnwedge";
import { claimReopen, releaseReopen } from "./reopenRation";
import { sharedImages, type ImageStore } from "./images";
import { ModelLadder, type LadderView } from "./ladder";
import { instantDeadTurn, openWorkText, systemAbortStall, type OpenWork } from "./liveness";
import type { ModelLevel } from "./rememberedLevels";

/** A mode keyword that prefixes every prose message while it is on (the actions menu's toggles). */
export type NextMode = "ulw" | "mass ulw";

export type TabState = { sessionPath?: string; modelMode: "auto" | "manual"; title?: string; durableId?: string; stickyMode?: NextMode };

export type DialogAnswer = { value?: string; confirmed?: boolean; answers?: unknown; cancelled?: boolean; comment?: string };
/** How an answer ended: taken, refused because OmO had already settled the dialog (timeout, another client), or failed. */
export type AnswerOutcome = "applied" | "closed" | "failed";

/** OmO's word for a dialog it no longer has: the answer comes too late, the dialog is gone for good. */
const DIALOG_GONE = new Set(["unknown_extension_ui_request", "question_already_resolved"]);
/** A dialog past its deadline is dropped this long after it, if OmO has not said so by then. */
const DIALOG_DEADLINE_GRACE_MS = 500;

export type OutgoingImage = { mimeType: string; data: string; name?: string };

/**
 * What «Снять зависание» did: the session was unloaded and re-opened here, OmO refused to unload it (nothing changed),
 * or the call itself did not go through (see `state.error`).
 */
export type UnwedgeOutcome = { outcome: "unloaded" } | { outcome: "refused"; reason: string } | { outcome: "failed"; reason: string };

/** OmO's words for an unload it would not do, in the person's language; anything new is shown as it came. */
const UNLOAD_REFUSAL: Record<string, string> = {
  turn_active: "Ход агента не удалось прервать",
  work_pending: "Осталась незавершённая работа",
  extension_work: "Работают расширения сессии",
  children_live: "Дочерние задачи ещё работают",
  attached: "Сессию держат другие клиенты",
  host_draining: "OmO останавливается",
  session_closing: "Сессия уже закрывается",
  unsupported: "Эту сессию нельзя выгрузить",
};

/** What became of «Отозвать» / «Изменить»: done, too late (OmO already gave it to the agent), or failed (see `state.error`). */
export type QueueOutcome = { outcome: "removed"; text: string; images: OutgoingImage[] } | { outcome: "edited" } | { outcome: "delivered" } | { outcome: "failed" };

export type CommandRow = {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  syntax: "slash" | "dollar";
};

type Frame = Record<string, any>;

const ENTRIES_PAGE_LIMIT = 500;
const SESSION_NAME_MAX = 60;
/**
 * The agent rows are cosmetic and off the open path, so the list is asked for with a deadline of its own instead of the
 * client's 30-second default: a reopened session's task bridge answers `omo.task.list` never at all (OmO 5.1.59), and
 * the open used to sit on that request for the full 30 seconds with the conversation already in hand.
 */
const TASK_LIST_TIMEOUT_MS = 5_000;

/** What one journal load cost: the one line an open writes to the channel is made of it. */
type JournalLoad = { ms: number; pages: number };

/**
 * What OmO asks a client to send after it resumed a session whose goal it had stopped: `/goal resume` puts the goal
 * back to active and queues its continuation, so the agent carries on by itself. A slash command goes in as a prompt
 * and is answered `disposition: "handled"` — an input handler took it, no turn of its own was started.
 */
const GOAL_RESUME_COMMAND = "/goal resume";
const GOAL_RESUMED_TEXT = "Цель сессии была остановлена — возобновил её, агент продолжает работу";
const GOAL_RESUME_FAILED_TEXT = "Цель сессии остановлена, и возобновить её не удалось — агент сам не продолжит, напишите, что делать дальше";

/** One fixed id for the park line, so a session parked more than once shows it once instead of stacking a copy per reopen. */
const PARK_NOTICE_ID = "parked";
const PARK_TEXT = "Сессия выгружена — открываю заново";
/**
 * What the tab says when OmO keeps parking the session faster than it can stay open: the automatic reopen gave up (see
 * `src/sessions/reopenRation.ts`) rather than storm, and «Переподключить» is the person's way to try again.
 */
const REOPEN_STORM_TEXT = "Сессия раз за разом выгружается и не остаётся открытой — перестал открывать её заново. Нажмите «Переподключить», чтобы попробовать снова.";

/**
 * What the feed says about a turn OmO killed itself (`src/sessions/liveness.ts`): the message never reached the model,
 * and OmO never re-sends an admitted message («an admitted turn is never replayed, even if later aborted»), so without
 * these lines the person is left with a tab that says «Работаю…» and an answer that is never coming.
 *
 * The way out is the one OmO leaves a client: the only client-reachable reset of the state this turn died in is a
 * session shutdown (`unload_session` → `session_shutdown`), and the message has to go back in under a **new**
 * `clientMessageId` — a repeat under the old one comes back from OmO's admission record without running anything.
 */
const LIVENESS_ABORT_TEXT = "OmO оборвал ход сам, сразу после старта — ответа на это сообщение не будет";
const LIVENESS_RESENT_TEXT = "Перезапустил сессию и отправил сообщение заново";
const LIVENESS_GOAL_TEXT = "Перезапустил сессию — агент продолжает по цели, ваше сообщение у него уже есть";
const LIVENESS_MANUAL_TEXT = "Отправьте сообщение заново — а если повторится, перезапустите сессию кнопкой «Снять зависание»";
/** Why the automatic restart happened, for the «Agent Tabs» channel. */
const LIVENESS_UNWEDGE_WHY = "OmO оборвал ход сам сразу после старта";
/**
 * A `"system"` abort that landed *after* the turn had done real work (tool calls, model output) — not the instant-dead
 * one above. OmO's own machinery decided to park the turn: the stall row it leaves is written only once OmO has ruled
 * out a retry or a queued continuation (`willRetry`/`continuationQueued` in the binary), so by the time we read it the
 * turn is genuinely stopped. We say so plainly and leave the tab usable — the message was already answered, so there is
 * nothing to resend; «Снять зависание» is still there if the person wants to nudge a stuck goal.
 */
const SYSTEM_ABORT_TEXT = "OmO остановил ход сам";
/** The benign twin: the abort was OmO starting a context compaction, after which it continues the turn on its own. */
const SYSTEM_ABORT_COMPACTING_TEXT = "OmO сжимает контекст и продолжит сам";

function isObject(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OmO rejects a `prompt` sent while a compaction is in flight — and only a `prompt`; a follow_up enqueues cleanly and
 * drains when the compaction ends. It throws a plain `Error` with no typed code (the RPC layer falls back to code
 * "error"), so its English text is the only thing to match on. Matched loosely on purpose, and used only as the race
 * fallback behind the `compacting` state check, which is what normally routes a message to the queue.
 */
const COMPACTION_REJECT = /compaction is in progress/i;
function isCompactionReject(error: RpcError): boolean {
  return COMPACTION_REJECT.test(error.message);
}

/** The one rule for a session's name: whitespace collapsed, trimmed, capped. Empty means "no name". */
export function normalizeSessionName(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SESSION_NAME_MAX);
}

/** The host's context estimate into the state: the window, and the token count (null after a compaction clears it until the next reply). */
function withContextUsage(state: ChatState, usage: unknown): ChatState {
  if (!isObject(usage)) return state;
  const { contextTokens: _old, ...rest } = state;
  const tokens = usage["tokens"];
  const window = usage["contextWindow"];
  return {
    ...rest,
    ...(typeof tokens === "number" ? { contextTokens: tokens } : {}),
    ...(typeof window === "number" && window > 0 ? { contextWindow: window } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Asking the host what it supports is on the path of a prompt: never long. */
const PROTOCOL_INFO_TIMEOUT_MS = 3_000;

/** Whether the host behind a connection advertises `tool_barrier`: an answer is kept per connection, a failure is asked again. */
const barrierSupport = new WeakMap<RpcClient, Promise<boolean>>();

function supportsToolBarrier(client: RpcClient): Promise<boolean> {
  const known = barrierSupport.get(client);
  if (known !== undefined) return known;
  const asking: Promise<boolean> = client
    .request<Frame>("get_protocol_info", {}, PROTOCOL_INFO_TIMEOUT_MS)
    .then((info) => Array.isArray(info?.["capabilities"]) && info["capabilities"].includes("tool_barrier"))
    .catch(() => {
      if (barrierSupport.get(client) === asking) barrierSupport.delete(client);
      return false;
    });
  barrierSupport.set(client, asking);
  return asking;
}

/**
 * One chat tab's connection to one omo session. Events: "change"(state), "surfaces" (commands may have changed),
 * "model" (this session's model changed), "attached" (a re-attach succeeded).
 * Never resends user messages: after a reconnect it re-attaches by session path and catches up from the journal.
 */
export class SessionController extends EventEmitter {
  private client: RpcClient;
  private handle = "";
  private current: ChatState = initialState();
  private readonly tab: TabState = { modelMode: "auto" };
  private buffer: Frame[] | undefined;
  private reconnecting: Promise<void> = Promise.resolve();
  /** The chain of reopens a park started: «Снять зависание» waits for the one its own unload caused. */
  private reopening: Promise<void> = Promise.resolve();
  private released = false;
  /** The timer that drops a dialog past its deadline, and the dialog list it was armed for. */
  private deadlineTimer: NodeJS.Timeout | undefined;
  private armedFor: ChatState["dialogs"] | undefined;
  private ready: Promise<void> | undefined;
  private nameSent = false;
  private durableId: string | undefined;
  private sessionCwd: string | undefined;
  /** The last message's dispatch (not its response): the next message is written after it. */
  private outgoing: Promise<unknown> = Promise.resolve();
  /** A prompt started a turn whose frames have not settled yet: until they do, a new message steers it. */
  private turnStarting = false;
  /** A `/goal resume` of this tab's own is in flight: one at a time, and its goal card is OmO's echo, not news. */
  private goalResuming = false;
  /** How many `/goal resume`s of this tab's own OmO accepted: a liveness recovery reads whether its reopen made one. */
  private goalsResumed = 0;
  /** The latest `/goal resume` of this tab's own, settled or not: a reopen starts it before it hands control back. */
  private goalResumeRun: Promise<void> = Promise.resolve();
  /**
   * The message a turn of ours is answering, and whether its one automatic recovery from a liveness abort is spent.
   * `key` is the person's own message id — a recovery's resend inherits it, so its own death cannot buy a second try.
   * `delivered` is set once a real turn result landed for it: a later `"system"` abort (an autonomous goal-continuation
   * turn OmO killed by itself) must never resend a message the model already answered — that is the second copy the
   * person saw. Only a message whose own turn died with zero effect is safe to put back.
   */
  private answering: { key: string; id: string; text: string; images: OutgoingImage[]; recovered: boolean; delivered: boolean } | undefined;
  /** Set while a recovery's resend goes out: it inherits the spent attempt instead of starting a new one. */
  private resending = false;
  /**
   * The person pressed «Стоп» while a message was queued behind the running turn. OmO aborts the turn but does not
   * start the queued message by itself (measured on 5.1.59: the follow_up stays `queued` with its `queuedId` forever),
   * so once the turn has actually ended the tab delivers the queue itself — the next turn is what the person queued.
   */
  private drainOnStop = false;
  /** The turn's last assistant message was one OmO abandoned as it was being made; the id it was answering, if named. */
  private deadTurn: { id: string | undefined } | undefined;
  /** A compaction of ours is in flight: the abort it sends is `"system"` too, and it is not a hang. */
  private ownCompact = false;
  /**
   * A `"system"` abort held until the very next frame says which kind it is: a `compaction_start` makes it benign (OmO
   * is compacting and will carry on), an end-of-turn frame (`agent_settled` / a settled lifecycle) makes it a genuine
   * park. Holding it one frame keeps the honest line from flashing before the compaction that replaces it — and routes
   * both shapes of a `"system"` abort through one decision: the instant-dead turn (`dead` set, the message never reached
   * the model, so it can be put back) and the abort after real work (`dead` undefined, the message was answered).
   */
  private pendingSysAbort: { key: string; work: OpenWork; dead: { id: string | undefined } | undefined } | undefined;
  /** The model ladder, once the tab has given this session one. */
  private modelLadder: ModelLadder | undefined;
  /** What was sent and is not in the conversation yet, by clientMessageId: a dequeued message goes back to the composer as typed. */
  private readonly outbox = new Map<string, { text: string; images: OutgoingImage[] }>();
  /** This tab's prefix in the shared image store: two sessions can have the same image ids. */
  private readonly imageScope = `${randomUUID()}/`;
  private readonly sink = (ref: ImageRef, data: string): void => this.imageStore.put({ ...ref, id: this.imageScope + ref.id }, data);
  private readonly onFrame = (frame: Frame): void => this.handleFrame(frame);
  private readonly onConnected = (client: RpcClient): void => {
    this.reconnecting = this.reconnecting.then(() => this.reconnect(client));
  };

  private constructor(
    private readonly dm: DaemonManager,
    client: RpcClient,
    private readonly imageStore: ImageStore,
    private readonly checkpointer: Checkpointer | undefined,
    /** One line per open (and one when a post-open extra fails) for the «Agent Tabs» channel; absent in tests. */
    private readonly log: ((text: string) => void) | undefined,
  ) {
    super();
    this.client = client;
  }

  /** Opens a brand-new session in `cwd` (the profile picks the model). */
  static async create(
    dm: DaemonManager,
    cwd: string,
    images: ImageStore = sharedImages,
    checkpointer?: Checkpointer,
    log?: (text: string) => void,
  ): Promise<SessionController> {
    const controller = new SessionController(dm, await dm.client(), images, checkpointer, log);
    controller.sessionCwd = realpathSync(cwd);
    await controller.start(
      { cwd: controller.sessionCwd, retain_on_disconnect: true, promptSurface: "app", auto_title: true },
      "full",
    );
    return controller;
  }

  /** Attaches to an existing session file and loads its whole history. Without saved tab state the model mode is inferred. */
  static async attach(
    dm: DaemonManager,
    sessionPath: string,
    saved?: TabState,
    images: ImageStore = sharedImages,
    checkpointer?: Checkpointer,
    log?: (text: string) => void,
  ): Promise<SessionController> {
    const controller = new SessionController(dm, await dm.client(), images, checkpointer, log);
    Object.assign(controller.tab, saved, { sessionPath });
    try {
      const cwd = (await readSessionHeader(sessionPath))["cwd"];
      if (typeof cwd === "string") controller.sessionCwd = cwd;
    } catch {
      // no readable header: the session simply gets no checkpoints
    }
    await controller.start({ sessionPath, retain_on_disconnect: true }, "full");
    const { model, autoModel } = controller.current;
    if (saved === undefined && model !== undefined && autoModel !== undefined) {
      const profileModel = model.provider === autoModel.provider && model.id === autoModel.id;
      controller.tab.modelMode = profileModel ? "auto" : "manual";
    }
    return controller;
  }

  /**
   * Renames a session this window has no tab for. A freshly resumed one (`attached: false`) is closed again, even if the
   * rename fails; one that was already live in the daemon (a retained tab, a terminal) only loses our attachment —
   * closing it would tear down its work.
   */
  static async renameClosed(dm: DaemonManager, sessionPath: string, name: string): Promise<void> {
    const client = await dm.client();
    const clean = (error: unknown): Error => new Error(redact(errorText(error), dm.secrets));
    let sessionId: string;
    let wasLive: boolean;
    try {
      const opened = await client.request<Frame>("open_session", { sessionPath });
      sessionId = String(opened["sessionId"]);
      wasLive = opened["attached"] === true;
    } catch (error) {
      throw clean(error);
    }
    try {
      await client.request("set_session_name", { sessionId, name });
    } catch (error) {
      throw clean(error);
    } finally {
      await client.request(wasLive ? "release_attachment" : "close_session", { sessionId }).catch(() => undefined);
    }
  }

  get state(): ChatState {
    return this.current;
  }

  get tabState(): TabState {
    return this.tab;
  }

  /** The session's working directory: realpath'd on create, from the session file's header on attach. */
  get cwd(): string | undefined {
    return this.sessionCwd;
  }

  /** The session's durable id (its file's header id). */
  get sessionUuid(): string | undefined {
    return this.durableId;
  }

  /** The whole journal, paged, with the active branch's leaf. */
  async journal(): Promise<{ entries: Record<string, unknown>[]; leafId: string | null }> {
    const entries: Record<string, unknown>[] = [];
    let leafId: string | null = null;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.guarded(() =>
        this.request<Frame>("get_entries", { limit: ENTRIES_PAGE_LIMIT, ...(cursor !== undefined ? { since: cursor } : {}) }),
      );
      const list: unknown[] = Array.isArray(page?.["entries"]) ? page["entries"] : [];
      entries.push(...list.filter(isObject));
      if (typeof page?.["leafId"] === "string") leafId = page["leafId"];
      if (page?.["hasMore"] !== true || typeof page["nextSince"] !== "string" || page["nextSince"] === cursor) return { entries, leafId };
      cursor = page["nextSince"];
    }
  }

  /** Adds a local notice to the feed (not in the journal). */
  note(level: "info" | "warn" | "error", text: string): void {
    this.commit({ ...this.current, blocks: [...this.current.blocks, { kind: "notice", id: `rewind:${randomUUID()}`, level, text }] });
  }

  /** True while this tab holds a session handle on the current connection. */
  get attached(): boolean {
    return this.handle !== "";
  }

  /**
   * «Переподключить» when the connection is live but re-opening failed: releases the old handle if there is one,
   * then re-opens by session path on the current client and catches up. Never resends messages.
   */
  async reattach(): Promise<void> {
    if (this.durableId !== undefined) releaseReopen(this.durableId); // the person's own reopen is not a storm: let the ration start fresh
    await this.reopen();
  }

  /** The body of a reopen on the current connection; the automatic park path uses it directly so it does not reset the ration. */
  private async reopen(): Promise<void> {
    if (this.released) return;
    let client: RpcClient;
    try {
      client = await this.dm.client();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.reconnecting = this.reconnecting.then(() => this.reconnect(client));
    await this.reconnecting;
  }

  /**
   * Enter while a turn runs (or is starting) steers, idle prompts; "followUp" always queues behind the turn. The message
   * shows at once as sending, under `clientMessageId` (a retry passes the same id: OmO answers a repeat from its record,
   * never a second message). False = not sent: the message is taken back (see `state.error`).
   */
  async send(text: string, mode: "auto" | "followUp", images: OutgoingImage[] = [], clientMessageId: string = randomUUID()): Promise<boolean> {
    const imageParts =
      images.length > 0 ? { images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) } : {};
    // an image-only first message has no words to name the session by; the first text does it
    const unnamed =
      !this.nameSent && normalizeSessionName(text) !== "" && this.current.title === undefined && !this.current.blocks.some((block) => block.kind === "user" && block.text.trim() !== "");
    // What the next turn is answering, for a liveness abort to put back; a recovery's own resend inherits the attempt.
    const inherited = this.resending ? this.answering : undefined;
    this.answering = { key: inherited?.key ?? clientMessageId, id: clientMessageId, text, images, recovered: inherited !== undefined, delivered: false };
    // A recovery resends under a new id; the earlier bubble (its old id, perhaps re-queued when OmO restored the queue)
    // is the same message and must leave the feed, so the person sees it once — delivered, never also queued.
    this.showOutgoing(clientMessageId, text, images, inherited?.key);
    const fields = { message: text, clientMessageId, ...imageParts };
    /**
     * Messages leave in the order they were sent, through one chain: preparing a barrier must not let a later message
     * overtake, and a prompt that meets a running turn is re-sent as a steer (same id: never a second message) before
     * anything sent after it. A prompt therefore holds the chain until its answer; other messages only until written.
     * The kind is chosen when the message leaves: one that waited for a prompt that started its turn steers that turn.
     */
    const dispatch = this.outgoing.then(async () => {
      // A message typed while a compaction runs goes to the queue, not in as a prompt: OmO rejects a prompt during a
      // compaction, and the queue drains by itself when the compaction ends — exactly the wait the person expects.
      const type =
        mode === "followUp" || this.current.compacting
          ? "follow_up"
          : this.current.running || this.turnStarting
            ? "steer"
            : "prompt";
      const barrier = type === "prompt" ? await this.barrierPoint() : undefined;
      const toolBarrier = barrier ? { toolBarrier: { id: barrier.pointId, deadlineMs: BARRIER_DEADLINE_MS } } : {};
      const armedAt = Date.now();
      const sent = this.request<Frame>(type, { ...fields, ...toolBarrier });
      const answer =
        type !== "prompt"
          ? sent.then((data) => ({ data, steered: false, queued: false }))
          : sent.then(
              (data) => ({ data, steered: false, queued: false }),
              async (error: unknown) => {
                if (error instanceof RpcError && error.code === "streaming") {
                  return { data: await this.request<Frame>("steer", fields), steered: true, queued: false };
                }
                // A prompt that lost the race to a compaction OmO had just begun (its `compacting` flag had not
                // reached us when `type` was chosen): re-route to the queue rather than surface OmO's refusal.
                if (error instanceof RpcError && isCompactionReject(error)) {
                  return { data: await this.request<Frame>("follow_up", fields), steered: false, queued: true };
                }
                throw error;
              },
            );
      const settled = answer.then(({ data, steered, queued }) => {
        if (type === "prompt" && !steered && !queued && data?.["disposition"] === "started") this.turnStarting = true;
        return { data, steered, queued };
      });
      return { type, barrier, armedAt, answer: settled };
    });
    this.outgoing = dispatch.then(({ type, answer }) => (type === "prompt" ? answer : undefined)).catch(() => undefined);
    let sentMode: SentMode | undefined;
    try {
      const { type, barrier, armedAt, answer } = await dispatch;
      sentMode = type === "steer" ? "steer" : type === "follow_up" ? "followUp" : undefined;
      const { data, steered, queued } = await answer;
      if (steered) sentMode = "steer";
      else if (queued) sentMode = "followUp"; // a prompt re-routed to the queue mid-compaction is a queued message now
      else if (barrier !== undefined && data?.["toolBarrier"] === "armed") this.captureThenRelease(barrier, clientMessageId, armedAt);
      else if (data?.["toolBarrier"] === "ignored") sentMode = "steer";
      if (data?.["disposition"] === "handled") {
        this.takeBack(clientMessageId); // a command consumed it: no message will come
        if (this.answering?.id === clientMessageId) this.answering = undefined; // and no turn is answering it
      }
    } catch (error) {
      this.takeBack(clientMessageId);
      this.fail(error);
      return false;
    }
    if (sentMode !== undefined && this.checkpointer !== undefined && this.durableId !== undefined) {
      await this.checkpointer.markSent(this.durableId, clientMessageId, sentMode);
    }
    if (unnamed) {
      this.nameSent = true;
      await this.nameSession(text);
    }
    return true;
  }

  /** «Отозвать»: takes a queued message out of OmO's queue. Removed → it leaves the feed and its text and images come back. */
  async dequeue(blockId: string): Promise<QueueOutcome> {
    const queuedId = this.queuedId(blockId);
    if (queuedId === undefined) return { outcome: "delivered" };
    let data: Frame;
    try {
      data = await this.request<Frame>("dequeue_message", { queuedId });
    } catch (error) {
      this.fail(error);
      return { outcome: "failed" };
    }
    if (data?.["status"] !== "removed") return { outcome: "delivered" };
    const block = this.current.blocks.find((candidate) => candidate.id === blockId);
    const sent = this.outbox.get(blockId);
    this.takeBack(blockId);
    return { outcome: "removed", text: sent?.text ?? (block?.kind === "user" ? block.text : ""), images: sent?.images ?? [] };
  }

  /** «Изменить»: replaces a queued message's text in place; an edit made elsewhere meanwhile wins and is reported. */
  async editQueued(blockId: string, text: string): Promise<QueueOutcome> {
    const queuedId = this.queuedId(blockId);
    if (queuedId === undefined) return { outcome: "delivered" };
    const block = this.current.blocks.find((candidate) => candidate.id === blockId);
    const revision = block?.kind === "user" && block.delivery?.state === "queued" ? block.delivery.revision : undefined;
    let data: Frame;
    try {
      data = await this.request<Frame>("edit_queued_message", { queuedId, text, ...(revision !== undefined ? { expectedRevision: revision } : {}) });
    } catch (error) {
      this.fail(error);
      return { outcome: "failed" };
    }
    if (data?.["status"] === "conflict") {
      this.commit({ ...this.current, error: "Сообщение в очереди уже изменили — изменение не применено" });
      return { outcome: "failed" };
    }
    if (data?.["status"] !== "edited") return { outcome: "delivered" };
    const edited = typeof data["text"] === "string" ? data["text"] : text;
    const sent = this.outbox.get(blockId);
    if (sent !== undefined) sent.text = edited;
    this.commit(reviseQueued(this.current, blockId, edited, typeof data["revision"] === "number" ? data["revision"] : undefined));
    return { outcome: "edited" };
  }

  /** Cancels every pending dialog (abort is ignored while one is open), then aborts the turn. */
  async stop(): Promise<void> {
    this.noteInterrupt("Прерываю ход: «Стоп» — попросил человек");
    this.modelLadder?.noteStop(); // the person's own end to the turn: the ladder stops watching, never steps on it
    for (const dialog of this.current.dialogs) {
      try {
        await this.request("extension_ui_response", { uiRequestId: dialog.id, cancelled: true });
        this.commit(resolveDialog(this.current, dialog.id));
      } catch {
        // a dialog that is already gone must not block the abort
      }
    }
    const hadQueue = this.current.blocks.some((block) => block.kind === "user" && block.delivery?.state === "queued");
    try {
      await this.request("abort");
    } catch (error) {
      this.fail(error);
      return;
    }
    // The person expects what they queued to go out now. OmO's abort does not drain the queue, so the tab does: if the
    // turn has already ended, deliver it at once; otherwise mark it and let the turn-end do it (never twice — the drain
    // takes each message out of OmO's queue before re-sending, so a message OmO did run is skipped).
    if (!hadQueue) return;
    if (this.current.running) this.drainOnStop = true;
    else await this.drainQueueAfterStop();
  }

  /** Called only after confirmation. Abort does not cancel extension work in OmO 5.1.59. */
  async stopBackground(): Promise<void> {
    const background = this.current.background;
    if (this.current.running || this.turnStarting || background === undefined) return;
    try {
      const data = await this.taskRequest("omo.task.list", {});
      this.throwOnTaskFailure(data);
      this.commit(applyTaskList(this.current, data));
      const tasks = this.current.agents.filter((agent) => agent.taskId !== undefined && (agent.status === "running" || agent.status === "waiting"));
      for (const task of tasks) {
        if (this.current.running || this.turnStarting) return;
        if (task.taskId !== undefined) await this.cancelTask(task.taskId);
      }
      if (tasks.length > 0) this.note("info", `Отмена фоновых задач запрошена: ${tasks.length}`);
      if (background.sources.includes("terminal-background-sessions")) {
        if (this.current.running || this.turnStarting) return;
        // No interrupt or child detachment: a new turn or remaining children must prevent the unload.
        this.noteInterrupt("Выгружаю сессию: остановить фоновые команды — подтвердил человек");
        const result = await this.unloadSession({ force: true });
        this.note(result.outcome === "unloaded" ? "info" : "warn",
          result.outcome === "unloaded" ? "Фоновые команды остановлены" : `Не удалось остановить фоновые команды: ${result.reason}`);
      }
      const unsupported = background.sources.filter((source) => source !== "senpi-task" && source !== "terminal-background-sessions");
      if (unsupported.length > 0) this.note("warn", `Отмена этих фоновых задач через RPC недоступна: ${unsupported.join(", ")}`);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Delivers what was queued behind a turn the person stopped. Each still-queued message is first removed from OmO's
   * own queue (`dequeue_message`); only if that removal succeeds is it re-sent, so a message OmO delivered after all is
   * never sent a second time. Order is kept, and the first one prompts a new turn.
   */
  private async drainQueueAfterStop(): Promise<void> {
    const queued = this.current.blocks.filter((block) => block.kind === "user" && block.delivery?.state === "queued");
    for (const block of queued) {
      const queuedId = this.queuedId(block.id);
      if (queuedId === undefined) continue;
      let removed: boolean;
      try {
        const data = await this.request<Frame>("dequeue_message", { queuedId });
        removed = data?.["status"] === "removed";
      } catch (error) {
        this.fail(error);
        return;
      }
      if (!removed) continue; // OmO delivered it after all: it must not be sent again
      const sent = this.outbox.get(block.id);
      const text = sent?.text ?? (block.kind === "user" ? block.text : "");
      const images = sent?.images ?? [];
      this.takeBack(block.id);
      if (text.trim() !== "" || images.length > 0) await this.send(text, "auto", images);
    }
  }

  /**
   * «Снять зависание»: a turn OmO still calls running after «Стоп» (a provider request that never returns) is let go of
   * by unloading the session and opening it again in this tab. `interrupt` aborts the stuck turn, `force` drops the
   * extensions' own work and other clients' holds, and `children: "detach"` leaves child tasks running. The transcript
   * and the queued input survive — OmO restores the queue on the reopen. `why` names who asked, for the channel.
   */
  async unwedgeSession(why: string = "попросил человек"): Promise<UnwedgeOutcome> {
    this.noteInterrupt(`Выгружаю сессию: «Снять зависание» — ${why}`);
    return this.unloadSession({ interrupt: true, force: true, children: "detach" });
  }

  private async unloadSession(fields: Frame): Promise<UnwedgeOutcome> {
    let data: Frame;
    try {
      data = await this.request<Frame>("unload_session", fields);
    } catch (error) {
      this.fail(error);
      return { outcome: "failed", reason: redact(errorText(error), this.dm.secrets) };
    }
    if (data?.["outcome"] !== "unloaded") {
      const reason = typeof data?.["reason"] === "string" ? data["reason"] : "";
      const detail = typeof data?.["detail"] === "string" && data["detail"] !== "" ? `: ${data["detail"]}` : "";
      return { outcome: "refused", reason: redact(`${UNLOAD_REFUSAL[reason] ?? reason ?? "OmO не стал выгружать сессию"}${detail}`, this.dm.secrets) };
    }
    this.parked(); // the park may have arrived first; this is the same step, done once
    await this.reopening; // the reopen it started
    return this.attached ? { outcome: "unloaded" } : { outcome: "failed", reason: this.current.error ?? "Сессию не удалось открыть заново" };
  }

  /**
   * OmO let go of the session (our own unload, or its idle sweep): the handle is dead and the turn with it, so the tab
   * drops both and opens the session again by path. Doing nothing here would leave the tab stuck on «Работаю…» forever.
   */
  private parked(): void {
    if (this.handle === "" || this.released) return;
    this.handle = "";
    this.turnStarting = false; // the handle is gone and the turn with it: the next message prompts, it does not steer
    const blocks = this.current.blocks.filter((block) => block.id !== PARK_NOTICE_ID); // one park line, re-anchored, never a copy per reopen
    this.commit({
      ...this.current,
      running: false,
      blocks: [...blocks, { kind: "notice", id: PARK_NOTICE_ID, level: "info", text: PARK_TEXT }],
    });
    this.reopening = this.reopening.then(() => this.reopen()).catch(() => undefined);
  }

  /**
   * A park OmO sent by itself. Reopen it as `parked` does — unless OmO keeps parking faster than the session can stay
   * open: past the reopen ration (`src/sessions/reopenRation.ts`) the storm is stopped rather than fed, the tab is left
   * honestly not-running with one line and the «Переподключить» button, and the next park is ignored while it holds
   * (the handle is already gone). The person's «Переподключить» clears the ration, so a reopen is always theirs to make.
   */
  private autoParked(): void {
    if (this.handle === "" || this.released) return;
    const durableId = this.durableId;
    if (durableId !== undefined && !claimReopen(durableId)) {
      this.handle = "";
      this.turnStarting = false;
      this.commit({ ...this.current, running: false, error: REOPEN_STORM_TEXT });
      return;
    }
    this.parked();
  }

  /**
   * OmO resumed this session and left its goal stopped, telling us (in English) to resume it explicitly once loading
   * is done. That moment is here: the notice was held with the rest of the session's opening frames and is replayed
   * only after `open_session` and the journal are in hand. The feed hears about it in Russian, once, either way —
   * and if OmO will not resume the goal, the tab says the agent will not carry on by itself instead of waiting on it.
   */
  private async resumeStoppedGoal(): Promise<void> {
    if (this.goalResuming) return;
    this.goalResuming = true;
    const handle = this.handle;
    try {
      const data = await this.request<Frame>("prompt", { message: GOAL_RESUME_COMMAND, clientMessageId: randomUUID() });
      if (this.released || this.handle !== handle) return;
      if (data?.["disposition"] !== "handled") throw new Error(`OmO не выполнил «${GOAL_RESUME_COMMAND}»`);
      this.goalsResumed += 1;
      this.noteOnce("goal-resumed", "info", GOAL_RESUMED_TEXT);
    } catch (error) {
      // A turn is running after all: the goal continues with it, and the person is not waiting on anything.
      if (this.released || this.handle !== handle || (error instanceof RpcError && error.code === "streaming")) return;
      this.log?.(`«${GOAL_RESUME_COMMAND}» не прошёл: ${redact(errorText(error), this.dm.secrets)}`);
      this.noteOnce("goal-resume-failed", "warn", GOAL_RESUME_FAILED_TEXT);
    } finally {
      this.goalResuming = false;
    }
  }

  /**
   * The two records of a turn OmO killed by itself, watched as they come: the aborted assistant message that never
   * reached the model, and OmO's own stall row that names the abort `"system"`. Only the pair fires — see
   * `src/sessions/liveness.ts` for why neither half is enough on its own.
   */
  private observeLiveness(frame: Frame): void {
    const type = frame["type"];
    if (type === "agent_start" || type === "turn_start") this.deadTurn = undefined; // a new turn: the old one's shape is spent
    if (type === "compaction_end") this.ownCompact = false;
    // A held system-abort is settled by the very next frame: compaction makes it benign, the turn's end makes it a park.
    if (type === "compaction_start") this.settlePendingSysAbort(true);
    else if (type === "agent_settled" || (type === "session_lifecycle" && lifecycleRunning(frame["lifecycle"]) === false)) this.settlePendingSysAbort(false);
    if (type === "message_end") {
      const message = isObject(frame["message"]) ? frame["message"] : {};
      if (instantDeadTurn(frame["message"])) {
        const id = typeof frame["clientMessageId"] === "string" ? frame["clientMessageId"] : typeof message["clientMessageId"] === "string" ? message["clientMessageId"] : undefined;
        this.deadTurn = { id };
      } else if ((message["role"] === undefined || message["role"] === "assistant") && this.answering !== undefined) {
        // A real assistant turn result landed (words, a tool call, or any non-instant-dead end): the message it answered
        // is delivered and must never be auto-resent — otherwise a later autonomous abort puts a second copy of it in.
        this.answering.delivered = true;
      }
    }
    if (type !== "entry_appended") return;
    const work = systemAbortStall(frame["entry"]);
    if (work === undefined) return;
    const dead = this.deadTurn;
    this.deadTurn = undefined;
    if (this.ownCompact) {
      this.ownCompact = false; // the person asked for this compaction, and it aborts the turn with the same provenance
      return;
    }
    this.holdSysAbort(work, dead);
  }

  /**
   * A `"system"` abort read off a stall row. The tab stops claiming it works at once (the turn is over whatever the host
   * says next), but which kind it is waits one frame — `settlePendingSysAbort` decides it, so a compaction OmO starts at
   * turn start (its `compaction_start` follows the abort) is never mistaken for a hang. `dead` carries the instant-dead
   * turn when there was one: the same system abort can be OmO compacting, a genuine park, or a turn it killed at birth,
   * and one place now tells them apart. A compaction already in flight is benign now; otherwise the next frame tells us.
   */
  private holdSysAbort(work: OpenWork, dead: { id: string | undefined } | undefined): void {
    this.turnStarting = false;
    this.commit({ ...this.current, running: false, activity: undefined, activityTool: undefined });
    this.pendingSysAbort = { key: this.answering?.key ?? dead?.id ?? "turn", work, dead };
    if (this.current.compacting) this.settlePendingSysAbort(true);
  }

  /**
   * Say which kind the held system-abort was, once a later frame has told us: `compacting` true means OmO is compacting
   * and will carry the turn on by itself — a quiet, reassuring line and no recovery, whether the abort came after real
   * work or at the turn's birth; false means the turn is genuinely stopped. A `dead` instant-dead turn then gets the
   * unload-and-resend recovery (the message never reached the model); otherwise the honest line names what the plan
   * still has open. Either way the tab is already usable (not «Работаю…»).
   */
  private settlePendingSysAbort(compacting: boolean): void {
    const pending = this.pendingSysAbort;
    if (pending === undefined) return;
    this.pendingSysAbort = undefined;
    if (compacting) {
      this.noteOnce(`sysabort:${pending.key}`, "info", SYSTEM_ABORT_COMPACTING_TEXT);
      return;
    }
    // Killed at birth *and* the message it carried never got an answer: only then is it «no answer to this message».
    // The same 2 ms death after a tool result, or in a turn OmO started on its own, is a plain stop of answered work.
    const answering = this.answering;
    const unanswered = answering !== undefined && !answering.delivered && (pending.dead?.id === undefined || pending.dead.id === answering.id);
    if (pending.dead !== undefined && unanswered) {
      this.livenessAbort(pending.work, pending.dead.id); // a real park of a turn killed at birth: put the message back
      return;
    }
    const left = openWorkText(pending.work);
    this.noteOnce(`sysabort:${pending.key}`, "warn", left === undefined ? SYSTEM_ABORT_TEXT : `${SYSTEM_ABORT_TEXT} (${left})`);
  }

  /**
   * OmO killed the turn itself a millisecond after it started, and the held abort has now settled as a genuine park (no
   * compaction followed). The tab already stopped claiming it works when the abort was held (`holdSysAbort`); here the
   * feed hears it plainly once, and the message gets one automatic way back: the session is unloaded and reopened — the
   * only reset of this state a client can reach — and the message is sent again under a new id. Bounded by
   * `answering.recovered` (once per message) and by the auto-unwedge ration (`src/sessions/autoUnwedge.ts`, one
   * automatic restart per session per cooldown, shared with «Снять зависание»).
   */
  private livenessAbort(work: OpenWork, deadId: string | undefined): void {
    const answering = this.answering;
    const key = answering?.key ?? deadId ?? "turn";
    const left = openWorkText(work);
    this.noteOnce(`liveness:${key}`, "warn", left === undefined ? LIVENESS_ABORT_TEXT : `${LIVENESS_ABORT_TEXT} (${left})`);
    const durableId = this.durableId;
    if (
      answering === undefined ||
      answering.recovered ||
      answering.delivered || // a real turn already answered this message: the abort was a later autonomous turn, not this one
      this.released ||
      durableId === undefined ||
      (deadId !== undefined && deadId !== answering.id) || // the dead turn was answering some other message
      !claimAutoUnwedge(durableId) // last: the claim itself starts the cooldown
    ) {
      this.noteOnce(`liveness-fix:${key}`, "warn", LIVENESS_MANUAL_TEXT);
      return;
    }
    answering.recovered = true;
    void this.recoverLivenessAbort(answering);
  }

  /** The way back, in order: unload and reopen the session, then put the message in again under a new id. */
  private async recoverLivenessAbort(answering: { key: string; text: string; images: OutgoingImage[] }): Promise<void> {
    const { key, text, images } = answering;
    const goalsBefore = this.goalsResumed;
    const unwedged = await this.unwedgeSession(LIVENESS_UNWEDGE_WHY);
    if (this.released) return;
    if (unwedged.outcome !== "unloaded") {
      // Without the reopen the state that killed the turn is still there: a resend would die the same way.
      this.noteOnce(`liveness-fix:${key}`, "warn", `${unwedged.reason} — ${LIVENESS_MANUAL_TEXT}`);
      return;
    }
    await this.goalResumeRun; // the reopen may have just asked OmO to resume the goal: hear its answer first
    if (this.released) return;
    if (this.goalsResumed !== goalsBefore) {
      // The reopen resumed the goal: the agent carries on by itself with the message already in its history, so a
      // resend would show it twice and hand it to the agent twice.
      this.noteOnce(`liveness-fix:${key}`, "info", LIVENESS_GOAL_TEXT);
      return;
    }
    const id = randomUUID();
    this.modelLadder?.armed(id, text, images); // the ladder keeps watching the person's message through the resend
    this.resending = true;
    let sent: boolean;
    try {
      sent = await this.send(text, "auto", images, id);
    } finally {
      this.resending = false;
    }
    if (this.released) return;
    this.noteOnce(`liveness-fix:${key}`, sent ? "info" : "warn", sent ? LIVENESS_RESENT_TEXT : LIVENESS_MANUAL_TEXT);
  }

  /** One line in the feed under a fixed id: a session resumed again says the same thing in the same place. */
  private noteOnce(id: string, level: "info" | "warn", text: string): void {
    const blocks = this.current.blocks.filter((block) => block.id !== id);
    this.commit({ ...this.current, blocks: [...blocks, { kind: "notice", id, level, text }] });
  }

  /**
   * «Сжать сейчас»: the compact_start/compact_end frames drive the busy state; a refusal lands in the error.
   *
   * OmO's compaction begins by aborting the running turn with provenance `"system"` — the same provenance a liveness
   * abort carries — so this flag keeps the person's own request from being read as OmO killing the turn behind them.
   */
  async compact(): Promise<void> {
    this.ownCompact = true;
    try {
      await this.request("compact");
    } catch (error) {
      this.ownCompact = false;
      this.fail(error);
    }
  }

  async answer(dialogId: string, answer: DialogAnswer): Promise<AnswerOutcome> {
    const dialog = this.current.dialogs.find((candidate) => candidate.id === dialogId);
    const fields: Frame = { uiRequestId: dialogId };
    if (answer.cancelled === true) fields["cancelled"] = true;
    else if (dialog?.method === "question") Object.assign(fields, { answers: answer.answers, comment: answer.comment ?? "" });
    else if (answer.confirmed !== undefined) fields["confirmed"] = answer.confirmed;
    else fields["value"] = answer.value;
    try {
      await this.request("extension_ui_response", fields);
      this.commit(resolveDialog(this.current, dialogId));
      return "applied";
    } catch (error) {
      if (error instanceof RpcError && DIALOG_GONE.has(error.code)) {
        this.dropDialog(dialogId, "Запрос уже закрыт");
        return "closed";
      }
      this.fail(error);
      return "failed";
    }
  }

  /** A dialog OmO settled by itself: gone from the state, with a quiet line in the feed saying why. */
  private dropDialog(dialogId: string, text: string): void {
    const next = resolveDialog(this.current, dialogId);
    if (next === this.current) return;
    this.commit({ ...next, blocks: [...next.blocks, { kind: "notice", id: `dialog-closed:${dialogId}`, level: "info", text }] });
  }

  /** OmO settles a timed dialog itself and tells a client that observes no dialogs nothing: drop it at its deadline. */
  private armDeadlines(): void {
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    const deadlines = this.current.dialogs.flatMap((dialog) => (dialog.deadlineAt !== undefined ? [dialog.deadlineAt] : []));
    if (deadlines.length === 0 || this.released) return;
    const wait = Math.max(0, Math.min(...deadlines) + DIALOG_DEADLINE_GRACE_MS - Date.now());
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined;
      for (const dialog of this.current.dialogs) {
        if (dialog.deadlineAt !== undefined && dialog.deadlineAt + DIALOG_DEADLINE_GRACE_MS <= Date.now()) this.dropDialog(dialog.id, "Время на ответ вышло");
      }
      this.armDeadlines();
    }, wait);
  }

  async setModel(model: ModelRef | "auto"): Promise<void> {
    const target = model === "auto" ? this.current.autoModel : model;
    if (target === undefined) {
      this.commit({ ...this.current, error: "Модель профиля ещё неизвестна" });
      return;
    }
    try {
      await this.request("set_model", { provider: target.provider, modelId: target.id });
      this.tab.modelMode = model === "auto" ? "auto" : "manual";
      this.commit({ ...this.current, model: target });
    } catch (error) {
      this.fail(error);
    }
  }

  /** The composer mode kept with the tab; undefined turns it off. */
  setStickyMode(mode: NextMode | undefined): void {
    if (mode === undefined) delete this.tab.stickyMode;
    else this.tab.stickyMode = mode;
  }

  /**
   * Gives this session a model ladder. The walk only ever reaches the session through the port built here: it reads
   * the environment's ladder and model list, aborts (and, if that is not enough, unloads) the turn, switches the
   * model and repeats the message through the same `send` the person's own messages take. `view` is its line.
   */
  setLadder(deps: { ladder: () => Ladder; view: (view: LadderView | undefined) => void }): void {
    this.modelLadder?.dispose();
    this.modelLadder = new ModelLadder({
      ladder: deps.ladder,
      models: () => this.models(),
      model: () => this.current.model,
      running: () => this.current.running,
      abort: (reason) => this.abortForLadder(reason),
      unwedge: async () => void (await this.unwedgeSession("лесенка моделей не смогла оборвать ход")),
      setModel: (model) => this.setModel(model),
      send: (id, text, images) => this.send(text, "auto", images, id),
      note: (level, text) => this.note(level, text),
      view: deps.view,
    });
  }

  /** A message the person themselves just sent: the one thing the ladder ever watches. */
  watchForLadder(id: string, text: string, images: OutgoingImage[]): void {
    this.modelLadder?.armed(id, text, images);
  }

  /** «Прервать» on the ladder's line. */
  interruptLadder(): void {
    this.modelLadder?.interrupt();
  }

  /**
   * The abort a ladder step takes before it repeats the message. It is sent whatever the state says: a refusal ends
   * the turn *in the tab* — the reducer has drawn its line and freed the composer — while the request itself still
   * sits in the gateway's queue, and that late answer is the one thing this exists to prevent.
   *
   * Unlike «Стоп» it also forgets the turn the prompt started, so the repeat goes in as a prompt of its own instead
   * of steering into the turn just abandoned. A prompt OmO refuses because something is still streaming becomes a
   * steer by itself (see `send`), so guessing wrong here costs nothing.
   */
  private async abortForLadder(reason: string): Promise<void> {
    this.noteInterrupt(`Прерываю ход: лесенка моделей — ${reason}`);
    await this.request("abort").catch(() => undefined);
    this.turnStarting = false;
  }

  /**
   * Every interruption this tab sends, in the «Agent Tabs» channel, naming the path and its reason.
   *
   * OmO labels an abort that arrives over RPC `abortSource: "user"` whatever we meant by it (the dispatcher routes
   * `abort` to `session.abort()`, which calls `_abortActiveAgentAndRetry("user")`), so a journal cannot tell our
   * abort from the person's own — and when a turn dies, the journal is all there is to read. This line is the only
   * place that says it was us, which path it was, and why.
   */
  private noteInterrupt(text: string): void {
    this.log?.(text);
  }

  async models(): Promise<{ provider: string; id: string; name?: string; reasoning?: boolean; acceptsImages?: boolean }[]> {
    let data: Frame;
    try {
      data = await this.request<Frame>("get_available_models");
    } catch (error) {
      throw new Error(redact(errorText(error), this.dm.secrets));
    }
    const list: unknown[] = Array.isArray(data?.["models"]) ? data["models"] : [];
    const result: { provider: string; id: string; name?: string; reasoning?: boolean; acceptsImages?: boolean }[] = [];
    for (const item of list) {
      if (!isObject(item) || typeof item["provider"] !== "string" || typeof item["id"] !== "string") continue;
      const accepts = acceptsImageInput(item["input"]);
      result.push({
        provider: item["provider"],
        id: item["id"],
        ...(typeof item["name"] === "string" ? { name: item["name"] } : {}),
        // The catalogue's own word on whether the model thinks: the picker trusts it over a one-level answer from a
        // host that cached a bare entry (`get_available_thinking_levels` only reflects the running host's catalogue).
        ...(typeof item["reasoning"] === "boolean" ? { reasoning: item["reasoning"] } : {}),
        ...(accepts !== undefined ? { acceptsImages: accepts } : {}),
      });
    }
    return result;
  }

  /** A level the model cannot apply is refused by omo and leaves the session's level as it was; the reason goes to `state.error`. */
  async setThinkingLevel(level: string): Promise<void> {
    try {
      await this.request("set_thinking_level", { level });
      this.commit({ ...this.current, thinkingLevel: level });
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * What one model runs at in this session, without switching to it: the level, where it came from
   * (`get_state.thinkingLevelSource`) and the levels the model supports. Undefined when the host cannot say.
   */
  async modelThinkingLevel(model: ModelRef): Promise<ModelLevel | undefined> {
    let data: Frame;
    try {
      data = await this.request<Frame>("get_model_thinking_level", { provider: model.provider, modelId: model.id });
    } catch {
      return undefined; // an older host, or a model its registry does not offer
    }
    if (typeof data?.["level"] !== "string") return undefined;
    const available: unknown[] = Array.isArray(data["availableLevels"]) ? data["availableLevels"] : [];
    return {
      level: data["level"],
      ...(typeof data["source"] === "string" ? { source: data["source"] } : {}),
      availableLevels: available.filter((level): level is string => typeof level === "string"),
    };
  }

  /**
   * The level the host reports for this session, taken as the session's own. A new session's journal walks through the
   * steps of applying the profile (the remembered level, then the profile's own), and a client that loaded the journal
   * before the last step landed is left showing a level the session is not on; this corrects it without a command.
   */
  noteThinkingLevel(level: string): void {
    if (this.current.thinkingLevel !== level) this.commit({ ...this.current, thinkingLevel: level });
  }

  async thinkingLevels(): Promise<string[]> {
    const data = await this.guarded(() => this.request<Frame>("get_available_thinking_levels"));
    const levels: unknown[] = Array.isArray(data?.["levels"]) ? data["levels"] : [];
    return levels.filter((level): level is string => typeof level === "string");
  }

  async commands(): Promise<CommandRow[]> {
    const data = await this.guarded(() => this.request<Frame>("get_commands"));
    const list: unknown[] = Array.isArray(data?.["commands"]) ? data["commands"] : [];
    const rows: CommandRow[] = [];
    for (const item of list) {
      if (!isObject(item) || typeof item["name"] !== "string") continue;
      const { source, syntax } = item;
      if (source !== "extension" && source !== "prompt" && source !== "skill") continue;
      if (syntax !== "slash" && syntax !== "dollar") continue;
      rows.push({
        name: item["name"],
        ...(typeof item["description"] === "string" ? { description: item["description"] } : {}),
        source,
        syntax,
      });
    }
    return rows;
  }

  async rename(name: string): Promise<void> {
    await this.guarded(() => this.request("set_session_name", { name }));
    this.commit({ ...this.current, title: name });
  }

  /** Full transcript of an OmO task (extension request, scoped by the session's durable id). */
  async taskOutput(taskId: string): Promise<string> {
    const data = await this.guarded(() => this.taskRequest("omo.task.output", { task_id: taskId, mode: "full" }));
    this.throwOnTaskFailure(data);
    if (typeof data?.["transcript"] === "string") return data["transcript"];
    const snapshot = data?.["snapshot"];
    const finalResponse = isObject(snapshot) ? snapshot["final_response"] : undefined;
    return typeof finalResponse === "string" ? finalResponse : "";
  }

  /** What the agent details modal shows: the task, its result and transcript from one `omo.task.output` (mode full). */
  async taskDetails(taskId: string): Promise<AgentDetails> {
    const data = await this.guarded(() => this.taskRequest("omo.task.output", { task_id: taskId, mode: "full" }));
    this.throwOnTaskFailure(data);
    const snapshot = isObject(data?.["snapshot"]) ? data["snapshot"] : {};
    const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
    const details: AgentDetails = {};
    const prompt = text(snapshot["description"]) ?? text(snapshot["task_summary"]);
    if (prompt !== undefined) details.prompt = prompt;
    const result = text(snapshot["final_response"]);
    if (result !== undefined) details.result = result;
    const transcript = text(data?.["transcript"]);
    if (transcript !== undefined) details.transcript = transcript;
    if (snapshot["status"] !== undefined) details.status = taskStatus(snapshot["status"]);
    const error = text(snapshot["error_message"]);
    if (error !== undefined) details.error = error;
    return details;
  }

  async cancelTask(taskId: string): Promise<void> {
    const data = await this.guarded(() => this.taskRequest("omo.task.cancel", { task_id: taskId }));
    this.throwOnTaskFailure(data);
  }

  /** Bytes for an image ref; images arrive inline (media_placeholders is not advertised), so the store has them all. */
  async image(id: string): Promise<{ mimeType: string; data: string } | undefined> {
    return this.imageStore.get(this.imageScope + id);
  }

  /** Detaches this tab only; the session stays retained in the daemon. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.deadlineTimer);
    this.modelLadder?.dispose();
    this.imageStore.dropScope(this.imageScope);
    this.dm.off("connected", this.onConnected);
    this.client.off("frame", this.onFrame);
    await this.reconnecting; // an in-flight re-attach must finish so its fresh hold is released too
    if (this.handle === "") return;
    try {
      await this.client.request("release_attachment", { sessionId: this.handle });
    } catch {
      // the connection may already be gone; the daemon retains the session either way
    }
  }

  // ---------- internals ----------

  /** The message in the feed at once, its images under the ids the real message will use. */
  private showOutgoing(id: string, text: string, images: OutgoingImage[], supersedes?: string): void {
    const refs = images.map((image, index): ImageRef => ({ id: `${id}:${index}`, mimeType: image.mimeType, ...(image.name !== undefined ? { name: image.name } : {}) }));
    refs.forEach((ref, index) => this.sink(ref, (images[index] as OutgoingImage).data));
    this.outbox.set(id, { text, images });
    if (supersedes !== undefined) this.outbox.delete(supersedes); // the superseded bubble leaves the feed; drop its images too
    this.commit(addOutgoing(this.current, { id, text, images: refs, ...(supersedes !== undefined ? { supersedes } : {}) }));
  }

  /** A message that will not reach the conversation leaves the feed. */
  private takeBack(id: string): void {
    this.outbox.delete(id);
    this.commit(dropOutgoing(this.current, id));
  }

  private queuedId(blockId: string): string | undefined {
    const block = this.current.blocks.find((candidate) => candidate.id === blockId);
    return block?.kind === "user" && block.delivery?.state === "queued" ? block.delivery.queuedId : undefined;
  }

  /** The outbox keeps only messages still shown as undelivered (their images can be megabytes). */
  private pruneOutbox(): void {
    const waiting = new Set(this.current.blocks.flatMap((block) => (block.kind === "user" && block.delivery !== undefined ? [block.id] : [])));
    for (const id of this.outbox.keys()) if (!waiting.has(id)) this.outbox.delete(id);
  }

  /** A checkpoint for the next idle prompt: only with a checkpointer, a git cwd and a host that holds writing tools. */
  private async barrierPoint(): Promise<{ pointId: string; repo: string; sessionUuid: string } | undefined> {
    const { checkpointer, sessionCwd, durableId } = this;
    if (checkpointer === undefined || sessionCwd === undefined || durableId === undefined) return undefined;
    const repo = await checkpointer.repoFor(sessionCwd);
    if (repo === undefined || !(await supportsToolBarrier(this.client))) return undefined;
    return { pointId: randomUUID(), repo, sessionUuid: durableId };
  }

  /** In the background: snapshot (bounded by the checkpointer's budget), then always release the barrier. */
  private captureThenRelease(barrier: { pointId: string; repo: string; sessionUuid: string }, clientMessageId: string, armedAt: number): void {
    const checkpointer = this.checkpointer;
    if (checkpointer === undefined) return;
    void (async () => {
      try {
        await checkpointer.capture({ ...barrier, clientMessageId, startedAt: armedAt });
      } finally {
        await this.request("release_tool_barrier", { barrierId: barrier.pointId }).catch(() => undefined);
      }
    })();
  }

  /** Session request; while a re-attach is in flight it waits for the new handle, never using the old one. */
  private async request<T = unknown>(type: string, fields: Frame = {}): Promise<T> {
    if (this.ready !== undefined) await this.ready;
    return this.sessionRequest<T>(type, fields);
  }

  private taskRequest(name: string, data: Frame): Promise<Frame> {
    return this.request<Frame>("extension_request", {
      name,
      data: { ...data, parent_session_id: this.durableId },
    });
  }

  /** The task bridge reports failures as a successful response with a failure `kind`. */
  private throwOnTaskFailure(data: Frame | undefined): void {
    const kind = data?.["kind"];
    if (kind !== "not_found" && kind !== "unavailable" && kind !== "invalid_arguments" && kind !== "no_progress") return;
    const reason = typeof data?.["reason"] === "string" ? data["reason"] : kind;
    throw new Error(redact(reason, this.dm.secrets));
  }

  /** Runs a request for a caller that wants a thrown, redacted error instead of `state.error`. */
  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new Error(redact(errorText(error), this.dm.secrets));
    }
  }

  /** `timeoutMs` undefined leaves the client's own default. */
  private sessionRequest<T>(type: string, fields: Frame = {}, timeoutMs?: number): Promise<T> {
    if (this.handle === "") return Promise.reject(new RpcError("not_attached", "session is not attached"));
    return this.client.request<T>(type, { ...fields, sessionId: this.handle }, timeoutMs);
  }

  private async start(openFields: Frame, load: "full" | "catchup"): Promise<void> {
    this.client.on("frame", this.onFrame);
    this.dm.on("connected", this.onConnected);
    try {
      await this.open(openFields, load);
    } catch (error) {
      this.released = true;
      this.imageStore.dropScope(this.imageScope);
      this.dm.off("connected", this.onConnected);
      this.client.off("frame", this.onFrame);
      throw error;
    }
  }

  /**
   * open_session, then history; frames that arrive meanwhile are held and replayed in order. Returns as soon as the
   * conversation is in the state: everything a tab asks for on top of it (the agent rows here, the pickers' lists in
   * ChatPanel) is asked for afterwards, so nothing off the conversation's path can hold the tab on an empty feed.
   */
  private async open(openFields: Frame, load: "full" | "catchup"): Promise<void> {
    this.buffer = [];
    const startedAt = Date.now();
    let openedMs = 0;
    let journal: JournalLoad = { ms: 0, pages: 0 };
    try {
      const data = await this.client.request<Frame>("open_session", openFields);
      openedMs = Date.now() - startedAt;
      this.handle = String(data["sessionId"]);
      const sessionState = isObject(data["state"]) ? data["state"] : {};
      if (typeof sessionState["sessionFile"] === "string") this.tab.sessionPath = sessionState["sessionFile"];
      if (typeof sessionState["sessionId"] === "string") {
        this.durableId = sessionState["sessionId"];
        this.tab.durableId = this.durableId;
      }
      const cursor = this.current.cursor;
      if (load === "full" || cursor === undefined) {
        this.current = this.seedFromState(initialState(), sessionState);
        journal = await this.loadEntries(undefined);
      } else {
        this.current = this.seedFromState(this.current, sessionState);
        try {
          journal = await this.loadEntries(cursor);
        } catch (error) {
          if (!(error instanceof RpcError) || error.code !== "not_found") throw error;
          this.current = this.seedFromState(initialState(), sessionState);
          journal = await this.loadEntries(undefined);
        }
      }
    } finally {
      const held = this.buffer ?? [];
      this.buffer = undefined;
      for (const frame of held) this.handleFrame(frame);
      this.sync();
    }
    this.log?.(
      `Сессия открыта за ${Date.now() - startedAt} мс: open_session ${openedMs} мс, журнал ${journal.ms} мс (${journal.pages} стр.), блоков ${this.current.blocks.length}`,
    );
    void this.restoreAgents(); // never awaited: the conversation is already in hand
  }

  /**
   * OmO's list of this session's tasks, after the held frames: an attach hears no `omo.task.updated` until a task
   * changes. Asked for after the open and merged whenever it answers — best effort, and a host that does not answer
   * (see TASK_LIST_TIMEOUT_MS) only leaves the rows the journal gave, with a line in the channel saying so.
   */
  private async restoreAgents(): Promise<void> {
    if (this.durableId === undefined) return;
    const handle = this.handle;
    const startedAt = Date.now();
    try {
      const data = await this.sessionRequest<Frame>(
        "extension_request",
        { name: "omo.task.list", data: { parent_session_id: this.durableId } },
        TASK_LIST_TIMEOUT_MS,
      );
      if (this.released || this.handle !== handle) return;
      this.commit(applyTaskList(this.current, data));
    } catch (error) {
      if (this.released) return; // the tab was closed while it was in flight: nothing to say about it
      this.log?.(`Список задач сессии не получен за ${Date.now() - startedAt} мс: ${redact(errorText(error), this.dm.secrets)}`);
    }
  }

  /**
   * Live truth from `open_session`'s state: running flag, model, title, pending dialogs; an attach that got here clears
   * the old error. An idle session has no streaming reply and no running tool: a tool still marked running ended
   * without a result while we were away (the catch-up still applies any result the journal has).
   *
   * The turn comes from the host's own lifecycle, which knows a turn in a tool call and a turn a park left behind;
   * `isStreaming` only answers for a host that reports no lifecycle. What the tab remembered about the turn — the verb
   * it was showing — is never carried over: after a reopen only the host's word counts.
   */
  private seedFromState(base: ChatState, sessionState: Frame): ChatState {
    const { error: _cleared, activity: _verb, activityTool: _tool, background: _background, ...rest } = base;
    const lifecycle = sessionState["lifecycle"];
    const running = lifecycleRunning(lifecycle) ?? sessionState["isStreaming"] === true;
    const blocks = running
      ? rest.blocks
      : rest.blocks.map((block) => {
          if (block.kind === "assistant" && block.streaming) return { ...block, streaming: false };
          if (block.kind === "tool" && block.state === "running") return { ...block, state: "error" as const };
          return block;
        });
    let next: ChatState = applyLifecycle({ ...rest, blocks, dialogs: [], running }, lifecycle);
    const model = sessionState["model"];
    if (isObject(model) && typeof model["provider"] === "string" && typeof model["id"] === "string") {
      next = { ...next, model: { provider: model["provider"], id: model["id"] } };
    }
    if (typeof sessionState["thinkingLevel"] === "string") next = { ...next, thinkingLevel: sessionState["thinkingLevel"] };
    if (typeof sessionState["sessionName"] === "string") next = { ...next, title: sessionState["sessionName"] };
    next = withContextUsage(next, sessionState["contextUsage"]);
    if (typeof sessionState["autoCompactionEnabled"] === "boolean") next = { ...next, autoCompaction: sessionState["autoCompactionEnabled"] };
    if (sessionState["isCompacting"] === true) next = { ...next, compacting: true };
    const pending = (key: string): unknown[] => (Array.isArray(sessionState[key]) ? sessionState[key] : []);
    for (const dialog of [...pending("pendingDialogs"), ...pending("pendingQuestions")]) next = applyFrame(next, dialog, this.sink);
    return next;
  }

  /** Pages the journal (`since` undefined = from the start) into the state; returns what the load cost. */
  private async loadEntries(since: string | undefined): Promise<JournalLoad> {
    let cursor = since;
    let pages = 0;
    const startedAt = Date.now();
    for (;;) {
      const page = await this.sessionRequest<Frame>("get_entries", {
        limit: ENTRIES_PAGE_LIMIT,
        ...(cursor !== undefined ? { since: cursor } : {}),
      });
      pages += 1;
      const entries: unknown[] = Array.isArray(page?.["entries"]) ? page["entries"] : [];
      this.current = applyEntries(this.current, entries, this.sink);
      if (page?.["hasMore"] !== true || typeof page["nextSince"] !== "string" || page["nextSince"] === cursor) {
        return { ms: Date.now() - startedAt, pages };
      }
      cursor = page["nextSince"];
    }
  }

  private async reconnect(client: RpcClient): Promise<void> {
    if (this.released) return;
    if (this.client === client) this.releaseHandle(); // a re-open on the same connection must not leave the old hold behind
    this.client.off("frame", this.onFrame);
    this.client = client;
    this.handle = ""; // the old rpc-N means nothing (or someone else's session) on a new connection
    client.on("frame", this.onFrame);
    const sessionPath = this.tab.sessionPath;
    if (sessionPath === undefined) {
      this.commit({ ...this.current, error: "Сессия потеряна: у неё нет файла" });
      return;
    }
    const opening = this.open({ sessionPath, retain_on_disconnect: true }, "catchup");
    this.ready = opening.catch(() => undefined);
    try {
      await opening;
    } catch (error) {
      this.releaseHandle(); // opened but history failed: drop the half-open hold so «Переподключить» re-opens
      this.fail(error);
      return;
    } finally {
      this.ready = undefined;
    }
    this.emit("attached");
  }

  /** Best effort: the daemon retains the session either way. */
  private releaseHandle(): void {
    if (this.handle === "") return;
    const sessionId = this.handle;
    this.handle = "";
    this.client.request("release_attachment", { sessionId }).catch(() => undefined);
  }

  private handleFrame(frame: Frame): void {
    if (this.released) return;
    if (this.buffer !== undefined) {
      this.buffer.push(frame);
      return;
    }
    if (this.handle === "" || frame["sessionId"] !== this.handle) return;
    if (frame["type"] === "session_opened" && typeof frame["sessionPath"] === "string") {
      this.tab.sessionPath ??= frame["sessionPath"];
      return;
    }
    if (frame["type"] === "loaded_surfaces_changed") {
      this.emit("surfaces");
      return;
    }
    if (frame["type"] === "session_parked") {
      this.autoParked();
      return;
    }
    if (stoppedGoalNotice(frame) !== undefined) {
      if (!this.goalResuming) this.goalResumeRun = this.resumeStoppedGoal();
      return; // the English line never reaches the feed; the Russian one comes from the resume
    }
    if (this.goalResuming && goalCardNotice(frame)) return; // our own command's echo, in English, that nobody asked for
    if (this.checkpointer !== undefined && this.durableId !== undefined && this.sessionCwd !== undefined) {
      this.checkpointer.observe(this.durableId, this.sessionCwd, frame);
    }
    const wasRunning = this.current.running;
    this.commit(applyFrame(this.current, frame, this.sink));
    const type = frame["type"];
    if (type === "agent_settled" || (type === "session_lifecycle" && lifecycleRunning(frame["lifecycle"]) === false)) this.turnStarting = false;
    if (this.drainOnStop && wasRunning && !this.current.running) {
      this.drainOnStop = false; // the stopped turn has ended: deliver the queue once
      void this.drainQueueAfterStop();
    }
    if (type === "agent_settled" || type === "queue_update" || (type === "message_start" && frame["message"]?.["role"] === "user")) this.pruneOutbox();
    if (frame["type"] === "model_changed") this.emit("model");
    if (frame["type"] === "agent_settled" || frame["type"] === "compaction_end") void this.refreshContext();
    this.observeLiveness(frame);
    this.modelLadder?.observe(frame); // after the commit, so the ladder reads the turn's state as this frame left it
  }

  /** The context fill from the host's own estimate; best effort, the ring just keeps its last value on a failure. */
  private async refreshContext(): Promise<void> {
    const handle = this.handle;
    try {
      const stats = await this.request<Frame>("get_session_stats");
      if (this.released || this.handle !== handle) return;
      this.commit(withContextUsage(this.current, stats?.["contextUsage"]));
    } catch {
      // cosmetic
    }
  }

  private async nameSession(text: string): Promise<void> {
    const name = normalizeSessionName(text);
    if (name === "") return;
    try {
      await this.request("set_session_name", { name });
    } catch {
      // the title is cosmetic; the first message already went out
    }
  }

  /** Publishes a state: errors are redacted at this single exit, then listeners hear about it. */
  private commit(next: ChatState): void {
    if (next.error !== undefined && next.error !== this.current.error) {
      next = { ...next, error: redact(next.error, this.dm.secrets) };
    }
    if (next === this.current) return;
    this.current = next;
    this.sync();
  }

  private sync(): void {
    if (this.current.title !== undefined) this.tab.title = this.current.title;
    if (this.current.dialogs !== this.armedFor) {
      this.armedFor = this.current.dialogs;
      this.armDeadlines();
    }
    this.emit("change", this.current);
  }

  private fail(error: unknown): void {
    this.commit({ ...this.current, error: errorText(error) });
  }
}
