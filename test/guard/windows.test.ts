import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuardAdmin } from "../../src/guard/admin";
import { GuardApprovals, type ApprovalPanel } from "../../src/guard/approvals";
import { TaskRegistry } from "../../src/guard/tasks";
import type { GuardHostMessage } from "../../src/panel/protocol";
// @ts-expect-error plain ESM without types
import { servicePaths } from "../../kit/guard/service.mjs";
import { evaluate, makeSvcDir, removeSvcDirs, send, start, until } from "../kit/serviceHelpers";

type Service = { close(): Promise<void> };

let services: Service[] = [];
let hosts: Window[] = [];

/** A chat tab, as the approvals see one. */
class Tab implements ApprovalPanel {
  readonly got: GuardHostMessage[] = [];
  constructor(readonly durableId: string | undefined) {}
  runsChild(): boolean {
    return false;
  }
  postGuard(message: GuardHostMessage): void {
    this.got.push(message);
  }
  get cards(): GuardHostMessage[] {
    return this.got.filter((message) => message.type === "guardRequest");
  }
}

/** One extension host: its own tabs, its own subscription to the one service of the environment. */
class Window {
  readonly tabs = new Set<Tab>();
  readonly outside: Array<{ id: string; owner: string | undefined }> = [];
  readonly approvals: GuardApprovals;

  constructor(agentDir: string) {
    const tasks = new TaskRegistry(agentDir, { staleMs: 0, layoutStaleMs: 0 });
    this.approvals = new GuardApprovals({
      protectionOn: async () => true,
      connect: () => GuardAdmin.connect(agentDir, { reconnectDelaysMs: [] }),
      panels: () => this.tabs,
      rootOf: (session) => tasks.rootOf(session),
      outside: (request, owner) => {
        this.outside.push({ id: request.id, owner });
        return () => void this.outside.splice(
          this.outside.findIndex((raised) => raised.id === request.id),
          1,
        );
      },
      log: () => undefined,
      retryDelaysMs: [],
    });
    hosts.push(this);
  }

  tab(durableId: string | undefined): Tab {
    const tab = new Tab(durableId);
    this.tabs.add(tab);
    return tab;
  }

  get cards(): GuardHostMessage[] {
    return [...this.tabs].flatMap((tab) => tab.cards);
  }
}

async function boot(agentDir: string): Promise<Service> {
  const service = (await start(agentDir, { claimMs: 80 })) as Service;
  services.push(service);
  return service;
}

