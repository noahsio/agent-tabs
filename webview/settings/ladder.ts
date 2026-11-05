import { ASK_LABEL, FAILURE_CLASSES, type LadderRungView, type LadderSectionView, type RungAction } from "../../src/settings/ladderShape";
import type { FailureClass } from "../../src/sessions/ladderFailure";
import type { SettingsView } from "../../src/settings/protocol";
import { button, el } from "../dom";
import type { SectionContext, SectionView } from "./sections";

/** The failures, in the person's words, in the order the spec's table lists them. */
const FAILURE_LABELS: Record<FailureClass, string> = {
  refusal: "отказ",
  rejected: "отклонение",
  empty: "пустой ответ",
  silence: "молчание",
  transport: "обрыв",
};

const TOP_NOTE = "верх, с неё всё начинается";
const MISSING = "нет в этой среде";
const ASK_VALUE = "ask";
const TEXT_VALUE = "text";
const NOTE =
  "Первая ступенька — модель, с которой сессия начинает. Порог молчания — 5 минут. " +
  "Лесенка идёт только для вашего сообщения и только если ход ничего не успел сделать.";

/** `provider/id` of a model option, split on the first slash (a model id may contain more). */
function modelAction(value: string): RungAction | undefined {
  const slash = value.indexOf("/");
  return slash > 0 ? { kind: "model", provider: value.slice(0, slash), id: value.slice(slash + 1) } : undefined;
}

/**
 * «Лесенка моделей»: one row per rung, in the ladder's own order — its number, what it does, and a checkbox per
 * failure it answers. Rows reorder by dragging and by the ↑/↓ beside each one (both post the same move), and the
 * first rung is fixed: it is the model a session starts on, so there is nothing above it to fall back from.
 */
export class LadderSection implements SectionView {
  readonly element: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly note: HTMLElement;
  private last: LadderSectionView | undefined;
  /** The rung being dragged, while one is. */
  private dragging: string | undefined;

  constructor(private readonly context: SectionContext) {
    this.rows = el("div", { class: "st-rungs", role: "list", "aria-label": "Ступеньки" });
    this.note = el("p", { class: "st-s", "data-role": "ladder-note" }, NOTE);
    this.element = el(
      "div",
      { class: "st-ladder" },
      el("h3", { class: "st-h3" }, "Куда переходить, когда модель не отвечает"),
      this.rows,
      el(
        "div",
        { class: "st-actions" },
        button("Добавить ступеньку", { class: "st-sm", "data-role": "rung-add" }, () => this.context.act({ kind: "rung.add" })),
        button("Вернуть лесенку по умолчанию", { class: "st-sm", "data-role": "ladder-reset" }, () => this.context.act({ kind: "reset" })),
      ),
      this.note,
    );
  }

  update(state: SettingsView): void {
    const view = state.ladder as LadderSectionView | undefined;
    if (view === undefined) return;
    this.last = view;
    this.render(view);
  }

  result(_id: string, ok: boolean): void {
    if (!ok && this.last !== undefined) this.render(this.last); // the file did not change: show what it says
  }

  private render(view: LadderSectionView): void {
    this.dragging = undefined;
    this.rows.replaceChildren(...view.rungs.map((rung, at) => this.row(rung, at, view)));
  }

  private row(rung: LadderRungView, at: number, view: LadderSectionView): HTMLElement {
    const top = at === 0;
    const row = el("div", { class: "st-rung", role: "listitem", "data-rung": rung.id, draggable: "true" });
    if (top) row.dataset["top"] = "true";
    row.append(
      el("span", { class: "st-rung-n", "data-role": "rung-number" }, String(at + 1)),
      this.body(rung, view, top),
      this.failures(rung, top),
      this.handles(rung, at, view.rungs.length, top),
    );
    this.watchDrag(row, rung.id, at);
    return row;
  }

  /**
   * What the rung does: the action picker, the phrase of a text rung, and whatever the row must say about it. The
   * picker is the rung's name — printing the label above it as well would say the same thing twice on every row.
   */
  private body(rung: LadderRungView, view: LadderSectionView, top: boolean): HTMLElement {
    const body = el("div", { class: "st-rung-body" }, this.actionSelect(rung, view));
    if (rung.action.kind === "text") body.append(this.textField(rung));
    if (top) body.append(el("span", { class: "st-s" }, TOP_NOTE));
    else if (rung.missing === true) body.append(el("span", { class: "st-s st-warn", "data-role": "rung-missing" }, MISSING));
    return body;
  }

