import { randomBytes } from "node:crypto";
import path from "node:path";
import { tabTitle } from "./tabTitle";
import * as vscode from "vscode";
import type { ModelRef } from "../chat/model";
import { initialState } from "../chat/reducer";
import type { DaemonManager } from "../daemon";
import type { DeferredInbox } from "../deferred/inbox";
import { redact } from "../env";
import type { ApprovalPanel, GuardApprovals } from "../guard/approvals";
import type { Checkpointer } from "../rewind/checkpointer";
import type { ForkDraft } from "../rewind/fork";
import { claimAutoUnwedge, releaseAutoUnwedge } from "../sessions/autoUnwedge";
import { SessionController, normalizeSessionName, type CommandRow, type TabState } from "../sessions/controller";
import type { ReapOutcome } from "../sessions/reapHost";
import { heldPause, ReconnectLoop } from "../sessions/reconnect";
import { classifyOpen, giveUpText, heldByAnotherHostCopy, type Holder } from "../sessions/refusal";
import { levelToApply } from "../sessions/rememberedLevels";
import type { LoginEvent } from "../settings/accounts";
import type { Ladder } from "../settings/ladder";
import { SETTINGS_UNAVAILABLE, type SettingsResult } from "../settings/protocol";
import type { SettingsService } from "../settings/service";
import type { Catalog } from "./catalog";
import { MessageActions } from "./messageActions";
import { StatePoster } from "./poster";
import {
  type AgentDetailsMessage,
  type GuardHostMessage,
  type DeferredHostMessage,
  isExternalLink,
  parseWebviewMessage,
  rejectedSendId,
  type ModelInfo,
  type SessionItem,
  type StateMessage,
  type WebviewMessage,
} from "./protocol";
import type { PanelRegistry } from "./registry";
import { runningCwds, withArchived, withPin } from "./sessionsList";
import { sendAndAck } from "./send";

export const CHAT_VIEW_TYPE = "agentTabs.chat";
const UNTITLED = "Новая сессия";

/**
 * The editor group a tab opens in: the one it was asked from, else the active one. Always a concrete column, never
 * `Active` and never `Beside` — a locked editor group refuses those and VS Code makes a new group beside it instead,
 * so the session would open away from the tabs the person already has.
 */
export function targetColumn(column?: vscode.ViewColumn): vscode.ViewColumn {
  return column !== undefined && column > 0 ? column : vscode.window.tabGroups.activeTabGroup.viewColumn;
}

/** What every tab shares within one extension host. */
export type PanelHost = {
  extensionUri: vscode.Uri;
  registry: PanelRegistry<ChatPanel>;
  /** Every open tab, including ones whose session has no file yet. */
  panels: Set<ChatPanel>;
  /** The lists a session last loaded in this environment (stored across windows): what a draft offers in its pickers. */
  readonly catalog: Readonly<Catalog>;
  /** A session loaded one of its lists: the catalog (and its stored copy) takes it. */
  updateCatalog(part: Catalog): void;
  /** Calls `listener` after the catalog took a part (a draft repaints); returns the unsubscribe. */
  onCatalogChange(listener: () => void): () => void;
  /** The window's models without any session (through the settings' accounts service); absent while the environment is incomplete. */
  fetchModels?: () => Promise<ModelInfo[]>;
  /** The level this model was last set to, from OmO's own per-model memory; absent while the environment is incomplete. */
  rememberedLevel?: (model: ModelRef) => string | undefined;
  secrets: readonly string[];
  /** Redacting Output-channel logger. */
  log(text: string): void;
  /** The one daemon manager (created on first use), or the reason there can be none. */
  daemon(): { ok: true; value: DaemonManager } | { ok: false; error: string };
  /** Saved sessions of the project joined with live status and pins. */
  listSessions(currentPath: string | undefined): Promise<SessionItem[]>;
  setPinned(durableId: string, pinned: boolean): Promise<void>;
  isPinned(durableId: string): boolean;
  setArchived(durableId: string, archived: boolean): Promise<void>;
  /** Focuses the tab showing the session, else opens one in the given editor group (the active one when absent). */
  openSession(sessionPath: string, column?: vscode.ViewColumn): Promise<void>;
  /** Opens a new session's tab in the given editor group (the active one when absent). */
  newSession(column?: vscode.ViewColumn): void;
  /** Restarts OmO for this environment after the person confirms. */
  restartHost(): void;
  /** True when the path is one of this project's saved sessions. */
  isProjectSession(sessionPath: string): Promise<boolean>;
  /** Opens an agent's (already redacted) output as a read-only document. */
  showOutput(taskId: string, label: string, content: string): Promise<void>;
  /** This window's settings; absent while the environment is incomplete. */
  settings?: SettingsService;
  /** True once per window while nothing is connected: that tab opens «Подключения» by itself. */
  firstRun?: () => Promise<boolean>;
  /** The «/» menu's hidden commands (the same array until they change); absent while the environment is incomplete. */
  hiddenCommands?: () => readonly string[];
  /** This environment's model ladder, read on demand so an edit in the modal counts from the next failure on. */
  ladder?: () => Ladder;
  /** The window's approval cards (one guard subscription for every tab); absent while the environment is incomplete. */
  guard?: Pick<GuardApprovals, "answer" | "replay" | "panelsChanged">;
  deferred?: Pick<DeferredInbox, "refresh" | "answer">;
  /** Snapshots and the checkpoint log; absent when the environment is incomplete. */
  checkpointer?: Checkpointer;
  /** Opens a forked session in a new tab whose composer starts with `draft`; the tab names the session `name` once it is open. */
  openFork(sessionPath: string, draft: ForkDraft, column?: vscode.ViewColumn, name?: string): void;
  /**
   * Stops a second copy of this environment's own host that holds a session file, when every proof of safety holds —
   * `force` is the person's own say-so, which skips the proofs of idleness and keeps those of attribution. One attempt
   * per holder for the whole window, and every tab blocked by that holder gets this same answer. Absent while the
   * environment is incomplete (there is no host to have a second copy of).
   */
  stopDuplicateHost?: (holder: Holder | undefined, options?: { force?: boolean }) => Promise<ReapOutcome>;
};

