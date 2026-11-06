import type { AgentRow, Block, ChatState, ImageRef, ModelRef } from "../src/chat/model";
import { MAX_IMAGES, MAX_MESSAGE_IMAGE_CHARS, type ModelInfo, type StateMessage, type UnwedgedMessage, type WebviewMessage } from "../src/panel/protocol";
import type { NextMode, OutgoingImage } from "../src/sessions/controller";
import type { LadderView } from "../src/sessions/ladder";
import { browserCodec, prepareImage, REASONS, type ImageCodec, type PreparedImage } from "./attachments";
import { button, el, type Post } from "./dom";
import type { FeedImage } from "./feed";
import { icon } from "./icons";
import { PILL, TextField } from "./inputField";

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
/**
 * A prepared image over a limit is an error that keeps its bytes: removing another one frees room for it. `placed` is
 * true while the picture belongs to a spot in the text (a pill); false for one on the shelf above the input, which has
 * no position and travels unlabelled.
 */
type Attachment = { key: string; name: string; placed: boolean } & (
  | { status: "pending" }
  | { status: "ready"; image: OutgoingImage; size: Size }
  | { status: "error"; reason: string; image?: OutgoingImage; size?: Size }
);
type Ready = Extract<Attachment, { status: "ready" }>;
/** A message the host has not confirmed (or refused): the text as it went out (labels and all), its pictures in that order, and what was posted. */
type Unconfirmed = { text: string; images: Ready[]; message: SendMessage };

/** Where a picture lands: at the caret as a pill, or on the shelf above the input when there is no caret to aim at. */
export type Spot = "caret" | "shelf";

/** A message this session already sent, as ↑ gives it back. */
type Sent = { text: string; images: ImageRef[] };
/** What the field holds, taken apart so it can be put back: a label per pill and the record each label points at. */
type Recalled = { text: string; images: Attachment[] };

/** The label that stands for a picture in the text that goes to the agent, and the pattern that reads it back. */
export function imageLabel(index: number): string {
  return `[картинка ${index}]`;
}
const LABEL = /\[картинка (\d+)\]/g;

const IDLE_PLACEHOLDER = "Сообщение агенту (вставь картинку ⌘V или перетащи)";
const RUNNING_PLACEHOLDER = "В очередь ещё сообщение…";
const UNNAMED = "image.png";
const ONLY_PICTURES = "Можно прикладывать только картинки";
const DROP_HINT = "Отпустите — картинка встанет сюда";
/** A picture a recalled message pointed at that the host no longer holds. */
const GONE = "Картинки больше нет";
const NOTICE_MS = 3_000;
const PENDING_MODE_MS = 3_000;
/** The send button's own words: idle it prompts, mid-turn the message goes behind the turn. */
const SEND_LABEL = "Отправить";
const QUEUE_LABEL = "В очередь после текущего хода";

/**
 * A turn still running this long after «Стоп» is wedged: OmO answered the abort but the turn never ended. That one
 * the extension fixes itself — nothing to ask, the person already said stop.
 */
const STOP_WAIT_MS = 8_000;
/** A running turn whose session sent nothing for this long is wedged too (a provider request that never returns). */
const SILENT_MS = 180_000;
/** How long the outcome of «Снять зависание» stays on screen. */
const WEDGE_DONE_MS = 6_000;
/** The automatic restart, while it runs and when it was not done because this session has already had one. */
const AUTO_WEDGE_TEXT = "Перезапускаю сессию…";
const AUTO_SPENT_TEXT = "Перезапуск уже был — агент снова не отвечает на «Стоп». Снять зависание?";

/** The wedge line: nothing, the offer, the unload in flight, or its outcome. */
type WedgeState = "none" | "ask" | "working" | "done";

/** The ladder's own line: what it says while it walks, and what it leaves behind. */
const LADDER_STOP = "Прервать";
const LADDER_SETTLED = (model: string): string => `Сессия осталась на ${model}`;
const LADDER_BACK = (model: string): string => `вернуться на ${model}`;
const LADDER_WALKING = (rung: number, total: number, label: string): string => `Ступенька ${rung} из ${total} · ${label}`;

function isReady(attachment: Attachment): attachment is Ready {
  return attachment.status === "ready";
}

