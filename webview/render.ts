import type { Block } from "../src/chat/model";
import { applyDelta } from "../src/panel/delta";
import type { PendingView } from "../src/guard/admin";
import type {
  AgentDetailsMessage,
  DraftMessage,
  GuardStep,
  HostMessage,
  LadderMessage,
  MessageActionsMessage,
  QueueResultMessage,
  ReconnectingMessage,
  RewindPreviewMessage,
  RewoundMessage,
  SessionItem,
  StateDelta,
  StateMessage,
  UnwedgedMessage,
  WebviewMessage,
} from "../src/panel/protocol";
import type { LoginEvent } from "../src/settings/accounts";
import type { SettingsSection, SettingsState } from "../src/settings/protocol";
import { ActionsMenu } from "./actionsMenu";
import { AgentMap } from "./agentMap";
import { Composer } from "./composer";
import { deciderStep, Dock } from "./dock";
import { TodoStrip } from "./todo";
import { button, el, type Post } from "./dom";
import { Feed } from "./feed";
import { Header } from "./header";
import { Lightbox } from "./lightbox";
import { MessageMenu } from "./messageMenu";
import { ModelPopover } from "./modelPopover";
import { Popovers } from "./popover";
import { ReconnectDetails, ReconnectLine } from "./reconnectLine";
import { installRefocusGuard } from "./refocus";
import { RewindConfirm } from "./rewindConfirm";
import { SessionsPopover } from "./sessionsPopover";
import { SettingsModal } from "./settings/modal";
import { SlashMenu } from "./slashMenu";

const UNTITLED = "Новая сессия";
/** A key pressed in the composer this recently means the person is typing. */
const TYPING_MS = 800;

/** The chat tab's DOM: the composition root that wires header, feed, dialogs and composer. */
export class ChatView {
  private readonly header: Header;
  private readonly feed: Feed;
  /** The current plan over the composer while a turn runs. */
  private readonly todoStrip = new TodoStrip();
  private readonly composer: Composer;
  private readonly lightbox: Lightbox;
  private readonly popovers: Popovers;
  private readonly sessionsPopover: SessionsPopover;
  private readonly agentMap: AgentMap;
  private readonly modelPopover: ModelPopover;
  private readonly slashMenu: SlashMenu;
  private readonly actionsMenu: ActionsMenu;
  private readonly settingsModal: SettingsModal;
  private readonly messageMenu: MessageMenu;
  private readonly rewindConfirm: RewindConfirm;
  /** The connection's own line, over the composer, and the modal that carries the whole failure. */
  private readonly reconnectLine: ReconnectLine;
  private readonly reconnectDetails: ReconnectDetails;
  private readonly banner: HTMLElement;
  private readonly bannerText: HTMLElement;
  private readonly reconnect: HTMLButtonElement;
  private readonly empty: HTMLElement;
  /** Questions and approvals waiting for this tab, in the composer's place. */
  private readonly dock: Dock;
  private dockShown = false;
  /** When a key was last pressed in the composer: a prompt that comes while the person types does not take the focus. */
  private typedAt = Number.NEGATIVE_INFINITY;
  private dismissedError: string | undefined;
  private last: StateMessage | undefined;
  /** Messages posted and not yet answered (sending) or refused (not sent), shown until the host's state has them. */
  private readonly outgoing = new Map<string, Extract<Block, { kind: "user" }>>();

