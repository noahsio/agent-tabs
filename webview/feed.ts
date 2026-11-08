import MarkdownIt from "markdown-it";
import type { Answer, Block, ImageRef, SessionActivity } from "../src/chat/model";
import type { TodoPhase } from "../src/chat/todo";
import { button, copyButton, el, type Post } from "./dom";
import { isNone, splitHandoff, type Handoff } from "./handoff";
import { icon } from "./icons";
import { isTodoStep, todoMark, todoPlan, todoStates } from "./todo";

type ToolBlock = Extract<Block, { kind: "tool" }>;
type AssistantBlock = Extract<Block, { kind: "assistant" }>;
type UserBlock = Extract<Block, { kind: "user" }>;

/** An image as the lightbox gets it: `dataUrl` is absent until (or unless) the host sent the bytes. */
export type FeedImage = { id: string; dataUrl?: string };
/** `waiting`: a question or approval waits for the person; its line («Ждёт вашего решения») replaces the running verb. */
export type FeedActivity = { activity?: SessionActivity; tool?: string; waiting?: string };
export type FeedOptions = {
  /** Opens the lightbox (Task 5); no-op until then. */
  onOpenImage?: (images: FeedImage[], index: number) => void;
  /** Nodes placed after the blocks and before the indicator (dialogs, the empty-state hint). */
  tail?: Node[];
  /** The ↺ button of a sent message: opens its fork / rewind menu at the button. */
  onMessageActions?: (blockId: string, anchor: HTMLElement) => void;
  /** «Повторить» / «Убрать» on a message that was not sent. */
  onRetry?: (blockId: string) => void;
  onDiscard?: (blockId: string) => void;
};

const MESSAGE_ACTIONS = "Ответвить или откатить";
const DELIVERY_LABEL = { sending: "отправляется…", queued: "в очереди — ждёт агента", failed: "Не отправлено" } as const;
const HANDED_OVER = "уже передано агенту";
/** How long «уже передано агенту» stays on a message OmO gave the agent before «Отозвать» / «Изменить» reached it. */
const HANDED_OVER_MS = 2_500;

const markdown = new MarkdownIt({ html: false, linkify: true });

/** Markdown to HTML with the feed's safe config: html:false — raw HTML in the text stays text. */
export function renderMarkdown(text: string): string {
  return markdown.render(text);
}

/** Inline markdown (no wrapping <p>) with the same safe config. */
function renderInline(text: string): string {
  return markdown.renderInline(text);
}

/** The hand-off rows: label, then value; the request's outcome is its muted second line. */
function handoffCard(handoff: Handoff): HTMLElement | undefined {
  const rows: HTMLElement[] = [];
  const row = (label: string, value: string | undefined, block: boolean, wanted?: string): void => {
    if (isNone(value) || value === undefined) return;
    const body = el("div", { class: "handoff-value" });
    body.innerHTML = block ? renderMarkdown(value) : renderInline(value);
    if (wanted !== undefined && !isNone(wanted)) {
      const note = el("div", { class: "handoff-wanted" });
      note.innerHTML = `нужно: ${renderInline(wanted)}`;
      body.append(note);
    }
    rows.push(el("div", { class: "handoff-row" }, el("div", { class: "handoff-label" }, label), body));
  };
  row("Запрос", handoff.ask, false, handoff.wanted);
  row("Для тебя", handoff.answer, true);
  row("Сейчас", handoff.now, false);
  row("Дальше", handoff.next, false);
  return rows.length === 0 ? undefined : el("div", { class: "handoff" }, ...rows);
}

/** OmO's tool for asking the person: its call shows as the answer card (see `answerCard`), never as a step. */
const ASK_TOOL = "ask_user_question";
const ANSWER_TITLE = "Вопрос агента";
const ANSWERS_TITLE = "Вопросы агента";
const ANSWER_MARK = "Ответ";
const NOT_ANSWERED = "Не ответили";
const QUESTION_LOST = "Вопрос не сохранился";

/**
 * An answered question, as history: the question as it was asked, every option that was on screen with its
 * description, the one they chose marked, and their own words when no option says it. Quiet — it is not a prompt
 * any more — and in the shape of the panel they answered in (see the dialogs mockup).
 */
function answerCard(answer: Answer): HTMLElement {
  const set = answer.questions.length > 1;
  const only = answer.questions[0];
  const head = el("div", { class: "answer-head" }, el("span", { class: "answer-title" }, set ? ANSWERS_TITLE : ANSWER_TITLE));
  if (!set && only?.header !== undefined) head.append(el("span", { class: "tool" }, only.header));
  head.append(el("span", { class: "answer-mark" }, ANSWER_MARK));
  const card = el("div", { class: "answer" }, head);
  for (const question of answer.questions) {
    const body = el("div", { class: question.skipped === true ? "answer-q skipped" : "answer-q" });
    if (set && question.header !== undefined) body.append(el("div", { class: "answer-name" }, question.header));
    if (question.text !== undefined) body.append(el("p", { class: "question-text" }, question.text));
    const options = question.options ?? [];
    if (options.length > 0) {
      const list = el("ol", { class: "opts" });
      for (const option of options) {
        const label = el("span", { class: "lbl" }, option.label);
        if (option.description !== undefined) label.append(el("span", { class: "desc" }, option.description));
        const box = el("span", { class: option.chosen ? "box on" : "box", "aria-hidden": "true" });
        if (option.chosen) box.append(icon("check"));
        list.append(el("li", { class: option.chosen ? "opt chosen" : "opt" }, box, label));
      }
      body.append(list);
    }
    if (question.words !== undefined) body.append(el("p", { class: "answer-words" }, question.words));
    if (question.skipped === true) body.append(el("p", { class: "answer-note" }, NOT_ANSWERED));
    else if (question.text === undefined && options.length === 0) body.append(el("p", { class: "answer-note" }, QUESTION_LOST));
    card.append(body);
  }
  return card;
}

