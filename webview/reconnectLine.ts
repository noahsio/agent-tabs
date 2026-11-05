import type { ReconnectingMessage, ReconnectTarget } from "../src/panel/protocol";
import { button, copyText, el, type Post } from "./dom";
import type { PopoverContent } from "./popover";

/** The notice without its `type`: what the line shows and the modal expands. */
type Notice = Extract<ReconnectingMessage, { active: true }>;

const DRAFT_SESSION = "новая сессия";
const TITLE = "Не удалось подключиться";

function seconds(left: number): number {
  return Math.max(0, Math.ceil(left / 1_000));
}

/** «попытка 3», or nothing before the first one has failed. */
function attemptSuffix(attempt: number): string {
  return attempt > 0 ? ` · попытка ${attempt}` : "";
}

/**
 * One line over the input while the extension is getting the session back by itself: a spinner and the countdown to
 * the next attempt, the way a messenger shows it. Nothing is asked of the person — «Повторить сейчас» is only there
 * for impatience — and the whole error waits in the details modal, so the line stays one row however long it is.
 */
export class ReconnectLine {
  readonly element: HTMLElement;
  private readonly spinner: HTMLElement;
  private readonly text: HTMLButtonElement;
  private readonly progress: HTMLElement;
  private readonly now: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly more: HTMLButtonElement;
  private notice: Notice | undefined;
  /** When the pause now running is out (webview clock), or undefined while an attempt is in flight. */
  private deadline: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly post: Post,
    private readonly openDetails: () => void,
  ) {
    this.spinner = el("span", { class: "reconnect-spin", "data-role": "reconnect-spin", "aria-hidden": "true" });
    this.text = button("", { class: "reconnect-text", "data-role": "reconnect-text", title: "Подробности" }, () => this.openDetails());
    this.progress = el("span", { class: "reconnect-progress", "data-role": "reconnect-progress" });
    this.now = button("Повторить сейчас", { class: "link", "data-role": "reconnect-now" }, () => this.post({ type: "reconnect" }));
    // Only shown when the extension refused to stop the holder by itself: the words beside it say what is running there.
    this.stop = button("Остановить ту копию", { class: "link", "data-role": "reconnect-stop" }, () => this.post({ type: "stopHolder" }));
    this.more = button("Подробнее", { class: "link reconnect-more", "data-role": "reconnect-more" }, () => this.openDetails());
    this.element = el(
      "div",
      { class: "reconnect", "data-role": "reconnect-line", role: "status" },
      this.spinner,
      this.text,
      this.progress,
      this.now,
      this.stop,
      this.more,
    );
    this.element.hidden = true;
  }

  /** What the modal shows, or undefined while there is nothing to retry. */
  get current(): Notice | undefined {
    return this.notice;
  }

  /** ms until the next attempt, or undefined while one is in flight. */
  get wait(): number | undefined {
    return this.deadline === undefined ? undefined : Math.max(0, this.deadline - Date.now());
  }

  /** The host's word on its own retry: a pause starts counting down, `active: false` takes the line away. */
  update(message: ReconnectingMessage): void {
    if (!message.active) {
      this.notice = undefined;
      this.deadline = undefined;
      this.stopTicking();
      this.element.hidden = true;
      this.render();
      return;
    }
    this.notice = message;
    this.deadline = message.waitMs === undefined ? undefined : Date.now() + message.waitMs;
    this.element.hidden = false;
    if (this.deadline === undefined) this.stopTicking();
    else this.timer ??= setInterval(() => this.render(), 500);
    this.render();
  }

  dispose(): void {
    this.stopTicking();
  }

  private stopTicking(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The message is the part that may be any length, so it takes the row and is clipped with an ellipsis; the countdown
   * and the attempt keep their own room at the end and are never pushed out of sight.
   */
  private render(): void {
    const notice = this.notice;
    // A line that has given up keeps «Подробнее» and loses «Повторить сейчас»: no click can free what holds the
    // session, and offering one would tell the same lie the red banner told.
    this.now.hidden = notice === undefined || notice.givenUp === true;
    this.stop.hidden = notice?.offerStop !== true;
    this.more.hidden = notice === undefined;
    if (notice === undefined) {
      this.text.textContent = this.progress.textContent = "";
      return;
    }
    const left = this.wait;
    this.text.textContent = notice.error;
    this.text.title = notice.error;
    this.progress.textContent =
      notice.givenUp === true
        ? `Попыток: ${notice.attempt}`
        : left === undefined
          ? `Переподключаюсь…${attemptSuffix(notice.attempt)}`
          : `Повтор через ${seconds(left)} с${attemptSuffix(notice.attempt)}${notice.capped ? " · всё ещё пробую" : ""}`;
    this.element.dataset["phase"] = notice.givenUp === true ? "held" : left === undefined ? "trying" : "waiting";
  }
}

