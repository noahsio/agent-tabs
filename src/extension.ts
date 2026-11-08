import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { activeHostSocketPath, DaemonManager, RECONNECT_DELAYS_MS, systemProcesses } from "./daemon";
import { DeferredInbox } from "./deferred/inbox";
import { buildOmoEnv, redact, type EnvVar } from "./env";
import { serviceMayRun } from "../kit/guard/sockets.mjs";
import { guardFilesDir } from "../kit/guard/lifecycle.mjs";
import { DEFAULT_TG_ENV } from "../kit/guard/telegram.mjs";
import { GuardAdmin } from "./guard/admin";
import { GuardApprovals } from "./guard/approvals";
import {
  disableProtection,
  enableProtection,
  hostRestarter,
  installedKit,
  plannedWriteDenies,
  protectionStatus,
  refreshProfile,
  refreshProtection,
  systemProtectionDeps,
  setSandboxLayer,
  type VscodePaths,
} from "./guard/protection";
import { Freshness } from "./guard/freshness";
import { OutsideChats } from "./guard/outside";
import { TaskRegistry } from "./guard/tasks";
import { type Catalog, parseCatalog } from "./panel/catalog";
import { CHAT_VIEW_TYPE, ChatPanel, targetColumn, type PanelHost } from "./panel/ChatPanel";
import { isExternalLink, isNextMode, type ModelInfo, type PersistedState } from "./panel/protocol";
import { OUTPUT_SCHEME, OutputDocuments } from "./panel/outputDocuments";
import { PanelRegistry, revealOrOpen } from "./panel/registry";
import { buildSessionItems, fetchLiveSessions, liveSessionPath } from "./panel/sessionsList";
import { Checkpointer } from "./rewind/checkpointer";
import { pruneCheckpoints } from "./rewind/prune";
import { CheckpointStore } from "./rewind/store";
import { listPastSessions, type PastSession, type SummaryCache } from "./sessions/history";
import { SessionController } from "./sessions/controller";
import { HostReaper } from "./sessions/reapHost";
import { readRememberedLevels, rememberedLevel } from "./sessions/rememberedLevels";
import { RpcClient } from "./rpc/client";
import { AccountsService } from "./settings/accounts";
import { ConnectionsHost } from "./settings/connections";
import { EnvironmentHost } from "./settings/environment";
import { keyFileSecrets } from "./settings/gateway";
import { LadderHost, readLadder } from "./settings/ladder";
import { RolesHost } from "./settings/roles";
import { SecurityHost } from "./settings/security";
import { migrateGwApiKey } from "./settings/migrateKey";
import { ensureQuestionTimeout, QUESTION_TIMEOUT_DEFAULT } from "./settings/questionTimeout";
import { writeAutonomyRule } from "./sessions/autonomyRule";
import { envName, envPaths } from "./settings/paths";
import { FieldErrors, SettingsService } from "./settings/service";
import { readHiddenCommands, ToolsHost } from "./settings/tools";

const PINNED_KEY = "agentTabs.pinned";
const ARCHIVED_KEY = "agentTabs.archived";
/** Per agent dir, in the global state: the pickers' lists, for drafts in a window where no session has loaded yet. */
const CATALOG_KEY = "agentTabs.catalog";
const NO_FOLDER = "Откройте папку проекта";
const DEFAULT_OMO_PATH = "~/.local/bin/omo";
const RESTART_COMMAND_TITLE = "Agent Tabs: Перезапустить OmO";
const RESTART = "Перезапустить";
const MIN_SECRET_LENGTH = 4;
/** How long the consent dialog's list of dirs closed to agents is reused (it runs the login shell). */
const WRITE_DENIES_TTL_MS = 60_000;

let daemon: DaemonManager | undefined;
/** The window's «Подключения»: its accounts service holds a session and a connection of its own until deactivation. */
let connections: ConnectionsHost | undefined;

/** The settings value is outside data: keep only well-formed `{name, value}` string pairs. */
function readEnvironmentVariables(raw: unknown): EnvVar[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is EnvVar => typeof item === "object" && item !== null && typeof item.name === "string" && typeof item.value === "string",
  );
}

/**
 * The user setting itself, read afresh: what the settings write back (to the user setting), never a workspace
 * override merged into it.
 */
function userEnvironmentVariables(): EnvVar[] {
  return readEnvironmentVariables(vscode.workspace.getConfiguration("agentTabs").inspect<unknown>("environmentVariables")?.globalValue);
}

