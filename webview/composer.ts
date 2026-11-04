import type { AgentRow, Block, ChatState, ModelRef } from "../src/chat/model";
import { MAX_IMAGES, MAX_MESSAGE_IMAGE_CHARS, type ModelInfo, type StateMessage, type UnwedgedMessage, type WebviewMessage } from "../src/panel/protocol";
import type { NextMode, OutgoingImage } from "../src/sessions/controller";
import { browserCodec, prepareImage, REASONS, type ImageCodec, type PreparedImage } from "./attachments";
import { button, el, type Post } from "./dom";
import type { FeedImage } from "./feed";
import { icon } from "./icons";

export type ComposerOptions = {
  /** Where files may be dropped (the whole tab); defaults to the composer itself. */
  dropZone?: HTMLElement;
  codec?: ImageCodec;
  /** Popover triggers; each gets the button it was opened from. */
  onAgents?: (anchor: HTMLElement) => void;
  onModel?: (anchor: HTMLElement) => void;
  onSlash?: (anchor: HTMLElement) => void;
  /** Sees every key in the input first; true means it handled the key (e.g. the «/» menu took Enter). */
  onInputKey?: (event: KeyboardEvent) => boolean;
  onOpenImage?: (images: FeedImage[], index: number) => void;
  /** False while something covers the tab (the lightbox): drops are then swallowed. */
  acceptsDrops?: () => boolean;
  /** Each message as it is posted (a retry too), so the feed shows it at once. */
  onSend?: (message: SendMessage) => void;
};

type SendMessage = Extract<WebviewMessage, { type: "send" }>;

export type { NextMode };

/** Plain-language face of a mode: the title, what it does, and the keyword that is actually sent. */
export const MODE_INFO: Record<NextMode, { title: string; detail: string }> = {
  ulw: { title: "Довести до конца", detail: "Агент сам составит план, выполнит его и проверит результат, прежде чем закончить" },
  "mass ulw": { title: "Команда агентов", detail: "Задача делится на части, которые параллельно делают несколько агентов на подходящих моделях" },
};

/** The size an image is sent at. */
type Size = { width: number; height: number };
/** A prepared image over a limit is an error that keeps its bytes: removing another one frees room for it. */
type Attachment = { key: string; name: string } & (
  | { status: "pending" }
  | { status: "ready"; image: OutgoingImage; size: Size }
  | { status: "error"; reason: string; image?: OutgoingImage; size?: Size }
);
type Ready = Extract<Attachment, { status: "ready" }>;
/** A message the host has not confirmed (or refused): the text as typed, its attachments, and what was posted (the mode stays on, so it is not given back). */
type Unconfirmed = { text: string; images: Ready[]; message: SendMessage };

const IDLE_PLACEHOLDER = "Сообщение агенту (вставь картинку ⌘V или перетащи)";
const RUNNING_PLACEHOLDER = "В очередь ещё сообщение…";
const UNNAMED = "image.png";
const ONLY_PICTURES = "Можно прикладывать только картинки";
const NOTICE_MS = 3_000;
const PENDING_MODE_MS = 3_000;
/** The send button's own words: idle it prompts, mid-turn the message goes behind the turn. */
const SEND_LABEL = "Отправить";
const QUEUE_LABEL = "В очередь после текущего хода";

/** A turn still running this long after «Стоп» is wedged: OmO answered the abort but the turn never ended. */
const STOP_WAIT_MS = 5_000;
/** A running turn whose session sent nothing for this long is wedged too (a provider request that never returns). */
const SILENT_MS = 180_000;
/** How long the outcome of «Снять зависание» stays on screen. */
const WEDGE_DONE_MS = 6_000;
const STOP_WEDGE_TEXT = "Агент не отвечает на «Стоп». Снять зависание?";

/** The wedge line: nothing, the offer, the unload in flight, or its outcome. */
type WedgeState = "none" | "ask" | "working" | "done";

function isReady(attachment: Attachment): attachment is Ready {
  return attachment.status === "ready";
}

