import type { Dialog } from "../src/chat/model";
import type { PendingView } from "../src/guard/admin";
import { GUARD_MESSAGE_MAX, type GuardStep, type WebviewMessage } from "../src/panel/protocol";
import { button, el, type Post } from "./dom";
import { clock, toolLabel } from "./feed";
import { icon } from "./icons";

type DialogAnswer = Extract<WebviewMessage, { type: "answer" }>["answer"];

/** A command longer than this (lines or characters) starts collapsed. */
const LONG_COMMAND_LINES = 6;
const LONG_COMMAND_CHARS = 400;
const MAIN_AGENT = "главный агент";
/** Keys that answer are not taken this soon after a prompt shows: a keystroke meant for the composer never decides. */
export const KEY_GUARD_MS = 500;
const OTHER = "Другое";

const VERDICT: Record<string, string> = { allow: "разрешить", deny: "запретить", ask: "спросить" };
const STEP_VERDICT: Record<string, string> = { allow: "Решатель разрешил", deny: "Решатель запретил", ask: "Решатель спросил человека" };
/** Who answered an approval, when it was not this tab. */
const ANSWERED_BY: Record<string, string> = {
  "agent-tabs": "Agent Tabs",
  cli: "терминал",
  telegram: "Telegram",
  timeout: "никто не ответил вовремя",
  decider: "решатель",
};

/** «1 команда», «3 команды», «8 команд». */
export function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return one;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

