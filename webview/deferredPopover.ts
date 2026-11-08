import type { DeferredAction, DeferredDelivery, DeferredHostMessage, DeferredItem, DeferredResult } from "../src/panel/protocol";
import { button, el, type Post } from "./dom";
import type { PopoverContent } from "./popover";

type Row = { element: HTMLElement; item: DeferredItem; busy: boolean; error: HTMLElement; answer?: () => void; ready?: () => boolean };

/** Existing popover layout: one scrolling list, wrapping controls, no nested command scroller. */
export class DeferredPopover implements PopoverContent {
  readonly element: HTMLElement;
  private readonly list = el("div", { class: "deferred-list" });
  private readonly status = el("p", { class: "pop-empty", role: "status" }, "Загрузка…");
  private readonly all: HTMLButtonElement;
  private readonly rows = new Map<string, Row>();
  private deliveries: DeferredDelivery[] = [];

  constructor(private readonly post: Post, private readonly countChanged: (count: number) => void = () => undefined) {
    this.all = button("Ответить на все", { class: "secondary", "data-role": "deferred-all" }, () => {
      for (const row of this.rows.values()) if (!row.busy && row.ready?.()) row.answer?.();
    });
    this.all.disabled = true;
    this.element = el("div", { class: "pop pop-deferred", "data-popover": "deferred", role: "dialog", "aria-label": "Отложенные" },
      el("div", { class: "deferred-toolbar" }, el("h2", {}, "Отложенные"),
        button("Обновить", { class: "secondary" }, () => this.post({ type: "listDeferred" }))),
      this.status, this.list, this.all);
  }

  opened(): void {
    this.post({ type: "listDeferred" });
    this.element.querySelector<HTMLButtonElement>("button")?.focus();
  }

  update(message: Extract<DeferredHostMessage, { type: "deferred" }>): void {
    const items = [...message.items].sort((left, right) => right.deferredAt - left.deferredAt);
    const keys = new Set(items.map((item) => this.key(item)));
    for (const [key, row] of this.rows) {
      if (!keys.has(key)) {
        row.element.remove();
        this.rows.delete(key);
      }
    }
    for (const item of items) {
      const key = this.key(item);
      // Refreshes leave choices, custom words, focus and in-flight actions in place.
      if (!this.rows.has(key)) this.rows.set(key, this.row(item));
      const row = this.rows.get(key);
      if (row !== undefined) {
        row.item = item;
        const title = row.element.querySelector(".deferred-meta strong");
        if (title !== null) title.textContent = item.sessionTitle;
        const decided = row.element.querySelector<HTMLElement>(".deferred-decided");
        if (decided !== null && item.kind === "question") {
          decided.hidden = !item.decided;
          decided.textContent = item.decided ? `Агент продолжил: ${item.decided}` : "";
        }
      }
    }
    this.list.querySelectorAll("[data-delivery]").forEach((element) => element.remove());
    this.deliveries = message.deliveries ?? [];
    const ordered = [
      ...[...this.rows.values()].map((row) => ({ at: row.item.deferredAt, element: row.element })),
      ...this.deliveries.map((entry) => ({ at: entry.createdAt, element: this.delivery(entry) })),
    ].sort((left, right) => right.at - left.at);
    ordered.forEach(({ element }, index) => {
      const current = this.list.children[index];
      if (current !== element) this.list.insertBefore(element, current ?? null);
    });
    this.status.textContent = message.error ?? (ordered.length === 0 ? "Отложенных вопросов и команд нет" : "");
    this.status.hidden = ordered.length > 0 && message.error === undefined;
    this.changed();
  }

