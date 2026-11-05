import { describe, expect, it, vi } from "vitest";
import type { PendingView } from "../../src/guard/admin";
import { DENY, OPEN, OutsideChats, outsideText } from "../../src/guard/outside";

function request(overrides: Partial<PendingView> = {}): PendingView {
  return {
    id: "abc123abc123",
    session: "child-1",
    cwd: "/Users/u",
    tool: "bash",
    command: "python -m prisma db push --schema platform/database/prisma/schema.prisma",
    reasons: ["db"],
    createdAt: "2026-11-05T12:19:00.000Z",
    ...overrides,
  };
}

/** A notification whose press the test decides, after the raise returned. */
function deps(pressed?: string) {
  const notified: string[][] = [];
  const opened: string[] = [];
  const answered: Array<{ id: string; decision: string }> = [];
  const logged: string[] = [];
  let release: (() => void) | undefined;
  const chats = new OutsideChats({
    notify: (text, ...buttons) => {
      notified.push([text, ...buttons]);
      return new Promise<string | undefined>((resolve) => {
        release = () => resolve(pressed);
      });
    },
    openSession: async (session) => void opened.push(session),
    answer: async (id, decision) => void answered.push({ id, decision }),
    log: (text) => void logged.push(text),
  });
  return { chats, notified, opened, answered, logged, press: () => release?.() };
}

describe("a request no window has a tab for", () => {
  it("the_notification_names_the_session_and_the_command", () => {
    expect(outsideText(request(), "01a1a820-96ed-7252-9a77-a73ed56ebf85")).toBe(
      "Защита ждёт решения (сессия 01a1a820, её вкладка не открыта): bash python -m prisma db push --schema platform/database/prisma/schema.prisma",
    );
  });

  it("a_long_command_is_cut_and_only_its_first_line_is_shown", () => {
    const text = outsideText(request({ command: `${"x".repeat(200)}\nsecond line` }), "01a1a820-aaaa");
    expect(text).toContain("…");
    expect(text).not.toContain("second line");
    expect(text.length).toBeLessThan(160);
  });

  it("opening_the_session_is_offered_when_we_know_whose_it_is", async () => {
    const { chats, notified, opened, press } = deps(OPEN);
    chats.raise(request(), "01a1a820-96ed");
    expect(notified[0]?.slice(1)).toEqual([OPEN, DENY]);
    press();
    await vi.waitFor(() => expect(opened).toEqual(["01a1a820-96ed"]));
  });

  it("deny_from_the_notification_answers_the_service_without_opening_a_chat", async () => {
    const { chats, answered, opened, press } = deps(DENY);
    chats.raise(request(), "01a1a820-96ed");
    press();
    await vi.waitFor(() => expect(answered).toEqual([{ id: "abc123abc123", decision: "deny" }]));
    expect(opened).toEqual([]);
  });

  it("a_dismissed_notification_decides_nothing_and_the_deadline_has_the_request", async () => {
    const { chats, answered, opened, press } = deps(undefined);
    chats.raise(request(), "01a1a820-96ed");
    press();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answered).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("a_worker_that_asks_again_and_again_raises_one_notification_at_a_time", () => {
    const { chats, notified } = deps(undefined);
    chats.raise(request({ id: "one" }), "01a1a820-96ed");
    chats.raise(request({ id: "two" }), "01a1a820-96ed");
    chats.raise(request({ id: "three" }), "01a1a820-96ed");
    expect(notified).toHaveLength(1); // opening the tab brings up every card it has waiting
  });

  it("the_next_request_of_a_session_is_raised_once_the_last_one_ended", () => {
    const { chats, notified } = deps(undefined);
    const take = chats.raise(request({ id: "one" }), "01a1a820-96ed");
    take();
    chats.raise(request({ id: "two" }), "01a1a820-96ed");
    expect(notified).toHaveLength(2);
  });

  it("another_sessions_request_gets_its_own_notification", () => {
    const { chats, notified } = deps(undefined);
    chats.raise(request({ id: "one" }), "01a1a820-96ed");
    chats.raise(request({ id: "two", session: "child-2" }), "01a1a338-df1c");
    expect(notified).toHaveLength(2);
  });

  it("a_press_after_the_request_ended_decides_nothing", async () => {
    const { chats, answered, press } = deps(DENY);
    const take = chats.raise(request(), "01a1a820-96ed");
    take(); // the request was answered elsewhere, or timed out
    press();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answered).toEqual([]);
  });

  it("without_an_owner_there_is_nothing_to_open_so_only_a_deny_is_offered", () => {
    const { chats, notified } = deps(undefined);
    chats.raise(request(), undefined);
    expect(notified[0]?.slice(1)).toEqual([DENY]);
    expect(notified[0]?.[0]).toContain("сессия не определена");
  });

  it("a_notification_that_throws_is_logged_and_never_breaks_the_subscription", async () => {
    const logged: string[] = [];
    const chats = new OutsideChats({
      notify: () => Promise.reject(new Error("no window")),
      openSession: async () => undefined,
      answer: async () => undefined,
      log: (text) => void logged.push(text),
    });
    expect(() => chats.raise(request(), "01a1a820-96ed")).not.toThrow();
    await vi.waitFor(() => expect(logged.join()).toContain("no window"));
  });
});