/**
 * The whole failure behind that line: its full text, the host and session it was for, how many attempts there have
 * been and when the next one is. The tab's own modal chrome (the one the agent details card uses), so there is one
 * modal look in the extension and nothing new to learn.
 */
export class ReconnectDetails implements PopoverContent {
  readonly element: HTMLElement;
  private readonly error: HTMLElement;
  private readonly where: HTMLElement;
  private readonly attempts: HTMLElement;
  private readonly copy: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;

  constructor(
    post: Post,
    private readonly read: () => { notice: Notice | undefined; wait: number | undefined },
    private readonly hide: () => void,
  ) {
    const close = button("✕", { class: "icon-btn ad-close", "data-role": "reconnect-close", title: "Закрыть", "aria-label": "Закрыть" }, () => this.hide());
    this.error = el("div", { class: "ad-task", "data-role": "reconnect-error" });
    this.where = el("div", { class: "ad-task", "data-role": "reconnect-where" });
    this.attempts = el("div", { class: "ad-task", "data-role": "reconnect-attempts" });
    this.copy = button("Копировать", { class: "secondary", "data-role": "reconnect-copy" }, () => {
      void copyText(this.plainText()); // a clipboard the webview may not touch: nothing to tell
    });
    const retry = button("Повторить сейчас", { class: "secondary", "data-role": "reconnect-retry" }, () => {
      post({ type: "reconnect" });
      this.hide();
    });
    this.stop = button("Остановить ту копию", { class: "secondary", "data-role": "reconnect-details-stop" }, () => {
      post({ type: "stopHolder" });
      this.hide();
    });
    const panel = el(
      "div",
      { class: "agent-details", "data-role": "reconnect-details-panel", "data-status": "error" },
      el(
        "div",
        { class: "ad-head" },
        el("span", { class: "d", "aria-hidden": "true" }),
        el("h2", { id: "reconnect-details-title" }, TITLE),
        close,
      ),
      el(
        "div",
        { class: "ad-body" },
        el("section", { class: "ad-section" }, el("h3", {}, "Ошибка"), this.error),
        el("section", { class: "ad-section" }, el("h3", {}, "Куда подключаемся"), this.where),
        el("section", { class: "ad-section" }, el("h3", {}, "Попытки"), this.attempts),
      ),
      el("div", { class: "ad-actions" }, this.copy, this.stop, retry),
    );
    this.element = el(
      "div",
      { class: "agent-details-backdrop", "data-role": "reconnect-details", role: "dialog", "aria-modal": "true", "aria-labelledby": "reconnect-details-title" },
      panel,
    );
    this.element.addEventListener("click", (event) => {
      if (event.target === this.element) this.hide(); // the dimmed backdrop, not the panel
    });
  }

  /** Fills it from the line's current notice; the popover manager has already shown it. */
  opened(): void {
    this.render();
  }

  /** Keeps an open modal in step with the line (a new failure, the next pause). */
  refresh(): void {
    if (!this.element.hidden) this.render();
  }

  private render(): void {
    const { notice, wait } = this.read();
    this.error.textContent = notice?.error ?? "Соединение восстановлено";
    this.where.textContent = notice === undefined ? "" : whereText(notice.target);
    this.where.hidden = notice === undefined;
    this.attempts.textContent = notice === undefined ? "" : attemptsText(notice, wait);
    this.attempts.hidden = notice === undefined;
    this.copy.hidden = notice === undefined;
    this.stop.hidden = notice?.offerStop !== true;
  }

  private plainText(): string {
    const { notice, wait } = this.read();
    if (notice === undefined) return "";
    return [TITLE, notice.error, whereText(notice.target), attemptsText(notice, wait)].join("\n");
  }
}

function whereText(target: ReconnectTarget): string {
  return `Хост omo: ${target.host}\nСессия: ${target.session ?? DRAFT_SESSION}`;
}

function attemptsText(notice: Notice, wait: number | undefined): string {
  const made = `Автоматических попыток: ${notice.attempt}`;
  // A stop on offer is the one thing a click CAN do here, so the modal must not say the opposite.
  if (notice.offerStop === true) return `${made}\nБольше не пробую: путь освободит только остановка той копии — это решаете вы`;
  if (notice.givenUp === true) return `${made}\nБольше не пробую: повтор ничего не изменит, пока файл сессии держат`;
  const next = wait === undefined ? "Попытка идёт сейчас" : `Следующая через ${seconds(wait)} с`;
  return notice.capped ? `${made}\n${next} (пауза дошла до предела — продолжаю с этим интервалом)` : `${made}\n${next}`;
}