function dataUrl(image: OutgoingImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

/** The place in the text under a point on screen, as far as the browser can say (jsdom and old engines: nowhere). */
function caretFromPoint(x: number, y: number): Range | undefined {
  const document_ = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const position = document_.caretPositionFromPoint?.(x, y);
  if (position !== undefined && position !== null) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  const legacy = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y);
  return legacy ?? undefined;
}

/** A field somebody else owns (a dialog's answer, a settings box): its paste is not the composer's. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
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
  /** The editable element itself (focus, listeners); `field` is the text inside it. */
  readonly input: HTMLElement;
  readonly field: TextField;
  /** The rounded block; popovers above the composer sit over its top edge. */
  readonly box: HTMLElement;
  private readonly thumbs: HTMLElement;
  private readonly errors: HTMLElement;
  private readonly notice: HTMLElement;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly picker: HTMLInputElement;
  /** Where a file being carried over the input would land, and the words that say so (frame B of the mockup). */
  private readonly dropCaret: HTMLElement;
  private readonly dropHint: HTMLElement;
  /** The spot the marker is pointing at, so the drop lands there and not where the caret happened to be. */
  private dropAt: Range | undefined;
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
  /** The model ladder's line: the step it is on, or the model it left the session on. */
  private readonly ladderLine: HTMLElement;
  private readonly ladderText: HTMLElement;
  private readonly ladderStop: HTMLButtonElement;
  private readonly ladderBack: HTMLButtonElement;
  /** The model «вернуться на …» goes back to, while that offer is on screen. */
  private ladderHome: ModelRef | undefined;
  private readonly contextRing: HTMLButtonElement;
  private readonly contextArc: SVGCircleElement;
  private readonly contextTip: HTMLElement;
  private readonly modeChip: HTMLButtonElement;
  private nextMode: NextMode | undefined;
  /** A toggle the host has not echoed yet. */
  private pendingMode: { mode: NextMode | undefined; timer: ReturnType<typeof setTimeout> } | undefined;
  private readonly codec: ImageCodec;
  private attachments: Attachment[] = [];
  /** Pills the text lost, kept in case the editor's own undo brings one back. */
  private readonly retired = new Map<string, Attachment>();
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
  /** This session's sent messages, newest first, for ↑/↓; rebuilt only when its user blocks change (not per streamed delta). */
  private history: Sent[] = [];
  private historyFrom: Block[] = [];
  /** Which of them the input shows, while stepping through them; the draft waits for the way back. */
  private recalled: number | undefined;
  private draft: Recalled = { text: "", images: [] };
  /** Pictures of a recalled message the host is still fetching: its ref id to the key of the pill waiting for it. */
  private readonly awaiting = new Map<string, string>();

  constructor(
    root: HTMLElement,
    private readonly post: Post,
    private readonly options: ComposerOptions = {},
  ) {
    this.codec = options.codec ?? browserCodec;
    this.field = new TextField({ class: "input", "aria-label": "Сообщение агенту" });
    this.field.placeholder = IDLE_PLACEHOLDER;
    this.input = this.field.element;
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.input.addEventListener("input", () => {
      this.recalled = undefined; // an edited recall is the draft now
      this.syncPills();
    });
    this.input.addEventListener("paste", (event) => this.onPaste(event));
    this.input.addEventListener("click", (event) => {
      const cross = (event.target as Element | null)?.closest<HTMLElement>('[data-role="pill-remove"]');
      const key = cross?.closest<HTMLElement>("[data-key]")?.dataset["key"];
      if (key !== undefined) this.remove(key);
    });
    // ⌘V with the caret somewhere else (the feed, nothing at all) still attaches: the shelf takes what has no position.
    document.addEventListener("paste", (event) => {
      if (!this.input.isConnected || this.input.contains(event.target as Node) || isEditable(event.target)) return;
      this.onPaste(event);
    });

    this.thumbs = el("div", { class: "thumbs", "data-role": "thumbs" });
    this.errors = el("div", { class: "attach-notes", "data-role": "attach-notes", role: "status" });
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
      this.noteStop();
      this.post({ type: "stop" });
    });
    this.stop.hidden = true;
    this.modeChip = button("", { class: "pill mode-chip", "data-role": "mode-chip", title: "Снять режим" }, () => this.setMode(undefined));
    this.modeChip.hidden = true;

    this.overlay = el("div", { class: "drop", "data-role": "drop" }, "Отпустите, чтобы приложить картинку");
    this.overlay.hidden = true;
    this.dropCaret = el("span", { class: "drop-caret", "data-role": "drop-caret", "aria-hidden": "true" });
    this.dropHint = el("span", { class: "drop-hint", "data-role": "drop-hint", role: "status" }, DROP_HINT);
    this.dropCaret.hidden = true;
    this.dropHint.hidden = true;
    this.watchDrops(options.dropZone ?? root);

    this.wedgeText = el("span", { class: "wedge-text", "data-role": "wedge-text" });
    this.wedgeFix = button("Снять зависание", { class: "link", "data-role": "unwedge" }, () => this.askUnwedge());
    this.wedgeCancel = button("Отмена", { class: "link wedge-no", "data-role": "wedge-cancel" }, () => this.dismissWedge());
    this.wedge = el("div", { class: "wedge", "data-role": "wedge", role: "status" }, this.wedgeText, this.wedgeFix, this.wedgeCancel);
    this.showWedge("none", "");

    this.ladderText = el("span", { class: "wedge-text", "data-role": "ladder-text" });
    this.ladderStop = button(LADDER_STOP, { class: "link wedge-no", "data-role": "ladder-stop" }, () => {
      this.ladder(null); // the line goes at once; the host answers with its own null
      this.post({ type: "ladderInterrupt" });
    });
    this.ladderBack = button("", { class: "link", "data-role": "ladder-back" }, () => {
      const model = this.ladderHome;
      this.ladder(null);
      if (model !== undefined) this.post({ type: "setModel", model });
    });
    this.ladderLine = el("div", { class: "wedge ladder", "data-role": "ladder", role: "status" }, this.ladderText, this.ladderStop, this.ladderBack);
    this.ladder(null);

    this.box = el(
      "div",
      { class: "composer-box" },
      this.thumbs,
      this.errors,
      this.notice,
      this.input,
      this.dropCaret,
      this.dropHint,
      el("div", { class: "bar" }, attach, slash, agents, model, this.contextRing, this.modeChip, el("span", { class: "spacer" }), this.send, this.stop),
      this.picker,
    );
    root.classList.add("composer");
    root.replaceChildren(this.box, this.ladderLine, this.wedge);
    this.renderAttachments();
  }

  update(message: StateMessage): void {
    const { state, tab } = message;
    this.field.placeholder = state.running ? RUNNING_PLACEHOLDER : IDLE_PLACEHOLDER;
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

  /**
   * «Стоп» was pressed — here or in the dock, while a dialog hid this composer. A turn still running STOP_WAIT_MS from
   * now is wedged, and the bounded restart fires. Arming it from the dock too is what makes Stop free the tab from a
   * question the person is parked on, not only from a turn whose composer was on screen.
   */
  noteStop(): void {
    this.stoppedAt = Date.now();
    this.armWedge();
  }

  // ---------- the wedge watch ----------

  /**
   * A turn can wedge in OmO: a provider request that never returns leaves the turn running, the abort answers success
   * and the composer says «Работаю…» for good. After «Стоп» the extension restarts the session itself — the person
   * already asked for the turn to end. Silence alone is never acted on (the agent may be thinking): that line only
   * offers, and the person's click does it. Any change in this session's state counts as a frame and resets the silence.
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
      // One attempt for this «Стоп»: `stoppedAt` is cleared by the answer, and nothing re-arms while it runs.
      this.showWedge("working", AUTO_WEDGE_TEXT);
      this.post({ type: "unwedge", auto: true });
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

  /**
   * The host's answer to an unwedge: the session came back, or it did not and this says why. An automatic restart is
   * not reported here when it worked — the feed carries that line — and when it did not, the line hands the person
   * the manual way out instead of trying again.
   */
  unwedged(message: UnwedgedMessage): void {
    this.stoppedAt = undefined;
    this.dismissedAt = Date.now();
    if (message.outcome === "cooldown") {
      this.showWedge("ask", AUTO_SPENT_TEXT);
      return;
    }
    if (message.auto === true) {
      if (message.outcome === "unloaded") this.showWedge("none", "");
      else this.showWedge("ask", `${message.reason}. Снять зависание?`);
      return;
    }
    this.showWedge("done", message.outcome === "unloaded" ? "Сессия перезапущена" : message.reason);
    if (this.wedgeDoneTimer !== undefined) clearTimeout(this.wedgeDoneTimer);
    this.wedgeDoneTimer = setTimeout(() => {
      this.wedgeDoneTimer = undefined;
      if (this.wedgeState === "done") this.showWedge("none", "");
    }, WEDGE_DONE_MS);
  }

  // ---------- the model ladder's line ----------

  /**
   * The ladder's own quiet line under the box: which step it is on while it walks, with the way to interrupt, and
   * afterwards the model it left the session on with one click back to the one the message started on. `null` takes
   * the line away — the walk ended, was interrupted, or the person sent something new.
   */
  ladder(view: LadderView | null): void {
    this.ladderHome = view !== null && view.state === "settled" ? { provider: view.back.provider, id: view.back.id } : undefined;
    this.ladderLine.hidden = view === null;
    if (view === null) {
      this.ladderText.textContent = "";
      this.ladderStop.hidden = true;
      this.ladderBack.hidden = true;
      return;
    }
    const walking = view.state === "walking";
    this.ladderLine.dataset["state"] = view.state;
    this.ladderText.textContent = walking ? LADDER_WALKING(view.rung, view.total, view.label) : LADDER_SETTLED(view.model);
    this.ladderStop.hidden = !walking;
    this.ladderBack.hidden = walking;
    if (!walking) {
      const label = LADDER_BACK(view.back.label);
      this.ladderBack.textContent = label;
      this.ladderBack.setAttribute("aria-label", label);
    }
  }

  private showWedge(state: WedgeState, text: string): void {
    this.wedgeState = state;
    this.wedge.hidden = state === "none";
    this.wedge.dataset["state"] = state;
    this.wedgeText.textContent = text;
    this.wedgeFix.hidden = state !== "ask";
    this.wedgeCancel.hidden = state !== "ask";
    this.stop.disabled = state === "working"; // the session is going away: there is nothing left to stop or send to
    this.refreshSend();
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
    this.place(pending.text, pending.images);
  }

  /**
   * «Повторить»: the refused message goes out again under its id (OmO answers a repeat from its record). What came back
   * to the input for it leaves again when untouched; anything typed since stays. False when there is nothing to resend.
   */
  retry(id: string): boolean {
    const pending = this.refused.get(id);
    if (pending === undefined) return false;
    this.refused.delete(id);
    const returned = new Set(pending.images.map((image) => image.key));
    if (this.snapshot(true).text === pending.text) this.field.value = "";
    for (const key of returned) this.field.removePill(key);
    if (pending.images.length > 0 && this.attachments.some((attachment) => returned.has(attachment.key))) {
      this.attachments = this.attachments.filter((attachment) => !returned.has(attachment.key));
    }
    this.syncPills();
    this.dispatch(pending);
    return true;
  }

  /** «Убрать»: a refused message is not offered again (its text, already given back, stays where it is). */
  forget(id: string): void {
    this.refused.delete(id);
  }

  /** A fork tab starts with the forked message: its text (labels and all) before anything typed, its images as pills. */
  async prefill(text: string, images: OutgoingImage[]): Promise<void> {
    const records = images.map((image) => this.pending(image.name ?? UNNAMED));
    this.place(text, records);
    await Promise.all(
      images.map((image, index) => {
        const binary = atob(image.data);
        const bytes = new Uint8Array(binary.length);
        for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
        const file = new File([bytes], image.name ?? "", { type: image.mimeType });
        return prepareImage(file, image.name, this.codec).then((result) => this.settle((records[index] as Attachment).key, result));
      }),
    );
  }

  /**
   * Attaches files (paste, drop, «+»); resolves once every one is ready or rejected. `spot` says where they belong:
   * at the caret, each as a pill in the line being written, or on the shelf above the input when there is no caret.
   */
  async addFiles(files: File[], spot: Spot = "shelf"): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const file of files) {
      const name = file.name !== "" ? file.name : UNNAMED;
      const record = this.pending(name);
      if (this.attachments.filter((attachment) => attachment.status !== "error").length >= MAX_IMAGES) {
        this.add({ ...record, status: "error", reason: REASONS.count }, spot);
        continue;
      }
      this.add(record, spot);
      jobs.push(prepareImage(file, file.name !== "" ? file.name : undefined, this.codec).then((result) => this.settle(record.key, result)));
    }
    this.renderAttachments();
    await Promise.all(jobs);
  }

  // ---------- attachments ----------

  /** A record for a picture that is not prepared yet; it gets a key here and keeps it until it is removed. */
  private pending(name: string): Attachment {
    return { key: String(++this.nextKey), name, placed: false, status: "pending" };
  }

  /** Takes a record in: at the caret it becomes a pill in the text, on the shelf it is only a chip above the input. */
  private add(attachment: Attachment, spot: Spot): void {
    const placed = spot === "caret";
    const record = { ...attachment, placed };
    this.attachments.push(record);
    if (placed) this.field.insertNode(this.pillFor(record));
    this.enforceLimits();
  }

  private settle(key: string, result: PreparedImage): void {
    const index = this.attachments.findIndex((attachment) => attachment.key === key && attachment.status === "pending");
    const current = this.attachments[index];
    if (current === undefined) return; // removed (or over the limit) while it was being prepared
    const { name, placed } = current;
    this.attachments[index] = result.ok
      ? { key, name, placed, status: "ready", image: result.image, size: { width: result.width, height: result.height } }
      : { key, name, placed, status: "error", reason: result.reason };
    this.enforceLimits();
    this.renderAttachments();
  }

  /**
   * Re-derives which prepared images go out, in the order they are read in: the pills by their place in the text, then
   * the shelf. At most five, and no more characters in all than one message may carry; the rest are marked with the
   * reason, not dropped (e.g. after a failed send came back).
   */
  private enforceLimits(): void {
    let count = 0;
    let total = 0;
    this.attachments = this.ordered().map((attachment) => {
      if (attachment.status === "pending") {
        count += 1;
        return attachment;
      }
      const { key, name, placed, image, size } = attachment;
      if (image === undefined || size === undefined) return attachment; // a file that could not be prepared
      if (count >= MAX_IMAGES) return { key, name, placed, status: "error", reason: REASONS.count, image, size };
      if (total + image.data.length > MAX_MESSAGE_IMAGE_CHARS) return { key, name, placed, status: "error", reason: REASONS.total, image, size };
      count += 1;
      total += image.data.length;
      return { key, name, placed, status: "ready", image, size };
    });
  }

  /** The records in reading order: the pills as they stand in the text, then what is on the shelf. */
  private ordered(): Attachment[] {
    const byKey = new Map(this.attachments.map((attachment) => [attachment.key, attachment]));
    const placed: Attachment[] = [];
    for (const node of this.field.pills()) {
      const attachment = byKey.get(node.dataset["key"] ?? "");
      if (attachment !== undefined) placed.push(attachment);
    }
    return [...placed, ...this.attachments.filter((attachment) => !attachment.placed)];
  }

  /**
   * Brings the records back in step with the text after an edit: a pill the person deleted (or the editor's undo took
   * away) drops its picture, and one undo put back takes its picture up again.
   */
  private syncPills(): void {
    const keys = this.field.pills().map((node) => node.dataset["key"] ?? "");
    const live = new Set(keys);
    const kept: Attachment[] = [];
    for (const attachment of this.attachments) {
      if (!attachment.placed || live.has(attachment.key)) kept.push(attachment);
      else this.retired.set(attachment.key, attachment);
    }
    const known = new Set(kept.map((attachment) => attachment.key));
    for (const key of keys) {
      if (known.has(key)) continue;
      const back = this.retired.get(key);
      if (back === undefined) this.field.removePill(key); // a pill with no picture behind it cannot be sent
      else {
        this.retired.delete(key);
        kept.push(back);
      }
    }
    this.attachments = kept;
    this.enforceLimits();
    this.renderAttachments();
  }

  private remove(key: string): void {
    this.attachments = this.attachments.filter((attachment) => attachment.key !== key);
    this.retired.delete(key);
    this.field.removePill(key);
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
    const shelf = this.attachments.filter((attachment) => !attachment.placed);
    this.thumbs.hidden = shelf.length === 0;
    this.thumbs.replaceChildren(...shelf.map((attachment) => this.thumb(attachment)));
    for (const attachment of this.attachments) {
      if (!attachment.placed) continue;
      const node = this.field.pill(attachment.key);
      if (node !== undefined) this.paintPill(node, attachment);
    }
    this.field.refresh();
    const notes = this.ordered().flatMap((attachment) =>
      attachment.status === "error"
        ? [el("div", { class: "attach-note error" }, `${attachment.name} — ${attachment.reason}`)]
        : attachment.status === "pending"
          ? [el("div", { class: "attach-note" }, `${attachment.name} — готовлю картинку…`)]
          : [],
    );
    this.errors.hidden = notes.length === 0;
    this.errors.replaceChildren(...notes);
  }

  /** The pill a picture takes in the text: the same chip as the shelf's, 20 px tall, with room for its ✕ at all times. */
  private pillFor(attachment: Attachment): HTMLElement {
    const node = el("span", { class: "att", "data-role": "pill", "data-key": attachment.key, contenteditable: "false" });
    this.paintPill(node, attachment);
    return node;
  }

  private paintPill(node: HTMLElement, attachment: Attachment): void {
    node.dataset["status"] = attachment.status;
    node.title = attachment.status === "error" ? attachment.reason : attachment.name;
    node.setAttribute("aria-label", `Картинка: ${attachment.name}`);
    const preview =
      attachment.status === "ready"
        ? el("span", { class: "tn" }, el("img", { src: dataUrl(attachment.image), alt: "" }))
        : el("span", { class: "tn" }, el("span", { class: "thumb-mark", "aria-hidden": "true" }, attachment.status === "error" ? "!" : "…"));
    node.replaceChildren(
      preview,
      el("span", { class: "lbl", "data-role": "pill-name" }, attachment.name),
      el("span", { class: "xx", "data-role": "pill-remove", title: "Убрать", "aria-hidden": "true" }, "✕"),
    );
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

  /**
   * Pictures from the clipboard are attached unless it carries text: an office copy of cells comes with a picture of
   * them, and the text wins. A rich fragment lands as plain text — the field is editable, so its own paste would bring
   * the markup in with it.
   */
  private onPaste(event: ClipboardEvent): void {
    const inside = this.input.contains(event.target as Node);
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.trim() !== "") {
      if (!inside) return; // somebody else's field: its paste is its own
      event.preventDefault();
      this.field.insertText(text);
      this.afterEdit();
      return;
    }
    const files = [...(event.clipboardData?.files ?? [])];
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    if (pictures.length > 0) {
      event.preventDefault();
      void this.addFiles(pictures, inside && this.field.hasCaret() ? "caret" : "shelf");
      return;
    }
    if (files.length > 0) this.flash(ONLY_PICTURES); // files only, none a picture: say why nothing happened
    if (!inside || text === "") return;
    event.preventDefault(); // blank text is still text, and still goes in plain
    this.field.insertText(text);
    this.afterEdit();
  }

  /** After a change the composer made itself: the editable element fires no input event for those. */
  private afterEdit(): void {
    this.recalled = undefined;
    this.syncPills();
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
      if (accepts()) this.aim(event);
    });
    zone.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth > 0) return;
      this.overlay.hidden = true;
      this.aimAway();
    });
    zone.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      this.dragDepth = 0;
      this.overlay.hidden = true;
      const spot = this.landing(event);
      this.aimAway();
      if (accepts()) void this.addFiles([...(event.dataTransfer?.files ?? [])], spot);
    });
  }

  /**
   * A file carried over the input: no veil over the words — the person needs to see them to aim — but a mark between
   * them, where the picture will stand, and the hint under it.
   */
  private aim(event: DragEvent): void {
    if (!this.input.contains(event.target as Node)) {
      this.overlay.hidden = false;
      this.aimAway();
      return;
    }
    this.overlay.hidden = true;
    const range = caretFromPoint(event.clientX, event.clientY) ?? this.dropAt;
    if (range === undefined) return;
    this.dropAt = range;
    const box = this.box.getBoundingClientRect();
    const spot = range.getBoundingClientRect();
    this.dropCaret.hidden = false;
    this.dropHint.hidden = false;
    this.dropCaret.style.left = `${spot.left - box.left}px`;
    this.dropCaret.style.top = `${spot.top - box.top}px`;
    this.dropHint.style.left = `${spot.left - box.left}px`;
    this.dropHint.style.top = `${spot.bottom - box.top + 6}px`;
  }

  private aimAway(): void {
    this.dropCaret.hidden = true;
    this.dropHint.hidden = true;
  }

  /** Where a dropped file goes: into the text at the mark when it was let go over the input, otherwise onto the shelf. */
  private landing(event: DragEvent): Spot {
    if (!this.input.contains(event.target as Node)) return "shelf";
    const range = caretFromPoint(event.clientX, event.clientY) ?? this.dropAt;
    const selection = window.getSelection();
    if (range !== undefined && selection !== null) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    this.dropAt = undefined;
    return "caret";
  }

  // ---------- sending ----------

  private onKeyDown(event: KeyboardEvent): void {
    if (this.options.onInputKey?.(event) === true) return;
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.isComposing && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (this.recall(event.key === "ArrowUp" ? 1 : -1)) event.preventDefault();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && !event.isComposing && this.eatPill(event.key === "Backspace")) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    this.submit(event.altKey);
  }

  /**
   * A pill is one thing, not a run of characters: Backspace right after one (or Delete right before one) takes the
   * whole chip away, picture and all. True when it did.
   */
  private eatPill(back: boolean): boolean {
    const { field } = this;
    const start = field.selectionStart;
    if (start !== field.selectionEnd) return false;
    const at = back ? start - 1 : start;
    const value = field.value;
    if (at < 0 || value[at] !== PILL) return false;
    const index = [...value.slice(0, at)].filter((character) => character === PILL).length;
    const node = field.pills()[index];
    const key = node?.dataset["key"];
    if (key === undefined) return false;
    this.remove(key);
    field.setSelectionRange(at);
    return true;
  }

  /**
   * True while a send would do something: words or a ready picture, nothing still being prepared, and no restart of
   * the session in flight (Enter goes nowhere while it runs, just like the button).
   */
  private get sendable(): boolean {
    if (this.wedgeState === "working") return false;
    if (this.attachments.some((attachment) => attachment.status === "pending")) return false;
    return this.field.value.trim() !== "" || this.attachments.some(isReady);
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
    const going = this.snapshot(true);
    const written = going.text;
    const ready = going.images.filter(isReady);
    const typed = written.trim() === "" ? "" : written;
    // The mode goes on prose only: a command keeps its «/» first and images alone get no bare keyword; the mode stays on.
    const mode = typed !== "" && !typed.trimStart().startsWith("/") ? this.nextMode : undefined;
    const text = mode === undefined ? typed : `${mode} ${typed}`;
    const images = ready.map((attachment) => attachment.image);
    const message: SendMessage = { type: "send", id: crypto.randomUUID(), text, mode: queue ? "followUp" : "auto", ...(images.length > 0 ? { images } : {}) };
    this.dispatch({ text: typed, images: ready, message });
    this.field.value = "";
    this.recalled = undefined;
    this.attachments = [];
    this.retired.clear();
    this.renderAttachments();
  }

  /**
   * The field taken apart: the text with «[картинка N]» where each pill stands, numbered from the start of the text,
   * and the pictures in that same order with the shelf's — which have no place in the text — after them. OmO's `prompt`
   * carries only a message and a flat list of images, so the place rides in the text. `going` is the version that goes
   * over the wire: a chip with no picture behind it (still being prepared, or refused) leaves no label, only the gap
   * where it stands. Everything else — the draft ↑ sets aside — keeps every chip, so it can be put back as it was.
   */
  private snapshot(going: boolean): Recalled {
    const keys = this.field.pills().map((node) => node.dataset["key"] ?? "");
    const byKey = new Map(this.attachments.map((attachment) => [attachment.key, attachment]));
    const images: Attachment[] = [];
    let text = "";
    let seen = 0;
    for (const character of this.field.value) {
      if (character !== PILL) {
        text += character;
        continue;
      }
      const attachment = byKey.get(keys[seen++] ?? "");
      if (attachment === undefined || (going && !isReady(attachment))) continue;
      images.push(attachment);
      text += imageLabel(images.length);
    }
    const shelf = this.attachments.filter((attachment) => !attachment.placed).filter((attachment) => !going || isReady(attachment));
    return { text, images: [...images, ...shelf] };
  }

  /**
   * Puts a message back into the field: its text with every «[картинка N]» replaced by the pill of the Nth picture, and
   * whatever is already typed under it. Pictures past the last label (the shelf's, which never had a place) go back to
   * the shelf.
   */
  private place(text: string, images: Attachment[]): void {
    const had = this.field.value !== ""; // what is already there stays, under the message coming back
    this.field.setSelectionRange(0);
    const used = new Set<number>();
    let at = 0;
    LABEL.lastIndex = 0;
    for (let match = LABEL.exec(text); match !== null; match = LABEL.exec(text)) {
      const image = images[Number(match[1]) - 1];
      if (image === undefined) continue; // a label the person typed themselves: it stays text
      this.field.insertText(text.slice(at, match.index));
      this.add({ ...image, placed: false }, "caret"); // `add` places the pill and keeps the record
      used.add(Number(match[1]) - 1);
      at = match.index + match[0].length;
    }
    this.field.insertText(text.slice(at) + (had ? "\n" : ""));
    // Pictures that never had a place go back on the shelf, and before anything the person has attached since.
    const shelf = images.filter((_, index) => !used.has(index)).map((image) => ({ ...image, placed: false }));
    this.attachments = [...shelf, ...this.attachments];
    this.afterEdit();
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
    this.history = users
      .flatMap((block) => (block.kind === "user" && block.text.trim() !== "" ? [{ text: block.text, images: block.images ?? [] }] : []))
      .reverse();
  }

  /**
   * Pills for a message coming back from the history: the picture itself is with the host, so each chip stands in its
   * place while its bytes are asked for, and becomes ready when they arrive (see `image`).
   */
  private recallImages(refs: ImageRef[]): Attachment[] {
    return refs.map((ref) => {
      const record = this.pending(ref.name ?? UNNAMED);
      this.awaiting.set(ref.id, record.key);
      this.post({ type: "getImage", id: ref.id });
      return record;
    });
  }

  /** The host's answer for a recalled picture: an empty answer means it has none left, and the chip says so. */
  image(id: string, dataUrl: string): void {
    const key = this.awaiting.get(id);
    if (key === undefined) return;
    this.awaiting.delete(id);
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
    if (match === null) {
      this.settle(key, { ok: false, reason: GONE });
      return;
    }
    const [, mimeType, data] = match as unknown as [string, string, string];
    const name = this.attachments.find((attachment) => attachment.key === key)?.name;
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    void this.codec
      .decode(new Blob([bytes], { type: mimeType }))
      .then((bitmap) => {
        this.settle(key, { ok: true, image: { mimeType, data, ...(name !== undefined ? { name } : {}) }, width: bitmap.width, height: bitmap.height });
        bitmap.close?.();
      })
      .catch(() => this.settle(key, { ok: false, reason: GONE }));
  }

  /** Shows a message from the history (or the draft set aside for the way back) in place of what the field holds. */
  private show(entry: Recalled): void {
    this.field.value = "";
    this.attachments = [];
    this.retired.clear();
    this.place(entry.text, entry.images);
  }

  /**
   * ↑ with the caret at the very start shows the next older message, ↓ with the caret at the very end the next newer
   * one, and past the newest the draft. True when the key was used.
   */
  private recall(step: 1 | -1): boolean {
    const { field } = this;
    const value = field.value;
    const selectionStart = field.selectionStart;
    if (selectionStart !== field.selectionEnd) return false;
    if (step === 1 ? selectionStart !== 0 : this.recalled === undefined || selectionStart !== value.length) return false;
    const next = (this.recalled ?? -1) + step;
    if (next >= this.history.length) return false;
    if (this.recalled === undefined) this.draft = this.snapshot(false);
    this.recalled = next < 0 ? undefined : next;
    this.awaiting.clear(); // the message being left behind is no longer waiting for anything
    const sent = this.history[next];
    this.show(next < 0 || sent === undefined ? this.draft : { text: sent.text, images: this.recallImages(sent.images) });
    const caret = step === 1 ? 0 : field.value.length; // where the same key goes on
    field.setSelectionRange(caret, caret);
    this.recalled = next < 0 ? undefined : next; // `place` counts as an edit; this is still a recall
    return true;
  }
}
