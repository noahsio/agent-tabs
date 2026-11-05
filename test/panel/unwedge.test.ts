import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { DaemonManager, hostSocketPath } from "../../src/daemon";
import type { OmoEnv } from "../../src/env";
import { ChatPanel, type PanelHost } from "../../src/panel/ChatPanel";
import { applyDelta } from "../../src/panel/delta";
import type { HostMessage, StateMessage } from "../../src/panel/protocol";
import { PanelRegistry } from "../../src/panel/registry";
import { resetAutoUnwedge } from "../../src/sessions/autoUnwedge";
import { FakeDaemon, type Frame } from "../helpers/fakeDaemon";

vi.mock("vscode", () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.slice(1).join("/") }), parse: (value: string) => value, file: (path: string) => ({ fsPath: path }) },
  ViewColumn: { Active: -1, One: 1 },
  window: { showWarningMessage: vi.fn(), createWebviewPanel: vi.fn(), showTextDocument: vi.fn(), tabGroups: { activeTabGroup: { viewColumn: 1 } } },
  workspace: { openTextDocument: vi.fn() },
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
}));

const SESSION_FILE = "/tmp/agent/sessions/--proj--/wedged.jsonl";
const SECRET = "sekret-key-123";

let daemon: FakeDaemon;
let manager: DaemonManager;

function envFor(agentDir: string): OmoEnv {
  return { env: { OMO_CODING_AGENT_DIR: agentDir, GW_API_KEY: SECRET }, agentDir, omoPath: "/fake/omo", secrets: [SECRET] };
}

function openData(handle: string, streaming: boolean): unknown {
  return { sessionId: handle, state: { sessionFile: SESSION_FILE, sessionId: "durable-1", isStreaming: streaming, pendingDialogs: [], model: { provider: "gw", id: "m1" } } };
}

function fakePanel(): { panel: vscode.WebviewPanel; posted: StateMessage[]; other: Record<string, unknown>[]; receive(raw: unknown): void } {
  const other: Record<string, unknown>[] = [];
  const listeners: ((raw: unknown) => void)[] = [];
  const posted: StateMessage[] = [];
  const panel = {
    title: "",
    iconPath: undefined,
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
        if (message.type === "state") posted.push(message);
        else if (message.type === "delta") posted.push(applyDelta(posted.at(-1) as StateMessage, message));
        else other.push(message as unknown as Record<string, unknown>);
        return true;
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    reveal: () => undefined,
    viewColumn: 1,
  };
  return { panel: panel as unknown as vscode.WebviewPanel, posted, other, receive: (raw) => listeners.forEach((listener) => listener(raw)) };
}

function host(): PanelHost {
  return {
    extensionUri: {} as vscode.Uri,
    registry: new PanelRegistry<ChatPanel>(),
    panels: new Set<ChatPanel>(),
    catalog: {},
    updateCatalog: () => undefined,
    onCatalogChange: () => () => undefined,
    secrets: [SECRET],
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
  };
}

function requests(type: string): Frame[] {
  return daemon.requests.filter((request) => request["type"] === type);
}

/** The local lines in the feed, as the person reads them. */
function notices(posted: StateMessage[]): string[] {
  return (posted.at(-1)?.state.blocks ?? []).flatMap((block) => (block.kind === "notice" ? [block.text] : []));
}

/** The messages the tab shows as waiting in OmO's queue. */
function queued(posted: StateMessage[]): string[] {
  return (posted.at(-1)?.state.blocks ?? []).flatMap((block) => (block.kind === "user" && block.delivery?.state === "queued" ? [block.text] : []));
}

