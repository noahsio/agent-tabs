import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, symlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { DaemonManager, hostSocketPath } from "../../src/daemon";
import type { OmoEnv } from "../../src/env";
import { ChatPanel, type PanelHost } from "../../src/panel/ChatPanel";
import { applyDelta } from "../../src/panel/delta";
import type { HostMessage, SessionItem, StateMessage } from "../../src/panel/protocol";
import { PanelRegistry } from "../../src/panel/registry";
import { Checkpointer } from "../../src/rewind/checkpointer";
import { takeSnapshot } from "../../src/rewind/snapshot";
import { CheckpointStore } from "../../src/rewind/store";
import type { Ladder } from "../../src/settings/ladder";
import { SETTINGS_UNAVAILABLE } from "../../src/settings/protocol";
import { SettingsService, type SettingsSectionHost } from "../../src/settings/service";
import { FakeDaemon, type Frame } from "../helpers/fakeDaemon";
import { makeRepo } from "../helpers/gitRepo";
import { dirname, join } from "node:path";

vi.mock("vscode", () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.slice(1).join("/") }), parse: (value: string) => value, file: (path: string) => ({ fsPath: path }) },
  Range: class {
    constructor(
      readonly startLine: number,
      readonly startCharacter: number,
      readonly endLine: number,
      readonly endCharacter: number,
    ) {}
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  window: {
    showWarningMessage: vi.fn(),
    createWebviewPanel: vi.fn(),
    showTextDocument: vi.fn(),
    tabGroups: { activeTabGroup: { viewColumn: 4 } },
  },
  workspace: { openTextDocument: vi.fn() },
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
}));

const SESSION_FILE = "/tmp/agent/sessions/--proj--/2026_abc.jsonl";

let daemon: FakeDaemon;
let manager: DaemonManager;

function envFor(agentDir: string): OmoEnv {
  return { env: { OMO_CODING_AGENT_DIR: agentDir, GW_API_KEY: "sekret-key-123" }, agentDir, omoPath: "/fake/omo", secrets: ["sekret-key-123"] };
}

function openData(handle: string): unknown {
  return { sessionId: handle, state: { sessionFile: SESSION_FILE, isStreaming: false, pendingDialogs: [], model: { provider: "gw", id: "m1" } } };
}

