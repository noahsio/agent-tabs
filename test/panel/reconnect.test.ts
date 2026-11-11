import { EventEmitter } from "node:events";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { DaemonManager, hostSocketPath, type HostProcess, type SpawnFn } from "../../src/daemon";
import type { OmoEnv } from "../../src/env";
import { ChatPanel, type PanelHost } from "../../src/panel/ChatPanel";
import { applyDelta } from "../../src/panel/delta";
import type { HostMessage, ReconnectingMessage, StateMessage } from "../../src/panel/protocol";
import { PanelRegistry } from "../../src/panel/registry";
import { HostReaper } from "../../src/sessions/reapHost";
import { HELD_RETRY_PAUSES_MS } from "../../src/sessions/reconnect";
import { FakeDaemon, type Frame } from "../helpers/fakeDaemon";

vi.mock("vscode", () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.slice(1).join("/") }), parse: (value: string) => value, file: (path: string) => ({ fsPath: path }) },
  Range: class {},
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  window: { showWarningMessage: vi.fn(), createWebviewPanel: vi.fn(), showTextDocument: vi.fn(), tabGroups: { activeTabGroup: { viewColumn: 4 } } },
  workspace: { openTextDocument: vi.fn() },
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
}));

const SESSION_FILE = "/tmp/agent/sessions/--proj--/2026_abc.jsonl";
/** The pids the person measured on their own machine: 46960 kept the locks, 47080 took every client. */
const HOLDER = 46960;
const HOLDER_STARTED = "Thu Nov  5 14:48:42 2026";

let daemon: FakeDaemon;
/** The window's reaper as this test gives it to the tabs, or absent when the environment has none. */
let stopDuplicate: PanelHost["stopDuplicateHost"];
let manager: DaemonManager;
/** What the next host start does: die before it is ready, or publish the fake daemon's socket and stay up. */
let hostStarts: "dies" | "works" = "dies";
let spawns = 0;

function envFor(agentDir: string): OmoEnv {
  return { env: { OMO_CODING_AGENT_DIR: agentDir }, agentDir, omoPath: "/fake/omo", secrets: [] };
}

/** A host that exits at once with code 1 — the failure the person photographed — or one that comes up. */
const spawnHost: SpawnFn = () => {
  spawns += 1;
  const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => undefined }) as unknown as HostProcess & EventEmitter;
  if (hostStarts === "dies") setTimeout(() => child.emit("exit", 1, null), 5);
  else void symlink(daemon.socketPath, hostSocketPath(daemon.agentDir)).catch(() => undefined);
  return child;
};

function openData(handle: string): unknown {
  return { sessionId: handle, state: { sessionFile: SESSION_FILE, isStreaming: false, pendingDialogs: [], model: { provider: "gw", id: "m1" } } };
}

function fakePanel(): {
  panel: vscode.WebviewPanel;
  posted: StateMessage[];
  notices: ReconnectingMessage[];
  receive(raw: unknown): void;
  destroy(): void;
} {
  const listeners: ((raw: unknown) => void)[] = [];
  const posted: StateMessage[] = [];
  const notices: ReconnectingMessage[] = [];
  let onDispose: () => void = () => undefined;
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
        else if (message.type === "reconnecting") notices.push(message);
        return true;
      },
    },
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    onDidDispose: (listener: () => void) => {
      onDispose = listener;
      return { dispose: () => undefined };
    },
    reveal: () => undefined,
    viewColumn: 2,
  };
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    posted,
    notices,
    receive: (raw) => listeners.forEach((listener) => listener(raw)),
    destroy: () => onDispose(),
  };
}

function host(): PanelHost {
  const catalog: PanelHost["catalog"] = {};
  return {
    extensionUri: {} as vscode.Uri,
    registry: new PanelRegistry<ChatPanel>(),
    panels: new Set<ChatPanel>(),
    catalog,
    updateCatalog: (part) => Object.assign(catalog, part),
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
    showOutput: async () => undefined,
    isPinned: () => false,
    openFork: () => undefined,
    ...(stopDuplicate !== undefined ? { stopDuplicateHost: stopDuplicate } : {}),
  };
}

function opens(): Frame[] {
  return daemon.requests.filter((request) => request["type"] === "open_session");
}

