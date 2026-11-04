import type { AgentRow } from "../src/chat/model";
import type { AgentDetails, AgentDetailsMessage } from "../src/panel/protocol";
import { button, el, type Post } from "./dom";
import { renderMarkdown } from "./feed";

/** A running agent's details are asked again at most this often (at once only when its status changes). */
const REFRESH_MS = 3000;
/** An answer this late is taken as lost: the next tick asks again. */
const LOST_MS = 2 * REFRESH_MS;
/** A task longer than this is clamped to four lines until «показать всё». */
const LONG_TASK_LINES = 4;
const LONG_TASK_CHARS = 280;

/**
 * «Агент»: a modal over the agent map with what OmO knows about one task — its description, result (markdown) and
 * transcript. While it is open and the agent runs, the details are re-read every REFRESH_MS (not while the webview is
 * hidden), one request at a time, and at once when its status changes (for the final result). A DAG node has no task
 * of its own: only its row is shown.
 */
export class AgentDetailsModal {
  readonly element: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly note: HTMLElement;
  private readonly gone: HTMLElement;
  private readonly failure: HTMLElement;
  private readonly taskSection: HTMLElement;
  private readonly task: HTMLElement;
  private readonly more: HTMLButtonElement;
  private readonly resultSection: HTMLElement;
  private readonly result: HTMLElement;
  private readonly error: HTMLElement;
  private readonly log: HTMLDetailsElement;
  private readonly transcript: HTMLElement;
  private readonly stop: HTMLButtonElement;
  private readonly copy: HTMLButtonElement;
  private readonly file: HTMLButtonElement;
  private readonly onKey = (event: KeyboardEvent): void => this.onKeyDown(event);
  private readonly onVisibility = (): void => this.schedule();
  private agent: AgentRow | undefined;
  private details: AgentDetails | undefined;
  private failureReason: string | undefined;
  private taskExpanded = false;
  /** The markdown last rendered, so a refresh that brings the same result keeps the reader's selection. */
  private shownResult: string | undefined;
  /** The agent's row is no longer in the state: nothing more to ask. */
  private vanished = false;
  private inFlight = false;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  /** The status changed while a request was in flight: ask once more when it answers. */
  private again = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private returnFocus: () => void = () => undefined;