/** `posted` holds the full state the webview has after each state or delta message; `kinds` the message types as sent. */
function fakePanel(): { panel: vscode.WebviewPanel; posted: StateMessage[]; kinds: string[]; other: Record<string, unknown>[]; receive(raw: unknown): void; show(visible: boolean): void } {
  const other: Record<string, unknown>[] = [];
  const listeners: ((raw: unknown) => void)[] = [];
  const posted: StateMessage[] = [];
  const kinds: string[] = [];
  const viewListeners: (() => void)[] = [];
  const panel = {
    title: "",
    iconPath: undefined,
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (listener: (raw: unknown) => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
      postMessage: async (json: string) => {
        const message = JSON.parse(json) as HostMessage;
        if (message.type === "state" || message.type === "delta") kinds.push(message.type);
        if (message.type === "state") posted.push(message);
        else if (message.type === "delta") posted.push(applyDelta(posted.at(-1) as StateMessage, message));
        else other.push(message as unknown as Record<string, unknown>);
        return true;
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    onDidChangeViewState: (listener: () => void) => {
      viewListeners.push(listener);
      return { dispose: () => undefined };
    },
    reveal: () => undefined,
    viewColumn: 2,
  };
  const show = (visible: boolean): void => {
    panel.visible = visible;
    viewListeners.forEach((listener) => listener());
  };
  return { panel: panel as unknown as vscode.WebviewPanel, posted, kinds, other, receive: (raw) => listeners.forEach((listener) => listener(raw)), show };
}

function host(overrides: Partial<PanelHost> = {}): PanelHost {
  const catalog: PanelHost["catalog"] = { ...overrides.catalog };
  const listeners = new Set<() => void>();
  return {
    extensionUri: {} as vscode.Uri,
    registry: new PanelRegistry<ChatPanel>(),
    panels: new Set<ChatPanel>(),
    catalog,
    updateCatalog: (part) => {
      Object.assign(catalog, part);
      for (const listener of [...listeners]) listener();
    },
    onCatalogChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    secrets: ["sekret-key-123"],
    log: () => undefined,
    daemon: () => ({ ok: true, value: manager }),
    listSessions: async () => [],
    setPinned: async () => undefined,
    setArchived: async () => undefined,
    openSession: async () => undefined,
    newSession: () => undefined,
    restartHost: () => undefined,
    isProjectSession: async () => false,
    showOutput: async () => undefined,
    isPinned: () => false,
    openFork: () => undefined,
    ...overrides,
  };
}

function opens(): Frame[] {
  return daemon.requests.filter((request) => request["type"] === "open_session");
}

async function settle(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 400 && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

beforeEach(async () => {
  daemon = await FakeDaemon.start();
  await mkdir(join(daemon.agentDir, "rpc"), { recursive: true });
  await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
  manager = new DaemonManager(envFor(daemon.agentDir));
  daemon.on("open_session", () => ({ data: openData("rpc-1") }));
  daemon.on("get_entries", () => ({ data: { entries: [], hasMore: false } }));
  daemon.on("get_available_models", () => ({ data: { models: [] } }));
  daemon.on("release_attachment", () => ({}));
});

afterEach(async () => {
  manager.dispose();
  await daemon.stop();
});

describe("ChatPanel", () => {
  it("routes_inbox_actions_without_opening_a_draft_and_posts_confirmations", async () => {
    const { panel, receive, other } = fakePanel();
    const deferred = { refresh: vi.fn().mockResolvedValue(undefined), answer: vi.fn().mockResolvedValue(undefined) };
    const chat = ChatPanel.restore(host({ deferred }), panel, { kind: "new", cwd: "/work" });
    receive({ type: "ready" });
    receive({ type: "listDeferred" });
    receive({ type: "answerDeferredQuestion", id: "q", answers: ["Да"] });
    await settle(() => deferred.answer.mock.calls.length === 1);
    expect(deferred.refresh).toHaveBeenCalledTimes(2);
    expect(deferred.answer).toHaveBeenCalledWith({ type: "answerDeferredQuestion", id: "q", answers: ["Да"] });
    expect(opens()).toEqual([]);
    chat.postDeferred({ type: "deferredResult", kind: "question", id: "q", ok: true });
    expect(other).toContainEqual({ type: "deferredResult", kind: "question", id: "q", ok: true });
  });

  it("tells_the_inbox_view_which_projects_this_windows_tabs_hold", () => {
    const first = fakePanel();
    const second = fakePanel();
    const shared = host();
    const chat = ChatPanel.restore(shared, first.panel, { kind: "new", cwd: "/work" });
    ChatPanel.restore(shared, second.panel, { kind: "new", cwd: "/shop" });
    chat.postDeferred({ type: "deferred", items: [] });
    expect(first.other).toContainEqual({ type: "deferred", items: [], here: ["/work", "/shop"], sessions: [] });
  });

  it("sends_later_answers_through_the_attached_controller_with_the_stable_id", async () => {
    const { panel } = fakePanel();
    const chat = ChatPanel.restore(host(), panel, { kind: "attach", sessionPath: SESSION_FILE });
    daemon.on("prompt", () => ({ data: { disposition: "started" } }));
    expect(await chat.sendDeferred("Поздний ответ", "deferred-question-q")).toBe(true);
    expect(daemon.requests).toContainEqual(expect.objectContaining({ type: "prompt", message: "Поздний ответ", clientMessageId: "deferred-question-q" }));
  });
  it("reconnect_button_reopens_a_session_whose_reopen_failed_on_a_live_connection", async () => {
    const { panel, posted, receive } = fakePanel();
    ChatPanel.restore(host(), panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
    await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));

    daemon.on("open_session", () => ({ errorCode: "open_failed", error: "cannot open right now" }));
    daemon.dropConnections();
    manager.reconnectNow();
    await settle(() => posted.at(-1)?.state.error === "cannot open right now");
    expect(manager.connected).toBe(true);

    daemon.on("open_session", () => ({ data: openData("rpc-2") }));
    const before = opens().length;
    receive({ type: "reconnect" });
    await settle(() => opens().length > before);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opens().slice(before)).toEqual([expect.objectContaining({ sessionPath: SESSION_FILE, retain_on_disconnect: true })]);
    await settle(() => posted.at(-1)?.state.error === undefined);
  });

  it("state_goes_as_deltas_and_in_full_again_when_the_webview_is_ready_or_the_daemon_reconnects", async () => {
    const { posted, kinds, receive } = await openAttached();
    expect(kinds[0]).toBe("state");
    expect(kinds.slice(1)).not.toContain("state");
    daemon.push({ sessionId: "rpc-1", type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    await settle(() => posted.at(-1)?.state.blocks.some((block) => block.kind === "assistant" && block.text === "hi") === true);
    expect(kinds.at(-1)).toBe("delta");

    receive({ type: "ready" });
    await settle(() => kinds.at(-1) === "state");
    expect(posted.at(-1)?.state.blocks.map((block) => block.kind)).toEqual(["assistant"]);

    const full = kinds.filter((kind) => kind === "state").length;
    daemon.dropConnections();
    manager.reconnectNow();
    await settle(() => kinds.filter((kind) => kind === "state").length > full);
  });

  it("tool_args_never_reach_the_webview_only_their_capped_view", async () => {
    const { panel, posted } = fakePanel();
    ChatPanel.restore(host(), panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
    await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));
    const content = `WHOLE FILE\n${"z".repeat(50_000)}\nTAIL`;
    daemon.push({ sessionId: "rpc-1", type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "/a.txt", content } });
    await settle(() => posted.some((message) => message.state.blocks.some((block) => block.kind === "tool")));
    const tool = posted.at(-1)?.state.blocks.find((block) => block.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool).not.toHaveProperty("args");
    expect(tool).toMatchObject({ file: "/a.txt", input: expect.stringMatching(/^\+WHOLE FILE\n\+z/) });
    expect(JSON.stringify(posted)).not.toContain("TAIL"); // past the cap
  });

  /**
   * The tab's own symptom: an existing session shows the empty new-chat composer for as long as the open path takes.
   * OmO 5.1.59 answers `omo.task.list` on a session it has reopened never at all, and the open waited for it — the
   * whole conversation was in hand and the webview was shown none of it for the client's full 30-second timeout.
   */
  it("the_conversation_reaches_the_webview_without_waiting_for_the_task_list", async () => {
    const entries = Array.from({ length: 1_200 }, (_, index) => ({
      id: `e${index}`,
      type: "message",
      message: { role: index % 3 === 0 ? "user" : "assistant", timestamp: 1_700_000_000_000 + index, content: [{ type: "text", text: `line ${index}` }] },
    }));
    daemon.on("get_entries", (request) => {
      const since = request["since"];
      const from = since === undefined ? 0 : entries.findIndex((entry) => entry.id === since) + 1;
      const page = entries.slice(from, from + 500);
      return { data: { entries: page, hasMore: from + page.length < entries.length, nextSince: page[page.length - 1]?.id } };
    });
    // A durable id is what makes the tab ask for the task list at all; the host then never answers it.
    daemon.on("open_session", () => ({ data: { sessionId: "rpc-1", state: { sessionFile: SESSION_FILE, sessionId: "durable-1", isStreaming: false, pendingDialogs: [] } } }));
    daemon.on("extension_request", () => ({ silent: true }));
    const { panel, posted, receive } = fakePanel();
    ChatPanel.restore(host(), panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
    receive({ type: "ready" });
    const startedAt = Date.now();
    await settle(() => (posted.at(-1)?.state.blocks.length ?? 0) === entries.length);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(posted.at(-1)?.state.error).toBeUndefined(); // and no wrong state in the meantime
    await settle(() => daemon.requests.some((request) => request["name"] === "omo.task.list")); // asked for, just not waited on
  });

  async function openAttached(overrides: Partial<PanelHost> = {}): Promise<ReturnType<typeof fakePanel> & { chat: ChatPanel; panelHost: PanelHost }> {
    const fake = fakePanel();
    const panelHost = host(overrides);
    const chat = ChatPanel.restore(panelHost, fake.panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
    await settle(() => daemon.requests.some((request) => request["type"] === "get_commands"));
    return { ...fake, chat, panelHost };
  }

  beforeEach(() => {
    daemon.on("get_available_thinking_levels", () => ({ data: { levels: ["low", "high"] } }));
    daemon.on("get_commands", () => ({ data: { commands: [{ name: "review", source: "skill", syntax: "dollar" }] } }));
    daemon.on("set_session_name", () => ({}));
    daemon.on("close_session", () => ({}));
  });

  describe("the tab's dot when the agent has finished", () => {
    const icon = (panel: vscode.WebviewPanel): string => String((panel.iconPath as { light: vscode.Uri }).light);
    const turn = async (posted: StateMessage[], end: Frame = { type: "agent_settled" }): Promise<void> => {
      daemon.push({ sessionId: "rpc-1", type: "agent_start" });
      await settle(() => posted.at(-1)?.state.running === true);
      daemon.push({ sessionId: "rpc-1", ...end });
      await settle(() => posted.at(-1)?.state.running === false);
    };

    it("a_tab_out_of_sight_gets_the_dot_when_the_turn_ends_and_loses_it_when_seen", async () => {
      const { panel, posted, show } = await openAttached();
      expect(icon(panel)).toBe("media/mark-light.svg");
      show(false);
      await turn(posted);
      expect(icon(panel)).toBe("media/mark-done-light.svg");
      expect(String((panel.iconPath as { dark: vscode.Uri }).dark)).toBe("media/mark-done-dark.svg");
      show(true);
      expect(icon(panel)).toBe("media/mark-light.svg");
    });

    it("a_tab_in_sight_gets_no_dot", async () => {
      const { panel, posted } = await openAttached();
      await turn(posted);
      expect(icon(panel)).toBe("media/mark-light.svg");
    });

    it("the_dot_waits_for_background_work_but_not_for_a_command_left_running", async () => {
      const { panel, posted, show } = await openAttached();
      show(false);
      const waiting = (sources: string[]): Frame => ({
        type: "session_lifecycle",
        lifecycle: { state: "waiting_background", runId: "r1", waitingOn: { children: 0, background: sources.map((source) => ({ source, activeCount: 1 })), human: [] } },
      });
      await turn(posted, waiting(["senpi-task"]));
      expect(icon(panel)).toBe("media/mark-light.svg"); // a child agent still works: the agent will be back
      daemon.push({ sessionId: "rpc-1", ...waiting(["terminal-background-sessions"]) });
      await settle(() => icon(panel) === "media/mark-done-light.svg"); // only a dev server is left running
    });

    it("the_dot_goes_when_the_agent_starts_again", async () => {
      const { panel, posted, show } = await openAttached();
      show(false);
      await turn(posted);
      expect(icon(panel)).toBe("media/mark-done-light.svg");
      daemon.push({ sessionId: "rpc-1", type: "agent_start" });
      await settle(() => icon(panel) === "media/mark-light.svg");
    });
  });

  describe("a queued message", () => {
    async function queuedTab(): Promise<ReturnType<typeof fakePanel>> {
      const fake = await openAttached();
      daemon.push({ sessionId: "rpc-1", type: "queue_update", ordered: [{ text: "later", mode: "steer", queuedId: "q_1", revision: 1, clientMessageId: "m1" }] });
      await settle(() => fake.posted.at(-1)?.state.blocks.some((block) => block.id === "m1") === true);
      return fake;
    }

    it("taken_back_leaves_the_feed_and_its_text_returns_to_the_composer", async () => {
      daemon.on("dequeue_message", () => ({ data: { queuedId: "q_1", status: "removed" } }));
      const { posted, other, receive } = await queuedTab();
      receive({ type: "dequeue", blockId: "m1" });
      await settle(() => other.some((message) => message["type"] === "queueResult"));
      expect(other.filter((message) => message["type"] === "draft" || message["type"] === "queueResult")).toEqual([
        { type: "draft", text: "later", images: [] },
        { type: "queueResult", blockId: "m1", outcome: "removed" },
      ]);
      expect(daemon.requests.find((request) => request["type"] === "dequeue_message")).toMatchObject({ queuedId: "q_1" });
      expect(posted.at(-1)?.state.blocks.some((block) => block.id === "m1")).toBe(false);
    });

    it("one_omo_already_gave_the_agent_is_reported_and_stays", async () => {
      daemon.on("dequeue_message", () => ({ data: { queuedId: "q_1", status: "already_delivered" } }));
      const { other, receive } = await queuedTab();
      receive({ type: "dequeue", blockId: "m1" });
      await settle(() => other.some((message) => message["type"] === "queueResult"));
      expect(other.filter((message) => message["type"] === "draft")).toEqual([]);
      expect(other.at(-1)).toEqual({ type: "queueResult", blockId: "m1", outcome: "delivered" });
    });

    it("edited_in_place", async () => {
      daemon.on("edit_queued_message", () => ({ data: { queuedId: "q_1", status: "edited", text: "sooner", revision: 2 } }));
      const { posted, other, receive } = await queuedTab();
      receive({ type: "editQueued", blockId: "m1", text: "sooner" });
      await settle(() => other.some((message) => message["type"] === "queueResult"));
      expect(other.at(-1)).toEqual({ type: "queueResult", blockId: "m1", outcome: "edited" });
      expect(posted.at(-1)?.state.blocks.find((block) => block.id === "m1")).toMatchObject({ text: "sooner" });
    });
  });

  it("the_lists_a_session_loads_refresh_the_windows_catalog", async () => {
    const updateCatalog = vi.fn();
    const { posted } = await openAttached({ updateCatalog });
    await settle(() => posted.at(-1)?.commands?.[0]?.name === "review");
    expect(updateCatalog.mock.calls).toEqual(
      expect.arrayContaining([[{ models: [] }], [{ thinkingLevels: ["low", "high"] }], [{ commands: [{ name: "review", source: "skill", syntax: "dollar" }] }]]),
    );
  });

  it("the_hidden_slash_commands_go_with_the_state_and_a_settings_change_reposts_them", async () => {
    const settings = new SettingsService({ name: "second", agentDir: "/a" }, () => undefined);
    let hidden: readonly string[] = ["tui", "help"];
    const { posted } = await openAttached({ settings, hiddenCommands: () => hidden });
    expect(posted[0]?.hiddenCommands).toEqual(["tui", "help"]); // the very first state, before any modal opened
    hidden = ["tui"];
    settings.emit("changed");
    await settle(() => posted.at(-1)?.hiddenCommands?.length === 1);
    expect(posted.at(-1)?.hiddenCommands).toEqual(["tui"]);
  });

  it("a_connection_or_role_change_refetches_the_open_tabs_model_list", async () => {
    const settings = new SettingsService({ name: "second", agentDir: "/a" }, () => undefined);
    const updateCatalog = vi.fn();
    const { posted } = await openAttached({ settings, updateCatalog });
    await settle(() => posted.at(-1)?.models?.length === 0);
    const asked = daemon.requests.filter((request) => request["type"] === "get_available_models").length;

    daemon.on("get_available_models", () => ({ data: { models: [{ provider: "gw-x", id: "fresh", name: "Fresh" }] } }));
    settings.emit("models");
    await settle(() => posted.at(-1)?.models?.[0]?.id === "fresh");
    expect(daemon.requests.filter((request) => request["type"] === "get_available_models").length).toBe(asked + 1);
    expect(updateCatalog).toHaveBeenLastCalledWith({ models: [{ provider: "gw-x", id: "fresh", name: "Fresh" }] });
  });

  it("a_slow_first_model_list_never_overwrites_a_newer_refetch", async () => {
    const settings = new SettingsService({ name: "second", agentDir: "/a" }, () => undefined);
    daemon.on("get_available_models", () => ({ data: { models: [{ provider: "gw-x", id: "old" }] }, delayMs: 300 }));
    const fake = fakePanel();
    ChatPanel.restore(host({ settings }), fake.panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
    await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));
    daemon.on("get_available_models", () => ({ data: { models: [{ provider: "gw-x", id: "fresh" }] } }));
    settings.emit("models");
    await settle(() => fake.posted.at(-1)?.models?.[0]?.id === "fresh");
    await new Promise((resolve) => setTimeout(resolve, 450)); // the old answer arrives now
    expect(fake.posted.at(-1)?.models?.[0]?.id).toBe("fresh");
  });

  describe("a draft tab and a changed model list", () => {
    it("repaints_when_another_tab_refreshes_the_window_catalog", async () => {
      const settings = new SettingsService({ name: "second", agentDir: "/a" }, () => undefined);
      const fetchModels = vi.fn(async () => []);
      const panelHost = host({ settings, fetchModels });
      const draft = fakePanel();
      ChatPanel.restore(panelHost, draft.panel, { kind: "new", cwd: daemon.agentDir });
      const attached = fakePanel();
      ChatPanel.restore(panelHost, attached.panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
      await settle(() => attached.posted.at(-1)?.models?.length === 0);

      daemon.on("get_available_models", () => ({ data: { models: [{ provider: "gw-x", id: "fresh" }] } }));
      settings.emit("models");
      await settle(() => draft.posted.at(-1)?.models?.[0]?.id === "fresh");
      expect(fetchModels).not.toHaveBeenCalled(); // a session tab did the asking
    });

    it("asks_the_service_itself_when_no_tab_has_a_session", async () => {
      const settings = new SettingsService({ name: "second", agentDir: "/a" }, () => undefined);
      const fetchModels = vi.fn(async () => [{ provider: "gw-x", id: "viaService" }]);
      const draft = fakePanel();
      ChatPanel.restore(host({ settings, fetchModels }), draft.panel, { kind: "new", cwd: daemon.agentDir });
      settings.emit("models");
      await settle(() => draft.posted.at(-1)?.models?.[0]?.id === "viaService");
      expect(daemon.requests.filter((request) => request["type"] === "get_available_models")).toEqual([]);
    });
  });

  it("a_model_refetch_that_fails_keeps_the_old_list_and_is_logged", async () => {
    const settings = new SettingsService({ name: "second", agentDir: "/a" }, () => undefined);
    const logged: string[] = [];
    const { posted } = await openAttached({ settings, log: (text) => logged.push(text) });
    await settle(() => posted.at(-1)?.models?.length === 0);
    daemon.on("get_available_models", () => ({ error: "boom", errorCode: "x" }));
    settings.emit("models");
    await settle(() => logged.some((line) => line.includes("Список моделей")));
    expect(posted.at(-1)?.models).toEqual([]);
  });

  it("commands_and_levels_are_fetched_and_commands_refetched_on_surfaces_change", async () => {
    const { posted } = await openAttached();
    await settle(() => posted.at(-1)?.commands?.[0]?.name === "review");
    expect(posted.at(-1)?.thinkingLevels).toEqual(["low", "high"]);
    const before = daemon.requests.filter((request) => request["type"] === "get_commands").length;
    daemon.on("get_commands", () => ({ data: { commands: [{ name: "fresh", source: "skill", syntax: "dollar" }] } }));
    daemon.push({ sessionId: "rpc-1", type: "loaded_surfaces_changed" });
    daemon.push({ sessionId: "rpc-1", type: "loaded_surfaces_changed" });
    await settle(() => posted.at(-1)?.commands?.[0]?.name === "fresh");
    expect(daemon.requests.filter((request) => request["type"] === "get_commands").length).toBe(before + 1); // debounced
  });

  it("thinking_levels_are_refetched_after_this_sessions_model_changes", async () => {
    const { posted } = await openAttached();
    await settle(() => posted.at(-1)?.thinkingLevels?.length === 2);
    const before = daemon.requests.filter((request) => request["type"] === "get_available_thinking_levels").length;
    daemon.on("get_available_thinking_levels", () => ({ data: { levels: ["low", "high", "xhigh"] } }));
    daemon.push({ sessionId: "rpc-other", type: "model_changed", model: { provider: "gw", id: "m9" } }); // another session: ignored
    daemon.push({ sessionId: "rpc-1", type: "model_changed", model: { provider: "gw", id: "m2" } });
    daemon.push({ sessionId: "rpc-1", type: "model_changed", model: { provider: "gw", id: "m3" } });
    await settle(() => posted.at(-1)?.thinkingLevels?.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(daemon.requests.filter((request) => request["type"] === "get_available_thinking_levels").length).toBe(before + 1); // debounced
  });

  /**
   * The person's own path: the model is chosen in the popover, and the tab must end up on that model's ladder and on
   * the level OmO restored for it (it announces both in `model_changed`), not on the levels of the model it opened on.
   */
  it("a_model_picked_in_the_popover_brings_its_own_levels_and_its_remembered_level", async () => {
    const chosen = { provider: "gw", id: "m-thinks" };
    daemon.on("set_model", (request) => ({
      // what the live host does on a switch: it announces the new model and the level it restored for it
      frames: [{ sessionId: "rpc-1", type: "model_changed", model: { provider: request["provider"], id: request["modelId"] }, thinkingLevel: "minimal" }],
      data: {},
    }));
    const { posted, receive } = await openAttached();
    await settle(() => posted.at(-1)?.thinkingLevels?.length === 2);
    daemon.on("get_available_thinking_levels", () => ({ data: { levels: ["off", "minimal", "low", "medium", "high"] } }));

    receive({ type: "setModel", model: chosen });
    await settle(() => posted.at(-1)?.thinkingLevels?.length === 5);
    expect(posted.at(-1)?.state.model).toEqual(chosen);
    expect(posted.at(-1)?.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(posted.at(-1)?.state.thinkingLevel).toBe("minimal"); // the level OmO remembered for it, not the old one
  });

  it("commands_and_levels_are_refetched_after_a_reattach", async () => {
    const { posted } = await openAttached();
    const count = (type: string): number => daemon.requests.filter((request) => request["type"] === type).length;
    const commands = count("get_commands");
    const levels = count("get_available_thinking_levels");
    daemon.on("get_commands", () => ({ data: { commands: [{ name: "after", source: "extension", syntax: "slash" }] } }));
    daemon.dropConnections();
    manager.reconnectNow();
    await settle(() => posted.at(-1)?.commands?.[0]?.name === "after");
    expect(count("get_commands")).toBe(commands + 1);
    expect(count("get_available_thinking_levels")).toBe(levels + 1);
  });

  it("set_thinking_and_set_model_failures_surface_redacted_in_the_state", async () => {
    daemon.on("set_thinking_level", () => ({ errorCode: "error", error: "Thinking level xhigh is not supported sekret-key-123" }));
    daemon.on("set_model", () => ({ errorCode: "error", error: "no such model sekret-key-123" }));
    const { posted, receive } = await openAttached();
    receive({ type: "setThinking", level: "xhigh" });
    await settle(() => posted.at(-1)?.state.error === "Thinking level xhigh is not supported ‹redacted›");
    expect(posted.at(-1)?.state.thinkingLevel).toBeUndefined(); // a rejected level never lands
    receive({ type: "setModel", model: { provider: "gw", id: "zzz" } });
    await settle(() => posted.at(-1)?.state.error === "no such model ‹redacted›");
    expect(posted.at(-1)?.state.model).toEqual({ provider: "gw", id: "m1" });
  });

  it("set_mode_is_kept_in_the_persisted_tab_state", async () => {
    const { posted, receive } = await openAttached();
    receive({ type: "setMode", mode: "ulw" });
    await settle(() => posted.at(-1)?.tab.stickyMode === "ulw");
    receive({ type: "setMode", mode: null });
    await settle(() => posted.at(-1)?.tab.stickyMode === undefined);
  });

  it("an_attached_tab_restores_its_saved_mode", async () => {
    const fake = fakePanel();
    ChatPanel.restore(host(), fake.panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto", stickyMode: "mass ulw" } });
    await settle(() => daemon.requests.some((request) => request["type"] === "get_commands"));
    fake.receive({ type: "ready" });
    await settle(() => fake.posted.at(-1)?.tab.stickyMode === "mass ulw");
  });

  it("a_draft_keeps_a_toggled_mode_into_the_session_its_first_send_creates", async () => {
    daemon.on("prompt", () => ({}));
    daemon.on("open_session", () => ({ data: { sessionId: "rpc-1", state: { sessionFile: SESSION_FILE, sessionId: "durable-1", isStreaming: false } } }));
    const fake = fakePanel();
    ChatPanel.restore(host(), fake.panel, { kind: "new", cwd: daemon.agentDir });
    fake.receive({ type: "ready" });
    fake.receive({ type: "setMode", mode: "ulw" });
    await settle(() => fake.posted.at(-1)?.tab.stickyMode === "ulw");
    expect(fake.posted.at(-1)?.tab.draft).toBe(true);
    fake.receive({ type: "send", id: "m1", text: "ulw привет", mode: "auto" });
    await settle(() => fake.other.some((message) => message["type"] === "sent") && fake.posted.at(-1)?.tab.draft === undefined);
    expect(fake.posted.at(-1)?.tab.stickyMode).toBe("ulw");
  });

  it("the_tab_says_whether_its_session_is_pinned_and_a_pin_republishes_it", async () => {
    daemon.on("open_session", () => ({ data: { sessionId: "rpc-1", state: { sessionFile: SESSION_FILE, sessionId: "durable-1", isStreaming: false } } }));
    const pins = new Set<string>();
    const { posted, receive } = await openAttached({
      isPinned: (durableId) => pins.has(durableId),
      setPinned: async (durableId, pinned) => {
        if (pinned) pins.add(durableId);
        else pins.delete(durableId);
      },
    });
    await settle(() => posted.at(-1)?.tab.durableId === "durable-1");
    expect(posted.at(-1)?.tab.pinned).toBe(false);
    receive({ type: "pin", durableId: "durable-1", pinned: true });
    await settle(() => posted.at(-1)?.tab.pinned === true);
  });

  it("rename_this_tab_updates_panel_title", async () => {
    const { panel, receive, other, panelHost } = await openAttached();
    receive({ type: "rename", name: "Новое имя" });
    await settle(() => other.some((message) => message["type"] === "renamed"));
    expect(other.at(-1)).toEqual({ type: "renamed", ok: true });
    expect(panel.title).toBe("Новое имя");
    expect(daemon.requests.find((request) => request["type"] === "set_session_name")).toMatchObject({ sessionId: "rpc-1", name: "Новое имя" });
    expect(panelHost.registry.get(SESSION_FILE)).toBeDefined();
  });

  it("rename_closed_session_uses_rename_closed", async () => {
    const openSession = vi.fn(async () => undefined);
    const { panel, receive, other } = await openAttached({ isProjectSession: async () => true, openSession });
    const title = panel.title;
    daemon.on("open_session", () => ({ data: openData("rpc-9") }));
    daemon.on("release_attachment", () => ({}));
    receive({ type: "rename", name: "Старая", sessionPath: "/tmp/other.jsonl" });
    await settle(() => other.some((message) => message["type"] === "renamed"));
    expect(other.at(-1)).toEqual({ type: "renamed", ok: true });
    expect(openSession).not.toHaveBeenCalled(); // renamed in place: no tab opens or switches
    expect(panel.title).toBe(title);
    expect(opens().at(-1)).toMatchObject({ sessionPath: "/tmp/other.jsonl" });
    expect(daemon.requests.find((request) => request["type"] === "set_session_name" && request["sessionId"] === "rpc-9")).toMatchObject({ name: "Старая" });
    expect(daemon.requests.some((request) => request["type"] === "close_session" && request["sessionId"] === "rpc-9")).toBe(true); // freshly resumed: closed again
  });

  it("get_image_posts_data_url_unredacted", async () => {
    const entry: Frame = {
      type: "message",
      id: "e1",
      message: { role: "user", clientMessageId: "u1", content: [{ type: "text", text: "hi" }, { type: "image", data: "sekret-key-123", mimeType: "image/png" }] },
    };
    daemon.on("get_entries", () => ({ data: { entries: [entry], hasMore: false } }));
    const { posted, receive, other } = await openAttached();
    await settle(() => posted.some((message) => message.state.blocks.some((block) => block.kind === "user")));
    const block = posted.at(-1)?.state.blocks.find((candidate) => candidate.kind === "user");
    const id = block?.kind === "user" ? (block.images?.[0]?.id as string) : "";
    receive({ type: "getImage", id });
    await settle(() => other.some((message) => message["type"] === "image"));
    expect(other.find((message) => message["type"] === "image")).toEqual({ type: "image", id, dataUrl: "data:image/png;base64,sekret-key-123" });
  });

  it("agent_output_opens_a_redacted_read_only_document", async () => {
    daemon.on("extension_request", () => ({ data: { kind: "full", transcript: "log sekret-key-123 end", snapshot: {} } }));
    const showOutput = vi.fn(async () => undefined);
    const { receive } = await openAttached({ showOutput });
    daemon.push({ sessionId: "rpc-1", type: "extension_event", name: "omo.task.updated", data: { tasks: [{ task_id: "t1", name: "Поиск sekret-key-123", status: "done" }] } });
    receive({ type: "agentOutput", taskId: "t1" });
    await settle(() => showOutput.mock.calls.length > 0);
    expect(showOutput).toHaveBeenCalledWith("t1", "Поиск ‹redacted›", "log ‹redacted› end");
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled(); // no untitled document that asks to be saved
  });

  it("agent_output_failure_warns_with_redacted_reason", async () => {
    daemon.on("extension_request", () => ({ data: { kind: "not_found", reason: "no task sekret-key-123" } }));
    const { receive } = await openAttached();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    receive({ type: "agentOutput", taskId: "t1" });
    await settle(() => vi.mocked(vscode.window.showWarningMessage).mock.calls.length > 0);
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toBe("no task ‹redacted›");
  });

  it("agent_details_reach_the_webview_redacted", async () => {
    const snapshot = { status: "completed", description: "Найти sekret-key-123", final_response: "ответ sekret-key-123", error_message: "warn sekret-key-123" };
    daemon.on("extension_request", () => ({ data: { kind: "transcript", mode: "full", transcript: "log sekret-key-123 end", snapshot } }));
    const { receive, other } = await openAttached();
    receive({ type: "agentDetails", taskId: "t1" });
    await settle(() => other.some((message) => message["type"] === "agentDetails"));
    expect(daemon.requests.find((request) => request["type"] === "extension_request")).toMatchObject({ name: "omo.task.output", data: { task_id: "t1", mode: "full" } });
    expect(other.find((message) => message["type"] === "agentDetails")).toEqual({
      type: "agentDetails",
      taskId: "t1",
      ok: true,
      prompt: "Найти ‹redacted›",
      result: "ответ ‹redacted›",
      transcript: "log ‹redacted› end",
      error: "warn ‹redacted›",
      status: "done",
    });
    expect(JSON.stringify(other)).not.toContain("sekret-key-123");
  });

  it("agent_details_failure_answers_not_ok_in_the_webview_not_as_a_warning", async () => {
    daemon.on("extension_request", () => ({ data: { kind: "not_found", reason: "no task sekret-key-123" } }));
    const { receive, other } = await openAttached();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    receive({ type: "agentDetails", taskId: "t1" });
    await settle(() => other.some((message) => message["type"] === "agentDetails"));
    expect(other.find((message) => message["type"] === "agentDetails")).toEqual({ type: "agentDetails", taskId: "t1", ok: false, reason: "no task ‹redacted›" });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("invalid_send_still_acks_not_ok", async () => {
    const { receive, other } = await openAttached();
    receive({ type: "send", id: "m1", text: "x", mode: "auto", images: Array(6).fill({ mimeType: "image/png", data: "QUJD" }) });
    await settle(() => other.some((message) => message["type"] === "sent"));
    expect(other.at(-1)).toEqual({ type: "sent", id: "m1", ok: false });
  });

  const row = (durableId: string, pinned: boolean, updatedAt: number): SessionItem => ({
    sessionPath: `/s/${durableId}.jsonl`,
    durableId,
    title: durableId,
    updatedAt,
    running: false,
    pinned,
    archived: false,
    current: false,
  });

  it("pin_flips_the_flag_in_the_last_list_and_reposts_it_without_rebuilding", async () => {
    const listSessions = vi.fn(async () => [row("a", false, 300), row("b", false, 100)]);
    const setPinned = vi.fn(async () => undefined);
    const { receive, other } = await openAttached({ listSessions, setPinned });
    receive({ type: "listSessions" });
    await settle(() => other.some((message) => message["type"] === "sessions"));
    receive({ type: "pin", durableId: "b", pinned: true });
    await settle(() => other.filter((message) => message["type"] === "sessions").length === 2);
    expect(setPinned).toHaveBeenCalledWith("b", true);
    expect(listSessions).toHaveBeenCalledTimes(1);
    const items = (other.at(-1) as { items: SessionItem[] }).items;
    expect(items.map((item) => [item.durableId, item.pinned])).toEqual([["b", true], ["a", false]]);
  });

  it("archive_is_stored_and_the_list_comes_back_with_the_flag", async () => {
    const listSessions = vi.fn(async () => [row("a", false, 300), row("b", false, 100)]);
    const setArchived = vi.fn(async () => undefined);
    const { receive, other } = await openAttached({ listSessions, setArchived });
    receive({ type: "archive", durableId: "b", archived: true }); // before any list: the host builds one
    await settle(() => other.some((message) => message["type"] === "sessions"));
    expect(setArchived).toHaveBeenCalledWith("b", true);
    expect(listSessions).toHaveBeenCalledTimes(1);
    receive({ type: "archive", durableId: "a", archived: true });
    await settle(() => other.filter((message) => message["type"] === "sessions").length === 2);
    expect(setArchived).toHaveBeenLastCalledWith("a", true);
    expect(listSessions).toHaveBeenCalledTimes(1); // the last list, one flag flipped
    expect((other.at(-1) as { items: SessionItem[] }).items.map((item) => [item.durableId, item.archived])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("list_sessions_answers_while_the_session_is_still_opening_and_when_it_fails", async () => {
    const fake = fakePanel();
    const listSessions = vi.fn(async (): Promise<SessionItem[]> => Promise.reject(new Error("boom")));
    daemon.on("open_session", async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { data: openData("rpc-1") };
    });
    ChatPanel.restore(host({ listSessions }), fake.panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
    fake.receive({ type: "listSessions" });
    await settle(() => fake.other.some((message) => message["type"] === "sessions"));
    expect(fake.other.at(-1)).toEqual({ type: "sessions", items: [] });
    expect(daemon.requests.some((request) => request["type"] === "get_commands")).toBe(false); // answered before the open finished
    await settle(() => daemon.requests.some((request) => request["type"] === "get_commands"));
  });

  it("get_image_miss_answers_with_an_empty_data_url", async () => {
    const { receive, other } = await openAttached();
    receive({ type: "getImage", id: "nope" });
    await settle(() => other.some((message) => message["type"] === "image"));
    expect(other.at(-1)).toEqual({ type: "image", id: "nope", dataUrl: "" });
  });

  it("open_session_and_new_session_go_to_the_host_in_this_tabs_editor_group", async () => {
    const openSession = vi.fn(async () => undefined);
    const newSession = vi.fn();
    const { receive } = await openAttached({ openSession, newSession });
    receive({ type: "openSession", sessionPath: "/s/a.jsonl" });
    receive({ type: "newSession" });
    await settle(() => openSession.mock.calls.length === 1 && newSession.mock.calls.length === 1);
    expect(openSession).toHaveBeenCalledWith("/s/a.jsonl", 2); // the tab it was asked from, never beside it
    expect(newSession).toHaveBeenCalledWith(2);
  });

  it("the_focus_view_is_the_windows_setting_carried_in_every_state", async () => {
    let on = false;
    const setFocusView = vi.fn(async (enabled: boolean) => {
      on = enabled;
    });
    const { receive, posted, chat } = await openAttached({ focusView: () => on, setFocusView });
    expect(posted.at(-1)?.focusView).toBeUndefined();
    receive({ type: "setFocusView", enabled: true });
    await settle(() => setFocusView.mock.calls.length === 1);
    expect(setFocusView).toHaveBeenCalledWith(true);
    chat.focusViewChanged(); // what the window does once the setting is stored
    await settle(() => posted.at(-1)?.focusView === true);
    on = false;
    chat.focusViewChanged();
    await settle(() => posted.at(-1)?.focusView === undefined);
  });

  it("open_session_and_new_session_answer_while_this_tabs_own_session_is_still_opening", async () => {
    const fake = fakePanel();
    const openSession = vi.fn(async () => undefined);
    const newSession = vi.fn();
    daemon.on("open_session", async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { data: openData("rpc-1") };
    });
    ChatPanel.restore(host({ openSession, newSession }), fake.panel, {
      kind: "attach",
      sessionPath: SESSION_FILE,
      saved: { sessionPath: SESSION_FILE, modelMode: "auto" },
    });
    fake.receive({ type: "openSession", sessionPath: "/s/a.jsonl" });
    fake.receive({ type: "newSession" });
    await settle(() => openSession.mock.calls.length === 1 && newSession.mock.calls.length === 1);
    expect(daemon.requests.some((request) => request["type"] === "get_commands")).toBe(false); // answered before the open finished
    await settle(() => daemon.requests.some((request) => request["type"] === "get_commands"));
  });

  it("a_new_tab_opens_in_a_concrete_editor_group_never_the_active_or_beside_one", () => {
    const created = vi.mocked(vscode.window.createWebviewPanel);
    created.mockClear();
    created.mockImplementation(() => fakePanel().panel);
    ChatPanel.create(host(), { kind: "new", cwd: "/repo" });
    ChatPanel.create(host(), { kind: "new", cwd: "/repo" }, vscode.ViewColumn.Active);
    ChatPanel.create(host(), { kind: "new", cwd: "/repo" }, vscode.ViewColumn.Beside);
    ChatPanel.create(host(), { kind: "new", cwd: "/repo" }, 2);
    // 4 is the active tab group's column: a locked group refuses `Active` and VS Code opens a new group beside it instead.
    expect(created.mock.calls.map((call) => call[2])).toEqual([4, 4, 4, 2]);
  });

  /**
   * `vscode.open`, not `showTextDocument`: the latter opens text only, so a click on a png the agent read did nothing.
   * `vscode.open` picks the editor for the file (text, image preview, …).
   */
  it("open_file_opens_the_file_at_its_line_in_the_editor_that_fits_it", async () => {
    const run = vi.mocked(vscode.commands.executeCommand);
    run.mockClear();
    const { receive } = await openAttached();
    receive({ type: "openFile", path: "/repo/a.ts", line: 12 });
    receive({ type: "openFile", path: "/repo/shots/b.png" });
    receive({ type: "openFile", path: "command:workbench.action.reloadWindow" }); // dropped at the boundary
    const opens = () => run.mock.calls.filter((call) => call[0] === "vscode.open");
    await settle(() => opens().length === 2);
    expect(opens()[0]).toEqual(["vscode.open", { fsPath: "/repo/a.ts" }, { preview: true, selection: { startLine: 11, startCharacter: 0, endLine: 11, endCharacter: 0 } }]);
    expect(opens()[1]).toEqual(["vscode.open", { fsPath: "/repo/shots/b.png" }, { preview: true }]);
  });

  it("a_relative_path_opens_from_the_session_folder", async () => {
    const run = vi.mocked(vscode.commands.executeCommand);
    run.mockClear();
    const fake = fakePanel();
    ChatPanel.restore(host(), fake.panel, { kind: "new", cwd: "/repo" }); // a new tab: no session until its first message
    fake.receive({ type: "openFile", path: "shots/b.png" });
    const opens = () => run.mock.calls.filter((call) => call[0] === "vscode.open");
    await settle(() => opens().length === 1);
    expect(opens()[0]?.[1]).toEqual({ fsPath: "/repo/shots/b.png" });
  });

  it("a_file_that_cannot_be_opened_says_so", async () => {
    const run = vi.mocked(vscode.commands.executeCommand);
    const warn = vi.mocked(vscode.window.showWarningMessage);
    run.mockClear();
    warn.mockClear();
    run.mockImplementation(async (command: string) => {
      if (command === "vscode.open") throw new Error("File not found");
      return undefined;
    });
    const { receive } = await openAttached();
    receive({ type: "openFile", path: "/repo/gone.png" });
    await settle(() => warn.mock.calls.length === 1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("/repo/gone.png");
    run.mockReset();
  });

  it("restart_host_goes_to_the_host_and_its_confirmation", async () => {
    const restartHost = vi.fn();
    const { receive } = await openAttached({ restartHost });
    receive({ type: "restartHost" });
    await settle(() => restartHost.mock.calls.length === 1);
  });

  it("rename_of_another_open_tab_goes_to_that_tab_with_a_normalized_name", async () => {
    const { receive, other, panelHost } = await openAttached();
    const rename = vi.fn(async () => ({ ok: true as const }));
    panelHost.registry.add("/s/other.jsonl", { rename } as unknown as ChatPanel);
    receive({ type: "rename", sessionPath: "/s/other.jsonl", name: `  a \n b ${"x".repeat(100)}  ` });
    await settle(() => other.some((message) => message["type"] === "renamed"));
    const name = (rename.mock.calls[0] as unknown as [string])[0];
    expect(name.startsWith("a b xxx")).toBe(true);
    expect(name.length).toBe(60);
  });

  it("rename_of_a_path_outside_the_project_is_rejected_without_touching_the_daemon", async () => {
    const { receive, other } = await openAttached();
    const before = opens().length;
    receive({ type: "rename", sessionPath: "/etc/passwd", name: "x" });
    await settle(() => other.some((message) => message["type"] === "renamed"));
    expect(other.at(-1)).toMatchObject({ type: "renamed", ok: false });
    expect(opens().length).toBe(before);
  });

  it("empty_rename_is_rejected", async () => {
    const { receive, other } = await openAttached();
    receive({ type: "rename", name: "   " });
    await settle(() => other.some((message) => message["type"] === "renamed"));
    expect(other.at(-1)).toMatchObject({ type: "renamed", ok: false });
    expect(daemon.requests.some((request) => request["type"] === "set_session_name")).toBe(false);
  });

  it("set_thinking_reaches_the_daemon", async () => {
    daemon.on("set_thinking_level", () => ({}));
    const { receive } = await openAttached();
    receive({ type: "setThinking", level: "high" });
    await settle(() => daemon.requests.some((request) => request["type"] === "set_thinking_level"));
    expect(daemon.requests.find((request) => request["type"] === "set_thinking_level")).toMatchObject({ sessionId: "rpc-1", level: "high" });
  });

  it("agent_cancel_reaches_the_daemon", async () => {
    daemon.on("extension_request", () => ({ data: { kind: "cancelled" } }));
    const { receive } = await openAttached();
    receive({ type: "agentCancel", taskId: "t9" });
    await settle(() => daemon.requests.some((request) => request["type"] === "extension_request"));
    expect(daemon.requests.find((request) => request["type"] === "extension_request")).toMatchObject({
      name: "omo.task.cancel",
      data: { task_id: "t9" },
    });
  });

  describe("a new tab is a draft until its first message", () => {
    beforeEach(() => {
      for (const type of ["set_model", "set_thinking_level", "prompt", "follow_up", "set_session_name"]) daemon.on(type, () => ({}));
    });

    const flow = (): string[] =>
      daemon.requests.map((request) => String(request["type"])).filter((type) => ["open_session", "set_model", "set_thinking_level", "prompt"].includes(type));

    it("opens_nothing_until_the_first_send_then_creates_applies_the_choices_and_sends", async () => {
      const fake = fakePanel();
      const models = [{ provider: "gw", id: "m2", name: "M2" }];
      const panelHost = host({ catalog: { models, thinkingLevels: ["low", "high"] } });
      const chat = ChatPanel.restore(panelHost, fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "ready" });
      fake.receive({ type: "setModel", model: { provider: "gw", id: "m2" } });
      fake.receive({ type: "setThinking", level: "high" });
      await settle(() => fake.posted.at(-1)?.state.thinkingLevel === "high");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(daemon.requests).toEqual([]); // no session, no file, no list entry
      expect(chat.isDraft).toBe(true);
      const draft = fake.posted.at(-1) as StateMessage;
      expect(draft.models).toEqual(models); // the window's last known models and levels
      expect(draft.thinkingLevels).toEqual(["low", "high"]);
      expect(draft.state.model).toEqual({ provider: "gw", id: "m2" });
      expect(draft.tab.modelMode).toBe("manual");
      expect(draft.tab.sessionPath).toBeUndefined();
      expect(draft.tab.draft).toBe(true); // the sessions list shows this tab as its own row

      const image = { mimeType: "image/png", data: "QUJD" };
      fake.receive({ type: "send", id: "m1", text: "привет", mode: "auto", images: [image] });
      fake.receive({ type: "send", id: "m2", text: "ещё", mode: "followUp" });
      await settle(() => fake.other.filter((message) => message["type"] === "sent").length === 2);
      expect(fake.other.filter((message) => message["type"] === "sent")).toEqual([
        { type: "sent", id: "m1", ok: true },
        { type: "sent", id: "m2", ok: true },
      ]);
      expect(flow()).toEqual(["open_session", "set_model", "set_thinking_level", "prompt"]);
      expect(opens()[0]).toMatchObject({ cwd: realpathSync(daemon.agentDir), retain_on_disconnect: true });
      expect(daemon.requests.find((request) => request["type"] === "set_model")).toMatchObject({ provider: "gw", modelId: "m2" });
      expect(daemon.requests.find((request) => request["type"] === "prompt")).toMatchObject({ message: "привет", images: [{ type: "image", ...image }] });
      expect(daemon.requests.some((request) => request["type"] === "follow_up")).toBe(true);
      expect(chat.isDraft).toBe(false);
      expect(panelHost.registry.get(SESSION_FILE)).toBe(chat);
      await settle(() => fake.posted.at(-1)?.tab.sessionPath !== undefined);
      expect(fake.posted.at(-1)?.tab.draft).toBeUndefined(); // a saved session is listed by the host
    });

    it("a_draft_renamed_from_the_header_keeps_the_name_and_names_its_session_on_creation", async () => {
      const fake = fakePanel();
      ChatPanel.restore(host(), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "rename", name: "  Моя   задача " });
      await settle(() => fake.other.some((message) => message["type"] === "renamed"));
      expect(fake.other.at(-1)).toEqual({ type: "renamed", ok: true });
      expect(fake.panel.title).toBe("Моя задача");
      await settle(() => fake.posted.at(-1)?.state.title === "Моя задача");
      expect(daemon.requests).toEqual([]);

      fake.receive({ type: "send", id: "m1", text: "привет", mode: "auto" });
      await settle(() => fake.other.some((message) => message["type"] === "sent"));
      const named = daemon.requests.map((request) => String(request["type"])).filter((type) => ["open_session", "set_session_name", "prompt"].includes(type));
      expect(named).toEqual(["open_session", "set_session_name", "prompt"]); // named before the prompt, never auto-titled over
      expect(daemon.requests.find((request) => request["type"] === "set_session_name")).toMatchObject({ name: "Моя задача" });
    });

    it("an_auto_choice_sends_no_set_model_and_a_failed_create_leaves_a_draft_that_retries", async () => {
      daemon.on("open_session", () => ({ errorCode: "open_failed", error: "no room" }));
      const fake = fakePanel();
      const chat = ChatPanel.restore(host(), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "setModel", model: "auto" });
      fake.receive({ type: "send", id: "m1", text: "привет", mode: "auto" });
      await settle(() => fake.other.some((message) => message["type"] === "sent"));
      expect(fake.other.at(-1)).toEqual({ type: "sent", id: "m1", ok: false });
      await settle(() => fake.posted.at(-1)?.state.error?.includes("no room") === true);
      expect(chat.isDraft).toBe(true);

      daemon.on("open_session", () => ({ data: openData("rpc-1") }));
      fake.receive({ type: "send", id: "m2", text: "привет", mode: "auto" });
      await settle(() => fake.other.filter((message) => message["type"] === "sent").length === 2);
      expect(fake.other.at(-1)).toEqual({ type: "sent", id: "m2", ok: true });
      expect(flow()).toEqual(["open_session", "open_session", "prompt"]);
    });
  });

  describe("the level a model is remembered at", () => {
    const AVAILABLE = ["off", "low", "medium", "high", "xhigh"];

    beforeEach(() => {
      for (const type of ["set_model", "set_thinking_level", "prompt"]) daemon.on(type, () => ({}));
    });

    const asked = (): Frame[] => daemon.requests.filter((request) => request["type"] === "get_model_thinking_level");
    const levelsSet = (): Frame[] => daemon.requests.filter((request) => request["type"] === "set_thinking_level");

    /** A draft whose first message creates the session; `reported` is what OmO says about the model it starts on. */
    async function created(reported: Record<string, unknown>, overrides: Partial<PanelHost> = {}): Promise<ReturnType<typeof fakePanel>> {
      daemon.on("get_model_thinking_level", () => ({ data: reported }));
      const fake = fakePanel();
      ChatPanel.restore(host(overrides), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "send", id: "m1", text: "привет", mode: "auto" });
      await settle(() => fake.other.some((message) => message["type"] === "sent"));
      return fake;
    }

    it("a_new_session_starts_at_the_level_the_person_last_chose_for_that_model", async () => {
      const fake = await created({ level: "high", source: "explicit", availableLevels: AVAILABLE }, { rememberedLevel: () => "medium" });
      expect(asked()[0]).toMatchObject({ provider: "gw", modelId: "m1" }); // the model the session opened on
      expect(levelsSet()).toEqual([expect.objectContaining({ level: "medium" })]);
      // applied before the first message, so the very first turn runs at the remembered level
      const order = daemon.requests.map((request) => String(request["type"])).filter((type) => ["open_session", "set_thinking_level", "prompt"].includes(type));
      expect(order).toEqual(["open_session", "set_thinking_level", "prompt"]);
      await settle(() => fake.posted.at(-1)?.state.thinkingLevel === "medium"); // and the composer shows it
    });

    it("a_level_omo_restored_itself_is_left_alone", async () => {
      await created({ level: "high", source: "global", availableLevels: AVAILABLE }, { rememberedLevel: () => "medium" });
      expect(levelsSet()).toEqual([]);
    });

    it("with_nothing_remembered_the_composer_still_shows_the_level_the_session_is_really_on", async () => {
      // A new session's journal walks through the profile's own steps; the host's answer is what the turn will run at.
      const fake = await created({ level: "high", source: "explicit", availableLevels: AVAILABLE });
      expect(levelsSet()).toEqual([]);
      await settle(() => fake.posted.at(-1)?.state.thinkingLevel === "high");
    });

    it("the_level_picked_in_the_draft_wins_over_the_remembered_one", async () => {
      daemon.on("get_model_thinking_level", () => ({ data: { level: "high", source: "explicit", availableLevels: AVAILABLE } }));
      const fake = fakePanel();
      ChatPanel.restore(host({ rememberedLevel: () => "medium" }), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "setThinking", level: "xhigh" });
      await settle(() => fake.posted.at(-1)?.state.thinkingLevel === "xhigh");
      fake.receive({ type: "send", id: "m1", text: "привет", mode: "auto" });
      await settle(() => fake.other.some((message) => message["type"] === "sent"));
      expect(levelsSet()).toEqual([expect.objectContaining({ level: "xhigh" })]);
      expect(asked()).toEqual([]);
    });

    it("a_session_that_existed_before_keeps_its_own_level", async () => {
      daemon.on("get_model_thinking_level", () => ({ data: { level: "high", source: "explicit", availableLevels: AVAILABLE } }));
      await openAttached({ rememberedLevel: () => "medium" });
      expect(asked()).toEqual([]);
      expect(levelsSet()).toEqual([]);
    });

    it("the_drafts_composer_shows_the_remembered_level_of_the_model_it_picked", async () => {
      const fake = fakePanel();
      const levels: Record<string, string> = { "gw/m2": "xhigh" };
      ChatPanel.restore(host({ rememberedLevel: (model) => levels[`${model.provider}/${model.id}`] }), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "setModel", model: { provider: "gw", id: "m2" } });
      await settle(() => fake.posted.at(-1)?.state.thinkingLevel === "xhigh");
      fake.receive({ type: "setModel", model: { provider: "gw", id: "m9" } }); // nothing remembered for it
      await settle(() => fake.posted.at(-1)?.state.thinkingLevel === undefined);
      expect(daemon.requests).toEqual([]); // still a draft: nothing reached omo
    });

    it("the_composer_follows_the_level_omo_restores_on_a_model_switch", async () => {
      const { posted } = await openAttached();
      daemon.push({ sessionId: "rpc-1", type: "model_changed", model: { provider: "gw", id: "m2" }, thinkingLevel: "xhigh", source: "set" });
      await settle(() => posted.at(-1)?.state.thinkingLevel === "xhigh");
      expect(posted.at(-1)?.state.model).toEqual({ provider: "gw", id: "m2" });
    });
  });

  it("csp_allows_data_images_and_nothing_else_inline", async () => {
    const { panel } = await openAttached();
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(panel.webview.html)?.[1] ?? "";
    const directives = Object.fromEntries(csp.split("; ").map((directive) => [directive.split(" ")[0], directive.split(" ").slice(1)]));
    expect(directives["img-src"]).toEqual(["vscode-resource:", "data:"]);
    expect(directives["style-src"]).toEqual(["vscode-resource:"]);
    expect(directives["default-src"]).toEqual(["'none'"]);
  });

  describe("settings", () => {
    const KEY = "sk-typed-in-the-modal-9876";

    /** A section that remembers the last saved key, showing only its last four characters. */
    function keySection(): SettingsSectionHost<{ key: string }> & { saved: string } {
      return {
        section: "connections",
        saved: "",
        parse: (raw) => (typeof raw["key"] === "string" ? { key: raw["key"] } : undefined),
        async view() {
          return { keyHint: this.saved === "" ? "" : `••••••${this.saved.slice(-4)}` };
        },
        async perform(action) {
          this.saved = action.key;
        },
      };
    }

    it("the_modal_gets_the_state_and_every_change_without_the_key_coming_back", async () => {
      const logged: string[] = [];
      const settings = new SettingsService({ name: "second", agentDir: "/a" }, (text) => logged.push(text));
      settings.register(keySection() as SettingsSectionHost<unknown>);
      const panelHost = host({ settings, log: (text) => logged.push(text) });
      const asked = fakePanel();
      const silent = fakePanel();
      ChatPanel.restore(panelHost, asked.panel, { kind: "new", cwd: daemon.agentDir });
      ChatPanel.restore(panelHost, silent.panel, { kind: "new", cwd: daemon.agentDir });

      asked.receive({ type: "settingsGet" });
      await settle(() => asked.other.some((message) => message["type"] === "settings"));
      expect(asked.other).toContainEqual({ type: "settings", state: { env: { name: "second", agentDir: "/a" }, connections: { keyHint: "" } } });

      asked.receive({ type: "settingsAction", id: "a1", section: "connections", action: { key: KEY } });
      await settle(() => asked.other.some((message) => message["type"] === "settingsResult"));
      expect(asked.other).toContainEqual({ type: "settingsResult", id: "a1", ok: true });
      await settle(() => asked.other.filter((message) => message["type"] === "settings").length === 2);
      expect(asked.other.at(-1)).toEqual({ type: "settings", state: { env: { name: "second", agentDir: "/a" }, connections: { keyHint: "••••••9876" } } });

      asked.receive({ type: "settingsAction", id: "a2", section: "connections", action: { nonsense: KEY } });
      await settle(() => asked.other.some((message) => message["id"] === "a2"));
      expect(asked.other.at(-1)).toEqual({ type: "settingsResult", id: "a2", ok: false, error: expect.any(String) });

      expect(JSON.stringify(asked.other)).not.toContain(KEY);
      expect(logged.join("\n")).not.toContain(KEY);
      expect(silent.other.filter((message) => String(message["type"]).startsWith("settings"))).toEqual([]); // never asked
    });

    function ready({ any }: { any: boolean }): ReturnType<typeof fakePanel> {
      const fake = fakePanel();
      ChatPanel.restore(host({ firstRun: async () => !any }), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "ready" });
      return fake;
    }

    it("first_run_opens_connections", async () => {
      const { other } = ready({ any: false });
      await settle(() => other.some((message) => message["type"] === "openSettings"));
      expect(other).toContainEqual({ type: "openSettings", section: "connections", firstRun: true });
    });

    it("no_first_run_when_something_is_connected", async () => {
      const { other, kinds } = ready({ any: true });
      await settle(() => kinds.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(other.map((message) => message["type"])).not.toContain("openSettings");
    });

    it("login_events_go_to_every_tab_that_opened_the_settings", async () => {
      const settings = new SettingsService({ name: "second", agentDir: "/a" }, () => undefined);
      settings.setMaxListeners(0);
      const panelHost = host({ settings });
      const asked = fakePanel();
      const silent = fakePanel();
      ChatPanel.restore(panelHost, asked.panel, { kind: "new", cwd: daemon.agentDir });
      ChatPanel.restore(panelHost, silent.panel, { kind: "new", cwd: daemon.agentDir });
      asked.receive({ type: "settingsGet" });
      await settle(() => asked.other.some((message) => message["type"] === "settings"));
      settings.emit("login", { kind: "progress", text: "жду браузер" });
      expect(asked.other.at(-1)).toEqual({ type: "settingsLogin", event: { kind: "progress", text: "жду браузер" } });
      expect(silent.other).toEqual([]);
    });

    it("without_an_environment_the_modal_gets_the_reason_and_an_action_a_refusal", async () => {
      const fake = fakePanel();
      ChatPanel.restore(host(), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "settingsGet" });
      await settle(() => fake.other.some((message) => message["type"] === "settings"));
      expect(fake.other).toContainEqual({ type: "settings", state: { unavailable: SETTINGS_UNAVAILABLE } });
      fake.receive({ type: "settingsAction", id: "a1", section: "tools", action: {} });
      await settle(() => fake.other.some((message) => message["type"] === "settingsResult"));
      expect(fake.other).toContainEqual({ type: "settingsResult", id: "a1", ok: false, error: SETTINGS_UNAVAILABLE });
    });

    it("a_throwing_settings_service_still_gets_both_answers_and_the_key_stays_out", async () => {
      const broken = {
        on: () => undefined,
        off: () => undefined,
        state: async () => {
          throw new Error("state exploded");
        },
        perform: async () => {
          throw new Error(`perform exploded on ${KEY}`);
        },
      } as unknown as SettingsService;
      const logged: string[] = [];
      const fake = fakePanel();
      ChatPanel.restore(host({ settings: broken, log: (text) => logged.push(text) }), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "settingsGet" });
      await settle(() => fake.other.some((message) => message["type"] === "settings"));
      expect(fake.other).toContainEqual({ type: "settings", state: { unavailable: expect.any(String) } });
      fake.receive({ type: "settingsAction", id: "a1", section: "tools", action: { key: KEY } });
      await settle(() => fake.other.some((message) => message["type"] === "settingsResult"));
      expect(fake.other).toContainEqual({ type: "settingsResult", id: "a1", ok: false, error: expect.any(String) });
      expect(JSON.stringify(fake.other)).not.toContain(KEY);
      expect(logged.join("\n")).not.toContain(KEY);
    });
  });

  describe("message actions", () => {
    /** A session file in a git repo: c1 asked the agent to edit a.txt, which it did after a snapshot. */
    async function rewindable(): Promise<{ sessionFile: string; checkpointer: Checkpointer; repo: string }> {
      const repo = await makeRepo({ "a.txt": "a" });
      const realRepo = realpathSync(repo);
      const store = new CheckpointStore(daemon.agentDir);
      const checkpointer = new Checkpointer({ store, agentDir: daemon.agentDir });
      const { commit, skipped } = await takeSnapshot(realRepo, "p1");
      await store.append("durable-1", [{ type: "point", id: "p1", clientMessageId: "c1", repo: realRepo, commit, skipped, at: Date.now() }]);
      writeFileSync(join(repo, "a.txt"), "agent");
      const entries = [
        { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Fix" }], clientMessageId: "c1", timestamp: 1 } },
        { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "a.txt" } }] } },
        { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "t1", toolName: "edit", isError: false } },
      ];
      const sessionFile = join(mkdtempSync(join(tmpdir(), "agent-tabs-panel-")), "2026-11-04T09-00-00-000Z_durable-1.jsonl");
      writeFileSync(sessionFile, [{ type: "session", id: "durable-1", cwd: realRepo }, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      daemon.on("open_session", () => ({ data: { sessionId: "rpc-1", state: { sessionFile, sessionId: "durable-1", isStreaming: false } } }));
      daemon.on("get_entries", () => ({ data: { entries, hasMore: false, leafId: "r1" } }));
      daemon.on("list_sessions", () => ({ data: { sessions: [] } }));
      return { sessionFile, checkpointer, repo };
    }

    it("message_actions_are_answered_without_a_session", async () => {
      const fake = fakePanel();
      ChatPanel.restore(host(), fake.panel, { kind: "new", cwd: daemon.agentDir });
      fake.receive({ type: "messageActions", blockId: "c1" });
      fake.receive({ type: "rewindPreview", blockId: "c1", fork: true });
      fake.receive({ type: "rewind", blockId: "c1", fork: false, fingerprint: "fp" });
      await settle(() => fake.other.length === 3);
      const closed = { ok: false, reason: "Сессия не открыта" };
      expect(fake.other).toEqual([
        { type: "messageActions", blockId: "c1", fork: closed, rewind: closed },
        { type: "rewindPreview", blockId: "c1", fork: true, excerpt: "", ...closed },
        { type: "rewound", blockId: "c1", ...closed },
      ]);
      expect(daemon.requests).toEqual([]);
    });

    it("fork_opens_a_new_tab_whose_webview_gets_the_draft_once_after_ready", async () => {
      const { sessionFile, checkpointer } = await rewindable();
      const fake = fakePanel();
      const forked = fakePanel();
      const openFork = vi.fn((sessionPath: string, draft: { text: string; images: [] }) => {
        ChatPanel.restore(host(), forked.panel, { kind: "attach", sessionPath, draft });
      });
      const panelHost = host({ checkpointer, openFork });
      ChatPanel.restore(panelHost, fake.panel, { kind: "attach", sessionPath: sessionFile });
      await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));
      fake.receive({ type: "fork", blockId: "c1" });
      await settle(() => openFork.mock.calls.length === 1);
      const [path, draft, column] = openFork.mock.calls[0] as unknown as [string, unknown, unknown];
      expect(dirname(path)).toBe(dirname(sessionFile));
      expect(draft).toEqual({ text: "Fix", images: [] });
      expect(column).toBe(2);
      forked.receive({ type: "ready" });
      forked.receive({ type: "ready" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(forked.other.filter((message) => message["type"] === "draft")).toEqual([{ type: "draft", text: "Fix", images: [] }]);
    });

    it("a_fork_is_named_after_its_source_once_open", async () => {
      const { sessionFile, checkpointer } = await rewindable();
      daemon.on("open_session", () => ({ data: { sessionId: "rpc-1", state: { sessionFile, sessionId: "durable-1", isStreaming: false, sessionName: "Починить вход (fork)" } } }));
      daemon.on("set_session_name", () => ({}));
      const fake = fakePanel();
      const forked = fakePanel();
      const openFork = vi.fn((sessionPath: string, draft: { text: string; images: [] }, _column: unknown, name?: string) => {
        ChatPanel.restore(host(), forked.panel, { kind: "attach", sessionPath, draft, ...(name !== undefined ? { name } : {}) });
      });
      ChatPanel.restore(host({ checkpointer, openFork }), fake.panel, { kind: "attach", sessionPath: sessionFile });
      await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));
      fake.receive({ type: "fork", blockId: "c1" });
      await settle(() => daemon.requests.some((request) => request["type"] === "set_session_name"));
      expect(openFork.mock.calls[0]?.[3]).toBe("Починить вход (fork 2)");
      expect(daemon.requests.filter((request) => request["type"] === "set_session_name").map((request) => request["name"])).toEqual(["Починить вход (fork 2)"]);
    });

    it("fork_session_copies_the_whole_conversation_into_a_new_tab_without_a_draft", async () => {
      const { sessionFile, checkpointer } = await rewindable();
      const fake = fakePanel();
      const openFork = vi.fn();
      ChatPanel.restore(host({ checkpointer, openFork }), fake.panel, { kind: "attach", sessionPath: sessionFile });
      await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));
      fake.receive({ type: "forkSession" });
      await settle(() => openFork.mock.calls.length === 1);
      const [path, draft, column] = openFork.mock.calls[0] as unknown as [string, unknown, unknown];
      expect(dirname(path)).toBe(dirname(sessionFile));
      expect(draft).toBeUndefined();
      expect(column).toBe(2);
      const ids = readFileSync(path, "utf8").trimEnd().split("\n").slice(1).map((line) => (JSON.parse(line) as { id: string }).id);
      expect(ids).toEqual(["u1", "a1", "r1"]);
    });

    it("rewind_request_routes_to_the_service_and_answers_rewound", async () => {
      const { sessionFile, checkpointer, repo } = await rewindable();
      const fake = fakePanel();
      ChatPanel.restore(host({ checkpointer }), fake.panel, { kind: "attach", sessionPath: sessionFile });
      await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));
      fake.receive({ type: "messageActions", blockId: "c1" });
      await settle(() => fake.other.some((message) => message["type"] === "messageActions"));
      expect(fake.other.find((message) => message["type"] === "messageActions")).toEqual({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: true } });
      fake.receive({ type: "rewindPreview", blockId: "c1", fork: false });
      await settle(() => fake.other.some((message) => message["type"] === "rewindPreview"));
      const preview = fake.other.find((message) => message["type"] === "rewindPreview") as { fingerprint: string };
      fake.receive({ type: "rewind", blockId: "c1", fork: false, fingerprint: "stale" });
      await settle(() => fake.other.some((message) => message["type"] === "rewound"));
      expect(fake.other.slice(-2).map((message) => message["type"])).toEqual(["rewindPreview", "rewound"]); // a changed plan: the new preview first
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("agent");
      fake.other.length = 0;
      fake.receive({ type: "rewind", blockId: "c1", fork: false, fingerprint: preview.fingerprint });
      await settle(() => fake.other.some((message) => message["type"] === "rewound"));
      expect(fake.other.find((message) => message["type"] === "rewound")).toEqual({ type: "rewound", blockId: "c1", ok: true, count: 1 });
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a");
    });

    it("rewind_is_refused_when_the_live_sessions_cannot_be_listed", async () => {
      const { sessionFile, checkpointer, repo } = await rewindable();
      daemon.on("list_sessions", () => ({ error: "host busy", errorCode: "internal" }));
      const fake = fakePanel();
      ChatPanel.restore(host({ checkpointer }), fake.panel, { kind: "attach", sessionPath: sessionFile });
      await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));
      const reason = "Не удалось проверить, не идёт ли ход в другой сессии этого проекта";
      fake.receive({ type: "messageActions", blockId: "c1" });
      await settle(() => fake.other.some((message) => message["type"] === "messageActions"));
      expect(fake.other.find((message) => message["type"] === "messageActions")).toEqual({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: false, reason } });
      fake.receive({ type: "rewind", blockId: "c1", fork: false, fingerprint: "any" });
      await settle(() => fake.other.some((message) => message["type"] === "rewound"));
      expect(fake.other.find((message) => message["type"] === "rewound")).toEqual({ type: "rewound", blockId: "c1", ok: false, reason });
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("agent");
    });

    it("a_refused_fork_warns_with_its_reason", async () => {
      const { sessionFile, checkpointer } = await rewindable();
      const fake = fakePanel();
      const openFork = vi.fn();
      ChatPanel.restore(host({ checkpointer, openFork }), fake.panel, { kind: "attach", sessionPath: sessionFile });
      await settle(() => daemon.requests.some((request) => request["type"] === "get_available_models"));
      vi.mocked(vscode.window.showWarningMessage).mockClear();
      fake.receive({ type: "fork", blockId: "missing" });
      await settle(() => vi.mocked(vscode.window.showWarningMessage).mock.calls.length > 0);
      expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toBe("Сообщение не найдено в журнале сессии");
      expect(openFork).not.toHaveBeenCalled();
    });
  });

  describe("the model ladder", () => {
    const LADDER: Ladder = {
      rungs: [
        { id: "top", action: { kind: "model", provider: "gw", id: "m1" }, on: [] },
        { id: "next", action: { kind: "model", provider: "gw", id: "m2" }, on: ["refusal", "rejected", "empty", "silence", "transport"] },
        { id: "ask", action: { kind: "ask" }, on: ["refusal", "rejected", "empty", "silence", "transport"] },
      ],
    };

    const ladderMessages = (fake: { other: Record<string, unknown>[] }): Record<string, unknown>[] => fake.other.filter((message) => message["type"] === "ladder");
    const setModels = (): Frame[] => daemon.requests.filter((request) => request["type"] === "set_model");

    function refuse(): void {
      daemon.push({ sessionId: "rpc-1", type: "agent_start" });
      daemon.push({
        sessionId: "rpc-1",
        type: "message_end",
        message: { role: "assistant", timestamp: 9, content: [], stopReason: "error", rawStopReason: "refusal", stopDetails: { type: "refusal", explanation: "нет" } },
      });
    }

    async function sentAndDelivered(fake: ReturnType<typeof fakePanel>, text: string): Promise<void> {
      fake.receive({ type: "send", id: "m-own", text, mode: "auto" });
      await settle(() => daemon.requests.some((request) => request["type"] === "prompt"));
      daemon.push({ sessionId: "rpc-1", type: "message_start", message: { role: "user", clientMessageId: "m-own", content: [{ type: "text", text }] } });
    }

    beforeEach(() => {
      daemon.on("get_available_models", () => ({
        data: { models: [{ provider: "gw", id: "m1", name: "Первая" }, { provider: "gw", id: "m2", name: "Вторая" }] },
      }));
      daemon.on("prompt", (request) => ({ data: { disposition: "started", clientMessageId: request["clientMessageId"] } }));
      daemon.on("steer", () => ({ data: { disposition: "queued" } }));
      daemon.on("abort", () => ({}));
      daemon.on("set_model", () => ({}));
    });

    it("the_persons_send_arms_the_ladder_and_its_line_reaches_the_webview", async () => {
      const fake = await openAttached({ ladder: () => LADDER });
      await sentAndDelivered(fake, "разбери кошельки");
      refuse();
      await settle(() => ladderMessages(fake).length > 0);
      expect(ladderMessages(fake)[0]).toEqual({ type: "ladder", view: { state: "walking", rung: 2, total: 3, label: "Вторая" } });
      await settle(() => setModels().length === 1);
    });

    it("an_interrupt_from_the_webview_stops_the_walk", async () => {
      const fake = await openAttached({ ladder: () => LADDER });
      await sentAndDelivered(fake, "привет");
      fake.receive({ type: "ladderInterrupt" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      refuse();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(setModels()).toHaveLength(0);
      expect(ladderMessages(fake)).toEqual([]);
    });

    it("a_window_without_a_ladder_never_builds_one", async () => {
      const fake = await openAttached();
      await sentAndDelivered(fake, "привет");
      refuse();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(setModels()).toHaveLength(0);
      expect(ladderMessages(fake)).toEqual([]);
    });
  });
});
