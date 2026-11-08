import type { EnvironmentView, Folder } from "../../src/settings/environment";
import type { SettingsView } from "../../src/settings/protocol";
import { button, el } from "../dom";
import type { SectionContext, SectionView } from "./sections";

const FOLDERS: ReadonlyArray<[Folder, string]> = [
  ["agentDir", "Папка данных OmO"],
  ["memoryHome", "Память"],
  ["claudeDir", "Папка Claude"],
];

/**
 * «Среда» after the mockup: the three folders (a change posts when the field is left or Enter is pressed), OmO's
 * version and «Перезапустить OmO» with its hint, highlighted while the folders differ from the running OmO's.
 */
export class EnvironmentSection implements SectionView {
  readonly element: HTMLElement;
  private readonly inputs = new Map<Folder, HTMLInputElement>();
  private readonly version: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly timeout: HTMLInputElement;
  private last: EnvironmentView | undefined;

  constructor(private readonly context: SectionContext) {
    const fields = el("div", { class: "st-fields" });
    for (const [folder, label] of FOLDERS) {
      const input = el("input", { class: "st-mono", "data-field": folder, spellcheck: "false", "aria-label": label });
      input.addEventListener("change", () => {
        if (input.value.trim() !== "" && input.value.trim() !== this.last?.folders[folder]) this.context.act({ kind: "folder.set", which: folder, path: input.value.trim() });
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
      });
      this.inputs.set(folder, input);
      fields.append(el("div", { class: "st-field" }, el("label", {}, label), input));
    }
    this.timeout = el("input", { class: "st-mono st-narrow", type: "number", min: "1", max: "120", step: "1", "data-field": "questionTimeout", "aria-label": "Ответ на вопрос агента, мин" });
    this.timeout.addEventListener("change", () => {
      const minutes = Number(this.timeout.value);
      if (this.timeout.value.trim() !== "" && minutes !== this.last?.questionTimeoutMinutes) this.context.act({ kind: "questionTimeout.set", minutes });
    });
    this.timeout.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.timeout.blur();
    });
    fields.append(
      el(
        "div",
        { class: "st-field" },
        el("label", {}, "Ждать ответа на вопрос"),
        el("div", { class: "st-row" }, this.timeout, el("span", { class: "st-s" }, "мин — потом агент продолжает сам (1–120)")),
      ),
    );
    this.version = el("span", { class: "st-mono", "data-role": "omo-version" });
    this.hint = el("span", { class: "st-s", "data-role": "restart-hint" });
    fields.append(
      el("div", { class: "st-field" }, el("label", {}, "OmO"), this.version),
      el(
        "div",
        { class: "st-field" },
        el("label", {}),
        el("div", { class: "st-row" }, button("Перезапустить OmO", { "data-action": "restart" }, () => this.context.act({ kind: "restart" })), this.hint),
      ),
    );
    this.element = el("div", { class: "st-environment" }, fields);
  }

  update(state: SettingsView): void {
    const view = state.environment as EnvironmentView | undefined;
    if (view === undefined) return;
    this.last = view;
    this.render(view);
  }

  result(_id: string, ok: boolean): void {
    if (!ok && this.last !== undefined) this.render(this.last); // the setting did not change: show what it says
  }

  private render(view: EnvironmentView): void {
    for (const [folder, input] of this.inputs) if (document.activeElement !== input) input.value = view.folders[folder];
    if (document.activeElement !== this.timeout) this.timeout.value = String(view.questionTimeoutMinutes);
    this.version.textContent = view.omoVersion ?? view.omoUnavailable ?? "";
    this.version.classList.toggle("st-muted", view.omoVersion === undefined);
    // the mockup's «нужно после смены папок» beside the button; the whole hint once the folders really changed
    this.hint.textContent = view.restartNeeded ? view.restartHint : view.restartHint.replace(/^Перезапустить OmO — /, "");
    this.hint.classList.toggle("st-warn", view.restartNeeded);
  }
}