export type Opening =
  /** A draft: no session exists until the first message is sent. */
  | { kind: "new"; cwd: string }
  /** `durableId` is set when the person picked the session from the list: warn if it is open elsewhere. */
  | { kind: "attach"; sessionPath: string; saved?: TabState; durableId?: string; draft?: ForkDraft; name?: string };

const COMMANDS_DEBOUNCE_MS = 500;
const LEVELS_DEBOUNCE_MS = 300;
const NOT_OPEN = "Сессия не открыта";
/** The feed's own words for the restart the extension did without being asked. */
const AUTO_UNWEDGE_DONE = "Агент не ответил на «Стоп» — перезапустил сессию";
const AUTO_UNWEDGE_FAILED = "Не удалось перезапустить сессию";
const CONNECTION_LOST = "Связь с omo потеряна — переподключаюсь…";
/** The confirming word of the dialog «Остановить ту копию» opens. */
const STOP_HOLDER = "Остановить";
/** What the line says between the duplicate host going away and the session being open again. */
const REOPENING = "Файл сессии освободился — открываю заново";
const NOT_REOPENED = "Сессию не удалось открыть заново";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One editor tab = one webview = one SessionController. */
export class ChatPanel implements ApprovalPanel {
  private controller: SessionController | undefined;
  private actions: MessageActions | undefined;
  /** A fork tab's composer text and images, posted once after the webview's first `ready`. */
  private forkDraft: ForkDraft | undefined;
  /** Approvals of this tab's own session waiting for the person (the editor tab title is marked meanwhile). */
  private readonly awaitingGuard = new Set<string>();
  /** The name the editor tab title was last made from. */
  private titleName: string | undefined;
  private models: ModelInfo[] | undefined;
  private commands: CommandRow[] | undefined;
  private thinkingLevels: string[] | undefined;
  /** The last list posted to the webview: a pin or an archive mark only flips a flag in it. */
  private sessionItems: SessionItem[] | undefined;
  private commandsTimer: NodeJS.Timeout | undefined;
  private levelsTimer: NodeJS.Timeout | undefined;
  /** Bumped per fetch: an answer that is no longer the latest request's is dropped (an older list never wins). */
  private commandsFetch = 0;
  private levelsFetch = 0;
  private banner: string | undefined;
  /**
   * The tab's own retry of a connection it cannot reach: it waits out the schedule's pause and attempts again by
   * itself, and the webview shows that as one line over the composer. The top banner is left to what the person must
   * act on (an incomplete environment, a session error the quiet line is not already carrying) — a connection failure
   * the retry line already shows is never echoed there too (see `publish`).
   */
  private readonly retry = new ReconnectLoop(
    () => void this.runAttempt(),
    () => this.postRetry(),
  );
  private reconnectable = true;
  /** Attempts this tab has spent on a held session file: its own budget, apart from the connection schedule. */
  private heldAttempt = 0;
  /** Who the host last said holds this session file: what the line names once it stops trying. */
  private heldBy: Holder | undefined;
  /** The feed's line about a duplicate host this tab stopped, waiting for the session it unblocked to open. */
  private stopped: string | undefined;
  private key: string | undefined;
  private disposed = false;
  /** Set once the webview asked for the settings: from then on every change is posted to it. */
  private settingsWanted = false;
  private readonly onSettingsChanged = (): void => {
    this.publish(); // the hidden «/» commands may have changed; the poster sends only what did
    if (this.settingsWanted) void this.postSettings();
  };
  /** Bumped per fetch: only the latest model list wins. */
  private modelsFetch = 0;
  /** A connection or a role changed: the composer's model picker is stale. */
  private readonly onModelsChanged = (): void => {
    void this.refreshModels();
  };
  private readonly unsubscribeCatalog: () => void;
  private readonly onSettingsLogin = (event: LoginEvent): void => {
    if (this.settingsWanted) this.poster.send({ type: "settingsLogin", event });
  };
  /** In flight while the session is being opened; messages wait for it. */
  private starting: Promise<void> | undefined;
  /** A draft's model, thinking level and name, applied when its session is created. */
  private readonly pending: { model?: ModelRef | "auto"; level?: string; name?: string } = {};
  private readonly poster: StatePoster;
  private readonly tab: TabState;

