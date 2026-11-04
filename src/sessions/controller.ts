import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import type { ChatState, ImageRef, ModelRef } from "../chat/model";
import { addOutgoing, applyEntries, applyFrame, applyTaskList, dropOutgoing, initialState, resolveDialog, reviseQueued, taskStatus } from "../chat/reducer";
import type { DaemonManager } from "../daemon";
import { redact } from "../env";
import type { AgentDetails } from "../panel/protocol";
import { BARRIER_DEADLINE_MS, type Checkpointer } from "../rewind/checkpointer";
import { readSessionHeader } from "../rewind/fork";
import type { SentMode } from "../rewind/store";
import { RpcError, type RpcClient } from "../rpc/client";
import { sharedImages, type ImageStore } from "./images";

/** A mode keyword that prefixes every prose message while it is on (the actions menu's toggles). */
export type NextMode = "ulw" | "mass ulw";

export type TabState = { sessionPath?: string; modelMode: "auto" | "manual"; title?: string; durableId?: string; stickyMode?: NextMode };

export type DialogAnswer = { value?: string; confirmed?: boolean; answers?: unknown; cancelled?: boolean };
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

function isObject(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  ) {
    super();
    this.client = client;
  }

  /** Opens a brand-new session in `cwd` (the profile picks the model). */
  static async create(dm: DaemonManager, cwd: string, images: ImageStore = sharedImages, checkpointer?: Checkpointer): Promise<SessionController> {
    const controller = new SessionController(dm, await dm.client(), images, checkpointer);
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
  ): Promise<SessionController> {
    const controller = new SessionController(dm, await dm.client(), images, checkpointer);
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
    this.showOutgoing(clientMessageId, text, images);
    const fields = { message: text, clientMessageId, ...imageParts };
    /**
     * Messages leave in the order they were sent, through one chain: preparing a barrier must not let a later message
     * overtake, and a prompt that meets a running turn is re-sent as a steer (same id: never a second message) before
     * anything sent after it. A prompt therefore holds the chain until its answer; other messages only until written.
     * The kind is chosen when the message leaves: one that waited for a prompt that started its turn steers that turn.
     */
    const dispatch = this.outgoing.then(async () => {
      const type = mode === "followUp" ? "follow_up" : this.current.running || this.turnStarting ? "steer" : "prompt";
      const barrier = type === "prompt" ? await this.barrierPoint() : undefined;
      const toolBarrier = barrier ? { toolBarrier: { id: barrier.pointId, deadlineMs: BARRIER_DEADLINE_MS } } : {};
      const armedAt = Date.now();
      const sent = this.request<Frame>(type, { ...fields, ...toolBarrier });
      const answer =
        type !== "prompt"
          ? sent.then((data) => ({ data, steered: false }))
          : sent.then(
              (data) => ({ data, steered: false }),
              async (error: unknown) => {
                if (!(error instanceof RpcError) || error.code !== "streaming") throw error;
                return { data: await this.request<Frame>("steer", fields), steered: true };
              },
            );
      const settled = answer.then(({ data, steered }) => {
        if (type === "prompt" && !steered && data?.["disposition"] === "started") this.turnStarting = true;
        return { data, steered };
      });
      return { type, barrier, armedAt, answer: settled };
    });
    this.outgoing = dispatch.then(({ type, answer }) => (type === "prompt" ? answer : undefined)).catch(() => undefined);
    let sentMode: SentMode | undefined;
    try {
      const { type, barrier, armedAt, answer } = await dispatch;
      sentMode = type === "steer" ? "steer" : type === "follow_up" ? "followUp" : undefined;
      const { data, steered } = await answer;
      if (steered) sentMode = "steer";
      else if (barrier !== undefined && data?.["toolBarrier"] === "armed") this.captureThenRelease(barrier, clientMessageId, armedAt);
      else if (data?.["toolBarrier"] === "ignored") sentMode = "steer";
      if (data?.["disposition"] === "handled") this.takeBack(clientMessageId); // a command consumed it: no message will come
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
    for (const dialog of this.current.dialogs) {
      try {
        await this.request("extension_ui_response", { uiRequestId: dialog.id, cancelled: true });
        this.commit(resolveDialog(this.current, dialog.id));
      } catch {
        // a dialog that is already gone must not block the abort
      }
    }
    try {
      await this.request("abort");
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * «Снять зависание»: a turn OmO still calls running after «Стоп» (a provider request that never returns) is let go of
   * by unloading the session and opening it again in this tab. `interrupt` aborts the stuck turn, `force` drops the
   * extensions' own work and other clients' holds, and `children: "detach"` leaves child tasks running. The transcript
   * and the queued input survive — OmO restores the queue on the reopen. Only the person's click ever calls this.
   */
  async unwedgeSession(): Promise<UnwedgeOutcome> {
    let data: Frame;
    try {
      data = await this.request<Frame>("unload_session", { interrupt: true, force: true, children: "detach" });
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
    this.commit({
      ...this.current,
      running: false,
      blocks: [...this.current.blocks, { kind: "notice", id: `parked:${randomUUID()}`, level: "info", text: "Сессия выгружена — открываю заново" }],
    });
    this.reopening = this.reopening.then(() => this.reattach()).catch(() => undefined);
  }

  /** «Сжать сейчас»: the compact_start/compact_end frames drive the busy state; a refusal lands in the error. */
  async compact(): Promise<void> {
    try {
      await this.request("compact");
    } catch (error) {
      this.fail(error);
    }
  }

  async answer(dialogId: string, answer: DialogAnswer): Promise<AnswerOutcome> {
    const dialog = this.current.dialogs.find((candidate) => candidate.id === dialogId);
    const fields: Frame = { uiRequestId: dialogId };
    if (answer.cancelled === true) fields["cancelled"] = true;
    else if (dialog?.method === "question") Object.assign(fields, { answers: answer.answers, comment: "" });
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

  async models(): Promise<{ provider: string; id: string; name?: string }[]> {
    let data: Frame;
    try {
      data = await this.request<Frame>("get_available_models");
    } catch (error) {
      throw new Error(redact(errorText(error), this.dm.secrets));
    }
    const list: unknown[] = Array.isArray(data?.["models"]) ? data["models"] : [];
    const result: { provider: string; id: string; name?: string }[] = [];
    for (const item of list) {
      if (!isObject(item) || typeof item["provider"] !== "string" || typeof item["id"] !== "string") continue;
      result.push({
        provider: item["provider"],
        id: item["id"],
        ...(typeof item["name"] === "string" ? { name: item["name"] } : {}),
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
  private showOutgoing(id: string, text: string, images: OutgoingImage[]): void {
    const refs = images.map((image, index): ImageRef => ({ id: `${id}:${index}`, mimeType: image.mimeType, ...(image.name !== undefined ? { name: image.name } : {}) }));
    refs.forEach((ref, index) => this.sink(ref, (images[index] as OutgoingImage).data));
    this.outbox.set(id, { text, images });
    this.commit(addOutgoing(this.current, { id, text, images: refs }));
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

  private sessionRequest<T>(type: string, fields: Frame = {}): Promise<T> {
    if (this.handle === "") return Promise.reject(new RpcError("not_attached", "session is not attached"));
    return this.client.request<T>(type, { ...fields, sessionId: this.handle });
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

  /** open_session, then history; frames that arrive meanwhile are held and replayed in order. */
  private async open(openFields: Frame, load: "full" | "catchup"): Promise<void> {
    this.buffer = [];
    try {
      const data = await this.client.request<Frame>("open_session", openFields);
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
        await this.loadEntries(undefined);
      } else {
        this.current = this.seedFromState(this.current, sessionState);
        try {
          await this.loadEntries(cursor);
        } catch (error) {
          if (!(error instanceof RpcError) || error.code !== "not_found") throw error;
          this.current = this.seedFromState(initialState(), sessionState);
          await this.loadEntries(undefined);
        }
      }
    } finally {
      const held = this.buffer ?? [];
      this.buffer = undefined;
      for (const frame of held) this.handleFrame(frame);
      this.sync();
    }
    await this.restoreAgents();
  }

  /**
   * OmO's list of this session's tasks, after the held frames: an attach hears no `omo.task.updated` until a task
   * changes. Best effort — without the task bridge the rows the journal gave stay.
   */
  private async restoreAgents(): Promise<void> {
    if (this.durableId === undefined) return;
    const handle = this.handle;
    try {
      const data = await this.sessionRequest<Frame>("extension_request", { name: "omo.task.list", data: { parent_session_id: this.durableId } });
      if (this.released || this.handle !== handle) return;
      this.commit(applyTaskList(this.current, data));
    } catch {
      // an OmO without omo.task.list
    }
  }

  /**
   * Live truth from `open_session`'s state: running flag, model, title, pending dialogs; an attach that got here clears
   * the old error. An idle session has no streaming reply and no running tool: a tool still marked running ended
   * without a result while we were away (the catch-up still applies any result the journal has).
   */
  private seedFromState(base: ChatState, sessionState: Frame): ChatState {
    const { error: _cleared, ...rest } = base;
    const running = sessionState["isStreaming"] === true;
    const blocks = running
      ? rest.blocks
      : rest.blocks.map((block) => {
          if (block.kind === "assistant" && block.streaming) return { ...block, streaming: false };
          if (block.kind === "tool" && block.state === "running") return { ...block, state: "error" as const };
          return block;
        });
    let next: ChatState = { ...rest, blocks, dialogs: [], running };
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

  /** Pages the journal (`since` undefined = from the start) into the state. */
  private async loadEntries(since: string | undefined): Promise<void> {
    let cursor = since;
    for (;;) {
      const page = await this.sessionRequest<Frame>("get_entries", {
        limit: ENTRIES_PAGE_LIMIT,
        ...(cursor !== undefined ? { since: cursor } : {}),
      });
      const entries: unknown[] = Array.isArray(page?.["entries"]) ? page["entries"] : [];
      this.current = applyEntries(this.current, entries, this.sink);
      if (page?.["hasMore"] !== true || typeof page["nextSince"] !== "string" || page["nextSince"] === cursor) return;
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
      this.parked();
      return;
    }
    if (this.checkpointer !== undefined && this.durableId !== undefined && this.sessionCwd !== undefined) {
      this.checkpointer.observe(this.durableId, this.sessionCwd, frame);
    }
    this.commit(applyFrame(this.current, frame, this.sink));
    const type = frame["type"];
    if (type === "agent_settled" || (type === "session_lifecycle" && frame["lifecycle"]?.["state"] === "done")) this.turnStarting = false;
    if (type === "agent_settled" || type === "queue_update" || (type === "message_start" && frame["message"]?.["role"] === "user")) this.pruneOutbox();
    if (frame["type"] === "model_changed") this.emit("model");
    if (frame["type"] === "agent_settled" || frame["type"] === "compaction_end") void this.refreshContext();
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
