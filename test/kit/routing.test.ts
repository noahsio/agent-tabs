import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { servicePaths } from "../../kit/guard/service.mjs";
import { evaluate, makeSvcDir, removeSvcDirs, send, start, until } from "./serviceHelpers";

type Service = { close(): Promise<void> };

let services: Service[] = [];
let windows: Window[] = [];

/** One extension host on the admin socket: it reads events and answers claim rounds the way a window would. */
class Window {
  readonly events: any[] = [];
  /** Sessions this window has open as tabs. */
  tabs = new Set<string>();
  /** session -> the owner this window would resolve from its registry (a session it does not have open). */
  knows = new Map<string, string>();
  /** Claims the window never answers (a wedged extension host). */
  mute = false;
  private socket!: net.Socket;

  /** 1 = a window whose extension predates the claim round: it never answers one. */
  static async open(sock: string, label: string, protocol = 2): Promise<Window> {
    const window = new Window();
    window.label = label;
    window.protocol = protocol;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(sock);
      window.socket = socket;
      let buffer = "";
      let acked = false;
      socket.on("connect", () => socket.write(`${JSON.stringify({ op: "subscribe", ...(protocol > 1 ? { protocol } : {}) })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const message = JSON.parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          if (!acked) {
            acked = true;
            resolve();
          } else window.take(message);
        }
      });
      socket.on("error", reject);
    });
    windows.push(window);
    return window;
  }

  label = "";
  protocol = 2;

  private take(message: any): void {
    if (message.event === "claim") {
      if (this.mute || this.protocol < 2) return;
      const verdict = this.tabs.has(message.session) ? "own" : this.knows.has(message.session) ? "knows" : "no";
      const owner = this.knows.get(message.session);
      this.write({ op: "claim", id: message.id, verdict, ...(owner !== undefined ? { owner } : {}) });
      return;
    }
    if (message.event !== undefined) this.events.push(message);
  }

  write(message: unknown): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  /** Gives up a request this window was given (its tab closed). */
  disown(id: string): void {
    this.write({ op: "claim", id, verdict: "no" });
  }

  get cards(): any[] {
    return this.events.filter((event) => event.event === "pending" && event.outside === undefined);
  }

  get outside(): any[] {
    return this.events.filter((event) => event.event === "pending" && event.outside !== undefined);
  }

  close(): void {
    this.socket.destroy();
  }
}

async function boot(agentDir: string, options: Record<string, unknown> = {}): Promise<Service> {
  const service = (await start(agentDir, { claimMs: 60, ...options })) as Service;
  services.push(service);
  return service;
}

afterEach(async () => {
  for (const window of windows) window.close();
  windows = [];
  for (const service of services) await service.close();
  services = [];
  removeSvcDirs();
});

/** A command the rules send to a human, so a request opens and waits. */
const ASK = "rm -rf $U/main";

describe("one request, many windows", () => {
  it("the_window_whose_tab_owns_the_session_is_the_only_one_that_gets_a_card", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const owner = await Window.open(sock, "owner");
    const other = await Window.open(sock, "other");
    owner.tabs.add("child-1");
    other.knows.set("child-1", "root-9"); // it can resolve the owner, but has no tab for it

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    await until(() => owner.cards.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(owner.cards).toHaveLength(1);
    expect(owner.cards[0].only).toBe(true);
    expect(other.events).toEqual([]); // the chat that did not ask hears nothing at all
  });

  it("with_no_tab_anywhere_one_window_is_asked_to_raise_it_outside_the_chats", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const first = await Window.open(sock, "first");
    const second = await Window.open(sock, "second");
    first.knows.set("child-1", "root-9");
    second.knows.set("child-1", "root-9");

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    await until(() => first.outside.length + second.outside.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(first.outside.length + second.outside.length).toBe(1); // one notification for one request, not N
    expect([...first.cards, ...second.cards]).toEqual([]);
    expect([...first.outside, ...second.outside][0].outside).toEqual({ owner: "root-9" });
  });

  it("a_session_nobody_claims_goes_to_every_window", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const first = await Window.open(sock, "first");
    const second = await Window.open(sock, "second");

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "a-terminal"));
    await until(() => first.cards.length > 0 && second.cards.length > 0);
    expect(first.cards[0].only).toBeUndefined();
    expect(second.cards[0].only).toBeUndefined();
  });

  it("a_window_that_never_answers_does_not_hold_the_request", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const wedged = await Window.open(sock, "wedged");
    const live = await Window.open(sock, "live");
    wedged.mute = true;

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "a-terminal"));
    await until(() => live.cards.length > 0); // the claim timer closed the round without it
    expect(live.cards[0].only).toBeUndefined();
  });

  it("a_window_that_opens_the_tab_later_is_given_the_waiting_request", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const first = await Window.open(sock, "first");
    first.knows.set("child-1", "root-9");

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    await until(() => first.outside.length > 0);
    const id = first.outside[0].item.id;

    const late = await Window.open(sock, "late"); // the person opened the session's tab in another window
    late.tabs.add("child-1");
    late.write({ op: "claim", id, verdict: "own" });
    await until(() => late.cards.length > 0);
    expect(late.cards[0].only).toBe(true);
    expect(first.cards).toEqual([]);
  });

  it("a_request_its_only_window_gave_up_is_routed_again_instead_of_going_quiet", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const owner = await Window.open(sock, "owner");
    const other = await Window.open(sock, "other");
    owner.tabs.add("child-1");

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    await until(() => owner.cards.length > 0);
    const id = owner.cards[0].item.id;

    owner.tabs.delete("child-1"); // the person closed the tab while the request waits
    owner.disown(id);
    await until(() => other.cards.length > 0 || other.outside.length > 0);
    expect([...other.cards, ...other.outside]).toHaveLength(1); // somebody is asked again
  });

  it("a_window_that_disconnects_hands_its_request_back", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const owner = await Window.open(sock, "owner");
    const other = await Window.open(sock, "other");
    owner.tabs.add("child-1");

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    await until(() => owner.cards.length > 0);
    owner.close(); // the window was shut
    await until(() => other.cards.length > 0 || other.outside.length > 0);
  });

  it("a_window_that_subscribes_after_the_request_is_asked_to_claim_it_not_handed_it", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const owner = await Window.open(sock, "owner");
    owner.tabs.add("child-1");

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    await until(() => owner.cards.length > 0);

    const stranger = await Window.open(sock, "stranger"); // a chat that has nothing to do with it
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stranger.events).toEqual([]);
  });

  it("an_old_window_is_never_shown_a_request_a_round_placed_with_a_new_one", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const owner = await Window.open(sock, "owner");
    const stale = await Window.open(sock, "stale", 1); // a window still running the build it loaded hours ago
    owner.tabs.add("child-1");

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    await until(() => owner.cards.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(owner.cards).toHaveLength(1);
    expect(stale.events).toEqual([]); // it cannot claim, so it is not offered what it would decide for itself
  });

  it("an_old_window_is_not_offered_the_unclaimed_fan_out_either_while_a_new_one_is_there", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const fresh = await Window.open(sock, "fresh");
    const stale = await Window.open(sock, "stale", 1);

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "a-terminal"));
    await until(() => fresh.cards.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stale.events).toEqual([]);
  });

  it("with_every_window_old_the_request_still_goes_to_all_of_them", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const first = await Window.open(sock, "first", 1);
    const second = await Window.open(sock, "second", 1);

    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    // nobody can be asked, and a request nobody sees is denied at the deadline: the old broadcast is the honest fallback
    await until(() => first.cards.length > 0 && second.cards.length > 0);
    expect(first.cards[0].only).toBeUndefined();
    expect(second.cards[0].only).toBeUndefined();
  });

  it("an_old_window_that_subscribes_later_joins_only_a_request_that_went_to_everybody", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const owner = await Window.open(sock, "owner");
    owner.tabs.add("child-1");
    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"));
    await until(() => owner.cards.length > 0);

    const stale = await Window.open(sock, "stale", 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stale.events).toEqual([]);
  });

  it("a_new_window_arriving_after_an_all_old_fan_out_does_not_take_the_request_away", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const sock = servicePaths(agentDir).adminSock;
    const stale = await Window.open(sock, "stale", 1);
    void send(servicePaths(agentDir).hookSock, evaluate(ASK, "a-terminal"));
    await until(() => stale.cards.length > 0);

    const fresh = await Window.open(sock, "fresh");
    await until(() => fresh.cards.length > 0); // it joins what already went out; the old one keeps what it was given
    expect(stale.cards).toHaveLength(1);
  });

  it("the_service_says_what_it_speaks_and_where_its_kit_came_from", async () => {
    const agentDir = makeSvcDir();
    await boot(agentDir);
    const status = (await send(servicePaths(agentDir).adminSock, { op: "status" })) as any;
    expect(status.protocol).toBe(2);
    expect(status.kit).toContain("kit/guard");
  });

  it("the_deadline_denies_a_request_whose_window_only_raised_it_outside_the_chats", async () => {
    let clock = Date.parse("2026-11-05T10:00:00Z");
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" }, human: { waitSeconds: 60 } });
    await boot(agentDir, { now: () => clock, tickMs: 5 });
    const sock = servicePaths(agentDir).adminSock;
    const window = await Window.open(sock, "window");
    window.knows.set("child-1", "root-9");

    const opened = (await send(servicePaths(agentDir).hookSock, evaluate(ASK, "child-1"))) as any;
    expect(opened.decision).toBe("pending");
    await until(() => window.outside.length > 0);
    const waiting = send(servicePaths(agentDir).hookSock, { op: "wait", id: opened.id, ticket: opened.ticket }); // the hook is already holding
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock += 61_000;
    const waited = (await waiting) as any;
    expect(waited.decision).toBe("deny");
    expect(waited.reason).toContain("не ответил");
    await until(() => window.events.some((event) => event.event === "resolved" && event.by === "timeout"));
  });
});

