import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIDDEN_COMMANDS } from "../src/settings/protocol";

const vscodeMock = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  settings: {} as Record<string, unknown>,
  /** Workspace overrides: `get` returns them, `inspect().globalValue` does not. */
  workspaceSettings: {} as Record<string, unknown>,
  lines: [] as string[],
  warning: vi.fn(),
  error: vi.fn(),
  folders: undefined as { uri: { fsPath: string } }[] | undefined,
  host: undefined as import("../src/panel/ChatPanel").PanelHost | undefined,
  created: [] as { opening: unknown; column: unknown; panel: { reveal: ReturnType<typeof vi.fn>; isDraft: boolean } }[],
  serializer: undefined as { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> } | undefined,
  restored: [] as unknown[],
  activeColumn: 1 as number | undefined,
  updates: [] as unknown[],
}));

const restartHost = vi.hoisted(() => vi.fn(async () => true));

/** The home the extension sees: a temp dir per test, so nothing reads the user's real ~/.omo. */
const fakeHome = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, default: { ...original, homedir: () => fakeHome.dir }, homedir: () => fakeHome.dir };
});

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: () => ({ appendLine: (line: string) => vscodeMock.lines.push(line), dispose: () => undefined }),
    showWarningMessage: vscodeMock.warning,
    showErrorMessage: vscodeMock.error,
    showInformationMessage: vi.fn(),
    registerWebviewPanelSerializer: (_type: string, serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }) => {
      vscodeMock.serializer = serializer;
      return { dispose: () => undefined };
    },
    tabGroups: {
      get activeTabGroup() {
        return { viewColumn: vscodeMock.activeColumn };
      },
    },
  },
  EventEmitter: class {
    event = (): { dispose(): void } => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
    getConfiguration: () => ({
      get: (key: string) => vscodeMock.workspaceSettings[key] ?? vscodeMock.settings[key],
      inspect: (key: string) => ({ key, globalValue: vscodeMock.settings[key], workspaceValue: vscodeMock.workspaceSettings[key] }),
      update: async (key: string, value: unknown) => {
        vscodeMock.settings[key] = value;
        vscodeMock.updates.push(value);
      },
    }),
    get workspaceFolders() {
      return vscodeMock.folders;
    },
  },
  commands: {
    registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
      vscodeMock.commands.set(name, handler);
      return { dispose: () => undefined };
    },
  },
  Uri: { joinPath: () => ({}) },
  env: { appRoot: "/Applications/Fake Code.app/Contents/Resources/app" },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
}));

vi.mock("../src/panel/ChatPanel", () => ({
  CHAT_VIEW_TYPE: "agentTabs.chat",
  // Same rule as the real one: a concrete column, the active tab group's when none was asked for.
  targetColumn: (column?: number) => (column !== undefined && column > 0 ? column : vscodeMock.activeColumn),
  ChatPanel: {
    // A created tab is a draft (as the real one is) until a test says it sent its first message.
    create: (host: unknown, opening: unknown, column: unknown) => {
      vscodeMock.host = host as import("../src/panel/ChatPanel").PanelHost;
      const panel = { reveal: vi.fn(), isDraft: true };
      vscodeMock.host.panels.add(panel as never);
      vscodeMock.created.push({ opening, column, panel });
      return panel;
    },
    restore: (_host: unknown, _panel: unknown, opening: unknown) => void vscodeMock.restored.push(opening),
  },
}));

vi.mock("../src/daemon", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeDaemonManager extends EventEmitter {
    restartHost = restartHost;
    dispose = (): void => undefined;
    connected = false;
    secrets: string[] = [];
  }
  return { ...(await importOriginal<object>()), DaemonManager: FakeDaemonManager };
});

import { activate, deactivate } from "../src/extension";
import { encodeCwd } from "../src/sessions/history";

function memento(store: Map<string, unknown>): { get(key: string): unknown; update(key: string, value: unknown): Promise<void> } {
  return { get: (key) => store.get(key), update: async (key, value) => void store.set(key, value) };
}