function dataUrl(image: OutgoingImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

/** «1 агент работает», «2 агента работают», «5 агентов работают»; none running → «0 агентов». */
export function agentsLabel(agents: AgentRow[]): string {
  const count = agents.filter((agent) => agent.status === "running").length;
  if (count === 0) return "0 агентов";
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return `${count} агент работает`;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return `${count} агента работают`;
  return `${count} агентов работают`;
}

export function modelName(model: ModelRef | undefined, models: ModelInfo[]): string | undefined {
  if (model === undefined) return undefined;
  return models.find((item) => item.provider === model.provider && item.id === model.id)?.name ?? model.id;
}

/** OmO's default room kept free for the reply; auto-compaction starts when the context passes window − this. */
const RESERVE_TOKENS = 16_384;
const WARN_LEFT = 30;
const CRIT_LEFT = 10;
const RING_RADIUS = 7;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export type ContextLevel = "ok" | "warn" | "crit" | "unknown" | "busy";
export type ContextView = { level: ContextLevel; fill: number; tip: string; hint?: string };

/** What the context ring shows, or undefined while there is no context window (no model). */
export function contextView(state: Pick<ChatState, "contextWindow" | "contextTokens" | "autoCompaction" | "compacting">): ContextView | undefined {
  const { contextWindow, contextTokens, compacting } = state;
  if (contextWindow === undefined) return undefined;
  if (compacting === true) return { level: "busy", fill: 0, tip: "Сжимаю контекст…" };
  if (contextTokens === undefined) return { level: "unknown", fill: 0, tip: "Контекст пересчитается после следующего ответа", hint: COMPACT_HINT };
  const auto = state.autoCompaction !== false;
  const limit = auto ? Math.max(1, contextWindow - RESERVE_TOKENS) : contextWindow;
  const used = Math.min(1, Math.max(0, contextTokens / limit));
  const left = Math.round((1 - used) * 100);
  const level: ContextLevel = left <= CRIT_LEFT ? "crit" : left <= WARN_LEFT ? "warn" : "ok";
  return { level, fill: Math.round(used * 100), tip: `Осталось ${left}% контекста${auto ? " до автосжатия" : ""}.`, hint: COMPACT_HINT };
}

const COMPACT_HINT = "Нажмите, чтобы сжать сейчас.";

/** The input block: text, image attachments and the toolbar under it. */
export class Composer {
  /** The «drop here» veil; the owner places it over the drop zone. */
  readonly overlay: HTMLElement;
  readonly input: HTMLTextAreaElement;
  /** The rounded block; popovers above the composer sit over its top edge. */
  readonly box: HTMLElement;
  private readonly thumbs: HTMLElement;
  private readonly errors: HTMLElement;
  private readonly notice: HTMLElement;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly picker: HTMLInputElement;
  private readonly agentsDot: HTMLElement;
  private readonly agentsText: HTMLElement;
  private readonly modelText: HTMLElement;
  private readonly modelLevel: HTMLElement;
  private readonly send: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  /** The quiet line under the box that offers «Снять зависание», and what it says. */
  private readonly wedge: HTMLElement;
  private readonly wedgeText: HTMLElement;
  private readonly wedgeFix: HTMLButtonElement;
  private readonly wedgeCancel: HTMLButtonElement;
  private wedgeState: WedgeState = "none";
  private wedgeTimer: ReturnType<typeof setTimeout> | undefined;
  private wedgeDoneTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly contextRing: HTMLButtonElement;
  private readonly contextArc: SVGCircleElement;
  private readonly contextTip: HTMLElement;
  private readonly modeChip: HTMLButtonElement;
  private nextMode: NextMode | undefined;
  /** A toggle the host has not echoed yet. */
  private pendingMode: { mode: NextMode | undefined; timer: ReturnType<typeof setTimeout> } | undefined;
  private readonly codec: ImageCodec;
  private attachments: Attachment[] = [];
  /** What was sent but not yet confirmed by the host, by send id (the message's clientMessageId). */
  private readonly unconfirmed = new Map<string, Unconfirmed>();
  /** What the host refused, by send id, until it is sent again («Повторить») or dropped («Убрать»). */
  private readonly refused = new Map<string, Unconfirmed>();
  private nextKey = 0;
  private dragDepth = 0;
  /** Whether a turn is running, as the host last said: the send button's words and the wedge watch follow it. */
  private running = false;
  /** When «Стоп» was last pressed on a running turn. */
  private stoppedAt: number | undefined;
  /** When this session's state last changed, which is when a frame for it last arrived. */
  private progressAt = Date.now();
  /** The blocks and activity line that `progressAt` was taken from. */
  private progressFrom: Block[] = [];
  private progressActivity: string | undefined;
  /** «Отмена» (or an answered offer): no offer again until another SILENT_MS of silence. */
  private dismissedAt = Number.NEGATIVE_INFINITY;
  /** This session's sent texts, newest first, for ↑/↓; rebuilt only when its user blocks change (not per streamed delta). */
  private history: string[] = [];
  private historyFrom: Block[] = [];
  /** Which of them the input shows, while stepping through them; the draft waits for the way back. */
  private recalled: number | undefined;
  private draft = "";

  constructor(
    root: HTMLElement,
    private readonly post: Post,
    private readonly options: ComposerOptions = {},
  ) {
    this.codec = options.codec ?? browserCodec;
    this.input = el("textarea", { class: "input", rows: "1", placeholder: IDLE_PLACEHOLDER, "aria-label": "Сообщение агенту" });
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.input.addEventListener("input", () => {
      this.recalled = undefined; // an edited recall is the draft now
      this.fitInput();
      this.refreshSend();
    });
    this.input.addEventListener("paste", (event) => this.onPaste(event));

    this.thumbs = el("div", { class: "thumbs", "data-role": "thumbs" });
    this.errors = el("div", { class: "attach-errors", "data-role": "attach-errors", role: "alert" });
    this.notice = el("div", { class: "attach-notice", "data-role": "attach-notice", role: "status" });
    this.notice.hidden = true;
    this.picker = el("input", { type: "file", accept: "image/*", multiple: "", "data-role": "picker" });
    this.picker.hidden = true;
    this.picker.addEventListener("change", () => {
      const files = [...(this.picker.files ?? [])];
      this.picker.value = ""; // the same file can be picked again
      void this.addFiles(files);
    });

    const attach = button(icon("plus"), { class: "icon-btn", "data-role": "attach", title: "Приложить картинку", "aria-label": "Приложить картинку" }, () => this.picker.click());
    const slash = button(icon("slash"), { class: "icon-btn", "data-role": "slash", title: "Команды и навыки", "aria-label": "Команды и навыки" }, () => this.options.onSlash?.(slash));
    this.agentsDot = el("span", { class: "d", "aria-hidden": "true" });
    this.agentsText = el("span", {});
    const agents = button(this.agentsDot, { class: "pill", "data-role": "agents-pill", title: "Агенты сессии" }, () => this.options.onAgents?.(agents));
    agents.append(this.agentsText);
    this.modelText = el("span", {});
    this.modelLevel = el("span", { class: "w" });
    const model = button(this.modelText, { class: "pill", "data-role": "model-pill", title: "Модель и глубина размышлений" }, () => this.options.onModel?.(model));
    model.append(this.modelLevel);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    const circle = (className: string): SVGCircleElement => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      node.setAttribute("class", className);
      node.setAttribute("cx", "10");
      node.setAttribute("cy", "10");
      node.setAttribute("r", String(RING_RADIUS));
      return node;
    };
    this.contextArc = circle("arc");
    this.contextArc.setAttribute("stroke-dasharray", `0 ${RING_LENGTH}`);
    svg.append(circle("track"), this.contextArc);
    this.contextTip = el("span", { class: "tip", role: "tooltip", "data-role": "context-tip" });
    this.contextRing = button(svg, { class: "ctx", "data-role": "context-ring" }, () => {
      if (!this.contextRing.disabled) this.post({ type: "compact" });
    });
    this.contextRing.append(this.contextTip);
    this.contextRing.hidden = true;
    this.send = button(icon("send"), { "data-role": "send", class: "send", title: SEND_LABEL, "aria-label": SEND_LABEL }, () => this.submit(false));
    this.stop = button(el("i"), { "data-role": "stop", class: "stop", title: "Остановить агента", "aria-label": "Стоп" }, () => {
      this.stoppedAt = Date.now(); // a turn still running STOP_WAIT_MS from here is wedged
      this.armWedge();
      this.post({ type: "stop" });
    });
    this.stop.hidden = true;
    this.modeChip = button("", { class: "pill mode-chip", "data-role": "mode-chip", title: "Снять режим" }, () => this.setMode(undefined));
    this.modeChip.hidden = true;

    this.overlay = el("div", { class: "drop", "data-role": "drop" }, "Отпустите, чтобы приложить картинку");
    this.overlay.hidden = true;
    this.watchDrops(options.dropZone ?? root);

    this.wedgeText = el("span", { class: "wedge-text", "data-role": "wedge-text" });
    this.wedgeFix = button("Снять зависание", { class: "link", "data-role": "unwedge" }, () => this.askUnwedge());
    this.wedgeCancel = button("Отмена", { class: "link wedge-no", "data-role": "wedge-cancel" }, () => this.dismissWedge());
    this.wedge = el("div", { class: "wedge", "data-role": "wedge", role: "status" }, this.wedgeText, this.wedgeFix, this.wedgeCancel);
    this.showWedge("none", "");

    this.box = el(
      "div",
      { class: "composer-box" },
      this.thumbs,
      this.errors,
      this.notice,
      this.input,
      el("div", { class: "bar" }, attach, slash, agents, model, this.contextRing, this.modeChip, el("span", { class: "spacer" }), this.send, this.stop),
      this.picker,
    );
    root.classList.add("composer");
    root.replaceChildren(this.box, this.wedge);
    this.renderAttachments();
  }

  update(message: StateMessage): void {
    const { state, tab } = message;
    this.input.placeholder = state.running ? RUNNING_PLACEHOLDER : IDLE_PLACEHOLDER;
    this.updateHistory(state.blocks);
    this.running = state.running;
    this.stop.hidden = !state.running;
    this.refreshSend();
    this.watchWedge(state);

    const label = agentsLabel(state.agents);
    this.agentsText.textContent = label;
    this.agentsDot.classList.toggle("on", label !== "0 агентов");

    const models = message.models ?? [];
    const auto = tab.modelMode === "auto";
    const name = modelName(auto ? (state.autoModel ?? state.model) : state.model, models);
    this.modelText.textContent = auto ? (name !== undefined ? `Auto · ${name}` : "Auto") : (name ?? "Модель");
    this.modelLevel.textContent = state.thinkingLevel ?? "";
    this.modelLevel.hidden = state.thinkingLevel === undefined || state.thinkingLevel === "";
    // A toggle waits for the host's echo: a state already in flight must not undo it.
    if (this.pendingMode === undefined) this.showMode(tab.stickyMode);
    else if (tab.stickyMode === this.pendingMode.mode) {
      this.clearPending();
      this.showMode(tab.stickyMode);
    }
    this.updateContext(state);
  }

  private updateContext(state: ChatState): void {
    const view = contextView(state);
    this.contextRing.hidden = view === undefined;
    if (view === undefined) return;
    this.contextRing.dataset["level"] = view.level;
    this.contextRing.dataset["fill"] = String(view.fill);
    this.contextRing.disabled = view.level === "busy" || state.running;
    this.contextRing.setAttribute("aria-label", [view.tip, view.hint].filter((part) => part !== undefined).join(" "));
    this.contextArc.setAttribute("stroke-dasharray", `${(RING_LENGTH * view.fill) / 100} ${RING_LENGTH}`);
    this.contextTip.replaceChildren(el("span", {}, view.tip), ...(view.hint !== undefined ? [el("span", { class: "hint" }, view.hint)] : []));
  }

  get mode(): NextMode | undefined {
    return this.nextMode;
  }

  /** The user's toggle: the keyword stays on every prose message until turned off, and the host keeps it with the tab. */
  setMode(mode: NextMode | undefined): void {
    this.showMode(mode);
    this.clearPending();
    this.pendingMode = { mode, timer: setTimeout(() => this.clearPending(), PENDING_MODE_MS) };
    this.post({ type: "setMode", mode: mode ?? null });
  }

  /** Stops the toggle's safety timer and the wedge watch when the tab goes away. */
  dispose(): void {
    this.clearPending();
    if (this.wedgeTimer !== undefined) clearTimeout(this.wedgeTimer);
    this.wedgeTimer = undefined;
    if (this.wedgeDoneTimer !== undefined) clearTimeout(this.wedgeDoneTimer);
    this.wedgeDoneTimer = undefined;
  }

  // ---------- the wedge watch ----------

  /**
   * A turn can wedge in OmO: a provider request that never returns leaves the turn running, the abort answers success
   * and the composer says «Работаю…» for good. Nothing is unloaded on a guess — the line only ever offers, and the
   * person's click does it. Any change in this session's state counts as a frame and resets the silence.
   */
  private watchWedge(state: ChatState): void {
    const moved =
      state.blocks.length !== this.progressFrom.length ||
      state.activity !== this.progressActivity ||
      state.blocks.some((block, index) => block !== this.progressFrom[index]);
    this.progressFrom = state.blocks;
    this.progressActivity = state.activity;
    if (moved) this.progressAt = Date.now();
    if (!this.running) {
      this.stoppedAt = undefined;
      if (this.wedgeState === "ask") this.showWedge("none", "");
    }
    this.armWedge();
  }

  /** One timer at a time, set for the nearer of the two deadlines; nothing is armed unless a turn is running. */
  private armWedge(): void {
    if (this.wedgeTimer !== undefined) clearTimeout(this.wedgeTimer);
    this.wedgeTimer = undefined;
    if (!this.running || this.wedgeState !== "none") return;
    const stopDeadline = this.stoppedAt !== undefined ? this.stoppedAt + STOP_WAIT_MS : Number.POSITIVE_INFINITY;
    const silentDeadline = Math.max(this.progressAt, this.dismissedAt) + SILENT_MS;
    this.wedgeTimer = setTimeout(() => {
      this.wedgeTimer = undefined;
      this.checkWedge();
    }, Math.max(0, Math.min(stopDeadline, silentDeadline) - Date.now()));
  }

  /** The deadline came: «Стоп» went unanswered, or nothing came back for minutes. */
  private checkWedge(): void {
    if (!this.running || this.wedgeState !== "none") return;
    const now = Date.now();
    if (this.stoppedAt !== undefined && now - this.stoppedAt >= STOP_WAIT_MS) {
      this.showWedge("ask", STOP_WEDGE_TEXT);
      return;
    }
    const quiet = now - Math.max(this.progressAt, this.dismissedAt);
    if (quiet >= SILENT_MS) this.showWedge("ask", `От модели нет ответа ${Math.floor(quiet / 60_000)} мин`);
    else this.armWedge(); // the first deadline was the other one's: wait for it
  }

  private askUnwedge(): void {
    this.showWedge("working", "Снимаю зависание…");
    this.post({ type: "unwedge" });
  }

  private dismissWedge(): void {
    this.stoppedAt = undefined;
    this.dismissedAt = Date.now();
    this.showWedge("none", "");
  }

  /** The host's answer to «Снять зависание»: the session came back, or it did not and this says why. */
  unwedged(message: UnwedgedMessage): void {
    this.stoppedAt = undefined;
    this.dismissedAt = Date.now();
    this.showWedge("done", message.outcome === "unloaded" ? "Сессия перезапущена" : message.reason);
    if (this.wedgeDoneTimer !== undefined) clearTimeout(this.wedgeDoneTimer);
    this.wedgeDoneTimer = setTimeout(() => {
      this.wedgeDoneTimer = undefined;
      if (this.wedgeState === "done") this.showWedge("none", "");
    }, WEDGE_DONE_MS);
  }

  private showWedge(state: WedgeState, text: string): void {
    this.wedgeState = state;
    this.wedge.hidden = state === "none";
    this.wedge.dataset["state"] = state;
    this.wedgeText.textContent = text;
    this.wedgeFix.hidden = state !== "ask";
    this.wedgeCancel.hidden = state !== "ask";
    this.armWedge();
  }

  private clearPending(): void {
    if (this.pendingMode !== undefined) clearTimeout(this.pendingMode.timer);
    this.pendingMode = undefined;
  }

  /** Shown as a chip that drops it. */
  private showMode(mode: NextMode | undefined): void {
    this.nextMode = mode;
    this.modeChip.hidden = mode === undefined;
    this.modeChip.replaceChildren(el("span", {}, mode === undefined ? "" : MODE_INFO[mode].title), el("span", { class: "w", "aria-hidden": "true" }, "✕"));
  }

  /** The host's answer to a send: what did not go out comes back, before any new draft. */
  sent(id: string, ok: boolean): void {
    const pending = this.unconfirmed.get(id);
    this.unconfirmed.delete(id);
    if (ok || pending === undefined) return;
    this.refused.set(id, pending);
    this.input.value = this.input.value === "" ? pending.text : `${pending.text}\n${this.input.value}`;
    this.fitInput();
    this.refreshSend();
    if (pending.images.length === 0) return;
    this.attachments = [...pending.images, ...this.attachments];
    this.enforceLimits();
    this.renderAttachments();
  }

  /**
   * «Повторить»: the refused message goes out again under its id (OmO answers a repeat from its record). What came back
   * to the input for it leaves again when untouched; anything typed since stays. False when there is nothing to resend.
   */
  retry(id: string): boolean {
    const pending = this.refused.get(id);
    if (pending === undefined) return false;
    this.refused.delete(id);
    if (this.input.value === pending.text) {
      this.input.value = "";
      this.fitInput();
      this.refreshSend();
    }
    const returned = new Set(pending.images.map((image) => image.key));
    if (pending.images.length > 0 && this.attachments.some((attachment) => returned.has(attachment.key))) {
      this.attachments = this.attachments.filter((attachment) => !returned.has(attachment.key));
      this.enforceLimits();
      this.renderAttachments();
    }
    this.dispatch(pending);
    return true;
  }

  /** «Убрать»: a refused message is not offered again (its text, already given back, stays where it is). */
  forget(id: string): void {
    this.refused.delete(id);
  }

  /** A fork tab starts with the forked message: its text before anything typed, its images as attachments. */
  async prefill(text: string, images: OutgoingImage[]): Promise<void> {
    this.input.value = this.input.value === "" ? text : `${text}\n${this.input.value}`;
    this.fitInput();
    this.refreshSend();
    const files = images.map((image) => {
      const binary = atob(image.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return new File([bytes], image.name ?? "", { type: image.mimeType });
    });
    if (files.length > 0) await this.addFiles(files);
  }

  /** Attaches files (paste, drop, «+»); resolves once every one is ready or rejected. */
  async addFiles(files: File[]): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const file of files) {
      const key = String(++this.nextKey);
      const name = file.name !== "" ? file.name : UNNAMED;
      if (this.attachments.filter((attachment) => attachment.status !== "error").length >= MAX_IMAGES) {
        this.attachments.push({ key, name, status: "error", reason: REASONS.count });
        continue;
      }
      this.attachments.push({ key, name, status: "pending" });
      jobs.push(prepareImage(file, file.name !== "" ? file.name : undefined, this.codec).then((result) => this.settle(key, result)));
    }
    this.renderAttachments();
    await Promise.all(jobs);
  }

  // ---------- attachments ----------

  private settle(key: string, result: PreparedImage): void {
    const index = this.attachments.findIndex((attachment) => attachment.key === key && attachment.status === "pending");
    const current = this.attachments[index];
    if (current === undefined) return; // removed (or over the limit) while it was being prepared
    this.attachments[index] = result.ok
      ? { key, name: current.name, status: "ready", image: result.image, size: { width: result.width, height: result.height } }
      : { key, name: current.name, status: "error", reason: result.reason };
    this.enforceLimits();
    this.renderAttachments();
  }

  /**
   * Re-derives which prepared images go out, in order: at most five, and no more characters in all than one message
   * may carry. The rest are marked with the reason, not dropped (e.g. after a failed send came back).
   */
  private enforceLimits(): void {
    let count = 0;
    let total = 0;
    this.attachments = this.attachments.map((attachment) => {
      if (attachment.status === "pending") {
        count += 1;
        return attachment;
      }
      const { key, name, image, size } = attachment;
      if (image === undefined || size === undefined) return attachment; // a file that could not be prepared
      if (count >= MAX_IMAGES) return { key, name, status: "error", reason: REASONS.count, image, size };
      if (total + image.data.length > MAX_MESSAGE_IMAGE_CHARS) return { key, name, status: "error", reason: REASONS.total, image, size };
      count += 1;
      total += image.data.length;
      return { key, name, status: "ready", image, size };
    });
  }

  private remove(key: string): void {
    this.attachments = this.attachments.filter((attachment) => attachment.key !== key);
    this.enforceLimits();
    this.renderAttachments();
    this.input.focus();
  }

  private openImage(key: string): void {
    const ready = this.attachments.filter(isReady);
    this.options.onOpenImage?.(
      ready.map((attachment) => ({ id: attachment.key, dataUrl: dataUrl(attachment.image) })),
      ready.findIndex((attachment) => attachment.key === key),
    );
  }

  private renderAttachments(): void {
    this.refreshSend();
    this.thumbs.hidden = this.attachments.length === 0;
    this.thumbs.replaceChildren(...this.attachments.map((attachment) => this.thumb(attachment)));
    const failed = this.attachments.filter((attachment) => attachment.status === "error");
    this.errors.hidden = failed.length === 0;
    this.errors.replaceChildren(...failed.map((attachment) => el("div", {}, `${attachment.name}: ${attachment.reason}`)));
  }

  /** A chip: a tiny preview, the name and, once ready, the size it is sent at; ✕ on hover; a click opens the viewer. */
  private thumb(attachment: Attachment): HTMLElement {
    const tile = el("div", { class: "thumb", "data-status": attachment.status, title: attachment.status === "error" ? attachment.reason : attachment.name });
    const name = el("span", { class: "lbl", "data-role": "thumb-name" }, attachment.name);
    let body: HTMLElement;
    if (attachment.status === "ready") {
      const preview = el("span", { class: "tn" }, el("img", { src: dataUrl(attachment.image), alt: "" }));
      body = button(preview, { class: "thumb-view", "data-role": "thumb-view", "aria-label": `Открыть: ${attachment.name}` }, () => this.openImage(attachment.key));
      body.append(name, el("span", { class: "dim", "data-role": "thumb-size" }, `${attachment.size.width}×${attachment.size.height}`));
    } else {
      const mark = el("span", { class: "thumb-mark", "aria-hidden": "true" }, attachment.status === "error" ? "!" : "…");
      body = el("span", { class: "thumb-view" }, el("span", { class: "tn" }, mark), name);
    }
    tile.append(body, button("✕", { class: "xx", "data-role": "thumb-remove", title: "Убрать", "aria-label": `Убрать: ${attachment.name}` }, () => this.remove(attachment.key)));
    return tile;
  }

  // ---------- paste and drop ----------

  /** Pictures from the clipboard are attached unless it carries text: an office copy of cells comes with a picture of them, and the text wins. */
  private onPaste(event: ClipboardEvent): void {
    if ((event.clipboardData?.getData("text/plain") ?? "").trim() !== "") return; // the browser's own paste
    const files = [...(event.clipboardData?.files ?? [])];
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    if (pictures.length === 0) {
      if (files.length > 0) this.flash(ONLY_PICTURES); // files only, none a picture: say why nothing happened
      return;
    }
    event.preventDefault();
    void this.addFiles(pictures);
  }

  /** A short note over the input that goes away by itself. */
  private flash(text: string): void {
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.notice.textContent = text;
    this.notice.hidden = false;
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      this.notice.hidden = true;
    }, NOTICE_MS);
  }

  private watchDrops(zone: HTMLElement): void {
    const accepts = (): boolean => this.options.acceptsDrops?.() ?? true;
    zone.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (!accepts()) return;
      this.dragDepth += 1;
      this.overlay.hidden = false;
    });
    zone.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    });
    zone.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.overlay.hidden = true;
    });
    zone.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      this.dragDepth = 0;
      this.overlay.hidden = true;
      if (accepts()) void this.addFiles([...(event.dataTransfer?.files ?? [])]);
    });
  }

  // ---------- sending ----------

  private onKeyDown(event: KeyboardEvent): void {
    if (this.options.onInputKey?.(event) === true) return;
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.isComposing && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (this.recall(event.key === "ArrowUp" ? 1 : -1)) event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    this.submit(event.altKey);
  }

  /** True while a send would do something: words or a ready picture, and nothing still being prepared. */
  private get sendable(): boolean {
    if (this.attachments.some((attachment) => attachment.status === "pending")) return false;
    return this.input.value.trim() !== "" || this.attachments.some(isReady);
  }

  /** The send button: muted while there is nothing to send, and it says where the message goes. */
  private refreshSend(): void {
    this.send.disabled = !this.sendable;
    const label = this.running ? QUEUE_LABEL : SEND_LABEL;
    this.send.title = label;
    this.send.setAttribute("aria-label", label);
  }

  /** The one way out of the composer: Enter, ⌥Enter and the send button all come here. `queue` is ⌥'s follow-up. */
  private submit(queue: boolean): void {
    if (!this.sendable) return;
    const ready = this.attachments.filter(isReady);
    const typed = this.input.value.trim() === "" ? "" : this.input.value;
    // The mode goes on prose only: a command keeps its «/» first and images alone get no bare keyword; the mode stays on.
    const mode = typed !== "" && !typed.trimStart().startsWith("/") ? this.nextMode : undefined;
    const text = mode === undefined ? typed : `${mode} ${typed}`;
    const images = ready.map((attachment) => attachment.image);
    const message: SendMessage = { type: "send", id: crypto.randomUUID(), text, mode: queue ? "followUp" : "auto", ...(images.length > 0 ? { images } : {}) };
    this.dispatch({ text: typed, images: ready, message });
    this.input.value = "";
    this.recalled = undefined;
    this.attachments = [];
    this.renderAttachments();
    this.fitInput();
  }

  private dispatch(pending: Unconfirmed): void {
    this.unconfirmed.set(pending.message.id, pending);
    this.post(pending.message);
    this.options.onSend?.(pending.message);
  }

  /** A delta keeps unchanged blocks as the same objects: the same user blocks in the same order mean the same history. */
  private updateHistory(blocks: Block[]): void {
    const users = blocks.filter((block) => block.kind === "user");
    if (users.length === this.historyFrom.length && users.every((block, index) => block === this.historyFrom[index])) return;
    this.historyFrom = users;
    this.history = users.flatMap((block) => (block.kind === "user" && block.text.trim() !== "" ? [block.text] : [])).reverse();
  }

  /**
   * ↑ with the caret at the very start shows the next older message, ↓ with the caret at the very end the next newer
   * one, and past the newest the draft. True when the key was used.
   */
  private recall(step: 1 | -1): boolean {
    const { value, selectionStart, selectionEnd } = this.input;
    if (selectionStart !== selectionEnd) return false;
    if (step === 1 ? selectionStart !== 0 : this.recalled === undefined || selectionEnd !== value.length) return false;
    const next = (this.recalled ?? -1) + step;
    if (next >= this.history.length) return false;
    if (this.recalled === undefined) this.draft = value;
    this.recalled = next < 0 ? undefined : next;
    this.input.value = next < 0 ? this.draft : (this.history[next] as string);
    const caret = step === 1 ? 0 : this.input.value.length; // where the same key goes on
    this.input.setSelectionRange(caret, caret);
    this.fitInput();
    this.refreshSend();
    return true;
  }

  private fitInput(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${this.input.scrollHeight}px`;
  }
}
