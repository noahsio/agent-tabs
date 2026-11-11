import { untitledName, type AgentRow } from "../src/chat/model";
import type { AgentDetailsMessage, ModelInfo, StateMessage } from "../src/panel/protocol";
import { AgentDetailsModal } from "./agentDetails";
import { modelName } from "./composer";
import { button, el, type Post } from "./dom";
import type { PopoverContent } from "./popover";

const UNTITLED = "Новая сессия";

/** The Russian noun form for a count: 1 агент, 2 агента, 5 агентов. */
function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return one;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

/** «850 токенов», «58,1 тыс. токенов». */
export function tokensText(tokens: number): string {
  if (tokens < 1000) return `${tokens} ${plural(tokens, "токен", "токена", "токенов")}`;
  return `${(tokens / 1000).toFixed(1).replace(".", ",")} тыс. токенов`;
}

/** «41 с», «2 мин 5 с», «1 ч 2 мин» from start to end, or to now while the agent runs; undefined before it starts. */
export function elapsedText(agent: AgentRow, now: number): string | undefined {
  const end = agent.endedAt ?? (agent.status === "running" ? now : undefined);
  if (agent.startedAt === undefined || end === undefined) return undefined;
  const total = Math.max(0, Math.floor((end - agent.startedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return minutes > 0 ? `${minutes} мин ${seconds} с` : `${seconds} с`;
}

/** An agent's `provider/model_id` as the catalog names it, else the bare id. */
function agentModel(qualified: string | undefined, models: ModelInfo[]): string | undefined {
  const slash = qualified?.indexOf("/") ?? -1;
  if (qualified === undefined || slash <= 0) return qualified;
  return modelName({ provider: qualified.slice(0, slash), id: qualified.slice(slash + 1) }, models);
}

/** «GPT 6 Astra · 18 с · 31,0 тыс. токенов». */
function cardMeta(agent: AgentRow, now: number, models: ModelInfo[]): string {
  return [agentModel(agent.model, models), elapsedText(agent, now), agent.tokens === undefined ? undefined : tokensText(agent.tokens)]
    .filter((part) => part !== undefined)
    .join(" · ");
}

/** The card's meta plus the agent's role (category or agent type), for the details modal. */
function detailsMeta(agent: AgentRow, now: number, models: ModelInfo[]): string {
  return [cardMeta(agent, now, models), agent.role ?? ""].filter((part) => part !== "").join(" · ");
}

/** Running agents first, then the newest; agents that never started last. */
function ordered(agents: AgentRow[]): AgentRow[] {
  return [...agents].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity));
}

/**
 * «Карта агентов»: a modal over the tab, opened from the agents pill. The session on the left, its agents as cards on
 * the right joined to it by lines; a card opens the agent's details over the map, ⌥-click stops a running one.
 */
export class AgentMap implements PopoverContent {
  readonly element: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly rootTitle: HTMLElement;
  private readonly rootMeta: HTMLElement;
  private readonly rootNode: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly details: AgentDetailsModal;
  private agents: AgentRow[] = [];
  private models: ModelInfo[] = [];
  private rendered = "";
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly post: Post,
    private readonly close: () => void,
  ) {
    const cross = button("✕", { class: "icon-btn am-close", "data-role": "agent-map-close", title: "Закрыть", "aria-label": "Закрыть" }, () => this.close());
    this.subtitle = el("p", { class: "am-sub", "data-role": "agent-map-subtitle" });
    this.rootTitle = el("b", { "data-role": "agent-map-root-title" });
    this.rootMeta = el("span", { class: "s", "data-role": "agent-map-root-meta" });
    this.rootNode = el("div", { class: "am-node am-root", "data-role": "agent-map-root" }, el("span", { class: "d", "aria-hidden": "true" }), el("span", { class: "main" }, this.rootTitle, this.rootMeta));
    this.cards = el("div", { class: "am-cards" });
    this.panel = el(
      "div",
      { class: "agent-map", "data-role": "agent-map-panel" },
      el("div", { class: "am-head" }, el("h2", { "data-role": "agent-map-title" }, "Карта агентов"), cross),
      this.subtitle,
      el("div", { class: "am-body" }, this.rootNode, this.cards),
    );
    this.details = new AgentDetailsModal(post, (agent, now) => detailsMeta(agent, now, this.models));
    // Inside the map: a click in the details is a click inside the map, and the map's backdrop stays under them.
    this.element = el("div", { class: "agent-map-backdrop", "data-popover": "agents", role: "dialog", "aria-modal": "true", "aria-label": "Карта агентов" }, this.panel, this.details.element);
    this.element.addEventListener("click", (event) => {
      if (event.target === this.element) this.close(); // the dimmed backdrop, not the panel
    });
  }

  update(message: StateMessage): void {
    const { state, tab } = message;
    this.agents = ordered(state.agents);
    this.models = message.models ?? [];
    this.rootTitle.textContent = state.title ?? tab.title ?? untitledName(state.blocks) ?? UNTITLED;
    const model = modelName(state.model, message.models ?? []);
    this.rootMeta.textContent = [model, state.contextTokens === undefined ? undefined : `${tokensText(state.contextTokens)} в контексте`].filter((part) => part !== undefined).join(" · ");
    this.rootMeta.hidden = this.rootMeta.textContent === "";
    this.rootNode.dataset["status"] = state.running ? "running" : "done";
    const key = JSON.stringify([this.agents, this.models]);
    if (key !== this.rendered) this.render(); // state arrives on every streamed delta; keep hover and focus
    this.details.update(this.agents);
    this.tick();
  }

  opened(): void {
    this.render();
    this.tick();
    this.element.querySelector<HTMLElement>('[data-role="agent-map-close"]')?.focus();
  }

  closed(): void {
    this.details.close(false);
    this.tick();
  }

  /** The host's answer to `agentDetails`. */
  agentDetailsArrived(message: AgentDetailsMessage): void {
    this.details.receive(message);
  }

  private render(): void {
    this.rendered = JSON.stringify([this.agents, this.models]);
    const count = this.agents.length;
    this.subtitle.textContent = `${count} ${plural(count, "агент", "агента", "агентов")} · нажмите на агента, чтобы открыть подробности`;
    this.subtitle.hidden = count === 0;
    if (count === 0) {
      this.cards.replaceChildren(el("div", { class: "am-empty" }, "Субагентов пока нет"));
      return;
    }
    const now = Date.now();
    this.cards.replaceChildren(...this.agents.map((agent) => el("div", { class: "am-link" }, this.card(agent, now))));
  }

  /** A card opens the agent's details; ⌥ stops a running task (a DAG node has nothing to stop). */
  private card(agent: AgentRow, now: number): HTMLElement {
    const meta = cardMeta(agent, now, this.models);
    const parts = [
      el("span", { class: "d", "aria-hidden": "true" }),
      el("span", { class: "main" }, el("b", { "data-role": "agent-label" }, agent.label), ...(meta !== "" ? [el("span", { class: "s", "data-role": "agent-meta" }, meta)] : [])),
    ];
    const taskId = agent.taskId;
    const title = taskId === undefined ? "Клик — подробности" : "Клик — подробности, ⌥ клик — остановить";
    const card = el("button", { type: "button", class: "am-node", "data-row": "", "data-agent": agent.id, "data-status": agent.status, title }, ...parts);
    card.addEventListener("click", (event) => {
      if (event.altKey && taskId !== undefined && agent.status === "running") {
        this.post({ type: "agentCancel", taskId });
        return; // the card stays: its status changes when the host reports it
      }
      this.details.open(agent, () => this.focusCard(agent.id));
    });
    return card;
  }

  /** Cards are rebuilt as the agents change: the focus goes to the one showing this agent now. */
  private focusCard(id: string): void {
    [...this.cards.querySelectorAll<HTMLElement>("[data-row]")].find((card) => card.dataset["agent"] === id)?.focus();
  }

  /** Durations tick once a second, only while the map is open and something runs. */
  private tick(): void {
    const wanted = !this.element.hidden && this.agents.some((agent) => agent.status === "running");
    if (wanted && this.ticker === undefined) this.ticker = setInterval(() => this.refreshTimes(), 1000);
    if (!wanted && this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private refreshTimes(): void {
    const now = Date.now();
    const cards = this.cards.querySelectorAll<HTMLElement>("[data-row]"); // rebuilt whenever the agents change, so they line up
    this.agents.forEach((agent, index) => {
      const meta = cards[index]?.querySelector<HTMLElement>('[data-role="agent-meta"]');
      if (meta !== null && meta !== undefined) meta.textContent = cardMeta(agent, now, this.models);
    });
    this.details.tick(now);
  }
}
