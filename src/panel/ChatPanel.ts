import { randomBytes } from "node:crypto";
import { tabTitle } from "./tabTitle";
import * as vscode from "vscode";
import type { ModelRef } from "../chat/model";
import { initialState } from "../chat/reducer";
import type { DaemonManager } from "../daemon";
import { redact } from "../env";
import type { ApprovalPanel, GuardApprovals } from "../guard/approvals";
import type { Checkpointer } from "../rewind/checkpointer";
import type { ForkDraft } from "../rewind/fork";
import { SessionController, normalizeSessionName, type CommandRow, type TabState } from "../sessions/controller";
import type { LoginEvent } from "../settings/accounts";
import { SETTINGS_UNAVAILABLE, type SettingsResult } from "../settings/protocol";
import type { SettingsService } from "../settings/service";
import type { Catalog } from "./catalog";
import { MessageActions } from "./messageActions";
import { StatePoster } from "./poster";
import {
  type AgentDetailsMessage,
  type GuardHostMessage,
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
  /** The window's approval cards (one guard subscription for every tab); absent while the environment is incomplete. */
  guard?: Pick<GuardApprovals, "answer" | "replay">;
  /** Snapshots and the checkpoint log; absent when the environment is incomplete. */
  checkpointer?: Checkpointer;
  /** Opens a forked session in a new tab whose composer starts with `draft`; the tab names the session `name` once it is open. */
  openFork(sessionPath: string, draft: ForkDraft, column?: vscode.ViewColumn, name?: string): void;
};

export type Opening =
  /** A draft: no session exists until the first message is sent. */
  | { kind: "new"; cwd: string }
  /** `durableId` is set when the person picked the session from the list: warn if it is open elsewhere. */
  | { kind: "attach"; sessionPath: string; saved?: TabState; durableId?: string; draft?: ForkDraft; name?: string };

const COMMANDS_DEBOUNCE_MS = 500;
const LEVELS_DEBOUNCE_MS = 300;
const NOT_OPEN = "Сессия не открыта";

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
  private reconnectable = true;
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

  /** Daemon connection news, fanned out by the extension to every tab. */
  onDaemon(event: "connected" | "disconnected" | "gave_up", reason?: string): void {
    if (event === "connected") {
      this.banner = undefined;
      this.poster.reset(); // a new connection re-opens the session: the webview gets it whole
      if (this.controller === undefined && this.reconnectable && !this.noSession) this.open(); // a tab that failed to open retries
    } else if (event === "disconnected") this.banner = "Связь с omo потеряна — переподключаюсь…";
    else this.banner = `Не удалось переподключиться к omo: ${reason ?? "причина неизвестна"}`;
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
      controller =
        this.opening.kind === "new"
          ? await SessionController.create(daemon.value, this.opening.cwd, undefined, this.host.checkpointer)
          : await SessionController.attach(daemon.value, this.opening.sessionPath, this.opening.saved, undefined, this.host.checkpointer); // no saved state: mode inferred
      // A draft's choices go in before its first message (a refused one shows in the state; the message still goes).
      if (this.pending.model !== undefined && this.pending.model !== "auto") await controller.setModel(this.pending.model);
      controller.setStickyMode(this.tab.stickyMode);
      if (this.pending.level !== undefined) await controller.setThinkingLevel(this.pending.level);
      if (this.pending.name !== undefined) await this.nameCreated(controller, this.pending.name);
      if (this.opening.kind === "attach" && this.opening.name !== undefined) await this.nameCreated(controller, this.opening.name); // a fork
    } catch (error) {
      this.host.log(`Не удалось открыть сессию: ${errorText(error)}`);
      this.banner = `Не удалось открыть сессию: ${errorText(error)}`;
      this.publish();
      return;
    }
    if (this.disposed) {
      void controller.release();
      return;
    }
    this.controller = controller;
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
    this.publish();
    void this.loadLists(controller); // messages need not wait for the pickers' lists
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
      message.type === "guardAnswer";
    if (message.type === "send" && this.isDraft) this.open(); // the first message creates the draft's session
    if (message.type !== "ready" && message.type !== "reconnect" && !popover) await this.starting;
    const controller = this.controller;
    const draft = this.noSession;
    switch (message.type) {
      case "ready":
        this.poster.reset(); // a (re)loaded webview has no state to apply a delta to
        this.publish();
        this.host.guard?.replay(this);
        void this.offerFirstRun();
        if (this.forkDraft !== undefined) {
          this.poster.send({ type: "draft", ...this.forkDraft });
          this.forkDraft = undefined;
        }
        return;
      case "send": {
        if (controller === undefined && this.banner === undefined) {
          this.banner = "Сессия не открыта — сообщение не отправлено";
          this.publish();
        }
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
      case "stop":
        await controller?.stop();
        return;
      // Only ever reaches here from the person's own click on «Снять зависание»; always answered, a refusal included.
      case "unwedge":
        this.poster.send({
          type: "unwedged",
          ...(controller === undefined ? { outcome: "failed" as const, reason: NOT_OPEN } : await controller.unwedgeSession()),
        });
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
      case "openLink":
        if (isExternalLink(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      case "openFile": {
        const at = message.line === undefined ? undefined : new vscode.Range(message.line - 1, 0, message.line - 1, 0);
        await vscode.window.showTextDocument(vscode.Uri.file(message.path), { preview: true, ...(at !== undefined ? { selection: at } : {}) });
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

  private async reconnect(): Promise<void> {
    if (!this.reconnectable) return;
    this.banner = undefined;
    this.publish();
    if (this.controller !== undefined) {
      const daemon = this.host.daemon();
      if (!daemon.ok) return;
      // A live connection brings no new "connected" event: re-open on it ourselves.
      if (daemon.value.connected && !this.controller.attached) await this.controller.reattach();
      else daemon.value.reconnectNow();
      return;
    }
    if (!this.noSession) this.open(); // the session never opened: try again (a draft opens on send)
  }

  private publish(): void {
    if (this.disposed) return;
    const draft = this.noSession;
    const chosen = draft && this.pending.model !== undefined && this.pending.model !== "auto" ? this.pending.model : undefined;
    const base = this.controller?.state ?? initialState();
    // A draft shows its pending choices as if they were the session's.
    const state = draft
      ? {
          ...base,
          ...(chosen !== undefined ? { model: chosen } : {}),
          ...(this.pending.level !== undefined ? { thinkingLevel: this.pending.level } : {}),
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
    const error = this.banner ?? state.error;
    const message: StateMessage = {
      type: "state",
      state: error === undefined ? state : { ...state, error },
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
    this.poster.dispose();
    this.host.panels.delete(this);
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
