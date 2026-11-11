// @vitest-environment jsdom
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { DaemonManager, hostSocketPath } from "../../src/daemon";
import { ChatPanel, type PanelHost } from "../../src/panel/ChatPanel";
import type { HostMessage } from "../../src/panel/protocol";
import { PanelRegistry } from "../../src/panel/registry";
import { ChatView } from "../../webview/render";
import { FakeDaemon } from "../helpers/fakeDaemon";

vi.mock("vscode", () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.slice(1).join("/") }), parse: (value: string) => value },
  ViewColumn: { Active: -1 },
  window: { showWarningMessage: vi.fn() },
  workspace: {},
  commands: {},
  env: {},
}));

const SESSION_FILE = "/tmp/agent/sessions/--proj--/2026_abc.jsonl";

let daemon: FakeDaemon;
let manager: DaemonManager;

beforeEach(async () => {
  daemon = await FakeDaemon.start();
  await mkdir(join(daemon.agentDir, "rpc"), { recursive: true });
  await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
  manager = new DaemonManager({ env: {}, agentDir: daemon.agentDir, omoPath: "/fake/omo", secrets: [] });
  daemon.on("open_session", () => ({ data: { sessionId: "rpc-1", state: { sessionFile: SESSION_FILE, sessionId: "durable-1", isStreaming: true } } }));
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

async function settle(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 400 && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

describe("agents popover end to end", () => {
  it("a_task_row_from_omo_task_updated_asks_the_host_with_the_raw_task_id", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.getElementById("app") as HTMLElement;
    const toHost: ((raw: unknown) => void)[] = [];
    let view: ChatView | undefined;
    const panel = {
      title: "",
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: unknown) => uri,
        onDidReceiveMessage: (listener: (raw: unknown) => void) => {
          toHost.push(listener);
          return { dispose: () => undefined };
        },
        postMessage: async (json: string) => {
          const message = JSON.parse(json) as HostMessage;
          if (message.type === "state") view?.update(message);
          if (message.type === "delta") view?.delta(message);
          if (message.type === "agentDetails") view?.agentDetails(message);
          return true;
        },
      },
      onDidChangeViewState: () => ({ dispose: () => undefined }),
      onDidDispose: () => ({ dispose: () => undefined }),
      reveal: () => undefined,
    } as unknown as vscode.WebviewPanel;
    view = new ChatView(root, (message) => toHost.forEach((listener) => listener(JSON.parse(JSON.stringify(message)))));
    const host: PanelHost = {
      extensionUri: {} as vscode.Uri,
      registry: new PanelRegistry<ChatPanel>(),
      panels: new Set<ChatPanel>(),
      catalog: {},
      updateCatalog: () => undefined,
      onCatalogChange: () => () => undefined,
      secrets: [],
      log: () => undefined,
      daemon: () => ({ ok: true, value: manager }),
      listSessions: async () => [],
      setPinned: async () => undefined,
      setArchived: async () => undefined,
      openSession: async () => undefined,
      newSession: () => undefined,
      restartHost: () => undefined,
      isProjectSession: async () => false,
      showOutput: vi.fn(async () => undefined),
      isPinned: () => false,
      openFork: () => undefined,
    };
    daemon.on("extension_request", () => ({ data: { kind: "transcript", mode: "full", transcript: "done", snapshot: { status: "running" } } }));
    ChatPanel.restore(host, panel, { kind: "attach", sessionPath: SESSION_FILE, saved: { sessionPath: SESSION_FILE, modelMode: "auto" } });
    await settle(() => daemon.requests.some((request) => request["type"] === "get_commands"));

    daemon.push({ sessionId: "rpc-1", type: "extension_event", name: "omo.task.updated", data: { tasks: [{ task_id: "bg_7f3a", name: "Поиск", status: "running" }] } });
    const pill = root.querySelector('[data-role="agents-pill"]') as HTMLElement;
    await settle(() => pill.textContent === "1 агент работает");
    pill.click();
    const row = root.querySelector('[data-popover="agents"] [data-row]') as HTMLElement;
    row.click();
    await settle(() => daemon.requests.some((request) => request["name"] === "omo.task.output"));
    expect(daemon.requests.find((request) => request["name"] === "omo.task.output")).toMatchObject({
      type: "extension_request",
      data: { task_id: "bg_7f3a", parent_session_id: "durable-1" },
    });
    const log = (): string | null | undefined => root.querySelector('[data-role="agent-details-log"] pre')?.textContent;
    await settle(() => log() === "done"); // the answer lands in the details modal
    root.querySelector<HTMLElement>('[data-role="agent-details-close"]')?.click();

    (root.querySelector('[data-popover="agents"] [data-row]') as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    await settle(() => daemon.requests.some((request) => request["type"] === "extension_request" && request["name"] === "omo.task.cancel"));
    expect(daemon.requests.find((request) => request["name"] === "omo.task.cancel")).toMatchObject({ data: { task_id: "bg_7f3a" } });
  });
});