/** «1,2 с», «850 мс»: how long the decider took. */
function deciderTime(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} мс`;
  return `${(ms / 1000).toFixed(1).replace(".", ",")} с`;
}

/** One question of OmO's `question` method, read defensively (the payload is free-form). */
type Question = { id: string; header?: string; text: string; multi: boolean; options: { label: string; description?: string }[] };

function readQuestions(raw: unknown[] | undefined): Question[] {
  return (raw ?? []).map((value, index) => {
    const question = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const options = (Array.isArray(question["options"]) ? question["options"] : []).flatMap((option) => {
      const fields = (typeof option === "object" && option !== null ? option : {}) as Record<string, unknown>;
      const label = typeof option === "string" ? option : typeof fields["label"] === "string" ? fields["label"] : "";
      if (label === "") return [];
      const description = typeof fields["description"] === "string" && fields["description"].trim() !== "" ? fields["description"] : undefined;
      return [{ label, ...(description !== undefined ? { description } : {}) }];
    });
    const header = typeof question["header"] === "string" && question["header"].trim() !== "" ? question["header"] : undefined;
    return {
      id: typeof question["id"] === "string" ? question["id"] : `q${index + 1}`,
      ...(header !== undefined ? { header } : {}),
      text: typeof question["question"] === "string" ? question["question"] : (header ?? ""),
      multi: question["multiSelect"] === true,
      options,
    };
  });
}

/** What the person gave one question so far: chosen labels, and their own words («Другое…»). */
type Given = { selected: string[]; text?: string };

type Base = {
  id: string;
  /** The feed block that was last when the prompt came: its result line goes after it. */
  after: string | undefined;
  /** The focused row. */
  focus: number;
  /** The free-text row is open (approval «…иначе», «Другое…»). */
  editing: boolean;
  /** What the open field holds. */
  draft: string;
  /** An answer is on its way; the panel takes none until it lands or fails. */
  sending: boolean;
  error?: string;
  /** When it was first on screen (epoch ms): answering keys wait KEY_GUARD_MS from then. */
  shownAt?: number;
};
type GuardItem = Base & {
  kind: "guard";
  request: PendingView;
  elsewhere: boolean;
  answeredHere: boolean;
  /** Another session's request: its line in the feed («Решение ждёт в другой сессии»), where its result goes too. */
  notice?: HTMLElement;
};
type DialogItem = Base & {
  kind: "dialog";
  dialog: Dialog;
  questions: Question[];
  /** The open question of a set. */
  active: number;
  given: Map<string, Given>;
};
type Result = { name: string; verdict: string; ok: boolean };
type Item = GuardItem | DialogItem;

type Row = { label: string; desc?: string; more?: boolean; checked?: boolean; field?: { label: string; placeholder: string; maxLength?: number } };

export type DockOptions = {
  post: Post;
  /** The feed block that is last now. */
  anchor: () => string | undefined;
  /** A result line into the feed, after `after`. */
  addRow: (id: string, element: HTMLElement, after: string | undefined) => void;
  /** Who asks for a request of `session` («главный агент», or a subagent's name and model). */
  who: (session: string) => string;
  /** The prompts changed (one came, went or is shown instead of another). */
  onChange: () => void;
};

/**
 * Questions and approvals waiting for this tab, docked in the composer's place: one panel, oldest first, «1 из 3» and
 * ←/→ when several wait. Every prompt is a numbered list: ↑/↓ move, a digit or a click chooses, Enter chooses the
 * focused row, Esc refuses (an approval is denied, a dialog cancelled). After the answer the panel closes and a
 * one-line result stays in the feed at the call. Model and agent text only ever goes in as text nodes.
 */
export class Dock {
  readonly element: HTMLElement;
  private items: Item[] = [];
  private index = 0;
  private silent = false;
  private running = false;
  /** Other sessions' requests not opened here: a line in the feed each, until «Открыть» docks one. */
  private readonly away = new Map<string, GuardItem>();
  /** The result line each dialog answer leaves, once OmO took it (`answerResult`). */
  private readonly results = new Map<string, { result: Result; after: string | undefined }>();
  /** «Стоп» in the header while a turn runs: the hidden composer's button, still at hand. */
  private readonly stop: HTMLButtonElement;

  constructor(private readonly options: DockOptions) {
    this.element = el("div", { class: "ask-slot", "data-role": "dock" });
    this.element.hidden = true;
    this.element.addEventListener("keydown", (event) => this.onKey(event));
    this.stop = button("Стоп", { class: "ask-stop secondary", "data-role": "ask-stop", tabindex: "-1", title: "Остановить агента" }, () => this.options.post({ type: "stop" }));
  }

  get active(): boolean {
    return this.items.length > 0;
  }

  /** The feed's line while the panel waits: an approval asks for a decision, anything else for an answer. */
  get waiting(): string | undefined {
    const item = this.current;
    if (item === undefined) return undefined;
    return item.kind === "guard" ? "Ждёт вашего решения" : "Ждёт вашего ответа";
  }

  focus(): void {
    const field = this.element.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-role="ask-field"]');
    if (field === null) {
      this.element.querySelector<HTMLElement>(".ask")?.focus();
      return;
    }
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length); // typing goes on where it stopped
  }

  // ---------- what comes in ----------

  /** The session's open dialogs (OmO's `extension_ui_request`). */
  setDialogs(dialogs: Dialog[]): void {
    const ids = new Set(dialogs.map((dialog) => dialog.id));
    const kept = this.items.filter((item) => item.kind !== "dialog" || ids.has(item.id));
    const known = new Set(kept.map((item) => item.id));
    const added: Item[] = dialogs
      .filter((dialog) => !known.has(dialog.id))
      .map((dialog) => ({
        ...this.base(dialog.id),
        kind: "dialog",
        dialog,
        questions: readQuestions(dialog.questions),
        active: 0,
        given: new Map(),
        draft: dialog.method === "editor" ? (dialog.prefill ?? "") : "",
      }));
    this.replace([...kept, ...added]);
  }

  /** The host's word on one dialog answer: taken (its line goes into the feed), already closed, or failed (try again). */
  dialogAnswered(id: string, outcome: "applied" | "closed" | "failed"): void {
    const sent = this.results.get(id);
    this.results.delete(id);
    if (outcome === "applied" && sent !== undefined) {
      this.options.addRow(`dialog:${id}`, resultLine(sent.result.name, undefined, sent.result.verdict, sent.result.ok ? "ok" : "muted"), sent.after);
      return;
    }
    const item = this.items.find((candidate) => candidate.id === id);
    if (outcome === "failed" && item !== undefined && item.sending) {
      item.sending = false;
      this.render();
    }
  }

  /** A request of this tab's session docks; another session's gets a line in the feed with «Открыть» instead. */
  addGuard(request: PendingView, elsewhere: boolean): void {
    if (this.items.some((item) => item.id === request.id) || this.away.has(request.id)) return;
    const item: GuardItem = { ...this.base(request.id), kind: "guard", request, elsewhere, answeredHere: false };
    if (!elsewhere) {
      this.replace([...this.items, item]);
      return;
    }
    const open = button("Открыть", { class: "link", "data-role": "open-elsewhere" }, () => {
      if (!this.away.delete(item.id)) return;
      open.remove();
      this.replace([...this.items, item]);
      this.index = this.items.indexOf(item);
      this.render();
      this.focus();
      this.options.onChange();
    });
    item.notice = el("div", { class: "step ask-elsewhere", "data-guard": request.id }, `Решение ждёт в другой сессии: ${request.cwd} · `, open);
    this.away.set(item.id, item);
    this.options.addRow(item.id, item.notice, item.after);
  }

  /** While a turn runs the panel offers «Стоп», as the hidden composer would. */
  setRunning(running: boolean): void {
    if (running === this.running) return;
    this.running = running;
    // in place, not a redraw: a field being typed in stays as it is
    if (running) this.element.querySelector(".ask-end")?.append(this.stop);
    else this.stop.remove();
  }

  /** Answered (here, elsewhere) or timed out: the panel lets it go and the feed keeps one line at the call. */
  resolveGuard(id: string, decision: "allow" | "deny", by: string, message?: string): boolean {
    const item = this.guard(id) ?? this.away.get(id);
    if (item === undefined) return false;
    const who = item.answeredHere && by === "agent-tabs" ? "вы" : `${ANSWERED_BY[by] ?? by} · ${clock(Date.now())}`;
    const verdict = decision === "allow" ? "Разрешено один раз" : "Запрещено";
    const line = resultLine(toolLabel(item.request.tool), oneLine(item.request.command), verdict, decision === "allow" ? "ok" : "error", who);
    if (message !== undefined) line.append(el("p", { class: "quote" }, message));
    this.settle(item, line);
    return true;
  }

  /** The service no longer has the request: a line without a verdict. */
  closeGuard(id: string): boolean {
    const item = this.guard(id) ?? this.away.get(id);
    if (item === undefined) return false;
    this.settle(item, resultLine(toolLabel(item.request.tool), oneLine(item.request.command), "Закрыт", "muted", "запрос больше не ждёт ответа"));
    return true;
  }

  /** The request's one line in the feed: in place of its «ждёт в другой сессии» line, else at the call. */
  private settle(item: GuardItem, line: HTMLElement): void {
    line.dataset["guard"] = item.id;
    if (item.notice !== undefined) item.notice.replaceWith(line);
    else this.options.addRow(item.id, line, item.after);
    this.away.delete(item.id);
    this.drop(item.id);
  }

  /** This tab's answer did not reach the service: the panel takes answers again and says why. */
  guardFailed(id: string, error: string): void {
    const item = this.guard(id);
    if (item === undefined) return;
    item.sending = false;
    item.answeredHere = false;
    item.error = error;
    this.render();
  }

  setSilent(silent: boolean): void {
    this.silent = silent;
    this.render();
  }

  // ---------- state ----------

  private get current(): Item | undefined {
    return this.items[this.index];
  }

  private guard(id: string): GuardItem | undefined {
    const item = this.items.find((candidate) => candidate.id === id);
    return item?.kind === "guard" ? item : undefined;
  }

  private base(id: string): Base {
    return { id, after: this.options.anchor(), focus: 0, editing: false, draft: "", sending: false };
  }

  private drop(id: string): void {
    this.replace(this.items.filter((item) => item.id !== id));
  }

  /**
   * The list changes: the prompt on screen stays on screen while it waits. An unchanged list (every streamed state
   * brings the same dialogs) redraws nothing, so a field being typed in is left alone.
   */
  private replace(items: Item[], redraw: boolean = false): void {
    const same = items.length === this.items.length && items.every((item, index) => item === this.items[index]);
    if (same && !redraw) return;
    const shown = this.current?.id;
    this.items = items;
    const at = items.findIndex((item) => item.id === shown);
    this.index = at >= 0 ? at : Math.min(this.index, Math.max(0, items.length - 1));
    this.render();
    this.options.onChange();
  }

  private switchTo(delta: number): void {
    if (this.items.length < 2) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.render();
    this.focus();
    this.options.onChange();
  }

  // ---------- answers ----------

  private answerGuard(item: GuardItem, decision: "allow-once" | "deny", message?: string): void {
    if (item.sending) return;
    item.sending = true;
    item.answeredHere = true;
    delete item.error;
    this.options.post({ type: "guardAnswer", id: item.id, decision, ...(message !== undefined ? { message } : {}) });
    this.render();
  }

  private answerDialog(item: DialogItem, answer: DialogAnswer, result: Result): void {
    if (item.sending) return;
    item.sending = true;
    this.results.set(item.id, { result, after: item.after });
    this.options.post({ type: "answer", dialogId: item.id, answer });
    this.render();
  }

  /** Esc on the list: an approval is denied, a confirm answered «Нет», anything else cancelled. */
  private refuse(item: Item): void {
    if (item.kind === "guard") return this.answerGuard(item, "deny");
    if (item.dialog.method === "confirm") return this.answerDialog(item, { confirmed: false }, { name: "Вопрос", verdict: "Ответ: Нет", ok: true });
    this.answerDialog(item, { cancelled: true }, { name: item.questions.length > 1 ? "Вопросы" : "Вопрос", verdict: "Отменено", ok: false });
  }

  /** A row chosen by click, digit or Enter. */
  private choose(item: Item, index: number): void {
    if (item.sending) return;
    item.focus = index;
    if (item.kind === "guard") {
      if (index === 0) return this.answerGuard(item, "allow-once");
      if (index === 1) return this.answerGuard(item, "deny");
      if (index === 2) return this.openField(item);
      return;
    }
    const { dialog } = item;
    if (dialog.method === "select") {
      const option = dialog.options?.[index];
      if (option !== undefined) this.answerDialog(item, { value: option }, { name: "Вопрос", verdict: `Ответ: ${option}`, ok: true });
      return;
    }
    if (dialog.method === "confirm") {
      if (index > 1) return;
      const yes = index === 0;
      return this.answerDialog(item, { confirmed: yes }, { name: "Вопрос", verdict: `Ответ: ${yes ? "Да" : "Нет"}`, ok: true });
    }
    const question = item.questions[item.active];
    if (dialog.method !== "question" || question === undefined) return;
    const given = item.given.get(question.id) ?? { selected: [] };
    if (index === question.options.length) {
      if (question.multi && given.text !== undefined && !item.editing) {
        item.given.set(question.id, { selected: given.selected }); // «Другое» unticked
        return this.render();
      }
      return this.openField(item, given.text ?? "");
    }
    const label = question.options[index]?.label;
    if (label === undefined) return;
    if (question.multi) {
      const selected = given.selected.includes(label) ? given.selected.filter((value) => value !== label) : [...given.selected, label];
      item.given.set(question.id, { ...given, selected });
      return this.render();
    }
    item.given.set(question.id, { selected: [label] });
    this.advance(item);
  }

  private openField(item: Item, draft = ""): void {
    item.editing = true;
    item.draft = draft;
    this.render();
    this.focus();
  }

  private closeField(item: Item): void {
    item.editing = false;
    this.render();
    this.focus();
  }

  /** Enter in the open field. */
  private submitField(item: Item): void {
    const text = item.draft.trim();
    if (item.kind === "guard") {
      if (text === "" || text.length > GUARD_MESSAGE_MAX) return;
      return this.answerGuard(item, "deny", text);
    }
    const { method } = item.dialog;
    if (method === "input" || method === "editor") {
      return this.answerDialog(item, { value: item.draft }, { name: "Вопрос", verdict: `Ответ: ${oneLine(item.draft)}`, ok: true });
    }
    const question = item.questions[item.active];
    if (question === undefined) return;
    const given = item.given.get(question.id) ?? { selected: [] };
    if (text === "") {
      item.given.set(question.id, { selected: given.selected });
      return this.closeField(item);
    }
    item.editing = false;
    if (question.multi) {
      item.given.set(question.id, { selected: given.selected, text });
      this.render();
      this.focus();
      return;
    }
    item.given.set(question.id, { selected: [], text }); // own words replace a chosen option, as in OmO's own prompt
    this.advance(item);
  }

  /** The next question of the set, or — on the last one — the whole set goes out. */
  private advance(item: DialogItem): void {
    if (item.active + 1 < item.questions.length) {
      this.goTo(item, item.active + 1);
      return;
    }
    const answers: Record<string, Given> = {};
    for (const question of item.questions) {
      const given = item.given.get(question.id);
      if (given !== undefined && (given.selected.length > 0 || given.text !== undefined)) answers[question.id] = given;
    }
    if (Object.keys(answers).length === 0) return; // nothing to say yet
    const parts = item.questions.flatMap((question, index) => {
      const given = answers[question.id];
      if (given === undefined) return [];
      const words = [...given.selected, ...(given.text !== undefined ? [given.text] : [])].join(", ");
      return [item.questions.length > 1 ? `${question.header ?? `Вопрос ${index + 1}`} — ${words}` : words];
    });
    this.answerDialog(item, { answers }, { name: item.questions.length > 1 ? "Вопросы" : "Вопрос", verdict: `Ответ: ${parts.join("; ")}`, ok: true });
  }

  private goTo(item: DialogItem, active: number): void {
    if (active < 0 || active >= item.questions.length) return;
    item.active = active;
    item.editing = false;
    item.focus = 0;
    this.render();
    this.focus();
  }

  // ---------- keys ----------

  private rowCount(item: Item): number {
    if (item.kind === "guard") return 3;
    if (item.dialog.method === "select") return item.dialog.options?.length ?? 0;
    if (item.dialog.method === "confirm") return 2;
    if (item.dialog.method === "question") return (item.questions[item.active]?.options.length ?? 0) + 1;
    return 0;
  }

  private onKey(event: KeyboardEvent): void {
    const item = this.current;
    if (item === undefined || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    const inField = target?.dataset["role"] === "ask-field";
    if (!inField && target?.classList.contains("ask") !== true) return; // a summary, a link, a button: their own keys
    const key = event.key;
    const early = Date.now() - (item.shownAt ?? 0) < KEY_GUARD_MS;
    const handled = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (inField) {
      const editor = item.kind === "dialog" && item.dialog.method === "editor";
      if (key === "Enter" && !event.shiftKey && (!editor || event.metaKey || event.ctrlKey)) {
        handled();
        if (!item.sending && !early) this.submitField(item);
      } else if (key === "Escape") {
        handled();
        const fieldOnly = item.kind === "dialog" && (item.dialog.method === "input" || item.dialog.method === "editor");
        if (fieldOnly) this.refuse(item);
        else this.closeField(item);
      }
      return;
    }
    const set = item.kind === "dialog" && item.questions.length > 1;
    const rows = this.rowCount(item);
    if (early && (/^[1-9]$/.test(key) || key === " " || key === "Enter" || key === "Escape")) {
      handled(); // too soon to be meant for this prompt
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      handled();
      if (rows === 0) return;
      item.focus = Math.max(0, Math.min(rows - 1, item.focus + (key === "ArrowDown" ? 1 : -1)));
      this.render();
      this.focus();
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      handled();
      const delta = key === "ArrowRight" ? 1 : -1;
      if (set && item.kind === "dialog") this.goTo(item, item.active + delta);
      else this.switchTo(delta);
    } else if (/^[1-9]$/.test(key) && Number(key) <= rows) {
      handled();
      this.choose(item, Number(key) - 1);
    } else if (key === " " && item.kind === "dialog" && item.questions[item.active]?.multi === true) {
      handled();
      this.choose(item, item.focus);
    } else if (key === "Enter") {
      handled();
      if (item.kind === "dialog" && item.questions[item.active]?.multi === true) {
        if (!item.sending) this.advance(item);
      } else this.choose(item, item.focus);
    } else if (key === "Escape") {
      handled();
      if (!item.sending) this.refuse(item);
    }
  }

  // ---------- drawing ----------

  private render(): void {
    const item = this.current;
    this.element.hidden = item === undefined;
    if (item === undefined) {
      this.element.replaceChildren();
      return;
    }
    item.shownAt ??= Date.now();
    const active = document.activeElement;
    const hadFocus = active !== null && this.element.contains(active);
    const panel = el("div", { class: "ask", tabindex: "0", role: "group", "data-ask": item.id, "aria-label": item.kind === "guard" ? "Агент просит разрешения" : "Агент задаёт вопрос" });
    if (item.sending) panel.classList.add("sending");
    if (item.kind === "guard") this.drawGuard(panel, item);
    else this.drawDialog(panel, item);
    this.element.replaceChildren(panel);
    if (hadFocus) this.focus();
  }

  private head(title: string, chip: string | undefined, who: string | undefined): HTMLElement {
    const head = el("div", { class: "ask-head" }, el("span", { class: "ask-title" }, title));
    if (chip !== undefined) head.append(el("span", { class: "tool" }, chip));
    const end = el("span", { class: "ask-end" });
    head.append(end);
    if (who !== undefined) end.append(el("span", { class: who === MAIN_AGENT ? "who main" : "who" }, who));
    if (this.items.length > 1) {
      const count = el(
        "span",
        { class: "ask-count", "data-role": "ask-count" },
        button("‹", { class: "ask-step", "aria-label": "Предыдущий запрос", tabindex: "-1" }, () => this.switchTo(-1)),
        el("span", {}, `${this.index + 1} из ${this.items.length}`),
        button("›", { class: "ask-step", "aria-label": "Следующий запрос", tabindex: "-1" }, () => this.switchTo(1)),
      );
      end.append(count);
    }
    if (this.running) end.append(this.stop);
    return head;
  }

  private rows(item: Item, rows: Row[], multi: boolean): HTMLElement {
    const list = el("ol", { class: "opts", role: "listbox" });
    rows.forEach((row, index) => {
      const number = el("span", { class: "n" }, String(index + 1));
      const lbl = el("span", { class: "lbl" });
      const editing = row.field !== undefined && item.editing && index === rows.length - 1;
      const option = el("li", { class: "opt", role: "option", "data-index": String(index), "aria-selected": String(index === item.focus && !item.editing) }, number);
      if (multi) {
        option.classList.add("multi");
        const box = el("span", { class: row.checked === true ? "box on" : "box", "aria-hidden": "true" });
        if (row.checked === true) box.append(icon("check"));
        option.append(box);
      }
      if (editing && row.field !== undefined) {
        option.classList.add("editing");
        const field = el("input", { type: "text", class: "free", "data-role": "ask-field", placeholder: row.field.placeholder, "aria-label": row.field.label });
        if (row.field.maxLength !== undefined) field.maxLength = row.field.maxLength;
        field.value = item.draft;
        field.addEventListener("input", () => {
          item.draft = field.value;
        });
        lbl.append(el("span", { class: "free-label" }, row.field.label), field);
      } else {
        if (index === item.focus && !item.editing) option.classList.add("on");
        lbl.append(row.label);
        if (row.more === true) lbl.append(el("span", { class: "more" }, "…"));
        if (row.desc !== undefined) lbl.append(el("span", { class: "desc" }, row.desc));
        option.addEventListener("click", () => this.choose(item, index));
      }
      option.append(lbl);
      list.append(option);
    });
    return list;
  }

  private foot(hints: Array<[string, string]>, ...buttons: HTMLElement[]): HTMLElement {
    const hint = el("div", { class: "hint" });
    hints.forEach(([key, text], index) => {
      if (index > 0) hint.append(" · ");
      hint.append(el("span", { class: "k" }, key), ` ${text}`);
    });
    return el("div", { class: "foot" }, hint, el("span", { class: "away" }, el("span", { class: "k" }, "Tab"), " — к решению"), ...buttons);
  }

  /** «←→ другой запрос» when several wait and the arrows are not a set's own. */
  private switchHint(set: boolean): Array<[string, string]> {
    return this.items.length > 1 && !set ? [["←→", "другой запрос"]] : [];
  }

  private drawGuard(panel: HTMLElement, item: GuardItem): void {
    const { request } = item;
    // an eval stays «eval» on its chip: it names code, not a command (the mockup's spelling)
    panel.append(this.head("Разрешить команду?", request.tool === "eval" ? "eval" : toolLabel(request.tool), item.elsewhere ? "другая сессия" : this.options.who(request.session)));
    const body = el("div", { class: "ask-body" });
    if (this.silent) body.append(el("p", { class: "meta ask-silent", role: "status" }, "Служба защиты не отвечает"));
    if (item.elsewhere) body.append(el("p", { class: "meta where" }, `Другая сессия: ${request.cwd}`));
    body.append(...commandBlock(request));
    if (request.reasons.length > 0) body.append(el("p", { class: "meta" }, `Причина: ${request.reasons.join(", ")}`));
    const decider = request.decider;
    if (decider !== undefined) {
      const who = decider.model !== undefined ? `Решатель (${decider.model})` : "Решатель";
      body.append(el("p", { class: "meta" }, `${who}: ${VERDICT[decider.decision] ?? decider.decision} — ${decider.reason}`));
    }
    panel.append(body);
    const field = { label: "Запретить и сказать агенту, что сделать иначе", placeholder: "Что агенту сделать вместо этого", maxLength: GUARD_MESSAGE_MAX };
    panel.append(this.rows(item, [{ label: "Разрешить один раз" }, { label: "Запретить" }, { label: field.label, more: true, field }], false));
    if (item.error !== undefined) panel.append(el("p", { class: "ask-error", role: "alert" }, item.error));
    panel.append(
      item.editing
        ? this.foot([
            ["Enter", "запретить и отправить"],
            ["Esc", "назад к вариантам"],
          ])
        : this.foot([["↑↓", "выбрать"], ["Enter", "подтвердить"], ["Esc", "запретить"], ...this.switchHint(false)]),
    );
  }

  private drawDialog(panel: HTMLElement, item: DialogItem): void {
    const { dialog } = item;
    if (dialog.method === "question" && item.questions.length > 0) return this.drawQuestion(panel, item);
    panel.append(this.head(dialog.title, undefined, MAIN_AGENT));
    if (dialog.method === "select") {
      panel.append(this.rows(item, (dialog.options ?? []).map((label) => ({ label })), false));
      panel.append(this.foot([["↑↓", "выбрать"], ["Enter", "подтвердить"], ["Esc", "отменить"], ...this.switchHint(false)]));
    } else if (dialog.method === "confirm") {
      if (dialog.message !== undefined) panel.append(el("div", { class: "ask-body" }, el("p", { class: "question-text" }, dialog.message)));
      panel.append(this.rows(item, [{ label: "Да" }, { label: "Нет" }], false));
      panel.append(this.foot([["Enter", "подтвердить"], ["Esc", "нет"], ...this.switchHint(false)]));
    } else {
      const editor = dialog.method === "editor";
      const field = editor ? el("textarea", { class: "free", rows: "6", "data-role": "ask-field", "aria-label": dialog.title }) : el("input", { type: "text", class: "free", "data-role": "ask-field", "aria-label": dialog.title });
      if (dialog.placeholder !== undefined) field.placeholder = dialog.placeholder;
      field.value = item.draft;
      field.addEventListener("input", () => {
        item.draft = field.value;
      });
      panel.append(el("div", { class: "ask-body field-row" }, field));
      panel.append(this.foot([[editor ? "⌘Enter" : "Enter", "отправить"], ["Esc", "отменить"]]));
    }
  }

  private drawQuestion(panel: HTMLElement, item: DialogItem): void {
    const set = item.questions.length > 1;
    const question = item.questions[item.active] as Question;
    if (set) {
      panel.append(this.head("Вопросы агента", undefined, `Вопрос ${item.active + 1} из ${item.questions.length}`));
      const tabs = el("div", { class: "qtabs", role: "tablist" });
      item.questions.forEach((entry, index) => {
        const given = item.given.get(entry.id);
        const tab = button(entry.header ?? `Вопрос ${index + 1}`, { class: index === item.active ? "qtab on" : "qtab", role: "tab", tabindex: "-1", "aria-selected": String(index === item.active) }, () => this.goTo(item, index));
        if (given !== undefined && (given.selected.length > 0 || given.text !== undefined)) tab.prepend(icon("check"));
        tabs.append(tab);
      });
      panel.append(tabs);
    } else panel.append(this.head("Вопрос агента", question.header, MAIN_AGENT));
    const text = el("p", { class: "question-text" }, question.text);
    if (question.multi) text.append(el("span", { class: "plural" }, "можно несколько"));
    panel.append(el("div", { class: "ask-body" }, text));
    const given = item.given.get(question.id) ?? { selected: [] };
    const rows: Row[] = question.options.map((option) => ({ label: option.label, ...(option.description !== undefined ? { desc: option.description } : {}), checked: given.selected.includes(option.label) }));
    const other = given.text !== undefined && !item.editing ? `${OTHER}: ${given.text}` : OTHER;
    rows.push({ label: other, more: given.text === undefined, checked: given.text !== undefined, field: { label: OTHER, placeholder: "Свой ответ" } });
    panel.append(this.rows(item, rows, question.multi));
    const last = item.active + 1 === item.questions.length;
    const buttons: HTMLElement[] = [];
    if (set) {
      if (item.active > 0) buttons.push(button("Назад", { class: "secondary", tabindex: "-1" }, () => this.goTo(item, item.active - 1)));
      buttons.push(button(last ? "Ответить" : "Далее", { class: "primary", tabindex: "-1" }, () => this.advance(item)));
    } else if (question.multi) buttons.push(button("Ответить", { class: "primary", tabindex: "-1" }, () => this.advance(item)));
    const answeredAny = item.questions.some((entry) => {
      const given = item.given.get(entry.id);
      return given !== undefined && (given.selected.length > 0 || given.text !== undefined);
    });
    const submit = buttons.find((candidate) => candidate.textContent === "Ответить") as HTMLButtonElement | undefined;
    if (submit !== undefined) submit.disabled = !answeredAny; // nothing to say yet
    const enter: [string, string] = ["Enter", last ? "ответить" : "далее"];
    const back: Array<[string, string]> = set && item.active > 0 ? [["←", `к вопросу ${item.active}`]] : [];
    const hints: Array<[string, string]> = item.editing
      ? [["Enter", question.multi ? "готово" : last ? "ответить" : "далее"], ["Esc", "назад к вариантам"]]
      : question.multi
        ? [["Пробел", "отметить"], enter, ...back, ...this.switchHint(set)]
        : set
          ? [["↑↓", "выбрать"], enter, ...back]
          : [["Enter", "— ответить"], [`↑↓`, `или 1–${rows.length} выбрать`], ["Esc", "отменить"], ...this.switchHint(false)];
    panel.append(this.foot(hints, ...buttons));
  }
}

/** The guarded call: an eval's extracted commands (with its code apart), a long command collapsed. */
function commandBlock(request: PendingView): HTMLElement[] {
  const { command, code } = request;
  const lines = command.split("\n");
  const parts: HTMLElement[] = [];
  if (code !== undefined) parts.push(el("p", { class: "lead" }, `Код запустит ${lines.length} ${plural(lines.length, "команду", "команды", "команд")}:`));
  const pre = el("pre", { class: "cmd" }, command);
  parts.push(pre);
  if (lines.length > LONG_COMMAND_LINES || command.length > LONG_COMMAND_CHARS) {
    pre.classList.add("collapsed");
    const closed = code !== undefined ? `Показать все ${lines.length}` : "Показать полностью";
    const toggle = button(closed, { class: "link toggle", "data-role": "command-toggle", "aria-expanded": "false", tabindex: "-1" }, () => {
      const open = pre.classList.toggle("collapsed") === false;
      toggle.textContent = open ? "Свернуть" : closed;
      toggle.setAttribute("aria-expanded", String(open));
    });
    parts.push(toggle);
  }
  if (code !== undefined) {
    const count = code.split("\n").length;
    const summary = el("summary", {}, icon("chevron"), `Код eval (${count} ${plural(count, "строка", "строки", "строк")})`);
    parts.push(el("details", { class: "disclosure", "data-role": "eval-code" }, summary, el("pre", { class: "cmd" }, code)));
  }
  return parts;
}

/** A command as one line for the feed: its first line, «…» when there is more. */
function oneLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}

/** One feed line: the call (name, command) and how it ended («Запрещено · Telegram · 16:05»). */
function resultLine(name: string, command: string | undefined, verdict: string, state: "ok" | "error" | "muted", who?: string): HTMLElement {
  const res = el("div", { class: "res" }, el("span", { class: "tool-name" }, name));
  if (command !== undefined) res.append(el("span", { class: "mono" }, command));
  const verdictText = el("span", { class: "verdict" });
  const colon = verdict.indexOf(": ");
  if (colon > 0 && verdict.startsWith("Ответ")) verdictText.append(el("b", {}, verdict.slice(0, colon + 1)), ` ${verdict.slice(colon + 2)}`);
  else verdictText.append(el("b", {}, verdict));
  if (who !== undefined) verdictText.append(` · ${who}`);
  res.append(verdictText);
  return el("div", { class: `step ask-result ${state}` }, res);
}

/** The feed's quiet line for a decider's own verdict: «Решатель разрешил · git status · 1,4 с»; the reason on hover. */
export function deciderStep(step: GuardStep): HTMLElement {
  const { decider } = step;
  const verdict = STEP_VERDICT[decider.decision] ?? `Решатель: ${decider.decision}`;
  const state = decider.decision === "deny" ? "decider no" : decider.decision === "ask" ? "decider ask" : "decider";
  const title = `${decider.model !== undefined ? `${decider.model}: ` : ""}${decider.reason}`;
  const line = el("div", { class: `step ${state}`, "data-guard": step.id, title }, el("span", { class: "verb" }, verdict), " · ", el("code", {}, oneLine(step.command)), ` · ${deciderTime(decider.ms)}`);
  if (step.cwd !== undefined) line.append(` · другая сессия: ${step.cwd}`);
  return line;
}