/** A sent message taller than this many lines is collapsed (to the `.user-bubble.collapsed` height, a few lines). */
const LONG_MESSAGE_LINES = 6;
/** An answer card carries structured options worth keeping in view, so it only folds when genuinely huge. */
const ANSWER_MESSAGE_LINES = 12;
const TO_BOTTOM_LABEL = "К последнему сообщению";
const GOTO_PLACE_LABEL = "К сообщению на своём месте";
/** Where the message lands below the top line when the person scrolls to its real place: clear of the stick line, in flow. */
const GOTO_PLACE_MARGIN = 24;
const OPEN_MESSAGE = "Показать полностью";
const CLOSE_MESSAGE = "Свернуть";
/** 13px × 1.55, for when the computed line height is not a number. */
const FALLBACK_LINE_PX = 20;
const UNNAMED_IMAGE = "image.png";
/** The composer's mark for a picture standing in the text; see `imageLabel` in composer.ts. */
const LABEL = /\[картинка (\d+)\]/g;
const STICK_TO_BOTTOM_PX = 48;
const MINUTE_MS = 60_000;
const TASK_TOOL = "task";
const READ_TOOL = "read";
/** File-changing tools: the verb their header shows over a diff. */
const FILE_VERBS: Record<string, string> = { write: "Write", edit: "Edit", apply_patch: "Patch" };
/** A step's box shows at most this much of a text; the rest is counted, not rendered. */
const BOX_LINES = 200;
const BOX_CHARS = 20_000;
/** Lines a collapsed box row shows (CSS clamps to the same `--clamp`); a diff gets a few more. */
const CLAMP_LINES = 3;
const DIFF_CLAMP_LINES = 5;
const CAPPED_NOTE = "Вывод обрезан: показаны первые 20 000 символов.";
const NOTICE_CLASS: Record<Extract<Block, { kind: "notice" }>["level"], string> = { info: "muted", warn: "warn", error: "error" };
/** What folds away someone else's words under a notice (a provider's refusal text). */
const NOTICE_DETAILS_LABEL = "Подробнее";

/** The first BOX_LINES lines (at most BOX_CHARS characters) of a text, and how many lines are left out. */
function clip(text: string): { text: string; more: number } {
  const lines = text.replace(/\n+$/, "").split("\n");
  let shown = lines.slice(0, BOX_LINES).join("\n");
  if (shown.length > BOX_CHARS) shown = shown.slice(0, BOX_CHARS);
  return { text: shown, more: lines.length - shown.split("\n").length };
}

/** The Russian form for a count: 1 строка, 2 строки, 5 строк. */
function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return one;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

function lineWord(count: number): string {
  return plural(count, "строка", "строки", "строк");
}

/** «Добавлено 5 строк, удалено 2»: each verb agrees with its count; a zero side is left out. */
export function diffSummary(added: number, removed: number): string {
  const verb = (stem: string, count: number): string => stem + plural(count, "а", "ы", "о");
  const parts: string[] = [];
  if (added > 0) parts.push(`${verb("добавлен", added)} ${added} ${lineWord(added)}`);
  if (removed > 0) parts.push(`${verb("удален", removed)} ${removed}${added > 0 ? "" : ` ${lineWord(removed)}`}`);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== "").pop() ?? path;
}

/** A diff line's kind by its first character: added, removed, context, or a hunk / file header. */
function diffLine(line: string): HTMLElement {
  const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith(" ") ? "ctx" : "meta";
  return el("span", { class: `dl ${kind}` }, line);
}