/** A senpi-task record, where OmO writes them for this environment. */
function taskRecord(agentDir: string, fields: Record<string, unknown>): void {
  const dir = join(agentDir, "projects", "proj", "senpi-task", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(fields["task_id"])}.json`), JSON.stringify({ status: "running", depth: 1, ...fields }));
}

afterEach(async () => {
  for (const host of hosts) host.approvals.dispose();
  hosts = [];
  for (const service of services) await service.close();
  services = [];
  removeSvcDirs();
});

const ASK = "rm -rf $U/main";
const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

describe("two windows, one decision service", () => {
  it("a_request_of_a_session_open_in_one_window_never_reaches_the_other", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" }, human: { card: true, waitSeconds: 180 } });
    await boot(agentDir);
    taskRecord(agentDir, { task_id: "st_1", child_session_id: CHILD, parent_session_id: ROOT, root_session_id: ROOT });

    const owning = new Window(agentDir);
    const stranger = new Window(agentDir);
    const ownerTab = owning.tab(ROOT); // the chat the worker belongs to
    const strangerTab = stranger.tab("99999999-9999-4999-8999-999999999999"); // a different project
    await owning.approvals.sync();
    await stranger.approvals.sync();

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, CHILD));
    await until(() => ownerTab.cards.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200)); // long past the claim round

    expect(ownerTab.cards).toHaveLength(1);
    expect(strangerTab.got).toEqual([]); // «это не из этой сессии» cannot happen: it was never sent there
    expect(stranger.outside).toEqual([]);
    expect(owning.outside).toEqual([]);
  });

  it("with_the_owners_tab_open_in_no_window_one_window_raises_it_outside_the_chats", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" }, human: { card: true, waitSeconds: 180 } });
    await boot(agentDir);
    taskRecord(agentDir, { task_id: "st_1", child_session_id: CHILD, parent_session_id: ROOT, root_session_id: ROOT });

    const first = new Window(agentDir);
    const second = new Window(agentDir);
    const firstTab = first.tab("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const secondTab = second.tab("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await first.approvals.sync();
    await second.approvals.sync();

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, CHILD));
    await until(() => first.outside.length + second.outside.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(first.outside.length + second.outside.length).toBe(1); // one request, one notification
    expect([...first.outside, ...second.outside][0]?.owner).toBe(ROOT);
    expect(firstTab.got).toEqual([]);
    expect(secondTab.got).toEqual([]);
  });

  it("a_session_nothing_claims_still_reaches_every_window_as_an_offer", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" }, human: { card: true, waitSeconds: 180 } });
    await boot(agentDir);
    const first = new Window(agentDir);
    const second = new Window(agentDir);
    const firstTab = first.tab("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const secondTab = second.tab("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await first.approvals.sync();
    await second.approvals.sync();

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "a-terminal-of-nobody"));
    await until(() => firstTab.cards.length > 0 && secondTab.cards.length > 0);
    for (const tab of [firstTab, secondTab]) {
      expect(tab.cards[0]).toMatchObject({ type: "guardRequest", elsewhere: true });
      expect((tab.cards[0] as { owner?: string }).owner).toBeUndefined(); // honestly unattributable
    }
    expect([...first.outside, ...second.outside]).toEqual([]);
  });

  it("the_window_that_opens_the_session_later_gets_the_waiting_card", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" }, human: { card: true, waitSeconds: 180 } });
    await boot(agentDir);
    taskRecord(agentDir, { task_id: "st_1", child_session_id: CHILD, parent_session_id: ROOT, root_session_id: ROOT });

    const first = new Window(agentDir);
    first.tab("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await first.approvals.sync();
    void send(servicePaths(agentDir).hookSock, evaluate(ASK, CHILD));
    await until(() => first.outside.length > 0);

    const late = new Window(agentDir); // the person opened the owning session in another window
    const lateTab = late.tab(ROOT);
    await late.approvals.sync();
    await until(() => lateTab.cards.length > 0);
    expect(first.cards).toEqual([]);
  });

  it("a_window_that_goes_away_hands_its_request_to_the_one_that_is_left", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" }, human: { card: true, waitSeconds: 180 } });
    await boot(agentDir);
    taskRecord(agentDir, { task_id: "st_1", child_session_id: CHILD, parent_session_id: ROOT, root_session_id: ROOT });

    const owning = new Window(agentDir);
    owning.tab(ROOT);
    const other = new Window(agentDir);
    other.tab("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await owning.approvals.sync();
    await other.approvals.sync();

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, CHILD));
    await until(() => owning.cards.length > 0);
    owning.approvals.dispose(); // that window was closed while the request waits
    await until(() => other.outside.length > 0); // the request is not left to run down its deadline unseen
    expect(other.outside[0]?.owner).toBe(ROOT);
  });

  it("the_deadline_still_denies_a_request_nobody_answered", async () => {
    let clock = Date.parse("2026-11-05T10:00:00Z");
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" }, human: { card: true, waitSeconds: 60 } });
    const service = (await start(agentDir, { claimMs: 80, tickMs: 5, now: () => clock })) as Service;
    services.push(service);
    taskRecord(agentDir, { task_id: "st_1", child_session_id: CHILD, parent_session_id: ROOT, root_session_id: ROOT });

    const window = new Window(agentDir);
    window.tab("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    await window.approvals.sync();

    const first = (await send(servicePaths(agentDir).hookSock, evaluate(ASK, CHILD))) as { decision: string; id: string; ticket: string };
    expect(first.decision).toBe("pending");
    await until(() => window.outside.length > 0);
    const waiting = send(servicePaths(agentDir).hookSock, { op: "wait", id: first.id, ticket: first.ticket }); // the hook holds its ticket
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock += 61_000;
    const waited = (await waiting) as { decision: string; reason: string };
    expect(waited.decision).toBe("deny");
    expect(waited.reason).toContain("отложена до решения человека");
    await until(() => window.outside.length === 0); // and the notice goes with it rather than lingering
  });
});