  result(message: DeferredResult): void {
    const key = `${message.kind}:${message.id}`;
    const row = this.rows.get(key);
    if (message.ok) {
      row?.element.remove();
      this.rows.delete(key);
      this.deliveries = this.deliveries.filter((entry) => this.key(entry) !== key);
      this.list.querySelectorAll<HTMLElement>("[data-delivery]").forEach((element) => {
        if (element.dataset["delivery"] === key) element.remove();
      });
    } else if (row !== undefined) {
      row.busy = false;
      row.error.textContent = message.reason;
      row.error.hidden = false;
      for (const control of row.element.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea")) control.disabled = false;
    }
    if (this.rows.size + this.deliveries.length === 0) {
      this.status.textContent = "Отложенных вопросов и команд нет";
      this.status.hidden = false;
    }
    this.changed();
  }

  private key(item: { kind: string; id: string }): string {
    return `${item.kind}:${item.id}`;
  }

  private changed(): void {
    this.all.disabled = ![...this.rows.values()].some((row) => !row.busy && row.ready?.());
    this.all.hidden = [...this.rows.values()].filter((row) => row.item.kind === "question").length < 2;
    this.countChanged(this.rows.size + this.deliveries.length);
  }

  private submit(row: Row, action: DeferredAction): void {
    if (row.busy) return;
    row.busy = true;
    row.error.hidden = true;
    for (const control of row.element.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea")) control.disabled = true;
    this.changed();
    this.post(action);
  }

  private row(item: DeferredItem): Row {
    const time = new Date(item.createdAt);
    const element = el("section", { class: "deferred-row", "data-deferred-id": item.id, "data-deferred-kind": item.kind },
      el("div", { class: "deferred-meta" }, el("strong", {}, item.sessionTitle),
        el("time", { datetime: time.toISOString(), title: time.toLocaleString("ru-RU") }, time.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }))));
    const error = el("p", { class: "deferred-error", role: "alert" });
    error.hidden = true;
    const row: Row = { element, item, error, busy: false };
    if (item.kind === "question") {
      const values: (() => string)[] = [];
      for (const question of item.questions) {
        const selected = new Set<string>();
        const custom = el("textarea", { rows: "2", maxlength: "2000", placeholder: "Свой ответ", "aria-label": `Свой ответ: ${question.question}` });
        custom.addEventListener("input", () => this.changed());
        const options = el("div", { class: "deferred-options" });
        for (const option of question.options) {
          const control = button(option.label, { class: "secondary", "data-role": "deferred-option", "aria-pressed": "false" }, () => {
            if (question.multiSelect) {
              if (selected.has(option.label)) selected.delete(option.label);
              else selected.add(option.label);
            } else {
              selected.clear();
              selected.add(option.label);
            }
            for (const sibling of options.querySelectorAll("button")) sibling.setAttribute("aria-pressed", String(selected.has(sibling.textContent ?? "")));
            this.changed();
          });
          options.append(control);
        }
        values.push(() => [question.options.filter((option) => selected.has(option.label)).map((option) => option.label).join(", "), custom.value.trim()].filter(Boolean).join("; "));
        element.append(el("fieldset", {}, el("legend", {}, question.header || "Вопрос"), el("p", { class: "deferred-question" }, question.question), options,
          el("label", { class: "deferred-label" }, "Свой ответ", custom)));
      }
      const decided = el("p", { class: "deferred-decided" });
      decided.hidden = true;
      element.append(decided);
      row.ready = () => values.every((value) => value().length > 0 && value().length <= 2000);
      row.answer = () => {
        if (!row.ready?.()) {
          error.textContent = "Ответьте на каждый вопрос, не больше 2000 символов на ответ";
          error.hidden = false;
          return;
        }
        this.submit(row, { type: "answerDeferredQuestion", id: item.id, answers: values.map((value) => value()) });
      };
      element.append(el("div", { class: "deferred-actions" },
        button("Ответить", {}, row.answer), button("Убрать", { class: "secondary" }, () => this.submit(row, { type: "dismissDeferredQuestion", id: item.id }))));
    } else {
      const command = el("pre", { class: "deferred-command" }, item.command);
      element.append(item.command.length > 180 || item.command.includes("\n")
        ? el("details", {}, el("summary", {}, el("code", {}, item.command.slice(0, 120) + "…")), command) : command);
      const words = el("textarea", { rows: "2", maxlength: "2000", "data-role": "deferred-reason", placeholder: "Причина запрета — необязательно", "aria-label": "Причина запрета для агента" });
      element.append(el("label", { class: "deferred-label" }, "Причина запрета — необязательно", words), el("div", { class: "deferred-actions" },
        button("Разрешить", {}, () => this.submit(row, { type: "answerDeferredApproval", id: item.id, decision: "allow-once" })),
        button("Запретить", { class: "secondary" }, () => this.submit(row, { type: "answerDeferredApproval", id: item.id, decision: "deny",
          ...(words.value.trim() ? { message: words.value.trim() } : {}) }))));
    }
    element.append(error);
    return row;
  }

  private delivery(entry: DeferredDelivery): HTMLElement {
    return el("section", { class: "deferred-row", "data-delivery": this.key(entry) },
      el("strong", {}, "Ответ ожидает доставки"), el("p", {}, entry.text), el("p", { class: "deferred-error", role: "alert" }, entry.reason),
      button("Повторить доставку", { class: "secondary" }, () => this.post({ type: "listDeferred" })));
  }
}