export function clock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} ч` : `${Math.floor(minutes / 60)} ч ${rest} мин`;
}

/** The live label of a thinking step in progress: ticks the elapsed seconds, consistent with the finished «Размышлял Xс». */
export function thinkingLabel(startedAt: number, now: number = Date.now()): string {
  return `Размышляю ${formatDuration(Math.max(0, now - startedAt))}…`;
}

/** Plain lower-case tool names («bash») show like Claude Code («Bash»); anything else stays as sent. */
export function toolLabel(name: string): string {
  return /^[a-z]+$/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** An assistant block that has produced nothing yet stays out of the timeline. */
function isPending(block: Block): boolean {
  return block.kind === "assistant" && block.text === "" && block.thinking === "";
}

/** An answered question, wherever OmO recorded it: on the call the agent waited on, or on the answer's user message. */
function isAnswered(block: Block): boolean {
  return (block.kind === "tool" || block.kind === "user") && block.answer !== undefined;
}

/** A message not in the conversation yet (sending, queued, not sent): it stays under everything the agent did meanwhile. */
function isWaiting(block: Block): boolean {
  return block.kind === "user" && block.delivery !== undefined;
}

/**
 * A message the person sent and the agent already has: the one that heads its turn. Its bubble is `position: sticky`
 * and the turn it leads bounds it, so the next sent message pushes it up and out (see `renderBlocks`'s sections).
 */
function isSent(block: Block): boolean {
  return block.kind === "user" && block.delivery === undefined && block.answer === undefined && block.text !== "";
}

function indicatorVerb(activity: FeedActivity | undefined): string {
  switch (activity?.activity) {
    case "thinking":
      return "Думаю…";
    case "tool":
      if (activity.tool?.toLowerCase() === TASK_TOOL) return "Выполняю задачу…";
      return activity.tool !== undefined && activity.tool !== "" ? `Выполняю ${toolLabel(activity.tool)}…` : "Выполняю…";
    case "waiting_human":
      return "Жду ответа…";
    default:
      return "Работаю…";
  }
}

/** A shown `HH:MM` row for each block at least a minute after the previous shown one. */
function stamps(blocks: Block[]): Map<string, string> {
  const shown = new Map<string, string>();
  let last: number | undefined;
  for (const block of blocks) {
    if (block.kind === "notice" || block.timestamp === undefined || isPending(block)) continue;
    if (last !== undefined && block.timestamp - last < MINUTE_MS) continue;
    last = block.timestamp;
    shown.set(block.id, clock(block.timestamp));
  }
  return shown;
}

/** Image data URLs the webview keeps: least recently used go first past `maxCount` images or `maxChars` characters. */
export class DataUrlCache {
  private readonly items = new Map<string, string>();
  private chars = 0;

  constructor(
    private readonly maxCount: number = 60,
    private readonly maxChars: number = 150_000_000,
  ) {}

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): string | undefined {
    const dataUrl = this.items.get(id);
    if (dataUrl === undefined) return undefined;
    this.items.delete(id); // re-insert: the most recently used goes last
    this.items.set(id, dataUrl);
    return dataUrl;
  }

  /** Stores one; returns the ids evicted to make room (never the one just stored). */
  set(id: string, dataUrl: string): string[] {
    this.delete(id);
    this.items.set(id, dataUrl);
    this.chars += dataUrl.length;
    const evicted: string[] = [];
    for (const [oldId, old] of this.items) {
      if ((this.items.size <= this.maxCount && this.chars <= this.maxChars) || oldId === id) break;
      this.delete(oldId);
      evicted.push(oldId);
    }
    return evicted;
  }

  delete(id: string): void {
    const dataUrl = this.items.get(id);
    if (dataUrl === undefined) return;
    this.items.delete(id);
    this.chars -= dataUrl.length;
  }
}

/**
 * True when two versions of a block show the same thing: field by field, without serializing (a tool output can be
 * 20 000 characters). Image refs are small and compared whole.
 */
export function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    const x = left[key];
    const y = right[key];
    if (x === y) continue;
    if (key !== "images" || JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

/**
 * True while the person holds a selection that runs through `element`. Replacing those nodes would drop the selection,
 * and the clipboard — the editor's menu, a keystroke — reads it well after the gesture that made it.
 */
function selectionInside(element: Node): boolean {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return selection.getRangeAt(0).intersectsNode(element);
}

/** The transcript as a Claude-Code-style timeline. Blocks are keyed by id; only changed ones are rebuilt. */
export class Feed {
  private readonly list: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly verb: HTMLElement;
  /** The round control that floats over the composer while the feed is scrolled up: a tap returns to the latest message. */
  private readonly toBottom: HTMLButtonElement;
  private readonly toBottomSlot: HTMLElement;
  private scrollFrame: number | undefined;
  /** Ticks the elapsed seconds on the one in-progress thinking step; cleared the moment that step is gone (see syncThinkingTimer). */
  private thinkingTimer: ReturnType<typeof setInterval> | undefined;
  /** One turn's wrapper, keyed by the id of the sent message that leads it (`lead` for anything before the first). */
  private readonly sections = new Map<string, HTMLElement>();
  /** The feed's top inset in px (`--feed-top`): the line a sent bubble rests on when it is stuck. */
  private readonly feedTopPx: number;
  /** Per block: what it was rendered from, and the extras (the time stamp) that also shape it. */
  private readonly rendered = new Map<string, { block: Block; extras: string; element: HTMLElement }>();
  /** Tool steps whose IN/OUT box the person expanded. */
  private readonly openBoxes = new Set<string>();
  /** Long sent messages the person expanded (the rest of the long ones stay collapsed). */
  private readonly openMessages = new Set<string>();
  /** Sent-message elements already measured; a rebuilt one is measured again. */
  private readonly measured = new WeakSet<HTMLElement>();
  private resizeFrame: number | undefined;
  /** Image bytes by ref id; "" = the host has none. Bounded: an evicted image is asked for again when needed. */
  private readonly images = new DataUrlCache();
  private readonly requested = new Set<string>();
  private readonly tiles = new Map<string, HTMLElement>();
  /** Queued messages being edited in place, with the text typed so far. */
  private readonly editing = new Map<string, string>();
  /** Queued messages whose «Отозвать» / «Изменить» the host has not answered yet. */
  private readonly busy = new Set<string>();
  /** Messages that were already with the agent when «Отозвать» / «Изменить» arrived (shown for a moment). */
  private readonly handedOver = new Set<string>();
  private blocks: Block[] = [];
  /** Guard rows (decider steps, answered cards), each after the block that was last when it happened. */
  private readonly guardRows = new Map<string, { after: string | undefined; row: HTMLElement }>();
  /** A block left as it is because the person is selecting in it: it is built again when the selection lets go. */
  private held = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly post: Post,
    private readonly options: FeedOptions = {},
  ) {
    this.list = el("div", { class: "timeline" });
    this.verb = el("span", { class: "verb" });
    const star = el("span", { class: "star", "aria-hidden": "true" }, icon("spark"));
    this.indicator = el("div", { class: "indicator", "data-role": "indicator", role: "status" }, star, this.verb);
    this.indicator.hidden = true;
    this.toBottom = button(icon("scrollDown"), { class: "icon-btn to-bottom", "data-role": "to-bottom", title: TO_BOTTOM_LABEL, "aria-label": TO_BOTTOM_LABEL }, () =>
      this.scrollToBottom(),
    );
    this.toBottomSlot = el("div", { class: "to-bottom-slot" }, this.toBottom);
    this.toBottomSlot.hidden = true;
    root.classList.add("feed");
    this.feedTopPx = parseFloat(getComputedStyle(root).getPropertyValue("--feed-top")) || 8;
    root.replaceChildren(this.list, ...(options.tail ?? []), this.indicator, this.toBottomSlot);
    root.addEventListener("click", (event) => this.onClick(event));
    root.addEventListener("contextmenu", (event) => {
      const link = (event.target as Element | null)?.closest("a, [data-open-file]");
      const selection = window.getSelection();
      if (link === null || link === undefined || selection === null || !selection.isCollapsed) return;
      const range = document.createRange();
      range.selectNodeContents(link);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    // Sticky bubbles ride the scroll natively; the handler flags which sent bubble is pinned and shows the to-bottom control.
    root.addEventListener("scroll", () => {
      if (this.scrollFrame !== undefined) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = undefined;
        this.updateToBottom();
        this.updateStuck();
      });
    });
    root.addEventListener("keydown", (event) => {
      const box = (event.target as Element | null)?.closest<HTMLElement>('[data-role="tool-io"]');
      if (box === null || box === undefined || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      this.toggleBox(box);
    });
    // The selection let go (or moved): a block that waited for it catches up with what it should show.
    document.addEventListener("selectionchange", () => {
      if (this.held) this.renderBlocks();
    });
    window.addEventListener("resize", () => {
      if (this.resizeFrame !== undefined) return; // one measure per frame, however many resize events
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = undefined;
        this.fitMessages(true);
      });
    });
  }

  /** True while the view sits at (or near) the bottom; measure before changing the DOM. */
  stuck(): boolean {
    return this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < STICK_TO_BOTTOM_PX;
  }

  update(blocks: Block[], running: boolean, activity?: FeedActivity, stick: boolean = this.stuck()): void {
    this.blocks = blocks;
    this.renderBlocks();
    const waiting = activity?.waiting;
    // The in-progress thinking step already says «Размышляю…»; the bottom «Думаю…» would only duplicate it, so drop it then.
    const thinkingStepShown = waiting === undefined && activity?.activity === "thinking" && this.thinkingInProgress();
    this.indicator.hidden = (!running && waiting === undefined) || thinkingStepShown;
    this.indicator.classList.toggle("waiting", waiting !== undefined);
    this.verb.textContent = waiting ?? indicatorVerb(activity);
    if (stick) this.root.scrollTop = this.root.scrollHeight;
    this.updateToBottom();
    this.updateStuck();
  }

  /** The block the timeline ends with now: where something that happens now belongs. */
  anchor(): string | undefined {
    return this.blocks.filter((block) => !isPending(block) && !isWaiting(block)).at(-1)?.id;
  }

  /** Puts a guard row (or moves an answered card) into the timeline after `after`; the same id is placed once. */
  addGuardRow(id: string, element: HTMLElement, after: string | undefined = this.anchor()): void {
    if (this.guardRows.has(id)) return;
    const stick = this.stuck();
    this.guardRows.set(id, { after, row: el("div", { class: "entry steps guard-entry" }, element) });
    this.renderBlocks();
    if (stick) this.root.scrollTop = this.root.scrollHeight;
  }

  /** Takes a guard row out again: an offer this chat never took up leaves no trace in the timeline. */
  removeGuardRow(id: string): void {
    if (this.guardRows.delete(id)) this.renderBlocks();
  }

  /** Room under the last message as tall as the composer floating over the feed; a feed at the bottom stays there. */
  setBottomInset(px: number): void {
    const stick = this.stuck(); // before the padding changes
    this.root.style.paddingBottom = `${px}px`;
    if (stick) this.root.scrollTop = this.root.scrollHeight;
    this.updateToBottom();
    this.updateStuck();
  }

  /** The host's answer to «Отозвать» / «Изменить»: the buttons work again; one that came too late says so for a moment. */
  queueResult(blockId: string, outcome: "removed" | "edited" | "delivered" | "failed"): void {
    this.busy.delete(blockId);
    if (outcome === "delivered") {
      this.editing.delete(blockId);
      this.handedOver.add(blockId);
      setTimeout(() => {
        this.handedOver.delete(blockId);
        this.renderBlocks();
      }, HANDED_OVER_MS);
    }
    this.renderBlocks();
  }

  /** The host's answer to `getImage`. */
  image(id: string, dataUrl: string): void {
    for (const evicted of this.images.set(id, dataUrl)) this.requested.delete(evicted);
    const tile = this.tiles.get(id);
    if (tile !== undefined) this.fillTile(tile, id);
  }

  // ---------- blocks ----------

  /** Messages not in the conversation yet (sending, queued, not sent) stay under everything the agent did meanwhile. */
  private renderBlocks(): void {
    this.held = false;
    const blocks = [...this.blocks.filter((block) => !isWaiting(block)), ...this.blocks.filter(isWaiting)];
    const shown = stamps(blocks);
    const rows = [...this.guardRows.values()];
    const ids = new Set(blocks.map((block) => block.id));
    const plans = todoStates(blocks);
    const after = (anchor: string | undefined): { element: HTMLElement; head: boolean }[] =>
      rows.filter((row) => row.after === anchor).map((row) => ({ element: row.row, head: false }));
    // rows from before the first block lead; rows whose block is gone close the list
    const flat = [
      ...after(undefined),
      ...blocks.flatMap((block) => [{ element: this.blockElement(block, shown.get(block.id), plans.get(block.id)), head: isSent(block) }, ...after(block.id)]),
      ...rows.filter((row) => row.after !== undefined && !ids.has(row.after)).map((row) => ({ element: row.row, head: false })),
    ];
    // Each sent message opens a turn — its own containing block. Its bubble is `position: sticky` inside that turn, so
    // the next turn's bubble pushes it up and out natively: no copy, nothing fading in, the real bubbles carry the top.
    const turns: { key: string; items: HTMLElement[] }[] = [];
    for (const { element, head } of flat) {
      if (head || turns.length === 0) turns.push({ key: head ? (element.dataset["block"] as string) : "lead", items: [] });
      (turns[turns.length - 1] as { items: HTMLElement[] }).items.push(element);
    }
    const sections = turns.map((turn) => {
      let section = this.sections.get(turn.key);
      if (section === undefined) {
        section = el("div", { class: "turn" });
        this.sections.set(turn.key, section);
      }
      if (turn.key === "lead") {
        this.place(section, turn.items);
        return section;
      }
      // A zero-height marker at the turn's natural top: `scrollToPlace` reads it to find where the message really sits.
      let sentinel = section.querySelector<HTMLElement>(":scope > .stick-sentinel");
      if (sentinel === null) sentinel = el("div", { class: "stick-sentinel", "aria-hidden": "true" });
      this.place(section, [sentinel, ...turn.items]);
      return section;
    });
    this.place(this.list, sections);
    const live = new Set(turns.map((turn) => turn.key));
    for (const key of [...this.sections.keys()]) if (!live.has(key)) this.sections.delete(key);
    this.fitMessages(false); // in the DOM now: they can be measured
    for (const [id, { block }] of this.rendered) {
      if (ids.has(id)) continue;
      this.rendered.delete(id);
      this.openBoxes.delete(id);
      this.openMessages.delete(id);
      this.editing.delete(id);
      this.busy.delete(id);
      if (block.kind !== "user") continue;
      for (const image of block.images ?? []) {
        this.images.delete(image.id);
        this.requested.delete(image.id);
        this.tiles.delete(image.id);
      }
    }
    this.updateToBottom();
    this.updateStuck();
    this.syncThinkingTimer();
  }

  /** True while the current turn's thinking step is open and carrying reasoning text — the one «Размышляю…» line on screen. */
  private thinkingInProgress(): boolean {
    return this.blocks.some((block) => block.kind === "assistant" && block.thinkingStartedAt !== undefined && block.thinking !== "");
  }

  /** Runs one interval iff an in-progress thinking step is on screen, starting it once and tearing it down when that step is gone. */
  private syncThinkingTimer(): void {
    const live = this.list.querySelector('[data-role="thinking-live"]') !== null;
    if (live && this.thinkingTimer === undefined) this.thinkingTimer = setInterval(() => this.tickThinking(), 1_000);
    if (!live) this.stopThinkingTimer();
  }

  /** Re-reads the live summary (re-renders swap the element) and writes its ticked label; stops the interval once it is gone. */
  private tickThinking(): void {
    const summary = this.list.querySelector<HTMLElement>('[data-role="thinking-live"]');
    if (summary === null) {
      this.stopThinkingTimer();
      return;
    }
    summary.textContent = thinkingLabel(Number(summary.dataset["started"]));
  }

  private stopThinkingTimer(): void {
    if (this.thinkingTimer === undefined) return;
    clearInterval(this.thinkingTimer);
    this.thinkingTimer = undefined;
  }

  /** Releases what outlives a render: the seconds interval. Called when the view is torn down. */
  dispose(): void {
    this.stopThinkingTimer();
  }

  /** Reconciles `parent`'s children to `children` in order, reusing the cached elements and dropping the rest. */
  private place(parent: HTMLElement, children: HTMLElement[]): void {
    children.forEach((child, index) => {
      const current = parent.children[index] ?? null;
      if (current !== child) parent.insertBefore(child, current);
    });
    while (parent.children.length > children.length) parent.lastElementChild?.remove();
  }

  // ---------- the to-bottom control ----------

  /** Shown only while the feed is scrolled up, so there is a latest message to return to. */
  private updateToBottom(): void {
    this.toBottomSlot.hidden = this.stuck();
  }

  /**
   * Flags the sent bubble that is pinned to the feed's top as `is-stuck`: its rendered top has reached the rest line,
   * so it is a displaced copy, not in its place. In its natural spot it reads normally and the fork menu returns.
   */
  private updateStuck(): void {
    const view = this.root.getBoundingClientRect();
    if (view.height === 0) return; // no layout (a hidden tab, or jsdom): nothing is on screen to pin
    // The sentinel marks the head's natural top; at rest it sits on the stick line. Only once it has scrolled strictly
    // above that line is the head displaced (pinned), not merely sitting there in flow — so the first message at the
    // very top (its natural top coincides with the line) never reads as stuck.
    const line = view.top + this.feedTopPx - 1;
    for (const section of this.sections.values()) {
      const head = section.querySelector<HTMLElement>(":scope > .entry.user.head");
      const sentinel = section.querySelector<HTMLElement>(":scope > .stick-sentinel");
      if (head !== null && sentinel !== null) head.classList.toggle("is-stuck", sentinel.getBoundingClientRect().top < line);
    }
  }

  /** Back to the latest message; a smooth ride unless the person asked for less motion. */
  private scrollToBottom(): void {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    this.root.scrollTo({ top: this.root.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }

  /**
   * The cached element when the block is unchanged — the same object (a delta keeps it) or equal field by field (a full
   * state) — otherwise a fresh one that keeps disclosure state.
   */
  private blockElement(block: Block, stamp: string | undefined, plan?: TodoPhase[]): HTMLElement {
    const marks = [this.editing.has(block.id) ? "edit" : "", this.busy.has(block.id) ? "busy" : "", this.handedOver.has(block.id) ? "handed" : ""];
    const shownPlan = isTodoStep(block) && (block.todo.op === "init" || block.todo.op === "view") ? (plan ?? []) : undefined;
    const extras = [stamp ?? "", ...marks, shownPlan !== undefined ? JSON.stringify(shownPlan) : ""].join("|");
    const previous = this.rendered.get(block.id);
    if (previous !== undefined && previous.extras === extras && sameBlock(previous.block, block)) {
      previous.block = block;
      return previous.element;
    }
    if (previous !== undefined && selectionInside(previous.element)) {
      this.held = true; // left as it is, and still unrendered: the next render (or the selection letting go) builds it
      return previous.element;
    }
    // an answered question is the person's own turn, wherever the answer was recorded: the user entry's row and menu
    const kind = block.kind === "user" || isAnswered(block) ? "user" : isPending(block) ? "pending" : "steps";
    // A sent message heads its turn and sticks to the feed's top (CSS `.entry.user.head`); the rest scroll normally.
    const element = el("div", { "data-block": block.id, class: `entry ${kind}${isSent(block) ? " head" : ""}` });
    if (stamp !== undefined) element.append(el("div", { class: "ts" }, stamp));
    element.append(...this.renderBlock(block, shownPlan));
    if (previous !== undefined) {
      const wasOpen = [...previous.element.querySelectorAll("details")].map((details) => details.open);
      element.querySelectorAll("details").forEach((details, index) => {
        if (wasOpen[index] !== undefined) details.open = wasOpen[index] as boolean;
      });
    }
    this.rendered.set(block.id, { block, extras, element });
    return element;
  }

  /** `plan`: a todo step that shows the whole list — the list as it stood after it. */
  private renderBlock(block: Block, plan?: TodoPhase[]): HTMLElement[] {
    switch (block.kind) {
      case "user": {
        const bubble = this.renderUser(block);
        // both in the bubble's top-right corner (CSS): the fork menu while the bubble is in place, the "go to its place"
        // control instead while it is stuck to the top. An answer card carries its own fork menu, aimed at the question.
        if (block.delivery === undefined && block.answer === undefined) bubble.append(this.messageActions(block.id), this.gotoPlace(block.id));
        return [bubble];
      }
      case "assistant":
        return this.renderAssistant(block);
      case "tool":
        if (block.answer !== undefined) return [this.answerBubble(block.answer)];
        if (block.name === ASK_TOOL) return []; // a question still open: the panel asks it, the feed waits
        if (isTodoStep(block)) return [plan !== undefined ? todoPlan(plan) : todoMark(block.todo)]; // no box, no OmO's echo
        return [this.renderTool(block)];
      case "notice": {
        const row = el("div", { class: `step notice ${NOTICE_CLASS[block.level]}` }, block.text);
        // Someone else's words (a provider's refusal) stay folded away: the line itself says what to do about it.
        if (block.details !== undefined) {
          row.append(el("details", { class: "notice-details" }, el("summary", {}, NOTICE_DETAILS_LABEL), el("pre", {}, block.details)));
        }
        return [row];
      }
    }
  }

  /**
   * The card in the bubble's place, collapsed like a long message (same `.user-bubble` / `.user-text` shell, so
   * `fitMessages` measures it) and with the ↺ menu of the message whose turn asked the question.
   */
  private answerBubble(answer: Answer): HTMLElement {
    const bubble = el("div", { class: "user-bubble answered" }, el("div", { class: "user-text" }, answerCard(answer)));
    if (answer.forkFrom !== undefined) bubble.append(this.messageActions(answer.forkFrom));
    return bubble;
  }

  private renderUser(block: UserBlock): HTMLElement {
    if (block.answer !== undefined) {
      const card = this.answerBubble(block.answer);
      if (block.delivery === undefined) return card;
      card.classList.add("queued");
      card.append(el("span", { class: "queued-label" }, DELIVERY_LABEL[block.delivery.state]));
      return card;
    }
    const bubble = el("div", { class: "user-bubble" });
    const images = block.images ?? [];
    const body = this.userText(block.text, images);
    // Pictures the text has no label for (attached with no place in it) keep the row above the message.
    const loose = images.filter((_, index) => !body.labelled.has(index));
    if (loose.length > 0) bubble.append(el("div", { class: "uimgs" }, ...loose.map((image) => this.tile(image, false))));
    const delivery = block.delivery;
    const editable = delivery?.state === "queued" && delivery.queuedId !== undefined && !this.handedOver.has(block.id);
    bubble.append(editable && this.editing.has(block.id) ? this.queuedEditor(block.id) : body.element);
    if (this.handedOver.has(block.id)) {
      bubble.append(el("span", { class: "queued-label" }, HANDED_OVER));
      return bubble;
    }
    if (delivery === undefined) return bubble;
    bubble.classList.add(delivery.state === "failed" ? "failed" : "queued");
    if (delivery.state === "sending") bubble.classList.add("sending");
    bubble.append(el("span", { class: "queued-label" }, DELIVERY_LABEL[delivery.state]));
    if (delivery.state === "failed") {
      bubble.append(
        el(
          "div",
          { class: "queued-actions" },
          button("Повторить", { class: "link", "data-role": "retry" }, () => this.options.onRetry?.(block.id)),
          button("Убрать", { class: "link", "data-role": "discard" }, () => this.options.onDiscard?.(block.id)),
        ),
      );
    } else if (editable && !this.editing.has(block.id)) {
      const busy = this.busy.has(block.id);
      const edit = button("Изменить", { class: "link", "data-role": "edit-queued" }, () => this.startEdit(block.id, block.text));
      const dequeue = button("Отозвать", { class: "link", "data-role": "dequeue" }, () => {
        this.busy.add(block.id);
        this.post({ type: "dequeue", blockId: block.id });
        this.renderBlocks();
      });
      edit.disabled = busy;
      dequeue.disabled = busy;
      bubble.append(el("div", { class: "queued-actions" }, edit, dequeue));
    }
    return bubble;
  }

  /**
   * The message as it was written: every «[картинка N]» the composer put in for a pill becomes that pill again, so the
   * picture stands where the person put it. A label with no picture behind it (one the person typed) stays text.
   */
  private userText(text: string, images: ImageRef[]): { element: HTMLElement; labelled: Set<number> } {
    const element = el("div", { class: "user-text" });
    const labelled = new Set<number>();
    let at = 0;
    LABEL.lastIndex = 0;
    for (let match = LABEL.exec(text); match !== null; match = LABEL.exec(text)) {
      const index = Number(match[1]) - 1;
      const image = images[index];
      if (image === undefined || labelled.has(index)) continue;
      element.append(text.slice(at, match.index), this.tile(image, true));
      labelled.add(index);
      at = match.index + match[0].length;
    }
    element.append(text.slice(at));
    return { element, labelled };
  }

  private startEdit(blockId: string, text: string): void {
    this.editing.set(blockId, text);
    this.renderBlocks();
    const field = this.rendered.get(blockId)?.element.querySelector<HTMLTextAreaElement>('[data-role="queued-edit"]');
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }

  /** The queued message's text in place: Enter saves (not an empty one), Shift+Enter is a new line, Esc cancels. */
  private queuedEditor(blockId: string): HTMLElement {
    const field = el("textarea", { class: "queued-edit", "data-role": "queued-edit", rows: "3", "aria-label": "Изменить сообщение в очереди" });
    field.value = this.editing.get(blockId) ?? "";
    field.addEventListener("input", () => this.editing.set(blockId, field.value));
    field.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation(); // the tab's own Esc (popovers) is not for this
        this.editing.delete(blockId);
        this.renderBlocks();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (field.value.trim() === "") return;
      this.editing.delete(blockId);
      this.busy.add(blockId);
      this.post({ type: "editQueued", blockId, text: field.value });
      this.renderBlocks();
    });
    return el("div", { class: "queued-editor" }, field, el("div", { class: "queued-hint" }, "Enter — сохранить, Esc — отмена"));
  }

  /** Shown on hover and focus (CSS); a message not in the conversation yet has no menu: it is not in the journal. */
  private messageActions(blockId: string): HTMLButtonElement {
    const actions: HTMLButtonElement = button(
      icon("rewind"),
      { class: "icon-btn msg-actions", "data-role": "message-actions", title: MESSAGE_ACTIONS, "aria-label": MESSAGE_ACTIONS },
      () => this.options.onMessageActions?.(blockId, actions),
    );
    return actions;
  }

  /** The stuck bubble's corner control (CSS shows it only while `is-stuck`): it takes the view to the message's real place. */
  private gotoPlace(blockId: string): HTMLButtonElement {
    return button(icon("goTo"), { class: "icon-btn goto-place", "data-role": "goto-place", title: GOTO_PLACE_LABEL, "aria-label": GOTO_PLACE_LABEL }, () =>
      this.scrollToPlace(blockId),
    );
  }

  /** Scrolls the feed up to where the stuck message actually sits, landing it clear of the stick line so it reads in flow. */
  private scrollToPlace(blockId: string): void {
    const head = this.rendered.get(blockId)?.element;
    const sentinel = head?.previousElementSibling as HTMLElement | null;
    if (head === undefined || sentinel === null || !sentinel.classList.contains("stick-sentinel")) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    const target = this.root.scrollTop + (sentinel.getBoundingClientRect().top - this.root.getBoundingClientRect().top) - GOTO_PLACE_MARGIN;
    this.root.scrollTo({ top: Math.max(0, target), behavior: reduce ? "auto" : "smooth" });
  }

  /**
   * Measures sent messages by their real rendered height (only new ones, or all after a resize): a long one is collapsed
   * with a fade unless the person expanded it, and gets the toggle in its bottom-right corner.
   */
  private fitMessages(all: boolean): void {
    // Every read first, then every write: a class change between two reads would force a layout per bubble.
    const fits: { id: string; bubble: HTMLElement; long: boolean }[] = [];
    for (const [id, { block, element }] of this.rendered) {
      if ((block.kind !== "user" && !isAnswered(block)) || (!all && this.measured.has(element))) continue;
      const bubble = element.querySelector<HTMLElement>(".user-bubble");
      const text = bubble?.querySelector<HTMLElement>(".user-text");
      if (bubble === null || bubble === undefined || text === null || text === undefined) continue;
      const height = text.scrollHeight; // the whole text, collapsed or not
      if (height === 0) continue; // a hidden feed has no layout: measured on a later update
      this.measured.add(element);
      const line = parseFloat(getComputedStyle(text).lineHeight) || FALLBACK_LINE_PX;
      const trigger = isAnswered(block) ? ANSWER_MESSAGE_LINES : LONG_MESSAGE_LINES;
      fits.push({ id, bubble, long: height > trigger * line });
    }
    for (const { id, bubble, long } of fits) {
      bubble.classList.toggle("long", long);
      this.showMessage(id, bubble);
    }
  }

  private showMessage(id: string, bubble: HTMLElement): void {
    const long = bubble.classList.contains("long");
    const open = this.openMessages.has(id);
    bubble.classList.toggle("collapsed", long && !open);
    let toggle = bubble.querySelector<HTMLButtonElement>('[data-role="message-toggle"]');
    if (!long) {
      if (toggle !== null) toggle.hidden = true;
      return;
    }
    if (toggle === null) {
      toggle = button("", { class: "link message-toggle", "data-role": "message-toggle" }, () => {
        if (this.openMessages.has(id)) this.openMessages.delete(id);
        else this.openMessages.add(id);
        this.showMessage(id, bubble);
      });
      bubble.append(toggle);
    }
    toggle.hidden = false;
    toggle.textContent = open ? CLOSE_MESSAGE : OPEN_MESSAGE;
    toggle.setAttribute("aria-expanded", String(open));
  }

  /**
   * A chip like the composer's: preview, name («image.png» when it has none), the size once the picture loads. `inline`
   * is the one standing in the line of the message — the composer's pill, with no room for a size.
   */
  private tile(image: ImageRef, inline: boolean): HTMLElement {
    const label = image.name ?? UNNAMED_IMAGE;
    const tile = el(
      "button",
      { type: "button", class: inline ? "uimg att" : "uimg", "data-image": image.id, title: label, "aria-label": `Открыть: ${label}` },
      el("span", { class: "tn" }),
      el("span", { class: "lbl", "data-role": "image-name" }, label),
      ...(inline ? [] : [el("span", { class: "dim", "data-role": "image-size" })]),
    );
    this.tiles.set(image.id, tile);
    if (this.images.has(image.id)) this.fillTile(tile, image.id);
    else this.request(image.id);
    return tile;
  }

  /** Asks the host for an image's bytes, once while the answer is pending. */
  private request(id: string): void {
    if (this.requested.has(id)) return;
    this.requested.add(id);
    this.post({ type: "getImage", id });
  }

  private fillTile(tile: HTMLElement, id: string): void {
    const dataUrl = this.images.get(id) ?? "";
    const size = tile.querySelector<HTMLElement>(".dim"); // the inline chip has none: the line has no room for it
    tile.classList.toggle("missing", dataUrl === "");
    if (dataUrl === "") {
      (tile.querySelector(".tn") as HTMLElement).replaceChildren();
      if (size !== null) size.textContent = "нет превью";
      return;
    }
    const img = el("img", { src: dataUrl, alt: "" });
    img.addEventListener("load", () => {
      if (size !== null) size.textContent = `${img.naturalWidth}×${img.naturalHeight}`; // the bytes that were sent: their real size
    });
    (tile.querySelector(".tn") as HTMLElement).replaceChildren(img);
  }

  private renderAssistant(block: AssistantBlock): HTMLElement[] {
    const steps: HTMLElement[] = [];
    if (block.thinking !== "") {
      // In progress: a marked summary whose seconds the single thinking interval ticks (see syncThinkingTimer); otherwise static.
      const summary =
        block.thinkingStartedAt !== undefined
          ? el("summary", { "data-role": "thinking-live", "data-started": String(block.thinkingStartedAt) }, thinkingLabel(block.thinkingStartedAt))
          : el("summary", {}, block.thinkingMs !== undefined ? `Размышлял ${formatDuration(block.thinkingMs)}` : "Размышления");
      steps.push(el("div", { class: "step muted" }, el("details", { class: "thinking" }, summary, el("div", { class: "thinking-text" }, block.thinking))));
    }
    if (block.text !== "") {
      const body = el("div", { class: "markdown" });
      // A finished message's hand-off block becomes a summary card; a streaming one stays text so nothing jumps.
      const segments = block.streaming ? undefined : splitHandoff(block.text);
      if (segments === undefined) body.innerHTML = renderMarkdown(block.text);
      else {
        for (const segment of segments) {
          if (segment.kind === "handoff") {
            const card = handoffCard(segment);
            if (card !== undefined) body.append(card);
            continue;
          }
          const holder = document.createElement("div");
          holder.innerHTML = renderMarkdown(segment.text);
          body.append(...holder.childNodes);
        }
      }
      // The editor's own menu cannot copy out of a webview reliably; a code block carries its own control.
      for (const code of body.querySelectorAll("pre")) code.append(copyButton(() => code.querySelector("code")?.textContent ?? code.textContent ?? ""));
      steps.push(el("div", { class: block.streaming ? "step text streaming" : "step text" }, body));
    }
    return steps;
  }

  private renderTool(block: ToolBlock): HTMLElement {
    const verb = FILE_VERBS[block.name];
    const summary = el("summary", {}, this.toolLine(block, verb));
    if (block.name === TASK_TOOL) {
      const result =
        block.state === "error" ? "ошибка" : block.state === "ok" && block.durationMs !== undefined ? `готово за ${formatDuration(block.durationMs)}` : undefined;
      const sub = [block.role, result].filter((part) => part !== undefined && part !== "").join(" · ");
      if (sub !== "") summary.append(el("span", { class: "sub" }, sub));
    }
    if (verb !== undefined) {
      const stat = diffSummary(block.added ?? 0, block.removed ?? 0);
      if (stat !== "") summary.append(el("span", { class: "sub diff-stat" }, stat));
    }
    const details = el("details", { class: "tool-details" }, summary);
    const rows = this.ioRows(block, verb !== undefined);
    if (rows.length > 0) {
      details.classList.add("has-output");
      details.open = true;
      details.append(this.ioBox(block.id, rows, verb !== undefined));
    }
    return el("div", { class: `step tool ${block.state}` }, details);
  }

  /** The header: «Bash <summary>», «Agent: <description>», «Read <file> (строки A–B)», «Edit <file>». */
  private toolLine(block: ToolBlock, verb: string | undefined): HTMLElement {
    const line = el("span", { class: "line" });
    if (block.name === TASK_TOOL) {
      line.append(el("span", { class: "tool-name" }, "Agent:"));
      if (block.description !== undefined) line.append(el("span", { class: "agent-desc" }, block.description));
      if (block.model !== undefined) line.append(el("span", { class: "agent-tag" }, block.model));
      return line;
    }
    line.append(el("span", { class: "tool-name" }, verb ?? toolLabel(block.name)));
    const named = (block.name === READ_TOOL || verb !== undefined) && block.file !== undefined;
    if (named) line.append(this.fileLink(block.file as string, block.fromLine));
    else if (block.summary !== "") line.append(el("span", { class: "mono" }, block.summary));
    if (named && block.name === READ_TOOL && block.fromLine !== undefined) {
      line.append(el("span", { class: "range" }, block.toLine !== undefined ? `(строки ${block.fromLine}–${block.toLine})` : `(со строки ${block.fromLine})`));
    }
    return line;
  }

  /** Opens the file in the editor through the host (see onClick); the header does not toggle. */
  private fileLink(path: string, line: number | undefined): HTMLElement {
    const attributes: Record<string, string> = { href: "#", class: "file-link", "data-open-file": path, title: path };
    if (line !== undefined) attributes["data-line"] = String(line);
    return el("a", attributes, fileName(path));
  }

  /**
   * IN (the call) and, once it finished, OUT (the result). A read has no box and a file edit shows its diff instead of
   * IN; either shows OUT only when it failed.
   */
  private ioRows(block: ToolBlock, edits: boolean): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const quiet = edits || block.name === READ_TOOL;
    if (block.input !== undefined && block.name !== READ_TOOL) rows.push(this.ioRow(edits ? "diff" : "in", block.input, { lang: block.inputLang }));
    if (block.state !== "running" && block.output !== "" && (!quiet || block.state === "error")) {
      rows.push(this.ioRow("out", block.output, { error: block.state === "error", capped: block.truncated }));
    }
    return rows;
  }

  private ioRow(kind: "in" | "out" | "diff", text: string, extra: { lang?: string; error?: boolean; capped?: boolean }): HTMLElement {
    const shown = clip(text);
    const pre = el("pre", { class: "io-text" }, ...(kind === "diff" ? shown.text.split("\n").map(diffLine) : [shown.text]));
    const cell = el("div", { class: "io-cell" }, pre, copyButton(() => text)); // the whole text, not the lines the box shows
    const notes = [shown.more > 0 ? `… ещё ${shown.more} ${lineWord(shown.more)}` : "", extra.capped === true ? CAPPED_NOTE : ""].filter((note) => note !== "");
    if (notes.length > 0) cell.append(el("div", { class: "io-more" }, notes.join(" ")));
    const row = el("div", { class: "io-row", "data-io": kind });
    if (kind !== "diff") {
      const label = el("div", { class: "io-label" }, kind === "in" ? "IN" : "OUT");
      if (extra.lang !== undefined) label.append(el("span", { class: "io-lang" }, extra.lang));
      row.append(label);
    }
    row.append(cell);
    const clamp = kind === "diff" ? DIFF_CLAMP_LINES : CLAMP_LINES;
    row.style.setProperty("--clamp", String(clamp)); // CSSOM, not a style attribute: the webview's CSP allows it
    row.classList.toggle("tall", shown.text.split("\n").length > clamp);
    row.classList.toggle("error", extra.error === true);
    return row;
  }

  /** The bordered box; a click (or Enter / Space) expands and collapses it, and a rebuilt box keeps the choice. */
  private ioBox(blockId: string, rows: HTMLElement[], diff: boolean): HTMLElement {
    const open = this.openBoxes.has(blockId);
    const box = el("div", { class: diff ? "io diff" : "io", "data-role": "tool-io", role: "button", tabindex: "0", "aria-expanded": String(open) }, ...rows);
    box.classList.toggle("open", open);
    return box;
  }

  private toggleBox(box: HTMLElement): void {
    const id = box.closest<HTMLElement>("[data-block]")?.dataset["block"];
    if (id === undefined) return;
    const open = !this.openBoxes.has(id);
    if (open) this.openBoxes.add(id);
    else this.openBoxes.delete(id);
    box.classList.toggle("open", open);
    box.setAttribute("aria-expanded", String(open));
  }

  // ---------- clicks: links and images ----------

  private onClick(event: MouseEvent): void {
    if (event.button !== 0) return; // the secondary button belongs to the editor's menu: its Copy needs the default
    const target = event.target as Element | null;
    const copy = target?.closest('[data-role="copy"]');
    if (copy !== null && copy !== undefined) return; // a copy control acts for itself: it never opens its box
    const link = target?.closest("a");
    if (link !== null && link !== undefined) event.preventDefault(); // a link never navigates the tab itself
    const file = target?.closest<HTMLElement>("[data-open-file]");
    if (file !== null && file !== undefined) {
      if (selectionInside(file)) return; // the click only ended a selection in the link
      const line = Number(file.dataset["line"]);
      this.post({ type: "openFile", path: file.dataset["openFile"] as string, ...(line > 0 ? { line } : {}) });
      return;
    }
    const box = target?.closest<HTMLElement>('[data-role="tool-io"]');
    if (box !== null && box !== undefined) {
      if (!selectionInside(box)) this.toggleBox(box); // selecting text in it is not a click on the box
      return;
    }
    const tile = target?.closest<HTMLElement>(".uimg");
    if (tile !== null && tile !== undefined) {
      this.openImage(tile);
      return;
    }
    if (link === null || link === undefined || selectionInside(link)) return;
    const url = link.getAttribute("href");
    if (url !== null && url !== "") this.post({ type: "openLink", url });
  }

  private openImage(tile: HTMLElement): void {
    const id = tile.closest<HTMLElement>("[data-block]")?.dataset["block"];
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (block?.kind !== "user" || block.images === undefined) return;
    const images = block.images.map((image): FeedImage => {
      const dataUrl = this.images.get(image.id);
      if (dataUrl === undefined) this.request(image.id); // evicted: the lightbox gets it when the host answers
      return dataUrl !== undefined && dataUrl !== "" ? { id: image.id, dataUrl } : { id: image.id };
    });
    this.options.onOpenImage?.(images, block.images.findIndex((image) => image.id === tile.dataset["image"]));
  }
}
