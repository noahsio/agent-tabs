import { KNOWN_LEVELS, REASONING_LEVELS, type SettingsView } from "../../src/settings/protocol";
import type { RoleRowView, RolesView } from "../../src/settings/roles";
import { button, el } from "../dom";
import type { SectionContext, SectionView } from "./sections";

const FOOTER = "Список моделей — из всех подключений. Меняется для новых сессий; в открытой сессии модель главного агента выбирается в строке ввода.";
const MIXED = "mixed";
const MISSING = "нет в подключениях";
const NO_REASONING = "модель не думает";

/**
 * «Модели и роли» after the mockup: one line per role with its model (grouped by connection) and its power. The
 * controls show what the file says; a pick posts only what changed, and a refusal puts them back.
 */
export class ModelsSection implements SectionView {
  readonly element: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly note: HTMLElement;
  private last: RolesView | undefined;

  constructor(private readonly context: SectionContext) {
    this.rows = el("div", { class: "st-roles", role: "table", "aria-label": "Роли и модели" });
    this.note = el("p", { class: "st-s", "data-role": "models-note" });
    this.element = el("div", { class: "st-models" }, el("h3", { class: "st-h3" }, "Кто чем занимается"), this.rows, this.note);
  }

  update(state: SettingsView): void {
    const view = state.models as RolesView | undefined;
    if (view === undefined) return;
    this.last = view;
    this.render(view);
  }

  result(_id: string, ok: boolean): void {
    if (!ok && this.last !== undefined) this.render(this.last); // the file did not change: show what it says
  }

  private render(view: RolesView): void {
    this.rows.replaceChildren(
      el("div", { class: "st-role st-role-head", role: "row" }, el("span", {}, "Роль"), el("span", {}, "Модель"), el("span", {}, "Мощность")),
      ...view.rows.map((row) => this.roleRow(row, view)),
    );
    this.note.replaceChildren(FOOTER);
    if (view.omoUnavailable !== undefined) this.note.append(el("br"), `Модели аккаунтов: ${view.omoUnavailable} — показаны только модели шлюзов.`);
  }

  private roleRow(row: RoleRowView, view: RolesView): HTMLElement {
    const name = el("div", {}, el("b", { class: "st-t", title: row.hint }, row.title), el("span", { class: "st-s" }, row.detail));
    const hasPower = row.categories === undefined && row.profile === undefined;
    // a model the catalog marks as not thinking has no power to pick: the slot says so instead of offering levels
    const power = row.noReasoning === true ? el("span", { class: "st-s" }, NO_REASONING) : hasPower ? this.powerControl(row) : el("span");
    return el("div", { class: "st-role", role: "row", "data-role-row": row.id }, name, this.modelSelect(row, view), power);
  }

  private modelSelect(row: RoleRowView, view: RolesView): HTMLSelectElement {
    const control = el("select", { "data-field": "model", "aria-label": `Модель: ${row.title}` });
    control.addEventListener("change", () => {
      if (control.value === "" || control.value === MIXED) return;
      this.context.act({ kind: "role.set", id: row.id, model: control.value });
    });
    if (row.categories !== undefined) {
      for (const category of row.categories) control.append(el("option", { value: category.value, title: category.value }, category.label));
      control.value = row.model ?? "";
      return control;
    }
    const known = new Set(view.models.flatMap((group) => group.items.map((item) => item.value)));
    if (row.profile !== undefined) control.append(el("option", { value: "" }, `профиль ${row.profile}`));
    else if (row.model === undefined) control.append(el("option", { value: "" }, "не задана"));
    else if (row.model === MIXED) control.append(el("option", { value: MIXED }, "разные модели"));
    else if (!known.has(row.model)) control.append(el("option", { value: row.model }, `${row.model} — ${MISSING}`));
    for (const group of view.models) {
      const section = el("optgroup", { label: group.connection });
      for (const item of group.items) section.append(el("option", { value: item.value }, item.label));
      control.append(section);
    }
    control.value = row.profile !== undefined ? "" : (row.model ?? "");
    return control;
  }

  private powerControl(row: RoleRowView): HTMLElement {
    const group = el("div", { class: "st-seg", role: "group", "aria-label": `Мощность: ${row.title}` });
    // a level the file holds that the control does not offer (a model's own, e.g. minimal) is shown, selected, in its place
    const levels = KNOWN_LEVELS.filter((level) => (REASONING_LEVELS as readonly string[]).includes(level) || level === row.reasoning);
    for (const level of levels) {
      const on = row.reasoning === level;
      const segment = button(level, { "data-reasoning": level, "aria-pressed": String(on), class: on ? "on" : "" }, () => {
        if (!on) this.context.act({ kind: "role.set", id: row.id, reasoning: level });
      });
      group.append(segment);
    }
    return group;
  }
}