/**
 * VS Code's own dirs for the sandbox profile: the app bundle around `appRoot`, the user-data dir above
 * `globalStorageUri` (`<userData>/User/globalStorage/<id>`), the extensions dir this extension is installed in.
 * Undefined when VS Code does not say (no global storage).
 */
function vscodePathsOf(context: vscode.ExtensionContext): VscodePaths | undefined {
  const storage = context.globalStorageUri?.fsPath;
  if (storage === undefined) return undefined;
  let userDir = storage;
  while (path.basename(userDir) !== "User" && path.dirname(userDir) !== userDir) userDir = path.dirname(userDir);
  if (path.basename(userDir) !== "User") return undefined;
  const userDataDir = path.dirname(userDir);
  const appRoot = vscode.env.appRoot;
  const bundleEnd = appRoot.lastIndexOf(".app/");
  return {
    appRoot: bundleEnd >= 0 ? appRoot.slice(0, bundleEnd + ".app".length) : appRoot,
    userDataDir,
    userSettings: path.join(userDir, "settings.json"),
    extensionsDir:
      context.extensionMode === vscode.ExtensionMode.Production ? path.dirname(context.extensionPath) : path.join(homedir(), ".vscode", "extensions"),
  };
}

/** The daemon reports a session's cwd as the real path; the window may know it by a link. */
function cwdSpellings(folder: string): string[] {
  try {
    return [...new Set([realpathSync(folder), folder])];
  } catch {
    return [folder];
  }
}

