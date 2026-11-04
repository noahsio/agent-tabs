import type { ModelRef } from "../src/chat/model";
import type { ModelInfo, StateMessage } from "../src/panel/protocol";
import { modelName } from "./composer";
import { el, type Post } from "./dom";
import type { PopoverContent } from "./popover";

/** Rows come in this order; a gateway model's description names its family. */
const GROUPS: { title: string; matches: (provider: string) => boolean }[] = [
  { title: "Claude", matches: (provider) => provider === "gw-anthropic" },
  { title: "GPT", matches: (provider) => provider === "gw-openai" },
  { title: "Другие", matches: (provider) => provider !== "gw-anthropic" && provider !== "gw-openai" },
];
const GATEWAY_PREFIX = "gw-";

const NO_MODELS: ModelInfo[] = [];

type View = { auto: boolean; model?: ModelRef; autoModel?: ModelRef; models: ModelInfo[]; levels: string[]; level?: string };

function sameModel(model: ModelRef | undefined, info: ModelInfo): boolean {
  return model !== undefined && model.provider === info.provider && model.id === info.id;
}

/** «Claude · через шлюз» for a gateway model; anything else is described by its provider. */
function describeModel(info: ModelInfo, family: string): string {
  return info.provider.startsWith(GATEWAY_PREFIX) ? `${family} · через шлюз` : info.provider;
}

/** The main agent's model for this session, from the model pill: Auto or a gateway model, and the thinking level. */
export class ModelPopover implements PopoverContent {
  readonly element: HTMLElement;
  private view: View = { auto: true, models: [], levels: [] };
  /** What the shown rows were built from: the model list by reference (it arrives only when it changed), the rest as text. */
  private rendered: { models: ModelInfo[]; rest: string } | undefined;

  constructor(
    private readonly post: Post,
    private readonly close: () => void,
  ) {
    this.element = el("div", { class: "pop pop-model", "data-popover": "model", role: "dialog", "aria-label": "Модель главного агента" });
    this.element.addEventListener("keydown", (event) => this.onKey(event));
    this.render();
  }

  update(message: StateMessage): void {
    const { state, tab } = message;
    this.view = { auto: tab.modelMode === "auto", model: state.model, autoModel: state.autoModel, models: message.models ?? NO_MODELS, levels: message.thinkingLevels ?? [], level: state.thinkingLevel };
    // state arrives on every streamed delta; keep hover and focus
    if (this.rendered?.models !== this.view.models || this.rendered.rest !== this.restKey()) this.render();
  }

  private restKey(): string {
    const { models: _models, ...rest } = this.view;
    return JSON.stringify(rest);
  }

  private render(): void {
    const view = this.view;
    this.rendered = { models: view.models, rest: this.restKey() };
    const autoName = modelName(view.autoModel, view.models);
    const auto = this.choice("Auto", autoName !== undefined ? `Модель по ролям: ${autoName}` : "Модель по ролям из omo.jsonc", view.auto, () => this.choose("auto"));
    auto.setAttribute("data-role", "model-auto");

    const rows = GROUPS.flatMap((group) =>
      view.models
        .filter((info) => group.matches(info.provider))
        .map((info) => {
          const row = this.choice(info.name ?? info.id, describeModel(info, group.title), !view.auto && sameModel(view.model, info), () => this.choose({ provider: info.provider, id: info.id }));
          row.setAttribute("data-model", `${info.provider}/${info.id}`);
          return row;
        }),
    );

    this.element.replaceChildren(
      el("h4", {}, "Выбор модели"),
      auto,
      el("div", { class: "model-list", "data-role": "model-list" }, ...rows),
      el(
        "div",
        { class: "model-foot", "data-role": "model-foot" },
        ...(view.levels.length > 0 ? [this.effort()] : []),
        el("div", { class: "mrow note" }, el("span", { class: "s" }, "Субагенты всегда идут по ролям из omo.jsonc")),
      ),
    );
  }

  /** ↑/↓ walk Auto and the models; the focused row is scrolled into view inside the list. */
  private onKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...this.element.querySelectorAll<HTMLElement>("button.mrow")];
    const at = rows.findIndex((row) => row === document.activeElement);
    if (at < 0 && event.key === "ArrowUp") return;
    event.preventDefault();
    const target = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }

  private choice(name: string, description: string, checked: boolean, onClick: () => void): HTMLButtonElement {
    const row = el(
      "button",
      { type: "button", class: "mrow", role: "menuitemradio", "aria-checked": String(checked) },
      el("span", { class: "mtext" }, el("span", { class: "name" }, name), el("span", { class: "desc" }, description)),
    );
    row.classList.toggle("sel", checked);
    if (checked) row.append(el("span", { class: "check", "aria-hidden": "true" }, "✓"));
    row.addEventListener("click", onClick);
    return row;
  }

  /** «Мощность (level)» and a slider: one step per level, filled up to the chosen one, the knob on it. */
  private effort(): HTMLElement {
    const { levels, level } = this.view;
    const index = level === undefined ? -1 : levels.indexOf(level);
    const slider = el("div", {
      class: "slider",
      role: "slider",
      tabindex: "0",
      "aria-label": "Мощность",
      "aria-valuemin": "0",
      "aria-valuemax": String(levels.length - 1),
      "aria-valuenow": String(index),
      "aria-valuetext": level ?? "",
    });
    slider.append(
      ...levels.map((name, step) => {
        const cell = el("span", { class: "notch", "data-level": name, title: name });
        cell.classList.toggle("on", step <= index);
        cell.classList.toggle("cur", step === index);
        cell.addEventListener("click", () => this.think(name));
        return cell;
      }),
    );
    slider.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = levels[index + step];
      if (next !== undefined) this.think(next);
    });
    return el(
      "div",
      { class: "mrow effort" },
      el("span", { class: "name", "data-role": "effort-label" }, `Мощность (${level ?? "—"})`),
      slider,
    );
  }

  private choose(model: ModelRef | "auto"): void {
    this.post({ type: "setModel", model });
    this.close();
  }

  /** The level applies at once and the popover stays open; a slider driven by the keyboard keeps the focus. */
  private think(level: string): void {
    const keyboard = document.activeElement?.getAttribute("role") === "slider" && this.element.contains(document.activeElement);
    this.post({ type: "setThinking", level });
    this.view = { ...this.view, level };
    this.render();
    if (keyboard) this.element.querySelector<HTMLElement>('[role="slider"]')?.focus();
  }
}