/** The latest notice, or undefined before the host sent one. */
function latest(notices: ReconnectingMessage[]): ReconnectingMessage | undefined {
  return notices.at(-1);
}

async function settle(done: () => boolean, ticks = 600): Promise<void> {
  for (let tick = 0; tick < ticks && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

/** Every tab a test opened, so none is left retrying against the next test's daemon. */
const opened: ReturnType<typeof fakePanel>[] = [];

function attach(sessionPath: string = SESSION_FILE): ReturnType<typeof fakePanel> {
  const fake = fakePanel();
  opened.push(fake);
  ChatPanel.restore(host(), fake.panel, { kind: "attach", sessionPath, saved: { sessionPath, modelMode: "auto" } });
  return fake;
}

beforeEach(async () => {
  daemon = await FakeDaemon.start();
  await mkdir(join(daemon.agentDir, "rpc"), { recursive: true });
  hostStarts = "dies";
  spawns = 0;
  stopDuplicate = undefined;
  vi.mocked(vscode.window.showWarningMessage).mockReset();
  manager = new DaemonManager(envFor(daemon.agentDir), { spawn: spawnHost, readyTimeoutMs: 400 });
  daemon.on("open_session", () => ({ data: openData("rpc-1") }));
  daemon.on("get_entries", () => ({ data: { entries: [], hasMore: false } }));
  daemon.on("get_available_models", () => ({ data: { models: [] } }));
  daemon.on("get_available_thinking_levels", () => ({ data: { levels: [] } }));
  daemon.on("get_commands", () => ({ data: { commands: [] } }));
  daemon.on("release_attachment", () => ({}));
});

afterEach(async () => {
  for (const tab of opened.splice(0)) tab.destroy(); // a tab left open would keep retrying through the next test
  manager.dispose();
  await daemon.stop();
});

describe("a session whose connection fails", () => {
  /** The photographed banner: «Не удалось открыть сессию: omo host exited (code 1, signal null) before it was ready». */
  it("says_so_over_the_composer_and_never_in_the_banner_at_the_top", async () => {
    const { posted, notices } = attach();
    await settle(() => latest(notices)?.active === true);

    const notice = latest(notices);
    expect(notice).toMatchObject({ type: "reconnecting", active: true, attempt: 1, waitMs: 1_000, capped: false });
    expect(notice?.active === true && notice.error).toContain("omo host exited (code 1, signal null) before it was ready");
    expect(notice?.active === true && notice.target).toMatchObject({ host: daemon.agentDir, session: SESSION_FILE });
    expect(posted.at(-1)?.state.error).toBeUndefined(); // nothing for the banner element to show
  });

  it("a_failed_reattach_shows_in_the_quiet_line_and_is_not_also_echoed_into_the_banner", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    hostStarts = "works";
    const { posted, notices, receive } = attach();
    await settle(() => opens().length > 0 && posted.at(-1) !== undefined && posted.at(-1)?.state.error === undefined);

    // The session is open; now every re-open fails and the host parks the session, so the tab detaches.
    daemon.on("open_session", () => ({ error: "session gone", errorCode: "x" }));
    daemon.push({ type: "session_parked", sessionId: "rpc-1" });
    await settle(() => posted.at(-1)?.state.error === "session gone"); // the controller's own re-open failed

    // «Переподключить»: the attempt fails too. Its reason belongs on the quiet line, not twice — not the red banner.
    receive({ type: "reconnect" });
    await settle(() => {
      const notice = latest(notices);
      return notice?.active === true && notice.error === "session gone" && posted.at(-1)?.state.error === undefined;
    });
    const notice = latest(notices);
    expect(notice?.active === true && notice.error).toBe("session gone"); // the quiet line carries it
    expect(posted.at(-1)?.state.error).toBeUndefined(); // the red banner does not echo it
  });

  it("retries_by_itself_and_a_retry_that_works_clears_the_line_and_opens_the_session", async () => {
    const { posted, notices } = attach();
    await settle(() => latest(notices)?.active === true);
    const triedOnce = spawns;

    hostStarts = "works"; // nobody clicks anything
    await settle(() => opens().length > 0, 1_000);
    await settle(() => latest(notices)?.active === false, 1_000);
    expect(spawns).toBeGreaterThan(triedOnce);
    expect(posted.at(-1)?.state.error).toBeUndefined();
  });

  it("nothing_retries_once_the_tab_is_closed", async () => {
    const { notices, destroy } = attach();
    await settle(() => latest(notices)?.active === true);
    destroy();
    const after = spawns;
    const sent = notices.length;

    await new Promise((resolve) => setTimeout(resolve, 1_500)); // two pauses of the schedule would have passed
    expect(spawns).toBe(after);
    expect(notices).toHaveLength(sent);
  });

  /** The reload the person photographed: a path the previous host has not let go of yet is nobody's business but ours. */
  it("a_path_still_in_use_goes_to_the_quiet_line_and_never_to_the_banner", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    daemon.on("open_session", () => ({ errorCode: "session_path_in_use", error: "session path in use", errorData: { retry_after_ms: 2_000 } }));
    const { posted, notices } = attach();

    await settle(() => latest(notices)?.active === true);
    const notice = latest(notices);
    expect(notice).toMatchObject({ active: true, attempt: 1, waitMs: 300 }); // sub-second: the path frees in a moment
    expect(notice?.active === true && notice.error).toBe("Файл сессии ещё держит предыдущий хост OmO");
    expect(notice?.active === true && notice.givenUp).toBeUndefined();
    expect(posted.at(-1)?.state.error).toBeUndefined(); // the banner element has nothing to show
    expect(spawns).toBe(0);
  });

  it("the_retry_opens_the_session_once_the_path_frees_without_anyone_clicking", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    let held = true;
    daemon.on("open_session", () => (held ? { errorCode: "session_path_in_use", error: "session path in use" } : { data: openData("rpc-1") }));
    const { posted, notices } = attach();
    await settle(() => latest(notices)?.active === true);

    held = false; // the previous host let go; nothing is clicked
    await settle(() => latest(notices)?.active === false, 1_000);
    expect(opens().length).toBeGreaterThan(1);
    expect(posted.at(-1)?.state.error).toBeUndefined();
  });

  /** The held path has a budget of its own: attempts spent waiting for a host that was down do not eat into it. */
  it("a_tab_that_waited_for_a_host_still_gets_the_whole_fast_schedule_at_a_held_path", async () => {
    const { notices } = attach();
    await settle(() => latest(notices)?.active === true);
    const first = latest(notices);
    expect(first?.active === true && first.waitMs).toBe(1_000); // the connection's own schedule

    daemon.on("open_session", () => ({ errorCode: "session_path_in_use", error: "session path in use" }));
    hostStarts = "works";
    await settle(() => {
      const notice = latest(notices);
      return notice?.active === true && notice.error === "Файл сессии ещё держит предыдущий хост OmO";
    }, 1_000);
    const held = latest(notices);
    expect(held?.active === true && held.waitMs).toBe(300); // the fast schedule from its first pause
  });

  it("a_refusal_that_will_not_heal_by_itself_still_reaches_the_banner", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    daemon.on("open_session", () => ({ errorCode: "open_failed", error: "open_failed: model_unavailable: no such provider" }));
    const { posted, notices } = attach();

    await settle(() => posted.at(-1)?.state.error !== undefined);
    expect(posted.at(-1)?.state.error).toBe("Не удалось открыть сессию: open_failed: model_unavailable: no such provider");
    expect(manager.connected).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700)); // two held pauses would be out by now
    expect(notices.filter((notice) => notice.active)).toEqual([]);
    expect(opens()).toHaveLength(1); // asked once, and not again
  });

  /** The person's own machine: a second copy of the host holds the file and keeps working, so no retry can win. */
  it("a_file_held_by_another_copy_of_the_host_ends_in_an_honest_line_with_no_button", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    daemon.on("open_session", () => ({
      errorCode: "session_held",
      error: "session_held",
      errorData: { holders: [{ pid: 46960, cwd: "/work", host_socket: hostSocketPath(daemon.agentDir), host_instance: "another-copy" }] },
    }));
    const { posted, notices } = attach();

    await settle(() => latest(notices)?.active === true);
    const first = latest(notices);
    expect(first?.active === true && first.error).toBe("Файл сессии держит другая копия хоста OmO (pid 46960)");
    expect(first?.active === true && first.waitMs).toBe(300);

    await settle(() => latest(notices)?.active === true && latest(notices)?.active === true && (latest(notices) as { givenUp?: true }).givenUp === true, 4_000);
    const last = latest(notices);
    expect(last?.active === true && last.attempt).toBe(HELD_RETRY_PAUSES_MS.length);
    expect(last?.active === true && last.waitMs).toBeUndefined(); // nothing is counting down
    expect(last?.active === true && last.error).toContain("другая копия хоста OmO (pid 46960)");
    expect(last?.active === true && last.error).toContain("повторять бесполезно");
    expect(posted.at(-1)?.state.error).toBeUndefined(); // still the quiet line, never the red banner
    expect(opens()).toHaveLength(HELD_RETRY_PAUSES_MS.length + 1); // the open, then every pause of the schedule, and no more
  }, 20_000);

  /** The holder's refusal, as the host words it: another copy of our own host on our own socket. */
  function heldByCopy(): { errorCode: string; error: string; errorData: Record<string, unknown> } {
    return {
      errorCode: "session_held",
      error: "session_held",
      errorData: { holders: [{ pid: HOLDER, cwd: "/work", host_socket: hostSocketPath(daemon.agentDir), host_instance: "another-copy" }] },
    };
  }

  /** The notices of a tab, latest last, only the ones with something to show. */
  function noticeTexts(tab: ReturnType<typeof fakePanel>): string[] {
    return (tab.posted.at(-1)?.state.blocks ?? []).flatMap((block) => (block.kind === "notice" ? [block.text] : []));
  }

  it("a_duplicate_host_proved_idle_is_stopped_and_the_session_opens_with_one_line_in_the_feed", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    let held = true;
    daemon.on("open_session", () => (held ? heldByCopy() : { data: openData("rpc-1") }));
    const asked: { force?: boolean }[] = [];
    stopDuplicate = async (holder, options) => {
      asked.push({ ...options });
      expect(holder?.pid).toBe(HOLDER);
      held = false; // the TERM freed the path
      return {
        verdict: "stopped",
        proof: { pid: HOLDER, startedAt: HOLDER_STARTED, clients: 0, live: 0, quietMs: 13 * 60_000, cpuShare: 0.004 },
        note: `Остановил вторую копию хоста OmO (pid ${HOLDER}, запущена ${HOLDER_STARTED}): к ней никто не был подключён, все её задачи завершены или приостановлены, журналы задач молчали 13 мин, CPU 0 % — послал TERM. Файл сессии освободился.`,
      };
    };
    const tab = attach();

    await settle(() => latest(tab.notices)?.active === false, 5_000);
    expect(asked).toEqual([{ force: false }]); // automatic: the proofs of idleness were the extension's to make
    const feed = noticeTexts(tab);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toContain(`pid ${HOLDER}`);
    expect(feed[0]).toContain("никто не был подключён");
    expect(feed[0]).toContain("журналы задач молчали 13 мин");
    expect(tab.posted.at(-1)?.state.error).toBeUndefined(); // never the banner
  }, 20_000);

  it("a_holder_whose_task_log_is_still_being_written_is_not_stopped_and_the_person_gets_the_line_and_the_button", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    daemon.on("open_session", () => heldByCopy());
    const refusal = `Файл сессии держит другая копия хоста OmO (pid ${HOLDER}): в этой среде ещё идут задачи (1). Сама её не останавливаю — клиентов 0, незакрытых задач 1, журналы молчат 0 мин, CPU 3 %.`;
    stopDuplicate = async () => ({ verdict: "refused", reason: refusal, offerStop: true });
    const tab = attach();

    await settle(() => latest(tab.notices)?.active === true && (latest(tab.notices) as { givenUp?: true }).givenUp === true, 5_000);
    const notice = latest(tab.notices);
    expect(notice?.active === true && notice.error).toBe(refusal);
    expect(notice?.active === true && notice.offerStop).toBe(true); // the line offers the stop
    expect(notice?.active === true && notice.waitMs).toBeUndefined(); // and counts nothing down
    expect(noticeTexts(tab)).toEqual([]); // nothing was stopped, so nothing is claimed in the feed
    expect(tab.posted.at(-1)?.state.error).toBeUndefined();
  }, 20_000);

  it("the_button_stops_it_on_the_persons_say_so_and_only_after_they_confirm", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    let held = true;
    daemon.on("open_session", () => (held ? heldByCopy() : { data: openData("rpc-1") }));
    const asked: { force?: boolean }[] = [];
    stopDuplicate = async (_holder, options) => {
      asked.push({ ...options });
      if (options?.force !== true) return { verdict: "refused", reason: `держит pid ${HOLDER}: там идёт работа`, offerStop: true };
      held = false;
      return {
        verdict: "stopped",
        proof: { pid: HOLDER, startedAt: HOLDER_STARTED, clients: 2, live: 1, quietMs: 0, cpuShare: 0.5 },
        note: `Остановил вторую копию хоста OmO (pid ${HOLDER}, запущена ${HOLDER_STARTED}) по вашему решению.`,
      };
    };
    const tab = attach();
    await settle(() => latest(tab.notices)?.active === true && (latest(tab.notices) as { givenUp?: true }).givenUp === true, 5_000);

    // Nothing happens without the confirmation, however many times the button is pressed.
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    tab.receive({ type: "stopHolder" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveLength(1);
    const dialog = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    expect(String(dialog?.[0])).toContain("Остановить вторую копию");
    expect(String((dialog?.[1] as { detail?: string } | undefined)?.detail)).toContain(`pid ${HOLDER}`); // the facts are in front of them

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Остановить" as never);
    tab.receive({ type: "stopHolder" });
    await settle(() => latest(tab.notices)?.active === false, 5_000);
    expect(asked).toEqual([{ force: false }, { force: true }]);
    expect(noticeTexts(tab).at(-1)).toContain("по вашему решению");
  }, 20_000);

  /** One reaper for the window: however many tabs are blocked by one holder, it is signalled once. */
  it("several_restored_tabs_do_not_each_try_to_stop_the_same_process", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    let alive = true;
    daemon.on("open_session", () => (alive ? heldByCopy() : { data: openData("rpc-1") }));
    const signals: NodeJS.Signals[] = [];
    const reaper = new HostReaper({
      processes: {
        kill: (pid, signal) => {
          if (signal !== 0) signals.push(signal);
          if (pid !== HOLDER || !alive) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
          if (signal === "SIGTERM") alive = false; // it ends cleanly, and the path is free with it
        },
        commandLine: async () => undefined,
        listensOn: async () => true,
        hostPids: async () => [HOLDER],
        startedAt: async () => (alive ? HOLDER_STARTED : undefined),
        socketFds: async () => 1,
        cpuSeconds: async () => 0,
      },
      sleep: async () => undefined,
    });
    stopDuplicate = (holder, options) => reaper.stop(manager, holder, options);
    const tabs = [0, 1, 2, 3, 4].map((index) => attach(`${SESSION_FILE}.${index}`));
    try {
      await settle(() => tabs.every((tab) => latest(tab.notices)?.active === false), 6_000);
      expect(signals).toEqual(["SIGTERM"]); // five tabs, one TERM
    } finally {
      for (const tab of tabs) tab.destroy();
    }
  }, 30_000);

  it("several_tabs_reopening_at_once_keep_to_the_schedule", async () => {
    await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
    daemon.on("open_session", () => ({ errorCode: "session_path_in_use", error: "session path in use" }));
    const tabs = [0, 1, 2, 3].map((index) => attach(`${SESSION_FILE}.${index}`));
    try {
      await settle(() => tabs.every((tab) => latest(tab.notices)?.active === true));
      // Through the first three pauses (0.3 + 0.7 + 1.5 s): four attempts per tab at most, and not one more.
      await new Promise((resolve) => setTimeout(resolve, 2_600));
      for (const tab of tabs) {
        const notice = latest(tab.notices);
        expect(notice?.active === true && notice.attempt).toBeLessThanOrEqual(4);
      }
      expect(opens().length).toBeLessThanOrEqual(tabs.length * 4);
      expect(opens().length).toBeGreaterThanOrEqual(tabs.length * 3); // they really are retrying, not sitting still
    } finally {
      for (const tab of tabs) tab.destroy();
    }
  }, 15_000);
});