/** The project is the window's first folder (multi-root: the first one). */
function workspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("Agent Tabs");
  // Read once: this window's environment is fixed for the life of the extension host, never another one's.
  const config = vscode.workspace.getConfiguration("agentTabs");
  const built = buildOmoEnv(
    process.env,
    readEnvironmentVariables(config.get<unknown>("environmentVariables")),
    config.get<string>("omoPath") ?? DEFAULT_OMO_PATH,
  );
  const secrets = built.ok ? built.value.secrets : [];
  const paths = built.ok ? envPaths(built.value) : undefined;
  /** Keys that live only in key files are secrets too; later additions go into this same array (the poster and daemon share it). */
  const addSecret = (value: string): void => {
    if (value.length >= MIN_SECRET_LENGTH && !secrets.includes(value)) secrets.push(value);
  };
  if (paths !== undefined) for (const key of keyFileSecrets(paths)) addSecret(key);
  const log = (text: string): void => channel.appendLine(redact(text, secrets));
  let autonomyRuleFile: string | undefined;
  if (paths !== undefined) {
    try {
      autonomyRuleFile = writeAutonomyRule(paths);
    } catch (error) {
      log(`Правило автономной работы не записано, хост запустится без него: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (ensureQuestionTimeout(paths) === "written")
        log(`Вопрос агента ждёт ответа ${QUESTION_TIMEOUT_DEFAULT} мин, потом агент продолжает сам («Настройки → Среда»)`);
    } catch (error) {
      log(`Время ожидания вопроса не задано: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const envError = built.ok
    ? undefined
    : `Не заданы переменные: ${built.missing.join(", ")}. Задайте их в agentTabs.environmentVariables и перезагрузите окно; ` +
      `если OmO этой среды уже запущен, выполните «${RESTART_COMMAND_TITLE}», чтобы он получил новое окружение`;
  if (envError !== undefined) log(envError);
  const vscodeDirs = vscodePathsOf(context);
  /** P7: while protection is on, the profile follows this VS Code and agent dir (now, and before every host start). */
  const refreshSandbox = (): void => {
    if (paths !== undefined && vscodeDirs !== undefined) refreshProfile(paths, vscodeDirs);
  };
  try {
    refreshSandbox();
  } catch (error) {
    log(`Профиль песочницы не обновлён: ${error instanceof Error ? error.message : String(error)}`);
  }

  const panels = new Set<ChatPanel>();
  const outputs = new OutputDocuments();
  /** One parse per session file version for every list: popover opens, rename replies, path checks. */
  const summaries: SummaryCache = new Map();
  const broadcast = (event: "connected" | "disconnected" | "gave_up", reason?: string): void => {
    for (const panel of panels) panel.onDaemon(event, reason);
  };
  /** Durable ids kept per workspace (pins, archive marks); the stored value is outside data. */
  const readIds = (key: string): string[] => {
    const raw = context.workspaceState.get<unknown>(key);
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  };
  const setId = async (key: string, durableId: string, on: boolean): Promise<void> => {
    const others = readIds(key).filter((id) => id !== durableId);
    await context.workspaceState.update(key, on ? [...others, durableId] : others);
  };
  /** Only a successful non-empty scan proves an id dead; an empty or failed one keeps them. */
  const liveIds = async (key: string, past: PastSession[]): Promise<string[]> => {
    const ids = readIds(key);
    const alive = past.length === 0 ? ids : ids.filter((id) => past.some((session) => session.durableId === id));
    if (alive.length !== ids.length) await context.workspaceState.update(key, alive);
    return alive;
  };
  /** A path from the webview is only trusted when it is one of this project's saved sessions. */
  const knownSession = async (sessionPath: string): Promise<PastSession | undefined> => {
    const folder = workspaceFolder();
    if (folder === undefined || !built.ok) return undefined;
    const past = await listPastSessions(built.value.agentDir, folder, summaries).catch(() => [] as PastSession[]);
    return past.find((item) => item.sessionPath === sessionPath);
  };
  /**
   * A `.jsonl` file under this environment's `sessions` dir. The guard is about never opening an arbitrary file, not
   * about the project: a session whose working directory is another folder is still this environment's and still opens.
   */
  const environmentSession = (sessionPath: string): boolean => {
    if (!built.ok || !sessionPath.endsWith(".jsonl")) return false;
    const root = path.join(built.value.agentDir, "sessions") + path.sep;
    return path.resolve(sessionPath).startsWith(root);
  };
  const storedCatalogs = (): Record<string, unknown> => {
    const raw = context.globalState.get<unknown>(CATALOG_KEY);
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  };
  const catalog: Catalog = built.ok ? parseCatalog(storedCatalogs()[built.value.agentDir]) : {};
  /** One per window: its sections register here; every tab's modal talks to it. */
  const migrateKey = async (): Promise<void> => {
    if (paths === undefined) return;
    const vars = userEnvironmentVariables();
    const outcome = await migrateGwApiKey(vars, paths, async (rest) => {
      await vscode.workspace.getConfiguration("agentTabs").update("environmentVariables", rest, true);
    });
    if (outcome === "migrated") {
      for (const key of keyFileSecrets(paths)) addSecret(key);
      log("Ключ шлюза перенесён из настроек VS Code в файл ключей; перезагрузите окно, чтобы убрать его из окружения");
    }
  };
  const settings =
    built.ok && paths !== undefined ? new SettingsService({ name: envName(paths), agentDir: built.value.agentDir }, log, migrateKey) : undefined;
  settings?.setMaxListeners(0); // every tab listens for "changed" and "login"
  const catalogListeners = new Set<() => void>();
  const checkpointStore = built.ok ? new CheckpointStore(built.value.agentDir) : undefined;
  const host: PanelHost = {
    extensionUri: context.extensionUri,
    registry: new PanelRegistry<ChatPanel>(),
    panels,
    catalog,
    onCatalogChange: (listener) => {
      catalogListeners.add(listener);
      return () => void catalogListeners.delete(listener);
    },
    updateCatalog: (part) => {
      Object.assign(catalog, part);
      for (const listener of [...catalogListeners]) listener();
      if (!built.ok) return;
      const update = { ...storedCatalogs(), [built.value.agentDir]: { ...catalog } }; // other environments' entries stay
      context.globalState.update(CATALOG_KEY, update).then(undefined, (error: unknown) => log(`Не удалось сохранить списки: ${String(error)}`));
    },
    secrets,
    log,
    daemon: () => {
      if (!built.ok) return { ok: false, error: envError as string };
      if (daemon === undefined) {
        const manager = new DaemonManager(built.value, { beforeLaunch: refreshSandbox, ...(autonomyRuleFile !== undefined ? { systemPromptFile: autonomyRuleFile } : {}) });
        manager.setMaxListeners(0); // every tab's controller listens for "connected"
        manager.on("connected", () => broadcast("connected"));
        manager.on("warning", (text: string) => log(text)); // log() redacts
        manager.on("disconnected", () => {
          log("Связь с omo потеряна");
          broadcast("disconnected");
        });
        manager.on("gave_up", (reason: string) => {
          log(`Не удалось переподключиться к omo: ${reason}`);
          broadcast("gave_up", reason);
        });
        daemon = manager;
      }
      return { ok: true, value: daemon };
    },
    listSessions: async (currentPath) => {
      const folder = workspaceFolder();
      if (folder === undefined || !built.ok) return [];
      const past = await listPastSessions(built.value.agentDir, folder, summaries); // a failed scan throws: nothing is dropped
      const pins = await liveIds(PINNED_KEY, past);
      const archived = await liveIds(ARCHIVED_KEY, past);
      const manager = daemon;
      const live =
        manager !== undefined && manager.connected ? await fetchLiveSessions(await manager.client(), cwdSpellings(folder)) : [];
      return buildSessionItems(past, live, new Set(pins), currentPath, new Set(archived)).map((item) => ({
        ...item,
        title: redact(item.title, secrets),
      }));
    },
    isPinned: (durableId) => readIds(PINNED_KEY).includes(durableId),
    setPinned: (durableId, pinned) => setId(PINNED_KEY, durableId, pinned),
    setArchived: (durableId, archived) => setId(ARCHIVED_KEY, durableId, archived),
    openSession: async (sessionPath, column) => {
      const known = await knownSession(sessionPath);
      if (known === undefined && !environmentSession(sessionPath)) {
        log(`Отказано в открытии: ${sessionPath} не файл сессии этой среды`);
        void vscode.window.showWarningMessage("Эту сессию не открыть: её файл не из сессий этой среды — подробности в канале «Agent Tabs»");
        return;
      }
      await revealOrOpen(host.registry, sessionPath, async () =>
        ChatPanel.create(host, { kind: "attach", sessionPath, ...(known !== undefined ? { durableId: known.durableId } : {}) }, targetColumn(column)),
      );
    },
    isProjectSession: async (sessionPath) => (await knownSession(sessionPath)) !== undefined,
    newSession: (column) => newSession(column),
    restartHost: () => void restartHost(),
    showOutput: (taskId, label, content) => outputs.show(taskId, label, content),
    ...(settings !== undefined ? { settings } : {}),
    // Read on demand, never cached: OmO writes its store the moment a level is picked, in this window or another.
    ...(built.ok ? { rememberedLevel: (model) => rememberedLevel(readRememberedLevels(built.value.agentDir), model) } : {}),
    ...(built.ok && checkpointStore !== undefined ? { checkpointer: new Checkpointer({ store: checkpointStore, agentDir: built.value.agentDir }) } : {}),
    openFork: (sessionPath, draft, column, name) =>
      void ChatPanel.create(host, { kind: "attach", sessionPath, draft, ...(name !== undefined ? { name } : {}) }, targetColumn(column)),
    // One reaper for the window: it is where the one-attempt-per-holder bound and the shared attempt live, so however
    // many tabs are blocked by the same duplicate host, it is looked at once and stopped once.
    stopDuplicateHost: (holder, options) => {
      const manager = host.daemon();
      if (!manager.ok) return Promise.resolve({ verdict: "refused" as const, reason: manager.error, offerStop: false });
      return reaper.stop(manager.value, holder, options);
    },
  };
  const reaper = new HostReaper({ processes: systemProcesses });
  if (built.ok) {
    const inbox = new DeferredInbox(built.value.agentDir, {
      protectionOn: async () => paths !== undefined && vscodeDirs !== undefined && (await protectionStatus(paths, vscodeDirs)).state !== "off",
      connect: () => GuardAdmin.connect(built.value.agentDir),
      open: (sessionPath) => {
        const panel = host.registry.get(sessionPath);
        return panel === undefined ? undefined : { send: (text, _mode, _images, clientMessageId) => {
          if (clientMessageId === undefined) throw new Error("Не задан идентификатор отложенного ответа");
          return panel.sendDeferred(text, clientMessageId);
        } };
      },
      attach: async (sessionPath) => {
        const manager = host.daemon();
        if (!manager.ok) throw new Error(manager.error);
        return SessionController.attach(manager.value, sessionPath, undefined, undefined, host.checkpointer, log);
      },
      publish: (message) => { for (const panel of panels) panel.postDeferred(message); },
      log,
    });
    host.deferred = inbox;
    void inbox.refresh(); // Resume persisted deliveries even when no chat tab has been restored yet.
  }
  if (checkpointStore !== undefined) {
    pruneCheckpoints(checkpointStore, Date.now()).catch((error: unknown) => log(`Не удалось убрать старые снимки: ${String(error)}`));
  }

  if (settings !== undefined && paths !== undefined && built.ok) {
    const agentDir = built.value.agentDir;
    connections = new ConnectionsHost({
      paths,
      accounts: () =>
        new AccountsService({
          // OmO is started (or found) by the window's manager; the service talks to it on a connection of its own.
          connect: async () => {
            const manager = host.daemon();
            if (!manager.ok) throw new Error(manager.error);
            await manager.value.client();
            return RpcClient.connect(activeHostSocketPath(agentDir), agentDir);
          },
          pluginDir: paths.pluginDir,
          openExternal: (url) => {
            if (isExternalLink(url)) void vscode.env.openExternal(vscode.Uri.parse(url));
          },
          log,
        }),
      addSecret,
      changed: () => {
        settings.emit("changed");
        settings.emit("models"); // a background refresh or a login's end may have changed the models
      },
      login: (event) => settings.emit("login", event),
      log,
    });
    settings.register(connections);
    const sectionHost = connections;
    const roles = new RolesHost({ paths, accounts: () => sectionHost.accountsService(), changed: () => settings.emit("changed"), log });
    settings.register(roles);
    const kitDir = path.join(context.extensionPath, "kit");
    /** VS Code's own dirs go into the sandbox profile: without them protection can be neither checked nor turned on. */
    const vscodePaths = (): VscodePaths => {
      if (vscodeDirs === undefined) throw new FieldErrors("Защита недоступна: VS Code не сообщил свои папки", []);
      return vscodeDirs;
    };
    // The real machine: launchctl with this user's uid, ~/Library/LaunchAgents, the login PATH. The consent the person
    // gave already said the host restarts, so it restarts here without asking again.
    const protectionDeps = () =>
      systemProtectionDeps({
        kitDir,
        vscode: vscodePaths(),
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        restartHost: hostRestarter(() => host.daemon()),
      });
    // The consent dialog's list (P38) runs the login shell: computed at most once per WRITE_DENIES_TTL_MS.
    let writeDenies: { at: number; list: Promise<string[]> } | undefined;
    const plannedDenies = (): Promise<string[]> => {
      if (writeDenies === undefined || Date.now() - writeDenies.at > WRITE_DENIES_TTL_MS) {
        writeDenies = { at: Date.now(), list: plannedWriteDenies(paths, protectionDeps()) };
        writeDenies.list.catch(() => (writeDenies = undefined));
      }
      return writeDenies.list;
    };
    const guardSource = path.join(kitDir, "guard");
    /** Why the activation refresh below did not go through, for «Безопасность» to show instead of nothing. */
    let refreshError: string | undefined;
    settings.register(
      new SecurityHost({
        paths,
        guardSource,
        protection: {
          status: () => protectionStatus(paths, vscodePaths()),
          enable: () => enableProtection(paths, protectionDeps()),
          disable: () => disableProtection(paths, protectionDeps()),
          setLayer: async (layer, on) => {
            await setSandboxLayer(paths, protectionDeps(), layer, on);
            writeDenies = undefined;
          },
          writeDenies: plannedDenies,
          installed: () => {
            const kit = installedKit(paths, guardSource);
            return { ...(kit !== undefined ? { installed: kit } : {}), ...(refreshError !== undefined ? { refreshError } : {}) };
          },
        },
        admin: () => GuardAdmin.connect(agentDir),
        serviceMayRun: () => serviceMayRun(agentDir),
        models: () => roles.modelOptions(),
        log,
        addSecret,
        tgEnvPath: DEFAULT_TG_ENV,
        fetch: (url, init) => fetch(url, init),
      }),
    );
    // The guard that decides is the installed copy, not these files: an update reaches the person only here. Started
    // before any session attaches and never awaited — it restarts no host, so nothing it does interrupts a turn — and
    // it reads the installation off the disk first, so an activation with nothing to refresh touches nothing at all.
    if (vscodeDirs !== undefined) {
      void refreshProtection(paths, protectionDeps()).then(
        (outcome) => {
          if (outcome.kind === "refreshed") log(`Защита: установленная копия обновлена до нынешней (${outcome.kitDir}); служба перезапущена, OmO не тронут`);
          if (outcome.kind === "failed") {
            refreshError = outcome.reason;
            log(`Защита: установленную копию не удалось обновить до нынешней: ${outcome.reason}`);
          }
        },
        (error: unknown) => {
          refreshError = error instanceof Error ? error.message : String(error);
          log(`Защита: установленную копию не удалось обновить до нынешней: ${refreshError}`);
        },
      );
    }
    // Read on demand, never cached: the ladder a failure walks is the one the modal shows right now.
    host.ladder = () => readLadder(paths);
    settings.register(new LadderHost({ paths, models: () => roles.modelOptions(), changed: () => settings.emit("changed") }));
    let hiddenCommands: readonly string[] = readHiddenCommands(paths); // one array until it changes: the tabs' deltas compare by reference
    host.hiddenCommands = () => hiddenCommands;
    settings.register(
      new ToolsHost({
        paths,
        addSecret,
        openFile: async (file) => {
          const uri = vscode.Uri.file(file);
          // a CLAUDE.md that does not exist yet opens as a new file that saving creates
          const exists = await vscode.workspace.fs.stat(uri).then(
            () => true,
            () => false,
          );
          await vscode.window.showTextDocument(exists ? uri : uri.with({ scheme: "untitled" }));
        },
        hiddenChanged: (list) => {
          hiddenCommands = list;
        },
        log,
      }),
    );
    settings.register(
      new EnvironmentHost({
        paths,
        // fresh each time: another window may have changed the setting since this one started
        readVariables: userEnvironmentVariables,
        writeVariables: async (variables) => {
          await vscode.workspace.getConfiguration("agentTabs").update("environmentVariables", variables, true);
        },
        restartHost: () => void restartHost(),
        omoVersion: () => sectionHost.accountsService().omoVersion(),
        changed: () => settings.emit("changed"),
        log,
      }),
    );
    if (vscodeDirs !== undefined) {
      // One subscription for the window's tabs: started while protection is set up, re-checked on every settings change
      // (protection switched, `human.card` changed).
      // OmO's task registry of THIS agent dir: whose chat a subagent's request belongs to. One per window, never shared
      // with the other environment's dir.
      const tasks = new TaskRegistry(agentDir);
      // A request no window has a tab for: raised outside the chats, so no chat shows a card it never asked for.
      const chats = new OutsideChats({
        notify: (text, ...buttons) => Promise.resolve(vscode.window.showInformationMessage(text, ...buttons)),
        openSession: async (session) => {
          const manager = daemon;
          const path = manager !== undefined && manager.connected ? await liveSessionPath(await manager.client(), session) : undefined;
          if (path === undefined) {
            log(`Сессию ${session} не открыть: её нет среди живых сессий среды`);
            void vscode.window.showWarningMessage("Эту сессию не открыть: её больше нет среди живых — подробности в канале «Agent Tabs»");
            return;
          }
          await host.openSession(path);
        },
        answer: (id, decision) => approvals.answerOutside(id, decision),
        log,
      });
      const approvals: GuardApprovals = new GuardApprovals({
        protectionOn: async () => (await protectionStatus(paths, vscodeDirs)).state !== "off",
        connect: () => GuardAdmin.connect(agentDir),
        panels: () => panels,
        rootOf: (session) => tasks.rootOf(session),
        outside: (request, owner) => chats.raise(request, owner),
        log,
        retryDelaysMs: RECONNECT_DELAYS_MS,
        changed: () => void host.deferred?.refresh(),
      });
      host.guard = approvals;
      settings.on("changed", () => void approvals.sync());
      void approvals.sync();
      context.subscriptions.push({ dispose: () => approvals.dispose() });
      // Once per window and never per tab: the person has fifteen of them, each running whatever build it loaded when
      // it started, and no way to tell which of them is still deciding for itself whose request a card is.
      void new Freshness({
        running: String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? ""),
        extensionsDir: vscodeDirs.extensionsDir,
        expectedKit: guardFilesDir(paths.home, path.join(kitDir, "guard")),
        status: async () => {
          const admin = await GuardAdmin.connect(agentDir, { reconnectDelaysMs: [] });
          try {
            return await admin.status();
          } finally {
            admin.close();
          }
        },
        notify: (text, button) => Promise.resolve(vscode.window.showWarningMessage(text, button)),
        reloadWindow: () => void vscode.commands.executeCommand("workbench.action.reloadWindow"),
        restartService: () => enableProtection(paths, protectionDeps()),
        log,
      }).tell();
    }
    host.firstRun = () => sectionHost.firstRun();
    let modelsInFlight: Promise<ModelInfo[]> | undefined; // many drafts may ask at once
    host.fetchModels = () => (modelsInFlight ??= sectionHost.accountsService().availableModels().finally(() => (modelsInFlight = undefined)));
  }

  /** From the command palette (no column): the active editor group. */
  function newSession(column: vscode.ViewColumn = targetColumn()): void {
    const folder = workspaceFolder();
    if (folder === undefined) {
      void vscode.window.showErrorMessage(NO_FOLDER);
      return;
    }
    // One empty draft per window (and so per project): asking again brings it forward instead of adding another.
    const draft = [...panels].find((panel) => panel.isDraft);
    if (draft !== undefined) {
      draft.reveal();
      return;
    }
    ChatPanel.create(host, { kind: "new", cwd: folder }, column);
  }

  const openSession = async (): Promise<void> => {
    const folder = workspaceFolder();
    if (folder === undefined) {
      void vscode.window.showErrorMessage(NO_FOLDER);
      return;
    }
    if (!built.ok) {
      ChatPanel.create(host, { kind: "new", cwd: folder }, targetColumn()); // the tab shows what is missing; nothing starts
      return;
    }
    let sessions: PastSession[];
    try {
      sessions = await listPastSessions(built.value.agentDir, folder, summaries);
    } catch (error) {
      log(`Не удалось прочитать список сессий: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage("Не удалось прочитать список сессий — подробности в канале «Agent Tabs»");
      return;
    }
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage("В этом проекте ещё нет сессий");
      return;
    }
    const items = sessions.map((session) => ({
      label: redact(session.title, secrets),
      description:
        host.registry.get(session.sessionPath) !== undefined ? "открыта в этом окне" : new Date(session.updatedAt).toLocaleString("ru-RU"),
      session,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Открыть сессию", matchOnDescription: true });
    if (picked === undefined) return;
    const { sessionPath, durableId } = picked.session;
    await revealOrOpen(host.registry, sessionPath, async () => ChatPanel.create(host, { kind: "attach", sessionPath, durableId }, targetColumn()));
  };

  /** The host's environment is fixed when it starts: this is how a changed setting reaches it. */
  const restartHost = async (): Promise<void> => {
    const daemonResult = host.daemon();
    if (!daemonResult.ok) {
      void vscode.window.showErrorMessage(daemonResult.error);
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      "Перезапустить OmO этой среды?",
      {
        modal: true,
        detail:
          "Идущие ходы агента во всех окнах этой среды прервутся. Новый OmO получит окружение этого окна, " +
          "вкладки переподключатся к своим сессиям.",
      },
      RESTART,
    );
    if (answer !== RESTART) return;
    try {
      const stopped = await daemonResult.value.restartHost();
      log(stopped ? "OmO остановлен, запускаю заново" : "Запущенный расширением OmO не найден — подключаюсь заново");
    } catch (error) {
      log(`Не удалось перезапустить OmO: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage("Не удалось перезапустить OmO — подробности в канале «Agent Tabs»");
    }
  };

  context.subscriptions.push(
    channel,
    outputs,
    vscode.workspace.registerTextDocumentContentProvider(OUTPUT_SCHEME, outputs),
    vscode.commands.registerCommand("agentTabs.newSession", () => newSession()),
    vscode.commands.registerCommand("agentTabs.openSession", openSession),
    vscode.commands.registerCommand("agentTabs.restartHost", restartHost),
    vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
        const tab = (state as Partial<PersistedState> | undefined)?.tab;
        const sessionPath = tab?.sessionPath;
        if (typeof sessionPath !== "string") {
          panel.dispose(); // the tab never got a session file: nothing to restore
          return;
        }
        const existing = host.registry.get(sessionPath);
        if (existing !== undefined) {
          panel.dispose();
          existing.reveal();
          return;
        }
        const saved = {
          sessionPath,
          modelMode: tab?.modelMode === "manual" ? ("manual" as const) : ("auto" as const),
          ...(typeof tab?.title === "string" ? { title: tab.title } : {}),
          ...(tab !== undefined && isNextMode(tab.stickyMode) ? { stickyMode: tab.stickyMode } : {}),
        };
        ChatPanel.restore(host, panel, { kind: "attach", sessionPath, saved });
      },
    }),
  );
}

/** Closes the socket only; the daemon and its sessions keep running. */
export function deactivate(): void {
  void connections?.dispose();
  connections = undefined;
  daemon?.dispose();
  daemon = undefined;
}