async function settle(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 400 && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

/** A tab attached to a session OmO reports as mid-turn: exactly the state a wedge leaves behind. */
async function wedgedTab(): Promise<ReturnType<typeof fakePanel>> {
  const fake = fakePanel();
  ChatPanel.restore(host(), fake.panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
  await settle(() => requests("get_commands").length > 0);
  await settle(() => fake.posted.at(-1)?.state.running === true);
  return fake;
}

beforeEach(async () => {
  resetAutoUnwedge(); // the cooldown lives in the extension process, which the test suite shares
  daemon = await FakeDaemon.start();
  await mkdir(join(daemon.agentDir, "rpc"), { recursive: true });
  await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
  manager = new DaemonManager(envFor(daemon.agentDir));
  daemon.on("open_session", () => ({ data: openData("rpc-1", true) }));
  daemon.on("get_entries", () => ({ data: { entries: [], hasMore: false } }));
  daemon.on("get_available_models", () => ({ data: { models: [] } }));
  daemon.on("get_available_thinking_levels", () => ({ data: { levels: [] } }));
  daemon.on("get_commands", () => ({ data: { commands: [] } }));
  daemon.on("release_attachment", () => ({}));
});

afterEach(async () => {
  manager.dispose();
  await daemon.stop();
});

describe("unwedgeSession", () => {
  it("unloads_the_stuck_session_and_opens_it_again_in_the_same_tab", async () => {
    const { posted, other, receive } = await wedgedTab();
    daemon.on("unload_session", (request) => ({
      data: { outcome: "unloaded", sessionPath: SESSION_FILE },
      frames: [{ sessionId: request["sessionId"], type: "session_parked", sessionPath: SESSION_FILE, reason: "unloaded" }],
    }));
    daemon.on("open_session", () => ({ data: openData("rpc-2", false) })); // the reopened session is idle again

    receive({ type: "unwedge" });
    await settle(() => other.some((message) => message["type"] === "unwedged"));

    expect(requests("unload_session")).toEqual([
      expect.objectContaining({ sessionId: "rpc-1", interrupt: true, force: true, children: "detach" }),
    ]);
    expect(other.at(-1)).toEqual({ type: "unwedged", outcome: "unloaded" });
    // The tab came back usable: a second open by path, a live handle and no turn left running.
    expect(requests("open_session").length).toBeGreaterThanOrEqual(2);
    expect(requests("open_session").at(-1)).toMatchObject({ sessionPath: SESSION_FILE, retain_on_disconnect: true });
    await settle(() => posted.at(-1)?.state.running === false);
    expect(posted.at(-1)?.state.error).toBeUndefined();
  });

  it("a_refusal_changes_nothing_and_is_reported_in_the_persons_words", async () => {
    const { other, receive } = await wedgedTab();
    daemon.on("unload_session", () => ({ data: { outcome: "refused", reason: "children_live", detail: "2 задачи", action: "children" } }));
    const opens = requests("open_session").length;

    receive({ type: "unwedge" });
    await settle(() => other.some((message) => message["type"] === "unwedged"));

    expect(other.at(-1)).toEqual({ type: "unwedged", outcome: "refused", reason: "Дочерние задачи ещё работают: 2 задачи" });
    expect(requests("open_session").length).toBe(opens); // nothing was reopened
  });

  it("a_park_omo_sends_by_itself_reopens_the_session_so_the_tab_never_looks_stuck", async () => {
    const { posted } = await wedgedTab();
    daemon.on("open_session", () => ({ data: openData("rpc-2", false) }));
    const opens = requests("open_session").length;

    daemon.push({ sessionId: "rpc-1", type: "session_parked", sessionPath: SESSION_FILE, reason: "idle" });
    await settle(() => requests("open_session").length > opens);
    await settle(() => posted.at(-1)?.state.running === false);
    expect(requests("unload_session")).toEqual([]); // the park was not ours
  });

  it("nothing_is_ever_unloaded_without_the_message", async () => {
    const { receive } = await wedgedTab();
    daemon.on("abort", () => ({}));
    daemon.on("compact", () => ({}));
    receive({ type: "stop" });
    receive({ type: "compact" });
    receive({ type: "reconnect" });
    await settle(() => requests("abort").length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests("unload_session")).toEqual([]);
  });

  it("the_automatic_restart_happens_once_per_session_and_says_so_in_the_feed", async () => {
    const { posted, other, receive } = await wedgedTab();
    daemon.on("unload_session", (request) => ({
      data: { outcome: "unloaded", sessionPath: SESSION_FILE },
      frames: [{ sessionId: request["sessionId"], type: "session_parked", sessionPath: SESSION_FILE, reason: "unloaded" }],
    }));
    daemon.on("open_session", () => ({ data: openData("rpc-2", false) }));

    receive({ type: "unwedge", auto: true });
    await settle(() => other.some((message) => message["type"] === "unwedged"));
    expect(other.at(-1)).toEqual({ type: "unwedged", auto: true, outcome: "unloaded" });
    await settle(() => notices(posted).includes("Агент не ответил на «Стоп» — перезапустил сессию"));
    expect(requests("unload_session").length).toBe(1);

    // The same session asking again within the cooldown is told so, and nothing is unloaded a second time.
    receive({ type: "unwedge", auto: true });
    await settle(() => other.filter((message) => message["type"] === "unwedged").length === 2);
    expect(other.at(-1)).toEqual({ type: "unwedged", auto: true, outcome: "cooldown" });
    expect(requests("unload_session").length).toBe(1);

    // The person's own click is not rationed: it is theirs to make.
    receive({ type: "unwedge" });
    await settle(() => other.filter((message) => message["type"] === "unwedged").length === 3);
    expect(requests("unload_session").length).toBe(2);
  });

  it("a_refused_automatic_restart_is_said_in_the_feed_and_changes_nothing", async () => {
    const { posted, other, receive } = await wedgedTab();
    daemon.on("unload_session", () => ({ data: { outcome: "refused", reason: "children_live", detail: "2 задачи", action: "children" } }));
    const opens = requests("open_session").length;

    receive({ type: "unwedge", auto: true });
    await settle(() => other.some((message) => message["type"] === "unwedged"));

    expect(other.at(-1)).toEqual({ type: "unwedged", auto: true, outcome: "refused", reason: "Дочерние задачи ещё работают: 2 задачи" });
    expect(notices(posted)).toContain("Не удалось перезапустить сессию: Дочерние задачи ещё работают: 2 задачи");
    expect(requests("open_session").length).toBe(opens);
  });

  /**
   * The restart has to leave the tab honest. OmO reopens the session in the state its last turn was left in: nothing
   * streams, yet the lifecycle still reads "running" and names that very run as the one it stopped, and the message
   * the person queued is still in its queue. The tab used to keep the verb it was showing and go on waiting for an end
   * frame that never comes — composer locked in its queue mode, «Стоп» armed, the queued message never leaving.
   */
  it("the_restart_leaves_the_turn_over_in_the_tab_too", async () => {
    const { posted, other, receive } = await wedgedTab();
    daemon.push({ sessionId: "rpc-1", type: "entry_appended", entry: { type: "custom", id: "e1" } }); // a journal to catch up from
    daemon.push({ sessionId: "rpc-1", type: "session_lifecycle", lifecycle: { state: "waiting_human", runId: "run-1" } });
    daemon.push({
      sessionId: "rpc-1",
      type: "queue_update",
      steering: [],
      followUp: ["продолжай"],
      ordered: [{ text: "продолжай", mode: "followUp", queuedId: "q_1", revision: 1, clientMessageId: "m-2" }],
    });
    await settle(() => posted.at(-1)?.state.activity === "waiting_human");
    await settle(() => queued(posted).length === 1);

    daemon.on("unload_session", (request) => ({
      data: { outcome: "unloaded", sessionPath: SESSION_FILE },
      frames: [{ sessionId: request["sessionId"], type: "session_parked", sessionPath: SESSION_FILE, reason: "unloaded" }],
    }));
    daemon.on("open_session", () => ({
      data: {
        sessionId: "rpc-2",
        state: {
          sessionFile: SESSION_FILE,
          sessionId: "durable-1",
          isStreaming: false,
          pendingDialogs: [],
          model: { provider: "gw", id: "m1" },
          lifecycle: { state: "running", runId: "run-1", lastStop: { runId: "run-1", cause: "aborted", abortSource: "user" } },
          steering: [],
          followUp: ["продолжай"],
        },
      },
    }));

    receive({ type: "unwedge", auto: true });
    await settle(() => other.some((message) => message["type"] === "unwedged"));
    await settle(() => posted.at(-1)?.state.running === false);
    expect(posted.at(-1)?.state.activity).not.toBe("waiting_human"); // the verb the tab was showing is not carried over

    // The composer is usable again: the next message starts a turn instead of steering one that is over.
    daemon.on("prompt", (request) => ({ data: { disposition: "started", clientMessageId: request["clientMessageId"] } }));
    receive({ type: "send", id: "m-3", text: "дальше", mode: "auto" });
    await settle(() => requests("prompt").length > 0);
    expect(requests("steer")).toEqual([]);
  });

  /** The same reading must not call a turn over while it runs: a live run is one the host has not stopped. */
  it("a_reopen_during_a_running_turn_keeps_the_turn", async () => {
    const { posted } = await wedgedTab();
    daemon.on("open_session", () => ({
      data: {
        sessionId: "rpc-2",
        state: {
          sessionFile: SESSION_FILE,
          sessionId: "durable-1",
          isStreaming: false, // a turn inside a tool call streams nothing
          pendingDialogs: [],
          model: { provider: "gw", id: "m1" },
          lifecycle: { state: "running", runId: "run-2", activity: { kind: "tool", toolName: "bash" } },
        },
      },
    }));
    const opens = requests("open_session").length;

    daemon.push({ sessionId: "rpc-1", type: "session_parked", sessionPath: SESSION_FILE, reason: "idle" });
    await settle(() => requests("open_session").length > opens);
    await settle(() => posted.at(-1)?.state.activity === "tool");
    expect(posted.at(-1)?.state.running).toBe(true);
  });

  it("a_tab_without_a_session_still_gets_an_answer", async () => {
    const fake = fakePanel();
    daemon.on("open_session", () => ({ errorCode: "open_failed", error: "no" }));
    ChatPanel.restore(host(), fake.panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
    await settle(() => fake.posted.at(-1)?.state.error !== undefined);

    fake.receive({ type: "unwedge" });
    await settle(() => fake.other.some((message) => message["type"] === "unwedged"));
    expect(fake.other.at(-1)).toEqual({ type: "unwedged", outcome: "failed", reason: "Сессия не открыта" });
    expect(requests("unload_session")).toEqual([]);
  });
});