  constructor(
    private readonly post: Post,
    private readonly metaText: (agent: AgentRow, now: number) => string,
  ) {
    this.title = el("h2", { "data-role": "agent-details-title", id: "agent-details-title" });
    this.closeButton = button("✕", { class: "icon-btn ad-close", "data-role": "agent-details-close", title: "Закрыть", "aria-label": "Закрыть" }, () => this.close());
    this.meta = el("p", { class: "ad-meta", "data-role": "agent-details-meta" });
    this.note = el("p", { class: "ad-muted", "data-role": "agent-details-note" }, "У узла графа нет отдельного журнала");
    this.gone = el("p", { class: "ad-muted", "data-role": "agent-details-gone" }, "Агент больше не в списке");
    this.failure = el("p", { class: "ad-failure error", "data-role": "agent-details-failure", role: "alert" });
    this.task = el("div", { class: "ad-task", "data-role": "agent-details-task" });
    this.more = button("показать всё", { class: "link", "data-role": "agent-details-more" }, () => {
      this.taskExpanded = true;
      this.render();
    });
    this.taskSection = el("section", { class: "ad-section" }, el("h3", {}, "Задача"), this.task, this.more);
    this.result = el("div", { "data-role": "agent-details-result" });
    this.result.addEventListener("click", (event) => this.onLink(event));
    this.error = el("p", { class: "ad-error error", "data-role": "agent-details-error" });
    this.resultSection = el("section", { class: "ad-section" }, el("h3", {}, "Результат"), this.result, this.error);
    this.transcript = el("pre", { class: "ad-transcript" });
    this.log = el("details", { class: "ad-log", "data-role": "agent-details-log" }, el("summary", {}, "Ход работы"), this.transcript);
    this.stop = button("Остановить", { class: "secondary danger", "data-role": "agent-details-stop" }, () => {
      const taskId = this.agent?.taskId;
      if (taskId !== undefined) this.post({ type: "agentCancel", taskId }); // the status changes when the host reports it
    });
    this.copy = button("Копировать результат", { class: "secondary", "data-role": "agent-details-copy" }, () => {
      const result = this.details?.result;
      if (result !== undefined) navigator.clipboard?.writeText(result).catch(() => undefined); // no clipboard access: nothing to tell
    });
    this.file = button("Открыть как файл", { class: "secondary", "data-role": "agent-details-file" }, () => {
      const taskId = this.agent?.taskId;
      if (taskId !== undefined) this.post({ type: "agentOutput", taskId });
    });
    this.panel = el(
      "div",
      { class: "agent-details", "data-role": "agent-details-panel" },
      el("div", { class: "ad-head" }, el("span", { class: "d", "aria-hidden": "true" }), this.title, this.closeButton),
      this.meta,
      el("div", { class: "ad-body" }, this.note, this.gone, this.failure, this.taskSection, this.resultSection, this.log),
      el("div", { class: "ad-actions" }, this.stop, this.copy, this.file),
    );
    this.element = el(
      "div",
      { class: "agent-details-backdrop", "data-role": "agent-details", role: "dialog", "aria-modal": "true", "aria-labelledby": "agent-details-title" },
      this.panel,
    );
    this.element.hidden = true;
    this.element.addEventListener("click", (event) => {
      if (event.target === this.element) this.close(); // the dimmed backdrop, not the panel
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Shows one agent; `returnFocus` runs when the person closes it (back to its card on the map). */
  open(agent: AgentRow, returnFocus: () => void): void {
    this.agent = agent;
    this.details = undefined;
    this.failureReason = undefined;
    this.taskExpanded = false;
    this.shownResult = undefined;
    this.vanished = false;
    this.inFlight = false;
    this.lastRequestAt = Number.NEGATIVE_INFINITY;
    this.again = false;
    this.returnFocus = returnFocus;
    this.log.open = false;
    this.transcript.scrollTop = 0;
    if (!this.isOpen) {
      document.addEventListener("keydown", this.onKey, true); // before the map's own Esc
      document.addEventListener("visibilitychange", this.onVisibility);
      this.element.hidden = false;
    }
    this.render();
    this.request();
    this.schedule();
    this.closeButton.focus();
  }

  /** The agents from the latest state: a status change asks at once; tokens and the rest wait for the timer. */
  update(agents: AgentRow[]): void {
    const current = this.agent;
    if (!this.isOpen || current === undefined) return;
    const row = agents.find((candidate) => candidate.id === current.id);
    this.vanished = row === undefined; // keeps what it showed, asks no more
    if (row !== undefined) {
      const statusChanged = row.status !== current.status;
      this.agent = row;
      if (statusChanged) this.request();
    }
    this.render();
    this.schedule();
  }

  /** The running duration, every second while the map ticks. */
  tick(now: number): void {
    if (this.isOpen && this.agent !== undefined) setText(this.meta, this.metaText(this.agent, now));
  }

  /** The host's answer to `agentDetails`; one for another agent is dropped. */
  receive(message: AgentDetailsMessage): void {
    if (!this.isOpen || message.taskId !== this.agent?.taskId) return;
    this.inFlight = false;
    if (message.ok) {
      this.details = message;
      this.failureReason = undefined;
    } else this.failureReason = message.reason;
    this.render();
    if (this.again) {
      this.again = false;
      this.request();
    }
    this.schedule();
  }

  /** `restoreFocus` is false when the map itself closes: the focus goes where the map sends it. */
  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.agent = undefined;
    this.schedule();
    if (restoreFocus) this.returnFocus();
  }

  private request(): void {
    const taskId = this.agent?.taskId;
    if (taskId === undefined || this.vanished) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    this.lastRequestAt = Date.now();
    this.post({ type: "agentDetails", taskId });
  }

  /** A timer tick: asks when REFRESH_MS have passed since the last request, and gives up on an answer after LOST_MS. */
  private refresh(): void {
    const since = Date.now() - this.lastRequestAt;
    if (this.inFlight && since >= LOST_MS) this.inFlight = this.again = false;
    if (!this.inFlight && since >= REFRESH_MS) this.request();
  }

  /** The timer runs while the details are open and visible on a running task (or one still waiting for an answer). */
  private schedule(): void {
    const agent = this.agent;
    const wanted =
      this.isOpen && !document.hidden && !this.vanished && agent?.taskId !== undefined && (agent.status === "running" || this.inFlight);
    if (wanted && this.timer === undefined) this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    if (!wanted && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private render(): void {
    const agent = this.agent;
    if (agent === undefined) return;
    this.panel.dataset["status"] = agent.status;
    setText(this.title, agent.label);
    setText(this.meta, this.metaText(agent, Date.now()));
    this.meta.hidden = this.meta.textContent === "";
    const task = agent.taskId !== undefined;
    this.note.hidden = task;
    this.gone.hidden = !this.vanished;
    this.failure.hidden = !task || this.failureReason === undefined;
    setText(this.failure, this.failureReason === undefined ? "" : `Не удалось получить данные агента: ${this.failureReason}`);
    this.stop.hidden = !task || this.vanished || agent.status !== "running";
    this.file.hidden = !task;
    this.copy.hidden = this.details?.result === undefined;
    if (!task) {
      this.taskSection.hidden = this.resultSection.hidden = this.log.hidden = true;
      return;
    }
    this.renderTask(this.details?.prompt);
    this.renderResult(agent);
    const transcript = this.details?.transcript;
    this.log.hidden = transcript === undefined;
    if (transcript !== undefined) setText(this.transcript, transcript);
  }

  private renderTask(prompt: string | undefined): void {
    this.taskSection.hidden = prompt === undefined;
    if (prompt === undefined) return;
    setText(this.task, prompt);
    const long = prompt.split("\n").length > LONG_TASK_LINES || prompt.length > LONG_TASK_CHARS;
    this.task.classList.toggle("clamped", long && !this.taskExpanded);
    this.more.hidden = !long || this.taskExpanded;
  }

  private renderResult(agent: AgentRow): void {
    const details = this.details;
    const status = details?.status ?? agent.status;
    const result = details?.result;
    this.error.hidden = details?.error === undefined;
    setText(this.error, details?.error ?? "");
    this.resultSection.hidden = false;
    this.result.hidden = false;
    if (result !== undefined) {
      if (this.shownResult !== result) {
        this.result.className = "markdown";
        this.result.innerHTML = renderMarkdown(result);
        this.shownResult = result;
      }
      return;
    }
    this.shownResult = undefined;
    this.result.className = "ad-muted";
    setText(this.result, this.placeholder(status, details) ?? "");
    this.result.hidden = this.result.textContent === "";
    this.resultSection.hidden = this.result.hidden && this.error.hidden;
  }

  /** What stands in for a result that is not there (nothing when the error or the failure says it). */
  private placeholder(status: AgentRow["status"], details: AgentDetails | undefined): string | undefined {
    if (status === "running" || status === "waiting") return "Агент ещё работает…";
    if (details === undefined) return this.failureReason === undefined ? "Загрузка…" : undefined;
    return details.error === undefined ? "Результата нет" : undefined;
  }

  /** Links in the result leave through the host, as in the feed. */
  private onLink(event: MouseEvent): void {
    const link = (event.target as Element | null)?.closest("a");
    if (link === null || link === undefined) return;
    event.preventDefault();
    const url = link.getAttribute("href");
    if (url !== null && url !== "") this.post({ type: "openLink", url });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault(); // the map stays open: its Esc skips a handled event
    event.stopPropagation();
    this.close();
  }
}

/** Rewrites an element's text only when it changed, so a refresh keeps what the reader selected. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
