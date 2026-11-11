import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { DaemonManager, hostSocketPath } from "../../src/daemon";
import type { ClaimVerdict, GuardEvent, GuardSubscription, PendingView, RulesV2 } from "../../src/guard/admin";
import { GuardApprovals, type GuardAdminPort } from "../../src/guard/approvals";
import { TaskRegistry } from "../../src/guard/tasks";
import { ChatPanel, type PanelHost } from "../../src/panel/ChatPanel";
import { PanelRegistry } from "../../src/panel/registry";
import { FakeDaemon, type Frame } from "../helpers/fakeDaemon";

vi.mock("vscode", () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.slice(1).join("/") }), parse: (value: string) => value },
  ViewColumn: { Active: -1 },
  window: { showWarningMessage: vi.fn(), createWebviewPanel: vi.fn(), showTextDocument: vi.fn() },
  workspace: { openTextDocument: vi.fn() },
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
}));

const SECRET = "sekret-key-123";
const LATE_SECRET = "late-added-token-77";
const S1_FILE = "/tmp/agent/sessions/--proj--/s1.jsonl";
const S2_FILE = "/tmp/agent/sessions/--proj--/s2.jsonl";
/** session file -> [rpc handle, durable session id] */
const SESSIONS: Record<string, [string, string]> = { [S1_FILE]: ["rpc-1", "s1"], [S2_FILE]: ["rpc-2", "s2"] };

let daemon: FakeDaemon;
let manager: DaemonManager;

/** The admin socket as the window sees it: events are emitted by hand, answers recorded. */
class FakeAdmin implements GuardAdminPort {
  listener: ((event: GuardEvent) => void) | undefined;
  giveUp: (() => void) | undefined;
  /** Called by the real client each time the service confirms a (re)subscription. */
  confirmed: (() => void) | undefined;
  /** What the service replays right after confirming: its open requests. */
  replay: GuardEvent[] = [];
  /** What `pending()` reports. */
  open: PendingView[] = [];
  readonly answers: Array<{ id: string; decision: "allow-once" | "deny"; message?: string }> = [];
  subscriptions = 0;
  stops = 0;
  closed = 0;
  card = true;
  answerError: string | undefined;
  /** Held answers: resolved by the test (a double click lands while the first is in flight). */
  hold: Array<() => void> | undefined;
  /** Claim answers this window sent back, in order. */
  readonly claims: Array<{ id: string; verdict: ClaimVerdict; owner?: string }> = [];

  async rulesGet(): Promise<RulesV2> {
    return { human: { waitSeconds: 300, card: this.card, telegram: false } } as RulesV2;
  }

  async pending(): Promise<PendingView[]> {
    return this.open;
  }

  subscribe(listener: (event: GuardEvent) => void, onGiveUp?: () => void, onSubscribed?: () => void): GuardSubscription {
    this.listener = listener;
    this.giveUp = onGiveUp;
    this.confirmed = onSubscribed;
    this.subscriptions += 1;
    onSubscribed?.();
    for (const event of this.replay) listener(event);
    return {
      stop: () => {
        this.stops += 1;
        this.listener = undefined;
      },
      claim: (id, verdict, owner) => void this.claims.push({ id, verdict, ...(owner !== undefined ? { owner } : {}) }),
    };
  }

  async answer(id: string, decision: "allow-once" | "deny", message?: string): Promise<void> {
    this.answers.push({ id, decision, ...(message !== undefined ? { message } : {}) });
    if (this.hold !== undefined) await new Promise<void>((resolve) => this.hold?.push(resolve));
    if (this.answerError !== undefined) throw new Error(this.answerError);
  }

  close(): void {
    this.closed += 1;
  }

  emit(event: GuardEvent): void {
    this.listener?.(event);
  }
}

type Tab = { chat: ChatPanel; posted: Array<Record<string, unknown>>; json: string[]; receive(raw: unknown): void };

function fakePanel(): { panel: vscode.WebviewPanel; posted: Array<Record<string, unknown>>; json: string[]; receive(raw: unknown): void } {
  const listeners: ((raw: unknown) => void)[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const json: string[] = [];
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
      postMessage: async (text: string) => {
        json.push(text);
        const message = JSON.parse(text) as Record<string, unknown>;
        if (message["type"] !== "state" && message["type"] !== "delta") posted.push(message);
        return true;
      },
    },
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
    reveal: () => undefined,
    viewColumn: 2,
  };
  return { panel: panel as unknown as vscode.WebviewPanel, posted, json, receive: (raw) => listeners.forEach((listener) => listener(raw)) };
}