function activateWith(settings: Record<string, unknown>, state: Map<string, unknown> = new Map(), global: Map<string, unknown> = new Map()): void {
  vscodeMock.settings = settings;
  activate({
    subscriptions: [],
    extensionUri: {},
    extensionPath: join(__dirname, ".."), // the repo: its kit is the one the extension ships
    extensionMode: 2,
    globalStorageUri: { fsPath: join(fakeHome.dir, "Code/User/globalStorage/local.agent-tabs") },
    workspaceState: memento(state),
    globalState: memento(global),
  } as never);
}

const FULL_ENV = {
  environmentVariables: [
    { name: "OMO_CODING_AGENT_DIR", value: "/tmp/agent-tabs-unit" },
    { name: "GW_API_KEY", value: "sekret-key-123" },
  ],
};

beforeEach(() => {
  fakeHome.dir = mkdtempSync(join(tmpdir(), "agent-tabs-home-"));
  vscodeMock.commands.clear();
  vscodeMock.lines.length = 0;
  vscodeMock.warning.mockReset();
  vscodeMock.error.mockReset();
  restartHost.mockClear();
  vscodeMock.folders = undefined;
  vscodeMock.created.length = 0;
  vscodeMock.restored.length = 0;
  vscodeMock.activeColumn = 1;
  vscodeMock.updates.length = 0;
  vscodeMock.workspaceSettings = {};
});

afterEach(() => deactivate());

describe("agentTabs.restartHost", () => {
  it("is_contributed_and_activates_the_extension", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      activationEvents: string[];
      contributes: { commands: { command: string; title: string }[] };
    };
    expect(manifest.contributes.commands).toContainEqual({ command: "agentTabs.restartHost", title: "Agent Tabs: Перезапустить OmO" });
    expect(manifest.activationEvents).toContain("onCommand:agentTabs.restartHost");
  });

  it("restarts_the_host_after_a_modal_confirmation", async () => {
    activateWith(FULL_ENV);
    vscodeMock.warning.mockResolvedValue("Перезапустить");
    await vscodeMock.commands.get("agentTabs.restartHost")?.();
    expect(vscodeMock.warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modal: true }), "Перезапустить");
    expect(restartHost).toHaveBeenCalledTimes(1);
  });

  it("does_nothing_when_the_confirmation_is_dismissed", async () => {
    activateWith(FULL_ENV);
    vscodeMock.warning.mockResolvedValue(undefined);
    await vscodeMock.commands.get("agentTabs.restartHost")?.();
    expect(restartHost).not.toHaveBeenCalled();
  });

  it("explains_what_is_missing_instead_of_restarting", async () => {
    activateWith({ environmentVariables: [] });
    await vscodeMock.commands.get("agentTabs.restartHost")?.();
    expect(vscodeMock.warning).not.toHaveBeenCalled();
    expect(restartHost).not.toHaveBeenCalled();
    expect(vscodeMock.error).toHaveBeenCalledWith(expect.stringContaining("OMO_CODING_AGENT_DIR"));
  });

  it("the_missing_env_hint_points_at_the_restart_command", () => {
    activateWith({ environmentVariables: [] });
    expect(vscodeMock.lines.join("\n")).toContain("«Agent Tabs: Перезапустить OmO»");
  });
});

describe("editor title button", () => {
  type Icon = { light: string; dark: string };
  const root = join(__dirname, "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    icon: string;
    contributes: { commands: { command: string; icon?: Icon }[]; menus: Record<string, { command: string; group?: string; when?: string }[]> };
  };
  const shipped = readFileSync(join(root, ".vscodeignore"), "utf8").split("\n");

  it("opens_a_new_session_from_every_editor_title_first_in_its_group", () => {
    const [entry, ...rest] = manifest.contributes.menus["editor/title"] ?? [];
    expect(rest).toEqual([]);
    expect(entry).toEqual({ command: "agentTabs.newSession", group: "navigation@-100" }); // no `when`: every editor
  });

  it("has_light_and_dark_icons_that_exist_and_are_packaged", () => {
    const icon = manifest.contributes.commands.find((command) => command.command === "agentTabs.newSession")?.icon as Icon;
    for (const path of [icon.light, icon.dark]) {
      expect(readFileSync(join(root, path), "utf8")).toMatch(/^<svg [^>]*viewBox="0 0 16 16"/);
      expect(shipped).toContain(`!${path}`);
    }
    expect(icon.light).not.toBe(icon.dark);
  });

  it("the_extension_icon_is_a_packaged_128_px_png", () => {
    const png = readFileSync(join(root, manifest.icon));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
    expect(shipped).toContain(`!${manifest.icon}`);
  });
});