  constructor(
    root: HTMLElement,
    private readonly post: Post,
  ) {
    installRefocusGuard(); // the click that brings the window (or the panel) back only focuses it
    this.popovers = new Popovers(root, () => this.composer.input.focus());
    const close = (): void => this.popovers.close();
    /** A choice made in a popover: it closes and typing continues in the composer. */
    const choose = (): void => {
      close();
      this.composer.input.focus();
    };
    this.sessionsPopover = new SessionsPopover(post, choose);
    this.agentMap = new AgentMap(post, choose);
    this.modelPopover = new ModelPopover(post, choose);
    this.rewindConfirm = new RewindConfirm(post);
    this.messageMenu = new MessageMenu(post, this.rewindConfirm, close);
    this.reconnectDetails = new ReconnectDetails(post, () => ({ notice: this.reconnectLine.current, wait: this.reconnectLine.wait }), choose);
    this.reconnectLine = new ReconnectLine(post, () =>
      this.popovers.open(this.reconnectDetails, { anchor: this.reconnectDetails.element, side: "center" }),
    );

    const headerRoot = el("header");
    this.header = new Header(headerRoot, post, {
      onOpenSessions: (anchor) => this.popovers.toggle(this.sessionsPopover, { anchor, side: "below" }),
    });
    // A modal over the tab, opened from the «/» menu; Esc and ✕ close it like any popover.
    this.settingsModal = new SettingsModal(post, { show: () => this.popovers.open(this.settingsModal, { anchor: this.settingsModal.element, side: "center" }), hide: choose });
    this.lightbox = new Lightbox();

    this.bannerText = el("span", { class: "banner-text" });
    this.reconnect = button("Переподключить", { "data-role": "reconnect" }, () => {
      this.dismissedError = this.last?.state.error;
      this.renderBanner();
      this.post({ type: "reconnect" });
    });
    const dismiss = button("Скрыть", { class: "secondary", "data-role": "dismiss" }, () => {
      this.dismissedError = this.last?.state.error;
      this.renderBanner();
    });
    this.banner = el("div", { "data-role": "banner", class: "banner", role: "alert" }, this.bannerText, this.reconnect, dismiss);
    this.banner.hidden = true;

    this.empty = el("p", { class: "empty" }, "Опишите задачу. Enter — отправить, ⌥Enter — в очередь после текущего хода, Shift+Enter — новая строка.");
    const feedRoot = el("main");
    this.feed = new Feed(feedRoot, post, {
      tail: [this.empty],
      onOpenImage: (images, index) => this.lightbox.open(images, index),
      onMessageActions: (blockId, anchor) => {
        this.popovers.open(this.messageMenu, { anchor, side: "below" });
        this.messageMenu.show(blockId, anchor);
      },
      onRetry: (blockId) => {
        if (!this.composer.retry(blockId)) this.discard(blockId); // nothing to resend (the tab reloaded): just remove it
      },
      onDiscard: (blockId) => this.discard(blockId),
    });

    const composerRoot = el("footer");
    /** Popovers over the composer sit above its box, next to the button that opened them. */
    const above = (anchor: HTMLElement): { anchor: HTMLElement; side: "above"; level: HTMLElement } => ({ anchor, side: "above", level: this.composer.box });
    this.composer = new Composer(composerRoot, post, {
      dropZone: root,
      onAgents: (anchor) => this.popovers.toggle(this.agentMap, { anchor, side: "center" }), // a modal over the tab
      onModel: (anchor) => this.popovers.toggle(this.modelPopover, { ...above(anchor), stretch: true }),
      onSlash: (anchor) => this.popovers.toggle(this.actionsMenu, { ...above(anchor), stretch: true }), // the model picker's edges
      onInputKey: (event) => this.slashMenu.onKey(event),
      onOpenImage: (images, index) => this.lightbox.open(images, index),
      acceptsDrops: () => !this.lightbox.isOpen,
      onSend: (message) => this.showOutgoing(message),
    });
    const slashButton = composerRoot.querySelector('[data-role="slash"]') as HTMLElement;
    this.slashMenu = new SlashMenu({
      input: this.composer.field,
      show: () => this.popovers.open(this.slashMenu, { ...above(slashButton), inside: [this.composer.input], stretch: true }), // the model picker's edges
      hide: close,
    });
    this.composer.input.addEventListener("input", () => this.slashMenu.onInput());
    this.actionsMenu = new ActionsMenu({
      mode: () => this.composer.mode,
      setMode: (mode) => this.composer.setMode(mode),
      openSettings: () => this.settingsModal.open("connections"),
      done: choose,
    });

    composerRoot.insertBefore(this.reconnectLine.element, this.composer.box); // directly over the input, like the wedge under it
    composerRoot.prepend(this.todoStrip.element); // inside the floating footer: the feed's inset grows with it
    this.dock = new Dock({
      post,
      anchor: () => this.feed.anchor(),
      addRow: (id, element, after) => this.feed.addGuardRow(id, element, after),
      dropRow: (id) => this.feed.removeGuardRow(id),
      who: (session) => {
        const agent = this.last?.state.agents.find((row) => row.childSession === session);
        if (agent === undefined) return "главный агент";
        const model = agent.model?.split("/").pop();
        return model !== undefined && model !== "" ? `${agent.label} · ${model}` : agent.label;
      },
      onChange: () => this.dockChanged(),
    });
    composerRoot.append(this.dock.element); // the composer's slot: one of the two shows
    this.composer.input.addEventListener("keydown", () => {
      this.typedAt = Date.now();
    });
    // A prompt shown without the focus: Tab takes it there (the hint says so).
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || event.shiftKey || !this.dock.active || this.dock.element.contains(document.activeElement)) return;
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      event.preventDefault();
      this.dock.focus();
    });
    root.replaceChildren(headerRoot, this.banner, feedRoot, composerRoot, this.composer.overlay, this.lightbox.element, this.rewindConfirm.element);
    // The composer floats over the feed's bottom (CSS); the feed keeps room for it as it grows with text and attachments.
    new ResizeObserver(() => this.feed.setBottomInset(composerRoot.offsetHeight)).observe(composerRoot);
    for (const popover of [this.sessionsPopover, this.agentMap, this.modelPopover, this.slashMenu, this.actionsMenu, this.settingsModal, this.messageMenu, this.reconnectDetails])
      this.popovers.register(popover);
  }

  update(message: StateMessage): void {
    const stick = this.feed.stuck(); // measured before anything in the feed changes
    if (message.state.error !== this.last?.state.error) this.dismissedError = undefined;
    this.last = message;
    const { state, tab } = message;

    const title = state.title ?? tab.title ?? UNTITLED;
    this.header.update(title, tab.durableId, tab.pinned === true);
    this.sessionsPopover.setDraft(tab.draft === true ? title : undefined);
    this.composer.update(message);
    this.renderBanner();
    this.dock.setDialogs(state.dialogs);
    this.dock.setRunning(state.running);
    this.agentMap.update(message);
    this.modelPopover.update(message);
    this.slashMenu.setHidden(message.hiddenCommands);
    this.slashMenu.setCommands(message.commands);
    this.renderFeed(stick);
  }

  /** The host's blocks, then what was posted and is not among them yet. */
  private renderFeed(stick: boolean = this.feed.stuck()): void {
    const state = this.last?.state;
    const known = new Set((state?.blocks ?? []).map((block) => block.id));
    const blocks = [...(state?.blocks ?? []), ...[...this.outgoing.values()].filter((block) => !known.has(block.id))];
    this.renderEmpty();
    this.feed.update(blocks, state?.running ?? false, { activity: state?.activity, tool: state?.activityTool, waiting: this.dock.waiting }, stick);
    this.todoStrip.update(state?.blocks ?? [], state?.running ?? false);
  }

  /** A message in the feed the moment it is posted: its pictures under the ids the host's block will use. */
  private showOutgoing(message: Extract<WebviewMessage, { type: "send" }>): void {
    const images = message.images ?? [];
    images.forEach((image, index) => this.feed.image(`${message.id}:${index}`, `data:${image.mimeType};base64,${image.data}`));
    const refs = images.map((image, index) => ({ id: `${message.id}:${index}`, mimeType: image.mimeType, ...(image.name !== undefined ? { name: image.name } : {}) }));
    this.outgoing.set(message.id, { kind: "user", id: message.id, text: message.text, delivery: { state: "sending" }, ...(refs.length > 0 ? { images: refs } : {}) });
    this.renderFeed();
  }

  private discard(id: string): void {
    this.composer.forget(id);
    this.outgoing.delete(id);
    this.renderFeed();
  }

  /** What changed since the last state; without one to apply it to, the host is asked for the whole state. */
  delta(delta: StateDelta): void {
    if (this.last === undefined) {
      this.post({ type: "ready" });
      return;
    }
    this.update(applyDelta(this.last, delta));
  }

  /** The host's answer to `getImage`. */
  image(id: string, dataUrl: string): void {
    this.feed.image(id, dataUrl);
    this.lightbox.image(id, dataUrl);
    this.composer.image(id, dataUrl); // a message brought back by ↑ waits for its pictures
  }

  /** The host's answer to a send: an accepted message is the host's to show from now on; a refused one stays, as not sent. */
  sent(id: string, ok: boolean): void {
    this.composer.sent(id, ok);
    const block = this.outgoing.get(id);
    if (block === undefined) return;
    if (ok) this.outgoing.delete(id);
    else this.outgoing.set(id, { ...block, delivery: { state: "failed" } });
    this.renderFeed();
  }

  /** The host's answer to «Отозвать» / «Изменить» (a removed message's text arrives as a `draft`). */
  queueResult(message: QueueResultMessage): void {
    this.feed.queueResult(message.blockId, message.outcome);
  }

  /** The host's answer to `rename`. */
  renamed(ok: boolean, reason?: string): void {
    this.header.renamed(ok, reason);
    this.sessionsPopover.renamed();
  }

  /** The host's settings state, posted on `settingsGet` and after every change. */
  settings(state: SettingsState): void {
    this.settingsModal.update(state);
  }

  /** The host's answer to one `settingsAction`. */
  settingsResult(message: Extract<HostMessage, { type: "settingsResult" }>): void {
    this.settingsModal.result(message);
  }

  /** A subscription login's progress, prompt or end. */
  settingsLogin(event: LoginEvent): void {
    this.settingsModal.login(event);
  }

  /** The host opens the modal itself (first run: nothing is connected yet). */
  openSettings(section: SettingsSection, firstRun: boolean = false): void {
    this.settingsModal.open(section, firstRun);
  }

  /** The host's answer to `agentDetails`. */
  agentDetails(message: AgentDetailsMessage): void {
    this.agentMap.agentDetailsArrived(message);
  }

  /** The host's answer to `messageActions`: what the ↺ menu may offer. */
  messageActions(message: MessageActionsMessage): void {
    this.messageMenu.answer(message);
  }

  /** The host's answer to `rewindPreview`. */
  rewindPreview(message: RewindPreviewMessage): void {
    this.rewindConfirm.preview(message);
  }

  /** The host's answer to a confirmed `rewind`. */
  rewound(message: RewoundMessage): void {
    this.rewindConfirm.rewound(message);
  }

  /** A fork tab's first composer content. */
  draft(message: DraftMessage): void {
    void this.composer.prefill(message.text, message.images);
  }

  /** The host's answer to «Снять зависание». */
  unwedged(message: UnwedgedMessage): void {
    this.composer.unwedged(message);
  }

  /** The model ladder's line over the composer: the step it is walking, or the model it left the session on. */
  ladder(message: LadderMessage): void {
    this.composer.ladder(message.view);
  }

  /** The host is getting the connection back by itself: the line over the input, and the open modal follows it. */
  reconnecting(message: ReconnectingMessage): void {
    this.reconnectLine.update(message);
    this.reconnectDetails.refresh();
  }

  /** The project's sessions (this tab's own pin comes with the state, not from here). */
  sessions(items: SessionItem[]): void {
    this.sessionsPopover.update(items);
  }

  // ---------- guard ----------

  /** An open request: a panel in the composer's place (once, however often the host sends it). */
  guardRequest(request: PendingView, elsewhere: boolean, owner?: string): void {
    this.dock.addGuard(request, elsewhere, owner);
  }

  /** Answered or timed out: the panel lets it go, one line stays where it was asked. */
  guardResolved(id: string, decision: "allow" | "deny", by: string, message?: string): void {
    this.dock.resolveGuard(id, decision, by, message);
  }

  /** The service no longer has the request: a line without a verdict. */
  guardClosed(id: string): void {
    this.dock.closeGuard(id);
  }

  /** The host's word on a dialog answer. */
  answerResult(dialogId: string, outcome: "applied" | "closed" | "failed"): void {
    this.dock.dialogAnswered(dialogId, outcome);
  }

  guardAnswerFailed(id: string, error: string): void {
    this.dock.guardFailed(id, error);
  }

  /** A decider's verdict: a quiet «Решатель» line in the feed. */
  guardStep(step: GuardStep): void {
    this.feed.addGuardRow(`step:${step.id}`, deciderStep(step));
  }

  guardSilent(silent: boolean): void {
    this.dock.setSilent(silent);
  }

  /**
   * The panel came or went: the composer gives way to it and comes back as it was (text, attachments). Focus follows
   * when it was on the composer (or nowhere), so typing never lands in a hidden input.
   */
  private dockChanged(): void {
    const active = this.dock.active;
    if (active !== this.dockShown) {
      this.dockShown = active;
      const focused = document.activeElement;
      const typing = focused === this.composer.input || Date.now() - this.typedAt < TYPING_MS;
      this.composer.box.hidden = active;
      if (active && typing) this.composer.input.blur(); // no keystroke meant for the message lands on the prompt
      else if (active && (focused === null || focused === document.body)) this.dock.focus();
      if (!active && (focused === null || focused === document.body)) this.composer.input.focus();
    }
    if (this.last !== undefined) this.renderFeed(); // the feed's «Ждёт вашего …» line follows
  }

  private renderEmpty(): void {
    const state = this.last?.state;
    this.empty.hidden = (state !== undefined && state.blocks.length > 0) || this.outgoing.size > 0 || this.dock.active;
  }

  // ---------- banner ----------

  private renderBanner(): void {
    const error = this.last?.state.error;
    this.banner.hidden = error === undefined || error === this.dismissedError;
    this.bannerText.textContent = error ?? "";
    this.reconnect.hidden = this.last?.reconnectable !== true;
  }
}