function windowHost(secrets: string[]): PanelHost {
  return {
    extensionUri: {} as vscode.Uri,
    registry: new PanelRegistry<ChatPanel>(),
    panels: new Set<ChatPanel>(),
    catalog: {},
    updateCatalog: () => undefined,
    onCatalogChange: () => () => undefined,
    secrets,
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

async function settle(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 400 && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

function pending(overrides: Partial<PendingView> = {}): PendingView {
  return {
    id: "abc123abc123",
    session: "s1",
    cwd: "/work/proj",
    tool: "bash",
    command: "git push origin main",
    reasons: ["git-push"],
    createdAt: "2026-11-04T10:00:00.000Z",
    ...overrides,
  };
}

function guardMessages(tab: Tab): Array<Record<string, unknown>> {
  return tab.posted.filter((message) => String(message["type"]).startsWith("guard"));
}

let host: PanelHost;
let secrets: string[];
let admin: FakeAdmin;
let protectionOn: boolean;
let approvals: GuardApprovals;
let tasks: TaskRegistry;
/** Requests the window raised outside the chats, with the owner it named. */
let outside: Array<{ id: string; owner: string | undefined }>;
let tabS1: Tab;
let tabS2: Tab;

/** One senpi-task record, written where OmO writes it under the environment's agent dir. */
async function taskRecord(fields: { task_id: string; child_session_id: string; parent_session_id: string; root_session_id?: string }): Promise<void> {
  const dir = join(daemon.agentDir, "projects", "proj", "senpi-task", "tasks");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${fields.task_id}.json`), JSON.stringify({ status: "running", depth: 1, ...fields }));
}

async function attach(sessionPath: string): Promise<Tab> {
  const fake = fakePanel();
  const chat = ChatPanel.restore(host, fake.panel, { kind: "attach", sessionPath, saved: { sessionPath, modelMode: "auto" } });
  await settle(() => chat.durableId === SESSIONS[sessionPath]?.[1]);
  return { chat, ...fake };
}

beforeEach(async () => {
  daemon = await FakeDaemon.start();
  await mkdir(join(daemon.agentDir, "rpc"), { recursive: true });
  await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
  manager = new DaemonManager({ env: { OMO_CODING_AGENT_DIR: daemon.agentDir }, agentDir: daemon.agentDir, omoPath: "/fake/omo", secrets: [SECRET] });
  daemon.on("open_session", (frame: Frame) => {
    const [handle, durable] = SESSIONS[String(frame["sessionPath"])] ?? ["rpc-9", "s9"];
    return { data: { sessionId: handle, state: { sessionFile: frame["sessionPath"], sessionId: durable, isStreaming: false, pendingDialogs: [] } } };
  });
  daemon.on("get_entries", () => ({ data: { entries: [], hasMore: false } }));
  daemon.on("get_available_models", () => ({ data: { models: [] } }));
  daemon.on("release_attachment", () => ({}));
  secrets = [SECRET];
  host = windowHost(secrets);
  admin = new FakeAdmin();
  protectionOn = true;
  outside = [];
  // the real registry over the fake daemon's agent dir: a test writes OmO's own task records into it
  tasks = new TaskRegistry(daemon.agentDir, { staleMs: 0, layoutStaleMs: 0 });
  approvals = new GuardApprovals({
    protectionOn: async () => protectionOn,
    connect: async () => admin,
    panels: () => host.panels,
    rootOf: (session) => tasks.rootOf(session),
    outside: (request, owner) => {
      outside.push({ id: request.id, owner });
      return () => void outside.splice(outside.findIndex((raised) => raised.id === request.id), 1);
    },
    log: () => undefined,
    retryDelaysMs: [],
  });
  host.guard = approvals;
  tabS1 = await attach(S1_FILE);
  tabS2 = await attach(S2_FILE);
  await approvals.sync();
});

afterEach(async () => {
  approvals.dispose();
  manager.dispose();
  await daemon.stop();
});

describe("guard approvals in the chat", () => {
  it("a_request_reaches_the_panel_of_its_session", () => {
    admin.emit({ event: "pending", item: pending({ session: "s1" }) });
    expect(guardMessages(tabS1)).toContainEqual({ type: "guardRequest", request: expect.objectContaining({ id: "abc123abc123", command: "git push origin main" }) });
    expect(guardMessages(tabS2)).toEqual([]);
  });

  it("a_request_of_an_unknown_session_goes_to_every_panel_with_nothing_claimed_about_it", () => {
    admin.emit({ event: "pending", item: pending({ session: "terminal-session" }) });
    for (const tab of [tabS1, tabS2]) {
      // no `owner`: the card says we could not attribute it, rather than naming a session we do not know
      expect(guardMessages(tab)).toEqual([{ type: "guardRequest", request: expect.objectContaining({ id: "abc123abc123", cwd: "/work/proj" }), elsewhere: true }]);
    }
  });

  it("a_childs_request_reaches_only_the_tab_of_the_session_that_spawned_it", async () => {
    await taskRecord({ task_id: "st_1", child_session_id: "child-of-s2", parent_session_id: "s2", root_session_id: "s2" });
    admin.emit({ event: "pending", item: pending({ session: "child-of-s2" }) });
    expect(guardMessages(tabS2)).toEqual([{ type: "guardRequest", request: expect.objectContaining({ id: "abc123abc123" }) }]);
    expect(guardMessages(tabS1)).toEqual([]);
  });

  it("a_grandchilds_request_resolves_through_two_hops_to_its_root_tab", async () => {
    await taskRecord({ task_id: "st_1", child_session_id: "child-of-s1", parent_session_id: "s1" });
    await taskRecord({ task_id: "st_2", child_session_id: "grandchild", parent_session_id: "child-of-s1" });
    admin.emit({ event: "pending", item: pending({ session: "grandchild" }) });
    expect(guardMessages(tabS1)).toEqual([{ type: "guardRequest", request: expect.objectContaining({ id: "abc123abc123" }) }]);
    expect(guardMessages(tabS2)).toEqual([]);
  });

  it("a_claim_round_is_answered_own_for_a_session_this_window_has_open", () => {
    admin.emit({ event: "claim", id: "r1", session: "s2" });
    expect(admin.claims).toEqual([{ id: "r1", verdict: "own" }]);
  });

  it("a_claim_round_is_answered_own_for_a_child_of_a_session_this_window_has_open", async () => {
    await taskRecord({ task_id: "st_1", child_session_id: "child-of-s1", parent_session_id: "s1", root_session_id: "s1" });
    admin.emit({ event: "claim", id: "r2", session: "child-of-s1" });
    expect(admin.claims).toEqual([{ id: "r2", verdict: "own" }]);
  });

  it("a_claim_round_is_answered_knows_with_the_owner_when_no_tab_here_has_it", async () => {
    await taskRecord({ task_id: "st_1", child_session_id: "child-of-s9", parent_session_id: "s9-not-open", root_session_id: "s9-not-open" });
    admin.emit({ event: "claim", id: "r3", session: "child-of-s9" });
    expect(admin.claims).toEqual([{ id: "r3", verdict: "knows", owner: "s9-not-open" }]);
  });

  it("a_claim_round_is_answered_no_for_a_session_nothing_here_claims", () => {
    admin.emit({ event: "claim", id: "r4", session: "a-terminal" });
    expect(admin.claims).toEqual([{ id: "r4", verdict: "no" }]);
  });

  it("a_tab_that_closes_hands_its_request_back_to_the_service", async () => {
    await taskRecord({ task_id: "st_1", child_session_id: "child-of-s2", parent_session_id: "s2", root_session_id: "s2" });
    admin.emit({ event: "pending", item: pending({ session: "child-of-s2" }), only: true });
    expect(guardMessages(tabS2)).toHaveLength(1);
    host.panels.delete(tabS2.chat); // the person closed that tab
    approvals.panelsChanged();
    expect(admin.claims).toEqual([{ id: "abc123abc123", verdict: "no" }]);
  });

  it("a_request_the_service_sent_outside_the_chats_puts_no_card_in_any_tab", async () => {
    await taskRecord({ task_id: "st_1", child_session_id: "child-of-s9", parent_session_id: "s9-not-open", root_session_id: "s9-not-open" });
    admin.emit({ event: "pending", item: pending({ session: "child-of-s9" }), outside: { owner: "s9-not-open" } });
    expect(outside).toEqual([{ id: "abc123abc123", owner: "s9-not-open" }]);
    expect(guardMessages(tabS1)).toEqual([]); // nothing a chat did not ask for
    expect(guardMessages(tabS2)).toEqual([]);
  });

  it("a_request_raised_outside_the_chats_is_taken_down_when_it_ends", () => {
    admin.emit({ event: "pending", item: pending({ session: "child-of-s9" }), outside: { owner: "s9-not-open" } });
    expect(outside).toHaveLength(1);
    admin.emit({ event: "resolved", id: "abc123abc123", decision: "deny", by: "timeout", session: "child-of-s9" });
    expect(outside).toEqual([]); // the deadline passed: the notice goes with the request, it does not linger
  });

  it("a_request_raised_outside_the_chats_is_not_replayed_as_a_card_into_a_reloaded_tab", async () => {
    admin.emit({ event: "pending", item: pending({ session: "child-of-s9" }), outside: { owner: "s9-not-open" } });
    tabS1.posted.length = 0;
    tabS1.receive({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(guardMessages(tabS1)).toEqual([]);
  });

  it("a_deny_given_outside_the_chats_reaches_the_service_once", async () => {
    admin.emit({ event: "pending", item: pending({ session: "child-of-s9" }), outside: { owner: "s9-not-open" } });
    await approvals.answerOutside("abc123abc123", "deny");
    await approvals.answerOutside("abc123abc123", "deny"); // a second press after the first is in flight
    expect(admin.answers).toEqual([{ id: "abc123abc123", decision: "deny" }]);
  });

  it("a_request_the_service_placed_here_as_the_owner_docks_in_this_tabs_session", async () => {
    await taskRecord({ task_id: "st_1", child_session_id: "child-of-s2", parent_session_id: "s2", root_session_id: "s2" });
    admin.emit({ event: "pending", item: pending({ session: "child-of-s2" }), only: true });
    expect(guardMessages(tabS2)).toEqual([{ type: "guardRequest", request: expect.objectContaining({ id: "abc123abc123" }) }]);
    expect(guardMessages(tabS1)).toEqual([]);
    expect(outside).toEqual([]);
  });

  it("a_request_placed_here_whose_tab_went_in_between_is_given_back_not_shown_elsewhere", () => {
    // the service placed it with this window, but by the time it arrived no tab of ours owns the session
    admin.emit({ event: "pending", item: pending({ session: "child-of-nobody" }), only: true });
    expect(guardMessages(tabS1)).toEqual([]);
    expect(guardMessages(tabS2)).toEqual([]);
    expect(admin.claims).toEqual([{ id: "abc123abc123", verdict: "no" }]);
  });

  // Seen live (2026-11-11): every tab of a window showed «Решатель разрешил» for a session open in another window. A step
  // is already decided — nobody has to answer it — so it shows only in the tab it belongs to, never fanned out.
  it("a_decider_step_of_a_child_whose_tab_is_closed_shows_in_no_tab", async () => {
    await taskRecord({ task_id: "st_1", child_session_id: "child-of-s9", parent_session_id: "s9-not-open", root_session_id: "s9-not-open" });
    const decider = { model: "gw/m", decision: "deny", reason: "force push", ms: 300 };
    const item = pending({ id: "d9", session: "child-of-s9", decider });
    admin.emit({ event: "resolved", id: "d9", decision: "deny", by: "decider", session: "child-of-s9", decider, item });
    expect(guardMessages(tabS1)).toEqual([]);
    expect(guardMessages(tabS2)).toEqual([]);
  });

  it("the_registry_of_another_environment_is_never_read", async () => {
    // the same child id recorded in a second agent dir: this window's registry must not answer for it
    const other = join(daemon.agentDir, "..", "other-agent-dir");
    await mkdir(join(other, "projects", "proj", "senpi-task", "tasks"), { recursive: true });
    await writeFile(
      join(other, "projects", "proj", "senpi-task", "tasks", "st_other.json"),
      JSON.stringify({ task_id: "st_other", child_session_id: "child-elsewhere", parent_session_id: "s1", root_session_id: "s1" }),
    );
    admin.emit({ event: "pending", item: pending({ session: "child-elsewhere" }) });
    for (const tab of [tabS1, tabS2]) {
      expect(guardMessages(tab)).toEqual([expect.objectContaining({ type: "guardRequest", elsewhere: true })]);
      expect(guardMessages(tab)[0]?.["owner"]).toBeUndefined();
    }
  });

  it("a_registry_that_cannot_be_read_falls_back_to_the_fan_out_without_losing_the_request", () => {
    const logged: string[] = [];
    approvals.dispose();
    const broken = new GuardApprovals({
      protectionOn: async () => true,
      connect: async () => admin,
      panels: () => host.panels,
      rootOf: () => {
        throw new Error("registry unreadable");
      },
      outside: () => undefined,
      log: (text) => logged.push(text),
      retryDelaysMs: [],
    });
    approvals = broken;
    return broken.sync().then(() => {
      admin.emit({ event: "pending", item: pending({ session: "child-of-s2" }) });
      expect(guardMessages(tabS1)).toEqual([expect.objectContaining({ type: "guardRequest", elsewhere: true })]);
      expect(logged.some((line) => line.includes("registry unreadable"))).toBe(true);
    });
  });

  it("a_subagents_request_goes_to_the_panel_whose_agents_run_that_child_session", async () => {
    daemon.push({
      sessionId: "rpc-2",
      type: "extension_event",
      name: "omo.task.updated",
      data: { tasks: [{ task_id: "st_1", status: "running", name: "explore", child_session_id: "child-of-s2" }] },
    });
    await settle(() => tabS2.chat.runsChild("child-of-s2"));
    admin.emit({ event: "pending", item: pending({ session: "child-of-s2" }) });
    expect(guardMessages(tabS2)).toEqual([{ type: "guardRequest", request: expect.objectContaining({ id: "abc123abc123" }) }]);
    expect(guardMessages(tabS1)).toEqual([]);
  });

  it("allow_once_answers_over_the_admin_socket_once_however_often_it_is_clicked", async () => {
    admin.emit({ event: "pending", item: pending() });
    admin.hold = [];
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "allow-once" });
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "allow-once" });
    tabS2.receive({ type: "guardAnswer", id: "abc123abc123", decision: "deny" });
    await settle(() => admin.answers.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admin.answers).toEqual([{ id: "abc123abc123", decision: "allow-once" }]);
    for (const release of admin.hold) release();
  });

  it("an_answer_to_a_request_that_is_not_open_is_never_sent", async () => {
    tabS1.receive({ type: "guardAnswer", id: "never-opened", decision: "allow-once" });
    admin.emit({ event: "pending", item: pending() });
    admin.emit({ event: "resolved", id: "abc123abc123", decision: "deny", by: "timeout", session: "s1" });
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "allow-once" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admin.answers).toEqual([]);
  });

  it("a_failed_answer_comes_back_to_the_card_and_can_be_given_again", async () => {
    admin.emit({ event: "pending", item: pending() });
    admin.answerError = "служба защиты не приняла ответ";
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "deny" });
    await settle(() => guardMessages(tabS1).some((message) => message["type"] === "guardAnswerFailed"));
    expect(guardMessages(tabS1).at(-1)).toEqual({ type: "guardAnswerFailed", id: "abc123abc123", error: "служба защиты не приняла ответ" });
    admin.answerError = undefined;
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "deny" });
    await settle(() => admin.answers.length === 2);
  });

  it("a_deny_with_words_for_the_agent_reaches_the_admin_socket_and_comes_back_redacted", async () => {
    const logged: string[] = [];
    host.log = (text) => logged.push(text);
    admin.emit({ event: "pending", item: pending() });
    admin.answerError = "служба защиты не приняла ответ";
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "deny", message: `прогони тесты ${SECRET}` });
    await settle(() => guardMessages(tabS1).some((message) => message["type"] === "guardAnswerFailed"));
    expect(admin.answers).toEqual([{ id: "abc123abc123", decision: "deny", message: `прогони тесты ${SECRET}` }]);
    expect(logged.join("\n")).not.toContain("прогони тесты"); // the person's words are never logged
    admin.emit({ event: "resolved", id: "abc123abc123", decision: "deny", by: "agent-tabs", session: "s1", message: `прогони тесты ${SECRET}` });
    expect(guardMessages(tabS1).at(-1)).toEqual({ type: "guardResolved", id: "abc123abc123", decision: "deny", by: "agent-tabs", message: "прогони тесты ‹redacted›" });
  });

  it("a_deny_message_too_long_or_on_an_allow_is_dropped_by_the_protocol", async () => {
    admin.emit({ event: "pending", item: pending() });
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "deny", message: "x".repeat(2001) });
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "allow-once", message: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admin.answers).toEqual([]);
  });

  it("the_editor_tab_title_is_marked_while_the_tab_waits_for_the_person", () => {
    const title = (): string => (tabS1.chat as unknown as { panel: vscode.WebviewPanel }).panel.title;
    const plain = title();
    expect(plain.startsWith("● ")).toBe(false);
    admin.emit({ event: "pending", item: pending() });
    expect(title()).toBe(`● ${plain}`);
    expect((tabS2.chat as unknown as { panel: vscode.WebviewPanel }).panel.title.startsWith("● ")).toBe(false);
    admin.emit({ event: "resolved", id: "abc123abc123", decision: "allow", by: "telegram", session: "s1" });
    expect(title()).toBe(plain);
  });

  it("every_dialog_answer_gets_its_outcome_back", async () => {
    daemon.on("extension_ui_response", () => ({ error: "gone", errorCode: "unknown_extension_ui_request" }));
    daemon.push({ sessionId: "rpc-1", type: "extension_ui_request", id: "d1", method: "confirm", title: "Удалить?" });
    await settle(() => tabS1.json.some((text) => text.includes('"d1"')));
    tabS1.receive({ type: "answer", dialogId: "d1", answer: { confirmed: true } });
    await settle(() => tabS1.posted.some((message) => message["type"] === "answerResult"));
    expect(tabS1.posted.find((message) => message["type"] === "answerResult")).toEqual({ type: "answerResult", dialogId: "d1", outcome: "closed" });
  });

  it("the_editor_tab_title_is_marked_while_an_omo_dialog_waits", async () => {
    const title = (): string => (tabS1.chat as unknown as { panel: vscode.WebviewPanel }).panel.title;
    daemon.push({ sessionId: "rpc-1", type: "extension_ui_request", id: "d1", method: "confirm", title: "Удалить?" });
    await settle(() => title().startsWith("● "));
    daemon.push({ sessionId: "rpc-1", type: "question_resolved", id: "d1" });
    await settle(() => !title().startsWith("● "));
  });

  it("a_card_answered_elsewhere_collapses_with_who_answered", () => {
    admin.emit({ event: "pending", item: pending() });
    admin.emit({ event: "resolved", id: "abc123abc123", decision: "allow", by: "telegram", session: "s1" });
    expect(guardMessages(tabS1).at(-1)).toEqual({ type: "guardResolved", id: "abc123abc123", decision: "allow", by: "telegram" });
  });

  it("the_end_of_a_request_reaches_only_the_tabs_that_were_shown_it", () => {
    admin.emit({ event: "pending", item: pending({ session: "s1" }) });
    admin.emit({ event: "resolved", id: "abc123abc123", decision: "allow", by: "agent-tabs", session: "s1" });
    expect(guardMessages(tabS1).map((message) => message["type"])).toEqual(["guardRequest", "guardResolved"]);
    expect(guardMessages(tabS2)).toEqual([]); // S2 was never shown it: its end is not S2's event either
  });

  it("a_request_the_service_lost_is_closed_only_where_its_card_was", async () => {
    admin.emit({ event: "pending", item: pending({ id: "gone00000000", session: "s1" }) });
    admin.open = [];
    admin.confirmed?.();
    await settle(() => guardMessages(tabS1).some((message) => message["type"] === "guardClosed"));
    expect(guardMessages(tabS2)).toEqual([]);
  });

  it("a_decider_final_verdict_shows_as_a_step_in_its_sessions_feed_only", () => {
    const decider = { model: "gw-anthropic/claude-haiku", decision: "allow", reason: "read-only push --dry-run", ms: 1200 };
    admin.emit({ event: "resolved", id: "d1", decision: "allow", by: "decider", session: "s2", decider, item: pending({ id: "d1", session: "s2", decider }) });
    expect(guardMessages(tabS2)).toEqual([{ type: "guardStep", id: "d1", tool: "bash", command: "git push origin main", decider, at: "2026-11-04T10:00:00.000Z" }]);
    expect(guardMessages(tabS1)).toEqual([]);
  });

  it("with_the_card_off_no_card_is_shown_but_the_decider_step_still_is", async () => {
    admin.card = false;
    await approvals.sync();
    const decider = { model: "gw/m", decision: "ask", reason: "unclear", ms: 900 };
    admin.emit({ event: "pending", item: pending({ decider }) });
    expect(guardMessages(tabS1).map((message) => message["type"])).toEqual(["guardStep"]);

    admin.card = true;
    await approvals.sync(); // the setting turned on: the open request's card appears
    expect(guardMessages(tabS1).map((message) => message["type"])).toEqual(["guardStep", "guardRequest"]);
  });

  it("an_answer_from_a_tab_the_request_was_not_routed_to_is_refused", async () => {
    admin.emit({ event: "pending", item: pending({ session: "s1" }) });
    tabS2.receive({ type: "guardAnswer", id: "abc123abc123", decision: "allow-once" }); // forged: S2 never had this card
    await settle(() => guardMessages(tabS2).length > 0);
    expect(guardMessages(tabS2)).toEqual([{ type: "guardAnswerFailed", id: "abc123abc123", error: "этот запрос относится к другой вкладке" }]);
    expect(admin.answers).toEqual([]);
  });

  it("a_click_while_another_tabs_answer_is_in_flight_says_so", async () => {
    admin.emit({ event: "pending", item: pending({ session: "terminal-session" }) }); // both tabs have the card
    admin.hold = [];
    tabS1.receive({ type: "guardAnswer", id: "abc123abc123", decision: "allow-once" });
    await settle(() => admin.answers.length === 1);
    tabS2.receive({ type: "guardAnswer", id: "abc123abc123", decision: "deny" });
    await settle(() => guardMessages(tabS2).some((message) => message["type"] === "guardAnswerFailed"));
    expect(guardMessages(tabS2).at(-1)).toEqual({ type: "guardAnswerFailed", id: "abc123abc123", error: "ответ уже отправляется" });
    expect(admin.answers).toHaveLength(1);
    for (const release of admin.hold) release();
  });

  it("with_the_card_off_the_open_requests_replayed_at_subscribe_show_no_card", async () => {
    approvals.dispose();
    const quiet = new FakeAdmin();
    quiet.card = false;
    quiet.replay = [{ event: "pending", item: pending() }];
    const fresh = new GuardApprovals({ protectionOn: async () => true, connect: async () => quiet, panels: () => host.panels, rootOf: () => undefined, outside: () => undefined, log: () => undefined, retryDelaysMs: [] });
    await fresh.sync();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(guardMessages(tabS1)).toEqual([]);
    fresh.dispose();
  });

  it("a_decider_step_of_a_session_no_tab_shows_goes_to_no_tab", () => {
    const decider = { model: "gw/m", decision: "deny", reason: "force push", ms: 300 };
    admin.emit({ event: "resolved", id: "d2", decision: "deny", by: "decider", session: "terminal-session", decider, item: pending({ id: "d2", session: "terminal-session", decider }) });
    for (const tab of [tabS1, tabS2]) expect(guardMessages(tab)).toEqual([]);
  });

  it("after_a_resubscription_requests_the_service_no_longer_has_are_closed", async () => {
    admin.emit({ event: "pending", item: pending({ id: "gone00000000" }) });
    admin.emit({ event: "pending", item: pending({ id: "kept00000000" }) });
    admin.open = [pending({ id: "kept00000000" })]; // the service restarted and lost one
    admin.confirmed?.();
    await settle(() => guardMessages(tabS1).some((message) => message["type"] === "guardClosed"));
    expect(guardMessages(tabS1).filter((message) => message["type"] === "guardClosed")).toEqual([{ type: "guardClosed", id: "gone00000000" }]);
    tabS1.receive({ type: "guardAnswer", id: "gone00000000", decision: "allow-once" });
    tabS1.receive({ type: "guardAnswer", id: "kept00000000", decision: "allow-once" });
    await settle(() => admin.answers.length === 1);
    expect(admin.answers).toEqual([{ id: "kept00000000", decision: "allow-once" }]);
  });

  it("a_secret_in_the_command_or_reasons_is_redacted_with_the_windows_live_secrets", () => {
    secrets.push(LATE_SECRET); // added after the panels were made (a key saved in the settings)
    admin.emit({
      event: "pending",
      item: pending({
        command: `curl -H "x-api-key: ${SECRET}" https://h/${LATE_SECRET}`,
        code: `const key = "${SECRET}"; await tool.bash("curl https://h/${LATE_SECRET}");`, // B2: an eval's code goes out too
        reasons: [`external ${LATE_SECRET}`],
        decider: { decision: "ask", reason: SECRET, ms: 1 },
      }),
    });
    const sent = tabS1.json.filter((text) => text.includes("guard"));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((text) => text.includes('"code":"const key = '))).toBe(true);
    for (const text of sent) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(LATE_SECRET);
    }
    // the ids still round-trip
    expect(guardMessages(tabS1)).toEqual([expect.objectContaining({ type: "guardStep", id: "abc123abc123" }), expect.objectContaining({ request: expect.objectContaining({ id: "abc123abc123" }) })]);
  });

  it("a_reloaded_webview_gets_the_open_cards_again", async () => {
    admin.emit({ event: "pending", item: pending() });
    tabS1.posted.length = 0;
    tabS1.receive({ type: "ready" });
    await settle(() => guardMessages(tabS1).length > 0);
    expect(guardMessages(tabS1)).toEqual([{ type: "guardRequest", request: expect.objectContaining({ id: "abc123abc123" }) }]);
  });

  it("one_subscription_per_window_started_with_protection_and_stopped_without_it", async () => {
    await approvals.sync();
    expect(admin.subscriptions).toBe(1);
    protectionOn = false;
    await approvals.sync();
    expect(admin.stops).toBe(1);
    expect(admin.closed).toBe(1);
    admin.emit({ event: "pending", item: pending() });
    expect(guardMessages(tabS1)).toEqual([]);
    protectionOn = true;
    await approvals.sync();
    expect(admin.subscriptions).toBe(2);
  });

  it("a_silent_service_shows_a_quiet_banner_only_in_panels_with_open_cards", () => {
    admin.emit({ event: "pending", item: pending({ session: "s1" }) });
    admin.giveUp?.();
    expect(guardMessages(tabS1).at(-1)).toEqual({ type: "guardSilent", silent: true });
    expect(guardMessages(tabS2)).toEqual([]);
  });

  it("a_given_up_or_stopped_subscription_closes_the_open_requests_and_the_title_mark", async () => {
    const title = (tab: Tab): string => (tab.chat as unknown as { panel: vscode.WebviewPanel }).panel.title;
    admin.emit({ event: "pending", item: pending({ session: "s1" }) });
    expect(title(tabS1).startsWith("● ")).toBe(true);
    admin.giveUp?.();
    expect(guardMessages(tabS1)).toContainEqual({ type: "guardClosed", id: "abc123abc123" });
    expect(title(tabS1).startsWith("● ")).toBe(false);
    await approvals.sync(); // a settings change subscribes again
    admin.emit({ event: "pending", item: pending({ id: "two000000000", session: "s2" }) });
    protectionOn = false;
    await approvals.sync();
    expect(guardMessages(tabS2)).toContainEqual({ type: "guardClosed", id: "two000000000" });
  });

  it("an_answer_to_a_request_that_is_gone_closes_it_in_that_tab", async () => {
    tabS1.receive({ type: "guardAnswer", id: "gone00000000", decision: "allow-once" });
    await settle(() => guardMessages(tabS1).length > 0);
    expect(guardMessages(tabS1)).toEqual([{ type: "guardClosed", id: "gone00000000" }]);
  });

  it("a_service_that_never_answers_is_given_up_after_the_bounded_retries", async () => {
    approvals.dispose();
    let attempts = 0;
    const logged: string[] = [];
    const retrying = new GuardApprovals({
      protectionOn: async () => true,
      connect: async () => {
        attempts += 1;
        throw new Error("connect ENOENT");
      },
      rootOf: () => undefined,
      outside: () => undefined,
      panels: () => host.panels,
      log: (text) => logged.push(text),
      retryDelaysMs: [1, 1],
    });
    await retrying.sync();
    await settle(() => attempts === 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(3);
    expect(logged.some((line) => line.includes("connect ENOENT"))).toBe(true);
    retrying.dispose();
  });
});
