import { button, el, type Post } from "./dom";

/**
 * The confirmation before a compaction the person asks for from the context ring: a compaction rewrites the older part
 * of the conversation into a summary and cannot be undone, so a stray click must not start one. The same modal look as
 * the rewind confirmation; Esc and the backdrop cancel.
 */
export class CompactConfirm {
  readonly element: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private returnFocus: () => void = () => undefined;
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  constructor(private readonly post: Post) {
    this.confirmButton = button("Сжать", { "data-role": "compact-confirm" }, () => {
      this.post({ type: "compact" });
      this.close();
    });
    const panel = el(
      "div",
      { class: "rewind-confirm" },
      el("h2", { id: "compact-title" }, "Сжать контекст?"),
      el(
        "div",
        { class: "rc-body" },
        el("p", {}, "Агент перескажет старую часть разговора коротким конспектом и освободит место для работы. Подробности старых шагов останутся только в конспекте — вернуть их нельзя."),
        el("p", {}, "Сжатие занимает до минуты; его можно остановить кнопкой «Стоп»."),
      ),
      el("div", { class: "rc-actions" }, this.confirmButton, button("Отмена", { class: "secondary", "data-role": "compact-cancel" }, () => this.close())),
    );
    this.element = el(
      "div",
      { class: "rewind-confirm-backdrop", "data-role": "compact-confirm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "compact-title" },
      panel,
    );
    this.element.hidden = true;
    this.element.addEventListener("click", (event) => {
      if (event.target === this.element) this.close(); // the dimmed backdrop, not the panel
    });
  }

  open(returnFocus: () => void = () => undefined): void {
    this.returnFocus = returnFocus;
    if (this.element.hidden) document.addEventListener("keydown", this.onKey, true);
    this.element.hidden = false;
    this.confirmButton.focus();
  }

  private close(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    document.removeEventListener("keydown", this.onKey, true);
    this.returnFocus();
  }
}