  private actionSelect(rung: LadderRungView, view: LadderSectionView): HTMLSelectElement {
    const control = el("select", { "data-field": "action", "aria-label": `Что делает ступенька: ${rung.label}` });
    for (const group of view.models) {
      const section = el("optgroup", { label: group.connection });
      for (const item of group.items) section.append(el("option", { value: item.value }, item.label));
      control.append(section);
    }
    const value = rung.action.kind === "model" ? `${rung.action.provider}/${rung.action.id}` : rung.action.kind === "text" ? TEXT_VALUE : ASK_VALUE;
    // a model the environment no longer serves keeps its place in the list, so the row is not silently retargeted
    if (rung.action.kind === "model" && ![...control.querySelectorAll("option")].some((option) => option.value === value)) {
      control.prepend(el("option", { value }, rung.action.id));
    }
    control.append(el("option", { value: TEXT_VALUE }, "отправить текст"), el("option", { value: ASK_VALUE }, ASK_LABEL));
    control.value = value;
    control.addEventListener("change", () => {
      if (control.value === ASK_VALUE) {
        this.context.act({ kind: "rung.action", id: rung.id, action: { kind: "ask" } });
        return;
      }
      if (control.value === TEXT_VALUE) {
        // the phrase itself is typed in the field the row grows next; «продолжи» is what the spec offers as the example
        const text = rung.action.kind === "text" ? rung.action.text : "продолжи";
        this.context.act({ kind: "rung.action", id: rung.id, action: { kind: "text", text } });
        return;
      }
      const action = modelAction(control.value);
      if (action !== undefined) this.context.act({ kind: "rung.action", id: rung.id, action });
    });
    return control;
  }

  private textField(rung: LadderRungView): HTMLInputElement {
    const field = el("input", {
      type: "text",
      "data-role": "rung-text",
      "aria-label": `Что отправить: ${rung.label}`,
      placeholder: "продолжи",
    });
    field.value = rung.action.kind === "text" ? rung.action.text : "";
    field.addEventListener("change", () => {
      const text = field.value.trim();
      if (text === "") {
        field.value = rung.action.kind === "text" ? rung.action.text : "";
        return;
      }
      this.context.act({ kind: "rung.action", id: rung.id, action: { kind: "text", text } });
    });
    return field;
  }

  /** One checkbox per failure; the top rung's are shown disabled, because there is nothing above it. */
  private failures(rung: LadderRungView, top: boolean): HTMLElement {
    const group = el("div", { class: "st-rung-on", role: "group", "aria-label": `На что отвечает: ${rung.label}` });
    for (const failure of FAILURE_CLASSES) {
      const box = el("input", { type: "checkbox", "data-failure": failure });
      box.checked = rung.on.includes(failure);
      box.disabled = top;
      box.addEventListener("change", () => this.context.act({ kind: "rung.on", id: rung.id, failure, on: box.checked }));
      group.append(el("label", {}, box, FAILURE_LABELS[failure]));
    }
    return group;
  }

  /** ↑ / ↓ and ✕: the keyboard's way to do what dragging does. Nothing may move above the first rung. */
  private handles(rung: LadderRungView, at: number, count: number, top: boolean): HTMLElement {
    const move = (to: number): void => void this.context.act({ kind: "rung.move", id: rung.id, to });
    const up = button("↑", { class: "icon-btn", "data-role": "rung-up", title: "Выше", "aria-label": `Выше: ${rung.label}` }, () => move(at - 1));
    const down = button("↓", { class: "icon-btn", "data-role": "rung-down", title: "Ниже", "aria-label": `Ниже: ${rung.label}` }, () => move(at + 1));
    up.disabled = at <= 1;
    down.disabled = top || at >= count - 1;
    const handles = el("div", { class: "st-rung-handles" }, up, down);
    if (!top) {
      handles.append(
        button("✕", { class: "icon-btn", "data-role": "rung-remove", title: "Убрать ступеньку", "aria-label": `Убрать: ${rung.label}` }, () =>
          this.context.act({ kind: "rung.remove", id: rung.id }),
        ),
      );
    }
    return handles;
  }

  private watchDrag(row: HTMLElement, id: string, at: number): void {
    row.addEventListener("dragstart", () => {
      this.dragging = id;
    });
    row.addEventListener("dragend", () => {
      this.dragging = undefined;
    });
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const moved = this.dragging;
      this.dragging = undefined;
      if (moved === undefined || moved === id) return;
      this.context.act({ kind: "rung.move", id: moved, to: at });
    });
  }
}