describe("PanelHost sessions", () => {
  const PINS = "agentTabs.pinned";

  function project(sessionIds: string[]): { settings: Record<string, unknown>; folder: string; agentDir: string } {
    const root = mkdtempSync(join(tmpdir(), "agent-tabs-ext-"));
    const folder = join(root, "proj");
    const agentDir = join(root, "agent");
    mkdirSync(folder);
    const dir = join(agentDir, "sessions", encodeCwd(folder));
    mkdirSync(dir, { recursive: true });
    const user = JSON.stringify({ type: "message", message: { role: "user", content: "x" } }); // an empty session is never listed
    for (const id of sessionIds) writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", id })}\n${user}\n`);
    vscodeMock.folders = [{ uri: { fsPath: folder } }];
    return {
      folder,
      agentDir,
      settings: {
        environmentVariables: [
          { name: "OMO_CODING_AGENT_DIR", value: agentDir },
          { name: "GW_API_KEY", value: "sekret-key-123" },
        ],
      },
    };
  }

  async function hostFor(settings: Record<string, unknown>, state: Map<string, unknown>, global: Map<string, unknown> = new Map()): Promise<import("../src/panel/ChatPanel").PanelHost> {
    activateWith(settings, state, global);
    await vscodeMock.commands.get("agentTabs.newSession")?.();
    return vscodeMock.host as import("../src/panel/ChatPanel").PanelHost;
  }

  it("the_window_has_one_settings_service_for_its_environment_and_none_without_one", async () => {
    const { settings } = project([]);
    const host = await hostFor(settings, new Map());
    const agentDir = (settings["environmentVariables"] as { name: string; value: string }[])[0]?.value;
    // «Подключения» is registered; this fake manager has no OmO to ask, so accounts are unknown and nothing is connected
    // «Модели и роли» reads the (empty) temp home's omo.jsonc: every role is there, none has a model yet
    const state = (await host.settings?.state()) as { models: { rows: Array<Record<string, unknown>> } };
    const roles = state.models.rows;
    expect(roles.map((row) => row["title"])).toEqual([
      "Главный агент", "Ревью плана", "Консультант", "Разведка кода", "Глубокая работа", "Быстрые задачи", "Сложные задачи", "Интерфейсы", "Тексты", "Память",
    ]);
    // «Инструменты» and «Среда» read the same temp home: nothing installed, the system Claude dir always loaded
    const home = fakeHome.dir;
    expect(state).toEqual({
      env: { name: "своя", agentDir },
      connections: { gateways: [], accounts: [], apiKeys: [], any: false, omoUnavailable: "нет связи с OmO" },
      models: { rows: roles, models: [], omoUnavailable: "нет связи с OmO" },
      tools: {
        codegraph: { on: false },
        superpowers: expect.objectContaining({ mode: "off", skills: 0 }),
        skills: [],
        otherSkills: [],
        mcp: [],
        hidden: [...DEFAULT_HIDDEN_COMMANDS],
        instructions: { on: true, path: join(home, ".claude", "CLAUDE.md"), exists: false, always: true },
      },
      environment: {
        folders: { agentDir, memoryHome: join(home, ".omo", "memory"), claudeDir: join(home, ".claude") },
        omoUnavailable: "нет связи с OmO",
        restartNeeded: false,
        restartHint: "Перезапустить OmO — нужно после смены папок",
      },
      // «Безопасность»: protection is off in a fresh home, the rules are the shipped kit's defaults, nothing installed
      security: expect.objectContaining({
        state: "off",
        consent: expect.objectContaining({ hooksJson: join(agentDir as string, "hooks.json"), profile: join(agentDir as string, "guard", "sandbox.sb") }),
        decider: expect.objectContaining({ mode: "decider-then-me" }),
        models: [],
      }),
    });
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(existsSync(join(agentDir as string, "guard"))).toBe(false);
    expect(host.hiddenCommands?.()).toEqual([...DEFAULT_HIDDEN_COMMANDS]); // every tab's state carries it from the start
    expect(host.firstRun).toBeDefined();
    deactivate();

    const incomplete = await hostFor({ environmentVariables: [] }, new Map());
    expect(incomplete.settings).toBeUndefined();
    expect(incomplete.firstRun).toBeUndefined();
  });

  it("a_key_that_exists_only_in_a_key_file_is_redacted_and_a_later_one_too", async () => {
    const { settings } = project([]);
    const agentDir = (settings["environmentVariables"] as { name: string; value: string }[])[0]?.value as string;
    mkdirSync(join(agentDir, "keys"), { recursive: true });
    writeFileSync(join(agentDir, "keys", "gw-x.key"), "file-only-key-777");
    const host = await hostFor({ environmentVariables: [{ name: "OMO_CODING_AGENT_DIR", value: agentDir }] }, new Map());
    host.log("request with file-only-key-777 failed");
    expect(vscodeMock.lines.at(-1)).toBe("request with ‹redacted› failed");
    expect(host.secrets).toContain("file-only-key-777");
  });

  it("the_first_settings_read_migrates_gw_api_key_out_of_the_setting", async () => {
    const { settings } = project([]);
    const agentDir = (settings["environmentVariables"] as { name: string; value: string }[])[0]?.value as string;
    const host = await hostFor(settings, new Map());
    // edited after activation: the migration must write back what is in the settings now
    vscodeMock.settings["environmentVariables"] = [...(settings["environmentVariables"] as object[]), { name: "ADDED_LATER", value: "1" }];
    await host.settings?.state();
    await host.settings?.state();
    expect(readFileSync(join(agentDir, "keys", "gw.key"), "utf8")).toBe("sekret-key-123");
    expect(vscodeMock.updates).toEqual([[{ name: "OMO_CODING_AGENT_DIR", value: agentDir }, { name: "ADDED_LATER", value: "1" }]]);
    host.log("sekret-key-123");
    expect(vscodeMock.lines.at(-1)).toBe("‹redacted›");
  });

  it("the_migration_and_a_folder_change_write_the_user_setting_not_a_workspace_override", async () => {
    const { settings } = project([]);
    const global = settings["environmentVariables"] as { name: string; value: string }[];
    const agentDir = global[0]?.value as string;
    // the workspace repeats the agent dir and adds a variable of its own; it must never leak into the user setting
    vscodeMock.workspaceSettings["environmentVariables"] = [global[0], { name: "WORKSPACE_ONLY", value: "1" }];
    const host = await hostFor(settings, new Map());
    await host.settings?.state();
    expect(readFileSync(join(agentDir, "keys", "gw.key"), "utf8")).toBe("sekret-key-123"); // read from the user setting
    expect(vscodeMock.updates).toEqual([[{ name: "OMO_CODING_AGENT_DIR", value: agentDir }]]);

    const result = await host.settings?.perform("environment", { kind: "folder.set", which: "claudeDir", path: "/data/claude" });
    expect(result).toEqual({ ok: true });
    expect(vscodeMock.updates.at(-1)).toEqual([
      { name: "OMO_CODING_AGENT_DIR", value: agentDir },
      { name: "CLAUDE_CONFIG_DIR", value: "/data/claude" },
    ]);
  });

  it("list_sessions_removes_a_dead_pin_from_storage", async () => {
    const { settings } = project(["alive"]);
    const state = new Map<string, unknown>([[PINS, ["alive", "gone"]]]);
    const host = await hostFor(settings, state);
    const items = await host.listSessions(undefined);
    expect(items.map((item) => [item.durableId, item.pinned])).toEqual([["alive", true]]);
    expect(state.get(PINS)).toEqual(["alive"]);
  });

  it("list_sessions_keeps_pins_when_the_scan_found_nothing", async () => {
    const { settings } = project([]);
    const state = new Map<string, unknown>([[PINS, ["a"]]]);
    const host = await hostFor(settings, state);
    expect(await host.listSessions(undefined)).toEqual([]);
    expect(state.get(PINS)).toEqual(["a"]);
  });

  it("set_pinned_persists_and_unpins", async () => {
    const { settings } = project(["a"]);
    const state = new Map<string, unknown>();
    const host = await hostFor(settings, state);
    await host.setPinned("a", true);
    expect(state.get(PINS)).toEqual(["a"]);
    await host.setPinned("a", false);
    expect(state.get(PINS)).toEqual([]);
  });

  it("a_new_session_opens_in_the_group_it_was_asked_from", async () => {
    const { settings } = project([]);
    vscodeMock.activeColumn = 3;
    const host = await hostFor(settings, new Map()); // the command palette: the active editor group
    expect(vscodeMock.created.at(-1)?.column).toBe(3);
    (vscodeMock.created.at(-1)?.panel as { isDraft: boolean }).isDraft = false; // it sent its first message
    host.newSession(2); // a tab's «Новая сессия»: that tab's group
    expect(vscodeMock.created.at(-1)?.column).toBe(2);
  });

  it("new_session_while_an_untouched_draft_is_open_focuses_that_draft", async () => {
    const { settings } = project([]);
    const host = await hostFor(settings, new Map()); // the palette: one draft
    await vscodeMock.commands.get("agentTabs.newSession")?.(); // the editor-title button / palette again
    host.newSession(2); // a tab's header icon
    expect(vscodeMock.created).toHaveLength(1);
    expect(vscodeMock.created[0]?.panel.reveal).toHaveBeenCalledTimes(2);
  });

  it("a_restored_draft_tab_is_closed_and_a_session_tab_reattaches", async () => {
    const { settings, folder } = project(["s1"]);
    await hostFor(settings, new Map());
    const draft = { dispose: vi.fn() };
    await vscodeMock.serializer?.deserializeWebviewPanel(draft, { tab: { modelMode: "manual" } }); // a draft has no session file
    expect(draft.dispose).toHaveBeenCalled();
    expect(vscodeMock.restored).toEqual([]);
    const tab = { dispose: vi.fn() };
    const sessionPath = join(folder, "s1.jsonl");
    await vscodeMock.serializer?.deserializeWebviewPanel(tab, { tab: { sessionPath, modelMode: "auto" } });
    expect(tab.dispose).not.toHaveBeenCalled();
    expect(vscodeMock.restored).toEqual([{ kind: "attach", sessionPath, saved: { sessionPath, modelMode: "auto" } }]);
  });

  it("a_restored_tab_keeps_a_valid_sticky_mode_and_drops_a_garbage_one", async () => {
    const { settings, folder } = project(["s1"]);
    await hostFor(settings, new Map());
    const sessionPath = join(folder, "s1.jsonl");
    await vscodeMock.serializer?.deserializeWebviewPanel({ dispose: vi.fn() }, { tab: { sessionPath, modelMode: "auto", stickyMode: "ulw" } });
    await vscodeMock.serializer?.deserializeWebviewPanel({ dispose: vi.fn() }, { tab: { sessionPath, modelMode: "auto", stickyMode: "rm -rf" } });
    expect(vscodeMock.restored).toEqual([
      { kind: "attach", sessionPath, saved: { sessionPath, modelMode: "auto", stickyMode: "ulw" } },
      { kind: "attach", sessionPath, saved: { sessionPath, modelMode: "auto" } },
    ]);
  });

  const CATALOG = "agentTabs.catalog";
  const agentDirOf = (settings: Record<string, unknown>): string => (settings["environmentVariables"] as { name: string; value: string }[])[0]?.value as string;

  it("a_fresh_window_offers_drafts_the_catalog_stored_for_its_environment", async () => {
    const { settings } = project([]);
    const model = { provider: "gw", id: "m1", name: "M1" };
    const command = { name: "goal", source: "extension", syntax: "slash" };
    const global = new Map<string, unknown>([
      [
        CATALOG,
        {
          [agentDirOf(settings)]: { models: [model, { provider: 1 }], thinkingLevels: ["low", 3, "high"], commands: [command, { name: "x", source: "bogus", syntax: "slash" }] },
          "/another/env": { models: [{ provider: "other", id: "o" }] },
        },
      ],
    ]);
    const host = await hostFor(settings, new Map(), global);
    expect(host.catalog).toEqual({ models: [model], thinkingLevels: ["low", "high"], commands: [command] }); // stored data is checked
  });

  it("lists_a_session_loads_refresh_the_stored_catalog_of_that_environment_only", async () => {
    const { settings } = project([]);
    const other = { models: [{ provider: "other", id: "o" }] };
    const global = new Map<string, unknown>([[CATALOG, { "/another/env": other }]]);
    const host = await hostFor(settings, new Map(), global);
    expect(host.catalog).toEqual({});
    const models = [{ provider: "gw", id: "m2" }];
    host.updateCatalog({ models });
    host.updateCatalog({ thinkingLevels: ["off", "high"] });
    expect(host.catalog).toEqual({ models, thinkingLevels: ["off", "high"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(global.get(CATALOG)).toEqual({ "/another/env": other, [agentDirOf(settings)]: { models, thinkingLevels: ["off", "high"] } });
  });

  it("archive_is_stored_per_workspace_and_a_dead_one_is_dropped", async () => {
    const ARCHIVED = "agentTabs.archived";
    const { settings } = project(["a", "b"]);
    const state = new Map<string, unknown>([[ARCHIVED, ["gone"]]]);
    const host = await hostFor(settings, state);
    await host.setArchived("a", true);
    expect(state.get(ARCHIVED)).toEqual(["gone", "a"]);
    const items = await host.listSessions(undefined);
    expect(items.map((item) => [item.durableId, item.archived]).sort()).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(state.get(ARCHIVED)).toEqual(["a"]);
    await host.setArchived("a", false);
    expect(state.get(ARCHIVED)).toEqual([]);
  });

  it("only_this_projects_sessions_are_known", async () => {
    const { settings, folder } = project(["a"]);
    const host = await hostFor(settings, new Map());
    const items = await host.listSessions(undefined);
    expect(await host.isProjectSession(items[0]?.sessionPath as string)).toBe(true);
    expect(await host.isProjectSession(join(folder, "elsewhere.jsonl"))).toBe(false);
  });

  it("a_listed_session_opens_in_the_group_it_was_asked_from_else_the_active_one", async () => {
    const { settings } = project(["a"]);
    vscodeMock.activeColumn = 3;
    const host = await hostFor(settings, new Map());
    const sessionPath = (await host.listSessions(undefined))[0]?.sessionPath as string;
    await host.openSession(sessionPath, 2);
    expect(vscodeMock.created.at(-1)).toMatchObject({ opening: { kind: "attach", sessionPath, durableId: "a" }, column: 2 });
    await host.openSession(sessionPath);
    expect(vscodeMock.created.at(-1)?.column).toBe(3); // the palette: the active editor group, never «Active» or «Beside»
  });

  it("a_session_of_another_folder_opens_instead_of_being_refused", async () => {
    const { settings, agentDir } = project(["a"]);
    const host = await hostFor(settings, new Map());
    const elsewhere = join(agentDir, "sessions", encodeCwd("/somewhere/else"), "2026_b.jsonl");
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, `${JSON.stringify({ type: "session", id: "b" })}\n`);
    await host.openSession(elsewhere, 2);
    expect(vscodeMock.created.at(-1)).toMatchObject({ opening: { kind: "attach", sessionPath: elsewhere }, column: 2 });
    expect(vscodeMock.warning).not.toHaveBeenCalled();
  });

  it("a_path_that_is_no_session_file_of_this_environment_is_refused_out_loud", async () => {
    const { settings, folder } = project(["a"]);
    const host = await hostFor(settings, new Map());
    const opened = vscodeMock.created.length;
    await host.openSession(join(folder, "elsewhere.jsonl"));
    await host.openSession(join(folder, "..", "agent", "sessions", "..", "state.json"));
    expect(vscodeMock.created).toHaveLength(opened); // no tab
    expect(vscodeMock.warning).toHaveBeenCalledTimes(2); // never a silent no-op
    expect(vscodeMock.lines.join("\n")).toContain("Отказано в открытии");
  });

  it("checkpoints_are_on_with_a_full_environment_and_a_fork_opens_an_attach_tab_with_its_draft", async () => {
    const { settings } = project([]);
    const host = await hostFor(settings, new Map());
    expect(host.checkpointer).toBeDefined();
    host.openFork("/s/fork.jsonl", { text: "Fix", images: [] }, 3 as never);
    expect(vscodeMock.created.at(-1)).toMatchObject({ opening: { kind: "attach", sessionPath: "/s/fork.jsonl", draft: { text: "Fix", images: [] } }, column: 3 });
  });
});