  static create(host: PanelHost, opening: Opening, column?: vscode.ViewColumn): ChatPanel {
    const panel = vscode.window.createWebviewPanel(CHAT_VIEW_TYPE, UNTITLED, targetColumn(column), {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(host.extensionUri, "dist"), vscode.Uri.joinPath(host.extensionUri, "media")],
    });
    return new ChatPanel(host, panel, opening);
  }

  /** Takes over a panel VS Code restored after a reload. */
  static restore(host: PanelHost, panel: vscode.WebviewPanel, opening: Opening): ChatPanel {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(host.extensionUri, "dist"), vscode.Uri.joinPath(host.extensionUri, "media")],
    };
    return new ChatPanel(host, panel, opening);
  }

  private constructor(
    private readonly host: PanelHost,
    private readonly panel: vscode.WebviewPanel,
    private readonly opening: Opening,
  ) {
    this.tab = opening.kind === "attach" ? { modelMode: "auto", ...opening.saved, sessionPath: opening.sessionPath } : { modelMode: "auto" };
    this.forkDraft = opening.kind === "attach" ? opening.draft : undefined;
    this.poster = new StatePoster((json) => void panel.webview.postMessage(json), host.secrets);
    panel.iconPath = { light: vscode.Uri.joinPath(host.extensionUri, "media", "mark-light.svg"), dark: vscode.Uri.joinPath(host.extensionUri, "media", "mark-dark.svg") };
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw));
    panel.onDidDispose(() => this.dispose());
    host.panels.add(this);
    host.settings?.on("changed", this.onSettingsChanged);
    host.settings?.on("login", this.onSettingsLogin);
    host.settings?.on("models", this.onModelsChanged);
    this.unsubscribeCatalog = host.onCatalogChange(() => {
      if (this.noSession && !this.disposed) this.publish(); // a draft shows the window's catalog
    });
    this.track(this.tab.sessionPath);
    if (opening.kind === "attach") this.open();
    else this.checkEnvironment(); // a draft: the session is created by the first send
    this.publish();
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** An untouched draft: a new tab whose session is not being created and does not exist (nothing sent, or the create failed). */
  get isDraft(): boolean {
    return this.noSession && this.starting === undefined && !this.disposed;
  }

  /** True once the tab has a live session (it can ask OmO for the model list itself). */
  get hasSession(): boolean {
    return this.controller !== undefined;
  }

  /** The live session's durable id (UUID): the guard names a session by it. */
  get durableId(): string | undefined {
    return this.controller?.tabState.durableId;
  }

  runsChild(session: string): boolean {
    return this.controller?.state.agents.some((agent) => agent.childSession === session) === true;
  }

  /** Redacted with the window's live secrets on the way out, like every post. */
  postGuard(message: GuardHostMessage): void {
    const before = this.awaitingGuard.size;
    if (message.type === "guardRequest" && message.elsewhere !== true) this.awaitingGuard.add(message.request.id);
    else if (message.type === "guardResolved" || message.type === "guardClosed") this.awaitingGuard.delete(message.id);
    this.poster.send(message);
    if (this.awaitingGuard.size !== before && this.titleName !== undefined) this.setTitle(this.titleName);
  }

  postDeferred(message: DeferredHostMessage): void {
    this.poster.send(message);
  }

  /** A later answer uses the tab's existing controller and OmO's durable admission ID. */
  async sendDeferred(text: string, clientMessageId: string): Promise<boolean> {
    await this.starting;
    return this.controller?.send(text, "auto", [], clientMessageId) ?? false;
  }

  /** The editor tab's title, marked while the tab waits for the person (an OmO dialog, or an approval of its own session). */
  private setTitle(name: string): void {
    this.titleName = name;
    const waiting = (this.controller?.state.dialogs.length ?? 0) > 0 || this.awaitingGuard.size > 0;
    this.panel.title = tabTitle(redact(name, this.host.secrets), waiting);
  }

  /** A new tab with no session yet: choices are kept in `pending`, nothing reaches the daemon. */
  private get noSession(): boolean {
    return this.opening.kind === "new" && this.controller === undefined;
  }

  /** A draft still tells at once what keeps it from ever starting. */
  private checkEnvironment(): void {
    const daemon = this.host.daemon();
    if (daemon.ok) return;
    this.banner = daemon.error;
    this.reconnectable = false;
  }

  /**
   * Daemon connection news, fanned out by the extension to every tab. Every one of these is about the connection, so
   * it goes to the line over the composer, not the banner: while the daemon manager runs its own retries the line
   * spins, and once it gives up this tab's own loop takes over and keeps trying with growing pauses.
   */
  onDaemon(event: "connected" | "disconnected" | "gave_up", reason?: string): void {
    if (event === "connected") {
      this.banner = undefined;
      this.poster.reset(); // a new connection re-opens the session: the webview gets it whole
      if (this.controller === undefined && this.reconnectable && !this.noSession) {
        // A new connection may be a new host process, so whoever held the file may be gone: the budget starts over.
        this.heldAttempt = 0;
        this.retry.trying(); // a tab that failed to open retries; `start` reports the outcome
        this.open();
      } else this.retry.stop(); // the connection was all that was missing
    } else if (event === "disconnected") this.retry.trying(CONNECTION_LOST);
    else this.retry.failed(`Не удалось переподключиться к omo: ${reason ?? "причина неизвестна"}`);
    this.publish();
  }

  private open(): void {
    if (this.starting !== undefined || this.disposed) return;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
  }

  private async start(): Promise<void> {
    const daemon = this.host.daemon();
    if (!daemon.ok) {
      this.retry.stop(); // no environment to connect to: retrying would change nothing
      this.banner = daemon.error;
      this.reconnectable = false;
      this.publish();
      return;
    }
    let controller: SessionController;
    try {
      // No «open elsewhere» guess from list_sessions: `attachments` also counts OmO's own holds (subagent task hosts,
      // retained sessions after a reload), so it warned about sessions nobody had open. A real conflict is OmO's own
      // `session_path_in_use` on attach, which the controller reports.
      const log = (text: string): void => this.host.log(text);
      controller =
        this.opening.kind === "new"
          ? await SessionController.create(daemon.value, this.opening.cwd, undefined, this.host.checkpointer, log)
          : await SessionController.attach(daemon.value, this.opening.sessionPath, this.opening.saved, undefined, this.host.checkpointer, log); // no saved state: mode inferred
      // A draft's choices go in before its first message (a refused one shows in the state; the message still goes).
      if (this.pending.model !== undefined && this.pending.model !== "auto") await controller.setModel(this.pending.model);
      controller.setStickyMode(this.tab.stickyMode);
      if (this.pending.level !== undefined) await controller.setThinkingLevel(this.pending.level);
      else if (this.opening.kind === "new") await this.applyRememberedLevel(controller);
      if (this.pending.name !== undefined) await this.nameCreated(controller, this.pending.name);
      if (this.opening.kind === "attach" && this.opening.name !== undefined) await this.nameCreated(controller, this.opening.name); // a fork
    } catch (error) {
      this.host.log(`Не удалось открыть сессию: ${errorText(error)}`);
      this.openFailed(error, daemon.value);
      this.publish();
      return;
    }
    if (this.disposed) {
      void controller.release();
      return;
    }
    this.controller = controller;
    const ladder = this.host.ladder;
    if (ladder !== undefined) controller.setLadder({ ladder, view: (view) => this.poster.send({ type: "ladder", view: view ?? null }) });
    const checkpointer = this.host.checkpointer;
    if (checkpointer !== undefined) {
      const manager = daemon.value;
      this.actions = new MessageActions({
        controller,
        checkpointer,
        runningCwds: async () => runningCwds(await manager.client()), // a failure is «unknown»: the service refuses with its reason
        openFork: (sessionPath, draft, name) => this.host.openFork(sessionPath, draft, this.panel.viewColumn, name),
      });
    }
    this.banner = undefined;
    this.heldBy = undefined;
    this.heldAttempt = 0;
    this.retry.stop(); // the session is open: the line goes and the schedule starts over
    controller.on("change", () => this.publish());
    controller.on("surfaces", () => this.scheduleCommands());
    controller.on("model", () => this.scheduleLevels()); // the levels belong to the model
    controller.on("attached", () => {
      // whatever changed while we were away: the whole state, the model's levels and the loaded commands
      this.poster.reset();
      this.publish();
      void this.refreshLevels();
      void this.refreshCommands();
    });
    // The duplicate host this tab had stopped: said once, in the session it unblocked, so the person can audit it.
    const stopped = this.stopped;
    this.stopped = undefined;
    if (stopped !== undefined) controller.note("info", stopped);
    this.publish();
    void this.loadLists(controller); // messages need not wait for the pickers' lists
  }

  /**
   * A session the person just created starts at the level its model is remembered at. OmO records that level itself
   * and restores it on a model switch, but the model a session *starts* on takes its level from the profile, whose
   * `model:level` pin outranks that memory — so the level the person picked was lost in every new session. See
   * `levelToApply`: only OmO's own `explicit` stamp gives way, and only here, once, before the first message. What the
   * host reports is also the session's level, so the composer never shows a step of the profile's own startup.
   */
  private async applyRememberedLevel(controller: SessionController): Promise<void> {
    const model = controller.state.model;
    if (model === undefined) return;
    const reported = await controller.modelThinkingLevel(model);
    if (reported === undefined) return; // a host that cannot say leaves the session exactly as it opened
    const level = levelToApply(reported, this.host.rememberedLevel?.(model));
    if (level !== undefined) await controller.setThinkingLevel(level);
    else controller.noteThinkingLevel(reported.level); // nothing to restore: show the level the session is really on
  }

  /**
   * A tab with a session asks OmO and keeps the window catalog current. A draft has no session: it repaints from the
   * catalog the other tabs update, and asks the settings' accounts service itself only when no tab has a session.
   */
  private async refreshModels(): Promise<void> {
    if (this.disposed) return;
    const controller = this.controller;
    if (controller === undefined && (!this.noSession || this.host.fetchModels === undefined || [...this.host.panels].some((panel) => panel.hasSession))) return;
    const fetch = ++this.modelsFetch;
    try {
      const models = await (controller !== undefined ? controller.models() : (this.host.fetchModels as () => Promise<ModelInfo[]>)());
      if (fetch !== this.modelsFetch || this.disposed) return;
      if (controller !== undefined) this.models = models; // a draft keeps reading the window catalog
      this.host.updateCatalog({ models });
      this.publish();
    } catch (error) {
      this.host.log(`Список моделей недоступен: ${errorText(error)}`);
    }
  }

  private async loadLists(controller: SessionController): Promise<void> {
    const fetch = ++this.modelsFetch;
    try {
      const models = await controller.models();
      if (fetch === this.modelsFetch) {
        this.models = models;
        this.host.updateCatalog({ models });
        this.publish();
      }
    } catch (error) {
      this.host.log(`Список моделей недоступен: ${errorText(error)}`);
    }
    await this.refreshLevels();
    await this.refreshCommands();
  }

  private scheduleLevels(): void {
    if (this.disposed) return;
    if (this.levelsTimer !== undefined) clearTimeout(this.levelsTimer);
    this.levelsTimer = setTimeout(() => {
      this.levelsTimer = undefined;
      void this.refreshLevels();
    }, LEVELS_DEBOUNCE_MS);
  }

  private async refreshLevels(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined || this.disposed) return;
    const fetch = ++this.levelsFetch;
    try {
      const levels = await controller.thinkingLevels();
      if (fetch !== this.levelsFetch) return;
      this.thinkingLevels = levels;
      this.host.updateCatalog({ thinkingLevels: levels });
    } catch (error) {
      this.host.log(`Уровни размышления недоступны: ${errorText(error)}`);
    }
    this.publish();
  }

  private scheduleCommands(): void {
    if (this.disposed) return;
    if (this.commandsTimer !== undefined) clearTimeout(this.commandsTimer);
    this.commandsTimer = setTimeout(() => {
      this.commandsTimer = undefined;
      void this.refreshCommands();
    }, COMMANDS_DEBOUNCE_MS);
  }

  private async refreshCommands(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined || this.disposed) return;
    const fetch = ++this.commandsFetch;
    try {
      const commands = await controller.commands();
      if (fetch !== this.commandsFetch) return;
      this.commands = commands;
      this.host.updateCatalog({ commands });
    } catch (error) {
      this.host.log(`Список команд недоступен: ${errorText(error)}`);
    }
    this.publish();
  }

  /** A draft's name is cosmetic: a refused one is logged and the first message still goes. */
  private async nameCreated(controller: SessionController, name: string): Promise<void> {
    try {
      await controller.rename(name);
    } catch (error) {
      this.host.log(`Не удалось назвать сессию: ${errorText(error)}`);
    }
  }

  /** Renames this tab's session (a draft keeps the name for its session); the editor tab title follows at once. */
  async rename(name: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.noSession) {
      this.pending.name = name;
      this.setTitle(name);
      this.publish();
      return { ok: true };
    }
    const controller = this.controller;
    if (controller === undefined) return { ok: false, reason: "Сессия не открыта" };
    try {
      await controller.rename(name);
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
    this.setTitle(name);
    this.publish();
    return { ok: true };
  }

  private onMessage(raw: unknown): void {
    const message = parseWebviewMessage(raw);
    if (message === undefined) {
      const id = rejectedSendId(raw);
      if (id !== undefined) this.poster.send({ type: "sent", id, ok: false });
      return;
    }
    this.handle(message).catch((error: unknown) => this.host.log(`Ошибка обработки «${message.type}»: ${errorText(error)}`));
  }

  private async handle(message: WebviewMessage): Promise<void> {
    // Must answer even while the session opens (a restart is how a stuck one gets unstuck). Opening another session
    // or a new one is the window's business, not this tab's: a slow open here must never swallow that click.
    const popover =
      message.type === "listSessions" ||
      message.type === "pin" ||
      message.type === "archive" ||
      message.type === "openSession" ||
      message.type === "newSession" ||
      message.type === "restartHost" ||
      message.type === "settingsGet" ||
      message.type === "settingsAction" ||
      message.type === "listDeferred" ||
      message.type === "answerDeferredQuestion" ||
      message.type === "dismissDeferredQuestion" ||
      message.type === "answerDeferredApproval" ||
      message.type === "guardAnswer";
    if (message.type === "send" && this.isDraft) this.open(); // the first message creates the draft's session
    if (message.type !== "ready" && message.type !== "reconnect" && !popover) await this.starting;
    const controller = this.controller;
    const draft = this.noSession;
    switch (message.type) {
      case "ready":
        this.poster.reset(); // a (re)loaded webview has no state to apply a delta to
        this.publish();
        this.postRetry(); // a reloaded webview is told again that a retry is running
        this.host.guard?.replay(this);
        if (this.host.deferred !== undefined) void this.host.deferred.refresh();
        else this.postDeferred({ type: "deferred", items: [] });
        void this.offerFirstRun();
        if (this.forkDraft !== undefined) {
          this.poster.send({ type: "draft", ...this.forkDraft });
          this.forkDraft = undefined;
        }
        return;
      case "send": {
        // The line over the composer already says the connection is being got back: no second word about it up top.
        if (controller === undefined && this.banner === undefined && this.retry.view === undefined) {
          this.banner = "Сессия не открыта — сообщение не отправлено";
          this.publish();
        }
        // The one place a person's own message enters, and so the one place the ladder is ever armed.
        controller?.watchForLadder(message.id, message.text, message.images ?? []);
        await sendAndAck(controller, message, (reply) => this.poster.send(reply));
        return;
      }
      case "dequeue": {
        const result = controller === undefined ? { outcome: "failed" as const } : await controller.dequeue(message.blockId);
        if (result.outcome === "removed") this.poster.send({ type: "draft", text: result.text, images: result.images }); // back to the composer
        this.poster.send({ type: "queueResult", blockId: message.blockId, outcome: result.outcome });
        return;
      }
      case "editQueued": {
        const result = controller === undefined ? { outcome: "failed" as const } : await controller.editQueued(message.blockId, message.text);
        this.poster.send({ type: "queueResult", blockId: message.blockId, outcome: result.outcome });
        return;
      }
      case "stop": {
        if (controller !== undefined && !controller.state.running) {
          if (controller.state.background !== undefined) {
            const answer = await vscode.window.showWarningMessage("Остановить фоновые задачи?", { modal: true }, { title: "Остановить" });
            if (answer?.title === "Остановить") await controller.stopBackground();
          }
          return;
        }
        // A person's «Стоп» is an explicit way out: clear the auto-restart ration so the bounded restart the composer
        // falls back to (when abort does not end the turn) is never declined because an earlier automatic one spent it.
        const durableId = controller?.sessionUuid;
        if (durableId !== undefined) releaseAutoUnwedge(durableId);
        await controller?.stop();
        return;
      }
      // The person's click on «Снять зависание», or the composer's own single attempt after an unanswered «Стоп».
      // Always answered, a refusal included.
      case "unwedge":
        if (message.auto === true) await this.autoUnwedge(controller);
        else
          this.poster.send({
            type: "unwedged",
            ...(controller === undefined ? { outcome: "failed" as const, reason: NOT_OPEN } : await controller.unwedgeSession()),
          });
        return;
      case "ladderInterrupt":
        controller?.interruptLadder();
        return;
      case "compact":
        await controller?.compact();
        return;
      case "answer": {
        const outcome = controller !== undefined ? await controller.answer(message.dialogId, message.answer) : "failed";
        this.poster.send({ type: "answerResult", dialogId: message.dialogId, outcome });
        return;
      }
      case "setModel":
        if (draft) {
          this.pending.model = message.model;
          this.publish();
        } else await controller?.setModel(message.model);
        return;
      case "setMode":
        if (controller !== undefined) controller.setStickyMode(message.mode ?? undefined);
        else if (message.mode === null) delete this.tab.stickyMode;
        else this.tab.stickyMode = message.mode;
        this.publish();
        return;
      case "reconnect":
        await this.reconnect();
        return;
      case "stopHolder":
        await this.stopHolderOnRequest();
        return;
      case "openLink":
        if (isExternalLink(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      case "openFile": {
        // A tool's relative path is relative to the session's folder; with no folder known there is nothing to resolve it against.
        const folder = controller?.cwd ?? (this.opening.kind === "new" ? this.opening.cwd : undefined);
        const file = path.isAbsolute(message.path) ? message.path : folder === undefined ? undefined : path.resolve(folder, message.path);
        if (file === undefined) return;
        const at = message.line === undefined ? undefined : new vscode.Range(message.line - 1, 0, message.line - 1, 0);
        // `vscode.open` picks the editor that fits the file (text, image preview, …); `showTextDocument` opens text only.
        try {
          await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: true, ...(at !== undefined ? { selection: at } : {}) });
        } catch (error) {
          void vscode.window.showWarningMessage(`Не удалось открыть ${file}: ${errorText(error)}`);
        }
        return;
      }
      case "setThinking":
        if (draft) {
          this.pending.level = message.level;
          this.publish();
        } else await controller?.setThinkingLevel(message.level);
        return;
      case "rename":
        await this.renameSession(message.name, message.sessionPath);
        return;
      case "pin":
        try {
          await this.host.setPinned(message.durableId, message.pinned);
        } finally {
          this.publish(); // the tab's pinned flag, stored or not
        }
        if (this.sessionItems === undefined) await this.postSessions();
        else this.postItems(withPin(this.sessionItems, message.durableId, message.pinned));
        return;
      case "archive": {
        let stored = true;
        try {
          await this.host.setArchived(message.durableId, message.archived);
        } catch (error) {
          stored = false;
          this.host.log(`Не удалось сохранить архив: ${errorText(error)}`);
        }
        // Always answers: a failed store re-reads the list, so the webview's own flip is undone.
        if (stored && this.sessionItems !== undefined) this.postItems(withArchived(this.sessionItems, message.durableId, message.archived));
        else await this.postSessions();
        return;
      }
      case "listSessions":
        await this.postSessions();
        return;
      case "listDeferred":
        if (this.host.deferred !== undefined) await this.host.deferred.refresh();
        else this.postDeferred({ type: "deferred", items: [] });
        return;
      case "answerDeferredQuestion":
      case "dismissDeferredQuestion":
      case "answerDeferredApproval":
        if (this.host.deferred !== undefined) await this.host.deferred.answer(message);
        else this.postDeferred({ type: "deferredResult", id: message.id, kind: message.type === "answerDeferredApproval" ? "approval" : "question",
          ok: false, reason: "Среда не подключена" });
        return;
      case "openSession":
        await this.host.openSession(message.sessionPath, this.panel.viewColumn); // in the group of the tab it was asked from
        return;
      case "newSession":
        this.host.newSession(this.panel.viewColumn); // in the group of the tab it was asked from
        return;
      case "restartHost":
        this.host.restartHost();
        return;
      case "getImage": {
        const image = await controller?.image(message.id);
        // A miss still answers (empty dataUrl), so the webview stops waiting.
        this.poster.send({ type: "image", id: message.id, dataUrl: image === undefined ? "" : `data:${image.mimeType};base64,${image.data}` });
        return;
      }
      case "agentOutput":
        await this.showAgentOutput(controller, message.taskId);
        return;
      case "agentDetails":
        this.poster.send(await this.agentDetails(controller, message.taskId)); // redacted on the way out, like every post
        return;
      case "agentCancel":
        try {
          await controller?.cancelTask(message.taskId);
        } catch (error) {
          this.warn(errorText(error));
        }
        return;
      // The ↺ menu always gets an answer: without a session (or checkpoints) every action is refused with a reason.
      case "messageActions": {
        const closed = { ok: false as const, reason: NOT_OPEN };
        this.poster.send(this.actions ? await this.actions.menu(message.blockId) : { type: "messageActions", blockId: message.blockId, fork: closed, rewind: closed });
        return;
      }
      case "rewindPreview":
        this.poster.send(
          this.actions
            ? await this.actions.preview(message.blockId, message.fork)
            : { type: "rewindPreview", blockId: message.blockId, fork: message.fork, excerpt: "", ok: false, reason: NOT_OPEN },
        );
        return;
      case "rewind": {
        if (this.actions === undefined) {
          this.poster.send({ type: "rewound", blockId: message.blockId, ok: false, reason: NOT_OPEN });
          return;
        }
        const { rewound, preview } = await this.actions.rewind(message.blockId, message.fork, message.fingerprint);
        if (preview !== undefined) this.poster.send(preview); // the plan changed: the confirmation shows the new one first
        this.poster.send(rewound);
        return;
      }
      case "fork": {
        const result = this.actions ? await this.actions.fork(message.blockId) : { ok: false as const, reason: NOT_OPEN };
        if (!result.ok) {
          // In the feed as well as a toast: a toast is easy to miss (do-not-disturb), and «nothing happened» is not an answer.
          this.host.log(`Ответвление не удалось: ${result.reason}`);
          this.controller?.note("warn", `Не удалось ответвить разговор: ${result.reason}`);
          this.warn(result.reason);
        }
        return;
      }
      case "settingsGet":
        this.settingsWanted = true;
        await this.postSettings();
        return;
      case "settingsAction": {
        let result: SettingsResult;
        try {
          result = this.host.settings === undefined ? { ok: false, error: SETTINGS_UNAVAILABLE } : await this.host.settings.perform(message.section, message.action);
        } catch {
          result = { ok: false, error: "Не удалось применить изменение" }; // the error may quote the action: not logged
        }
        this.poster.send({ type: "settingsResult", id: message.id, ...result }); // the action itself never goes back
        return;
      }
      case "guardAnswer":
        await this.host.guard?.answer(this, message.id, message.decision, message.message);
        return;
    }
  }

  /**
   * «Стоп» went unanswered, so the extension restarts the session itself instead of asking. Rationed per durable
   * session (src/sessions/autoUnwedge.ts): the second time within the cooldown nothing is unloaded and the webview
   * falls back to offering «Снять зависание». Whatever happens is said once in the feed, where it stays.
   */
  private async autoUnwedge(controller: SessionController | undefined): Promise<void> {
    const durableId = controller?.sessionUuid;
    if (controller === undefined || durableId === undefined) {
      this.poster.send({ type: "unwedged", auto: true, outcome: "failed", reason: NOT_OPEN });
      return;
    }
    if (!controller.state.running) {
      this.poster.send({ type: "unwedged", auto: true, outcome: "refused", reason: "Ход уже завершён" });
      return;
    }
    if (!claimAutoUnwedge(durableId)) {
      this.poster.send({ type: "unwedged", auto: true, outcome: "cooldown" });
      return;
    }
    const result = await controller.unwedgeSession("агент не ответил на «Стоп»");
    if (result.outcome === "unloaded") controller.note("info", AUTO_UNWEDGE_DONE);
    else controller.note("warn", `${AUTO_UNWEDGE_FAILED}: ${result.reason}`);
    this.poster.send({ type: "unwedged", auto: true, ...result });
  }

  /** Never holds the tab: asked in the background, and only the first tab of the window ever gets a yes. */
  private async offerFirstRun(): Promise<void> {
    try {
      if ((await this.host.firstRun?.()) === true && !this.disposed) this.poster.send({ type: "openSettings", section: "connections", firstRun: true });
    } catch (error) {
      this.host.log(`Проверка первого запуска не удалась: ${errorText(error)}`);
    }
  }

  /** Always answers: without an environment, or when the state cannot be read, with the reason instead. */
  private async postSettings(): Promise<void> {
    const settings = this.host.settings;
    if (settings === undefined) {
      this.poster.send({ type: "settings", state: { unavailable: SETTINGS_UNAVAILABLE } });
      return;
    }
    try {
      this.poster.send({ type: "settings", state: await settings.state() });
    } catch (error) {
      this.host.log(`Настройки недоступны: ${errorText(error)}`);
      this.poster.send({ type: "settings", state: { unavailable: "Настройки недоступны — подробности в канале «Agent Tabs»" } });
    }
  }

  /** Always answers: on failure with the items it has (the last list, else none). */
  private async postSessions(): Promise<void> {
    let items: SessionItem[];
    try {
      items = await this.host.listSessions(this.controller?.tabState.sessionPath ?? this.tab.sessionPath);
    } catch (error) {
      this.host.log(`Список сессий недоступен: ${errorText(error)}`);
      items = this.sessionItems ?? [];
    }
    this.postItems(items);
  }

  private postItems(items: SessionItem[]): void {
    this.sessionItems = items;
    this.poster.send({ type: "sessions", items });
  }

  private async renameSession(rawName: string, sessionPath: string | undefined): Promise<void> {
    const name = normalizeSessionName(rawName);
    const own = this.controller?.tabState.sessionPath ?? this.tab.sessionPath;
    let result: { ok: true } | { ok: false; reason: string };
    if (name === "") result = { ok: false, reason: "Имя не может быть пустым" };
    else if (sessionPath === undefined || sessionPath === own) result = await this.rename(name);
    else {
      const other = this.host.registry.get(sessionPath);
      if (other !== undefined) result = await other.rename(name);
      else if (await this.host.isProjectSession(sessionPath)) result = await this.renameClosed(sessionPath, name);
      else result = { ok: false, reason: "Это не сессия текущего проекта" };
    }
    this.poster.send({ type: "renamed", ...result });
  }

  private async renameClosed(sessionPath: string, name: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const daemon = this.host.daemon();
    if (!daemon.ok) return { ok: false, reason: daemon.error };
    try {
      await SessionController.renameClosed(daemon.value, sessionPath, name);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }

  private async showAgentOutput(controller: SessionController | undefined, taskId: string): Promise<void> {
    if (controller === undefined) return;
    try {
      const content = redact(await controller.taskOutput(taskId), this.host.secrets);
      const label = controller.state.agents.find((agent) => agent.taskId === taskId)?.label ?? taskId;
      await this.host.showOutput(taskId, redact(label, this.host.secrets), content);
    } catch (error) {
      this.warn(errorText(error));
    }
  }

  /** Always answers, a failure included: the modal shows it, not a VS Code warning. */
  private async agentDetails(controller: SessionController | undefined, taskId: string): Promise<AgentDetailsMessage> {
    if (controller === undefined) return { type: "agentDetails", taskId, ok: false, reason: "Сессия не открыта" };
    try {
      return { type: "agentDetails", taskId, ok: true, ...(await controller.taskDetails(taskId)) };
    } catch (error) {
      return { type: "agentDetails", taskId, ok: false, reason: errorText(error) };
    }
  }

  private warn(reason: string): void {
    void vscode.window.showWarningMessage(redact(reason, this.host.secrets));
  }

  /**
   * An open the host (or the lack of one) refused. A failure waiting fixes goes to the quiet line over the composer
   * with its countdown — the connection, and a session file still held a moment after a reload, which is the common
   * case and heals in milliseconds. A failure the person has to act on goes to the banner at the top. When the fast
   * schedule for a held file runs out, the line stops counting and says who holds it instead of spinning for ever.
   */
  private openFailed(error: unknown, daemon: DaemonManager): void {
    if (!daemon.connected) {
      // The host is not there, or died before it was ready: the connection's own schedule, which never gives up.
      this.retry.failed(`Не удалось открыть сессию: ${errorText(error)}`);
      return;
    }
    const host = { socket: daemon.socketPath, ...(daemon.hostInstance !== undefined ? { instance: daemon.hostInstance } : {}) };
    const failure = classifyOpen(error, host);
    if (failure.kind === "banner") {
      this.retry.stop();
      this.banner = `Не удалось открыть сессию: ${failure.text}`;
      return;
    }
    this.banner = undefined;
    this.heldBy = failure.holder ?? this.heldBy;
    // A budget of its own, not the connection loop's count: a tab that spent attempts on a host that was down still
    // gets the whole fast schedule at a held path, and a path that frees resets it.
    this.heldAttempt += 1;
    const pause = heldPause(this.heldAttempt);
    if (pause !== undefined) {
      this.retry.failed(failure.text, pause);
      return;
    }
    // The schedule is out: asking again will not move a second copy of our own host. Before saying so, the extension
    // tries to prove that copy is safe to stop and stops it — which is the only thing that can free the path.
    if (!heldByAnotherHostCopy(this.heldBy, host)) {
      this.retry.giveUp(giveUpText(this.heldBy, host, failure.text));
      return;
    }
    // The proofs and the grace take seconds, and this open must not hold the tab for them: the line spins meanwhile and
    // the reopen is armed by the attempt that ends, exactly as every other outcome here is.
    this.retry.trying(failure.text);
    void this.stopHolder(giveUpText(this.heldBy, host, failure.text));
  }

  /**
   * Stops the second copy of our host that holds this tab's session file, with `force` only when the person said so,
   * and either re-opens the session or leaves the honest line standing with what is really going on over there.
   */
  private async stopHolder(fallback: string, force = false): Promise<void> {
    const stop = this.host.stopDuplicateHost;
    if (stop === undefined) {
      this.retry.giveUp(fallback);
      return;
    }
    let outcome: ReapOutcome;
    try {
      outcome = await stop(this.heldBy, { force });
    } catch (error) {
      this.retry.giveUp(`${fallback} (остановить её не удалось: ${errorText(error)})`);
      return;
    }
    if (this.disposed) return;
    if (outcome.verdict === "refused") {
      this.host.log(`Вторую копию хоста не останавливаю: ${outcome.reason}`);
      this.retry.giveUp(outcome.reason, outcome.offerStop);
      return;
    }
    if (outcome.verdict === "stopped") {
      this.host.log(outcome.note);
      // Said in the feed of the session it unblocked: now if that session is somehow already open, else when it opens.
      if (this.controller !== undefined) this.controller.note("info", outcome.note);
      else this.stopped = outcome.note;
    } else this.host.log(`Держатель файла сессии исчез сам: ${outcome.reason}`);
    // The path should be free, so the fast schedule starts over. The attempt is ARMED rather than made: this may be
    // running inside the failed open's own stack, where `open` would refuse because that open has not unwound yet.
    this.heldAttempt = 0;
    this.retry.failed(REOPENING, heldPause(1) as number);
  }

  /**
   * «Остановить ту копию»: the extension refused to stop that holder by itself, so the person decides. The dialog
   * repeats the line's own words — the facts the refusal was made on — and the stop that follows keeps every proof of
   * attribution: a process that is not a host of ours on our socket path is not signalled even here.
   */
  private async stopHolderOnRequest(): Promise<void> {
    const view = this.retry.view;
    if (view?.offerStop !== true) return; // the line is not offering it: nothing was refused
    const answer = await vscode.window.showWarningMessage(
      "Остановить вторую копию хоста OmO?",
      { modal: true, detail: `${redact(view.error, this.host.secrets)}\n\nЕй будет послан TERM. Если там идёт работа, она прервётся.` },
      STOP_HOLDER,
    );
    if (answer !== STOP_HOLDER || this.disposed) return;
    this.retry.trying(view.error);
    await this.stopHolder(view.error, true);
    this.publish();
  }

  /** «Переподключить» / «Повторить сейчас»: the same attempt the loop makes, without waiting out its pause. */
  private async reconnect(): Promise<void> {
    if (!this.reconnectable) return;
    this.banner = undefined;
    this.publish();
    if (this.retry.waiting) this.retry.now(); // the pause is cut short; the attempt is the loop's
    else await this.runAttempt();
  }

  /**
   * One attempt to reach this tab's session, automatic or asked for. Its outcome always comes back to the loop — from
   * `start` for a session that never opened, from `onDaemon` for a connection the daemon manager is re-establishing —
   * so the next pause is armed by the attempt that ended and two are never in flight.
   */
  private async runAttempt(): Promise<void> {
    if (this.disposed || this.starting !== undefined) return; // an open in flight will report for itself
    const daemon = this.host.daemon();
    if (!daemon.ok) {
      this.retry.stop();
      this.banner = daemon.error;
      this.reconnectable = false;
      this.publish();
      return;
    }
    const controller = this.controller;
    if (controller === undefined) {
      if (this.noSession) this.retry.stop(); // a draft's session is created by its first message, not here
      else this.open();
      return;
    }
    // A live connection brings no new "connected" event: re-open on it ourselves.
    if (daemon.value.connected && !controller.attached) {
      await controller.reattach();
      if (controller.attached) this.retry.stop();
      // The line is fed the controller's own error verbatim: `publish` leans on that identity to keep the banner from
      // echoing it, so a wrapper here would bring the duplicate banner back. Keep the two the same string.
      else this.retry.failed(controller.state.error ?? NOT_REOPENED);
      this.publish(); // the banner re-reads now that the quiet line carries this failure: it is not shown twice
      return;
    }
    if (daemon.value.connected) this.retry.stop(); // live and attached: this tab's connection is not what is wrong
    daemon.value.reconnectNow(); // a fresh connection; "connected" or "gave_up" reports back
  }

  /** The line over the composer: what the retry is doing now, and the whole failure for its details modal. */
  private postRetry(): void {
    if (this.disposed) return;
    const view = this.retry.view;
    if (view === undefined) {
      this.poster.send({ type: "reconnecting", active: false });
      return;
    }
    const daemon = this.host.daemon();
    const session = this.controller?.tabState.sessionPath ?? this.tab.sessionPath;
    this.poster.send({
      type: "reconnecting",
      active: true,
      ...view,
      target: { host: daemon.ok ? daemon.value.agentDir : "omo", ...(session !== undefined ? { session } : {}) },
    });
  }

  private publish(): void {
    if (this.disposed) return;
    const draft = this.noSession;
    const chosen = draft && this.pending.model !== undefined && this.pending.model !== "auto" ? this.pending.model : undefined;
    const base = this.controller?.state ?? initialState();
    // Without a choice of its own a draft shows the level its model is remembered at: the level its session will start at.
    const level = this.pending.level ?? (chosen !== undefined ? this.host.rememberedLevel?.(chosen) : undefined);
    // A draft shows its pending choices as if they were the session's.
    const state = draft
      ? {
          ...base,
          ...(chosen !== undefined ? { model: chosen } : {}),
          ...(level !== undefined ? { thinkingLevel: level } : {}),
          ...(this.pending.name !== undefined ? { title: this.pending.name } : {}),
        }
      : base;
    const tab = this.controller?.tabState ?? (draft ? { ...this.tab, modelMode: chosen !== undefined ? ("manual" as const) : ("auto" as const) } : this.tab);
    const models = this.models ?? this.host.catalog.models;
    const commands = this.commands ?? this.host.catalog.commands;
    const thinkingLevels = this.thinkingLevels ?? this.host.catalog.thinkingLevels;
    const hiddenCommands = this.host.hiddenCommands?.();
    this.track(tab.sessionPath);
    this.setTitle(state.title ?? tab.title ?? UNTITLED);
    // A connection failure the quiet line over the composer already shows (it is handed the controller's own error
    // text) must not be echoed into the red banner too — that duplication is the transient error the person asked to
    // be rid of. The banner keeps a must-act `this.banner`, and a session error the retry line is not already showing.
    const error = this.banner ?? (this.retry.view?.error === state.error ? undefined : state.error);
    const message: StateMessage = {
      type: "state",
      state: error === state.error ? state : { ...state, error },
      tab: { ...tab, ...(tab.durableId !== undefined ? { pinned: this.host.isPinned(tab.durableId) } : {}), ...(draft ? { draft: true as const } : {}) },
      reconnectable: this.reconnectable,
      ...(models !== undefined ? { models } : {}),
      ...(commands !== undefined ? { commands } : {}),
      ...(thinkingLevels !== undefined ? { thinkingLevels } : {}),
      ...(hiddenCommands !== undefined ? { hiddenCommands } : {}),
    };
    this.poster.push(message);
  }

  /** Keeps the registry key equal to the session's current file. */
  private track(sessionPath: string | undefined): void {
    if (sessionPath === undefined || sessionPath === this.key) return;
    if (this.key === undefined) this.host.registry.add(sessionPath, this);
    else this.host.registry.rename(this.key, sessionPath);
    this.key = sessionPath;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.commandsTimer !== undefined) clearTimeout(this.commandsTimer);
    if (this.levelsTimer !== undefined) clearTimeout(this.levelsTimer);
    this.retry.dispose(); // the tab is gone: nothing retries for it any more
    this.poster.dispose();
    this.host.panels.delete(this);
    this.host.guard?.panelsChanged(); // a request this tab was showing goes back to the service, not to the deadline
    this.host.settings?.off("changed", this.onSettingsChanged);
    this.host.settings?.off("login", this.onSettingsLogin);
    this.host.settings?.off("models", this.onModelsChanged);
    this.unsubscribeCatalog();
    if (this.key !== undefined) this.host.registry.remove(this.key, this);
    void this.controller?.release();
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const asset = (name: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(this.host.extensionUri, "dist", name));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`, // image previews arrive as data: URLs from the `image` message
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset("webview.css").toString()}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset("webview.js").toString()}"></script>
</body>
</html>`;
  }
}
