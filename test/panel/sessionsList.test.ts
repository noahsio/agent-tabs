import { describe, expect, it } from "vitest";
import { buildSessionItems, fetchLiveSessions, runningCwds, withArchived, withPin } from "../../src/panel/sessionsList";
import type { PastSession } from "../../src/sessions/history";

const past: PastSession[] = [
  { sessionPath: "/s/a.jsonl", durableId: "a", title: "A", updatedAt: 100 },
  { sessionPath: "/s/b.jsonl", durableId: "b", title: "B", updatedAt: 300 },
  { sessionPath: "/s/c.jsonl", durableId: "c", title: "C", updatedAt: 200 },
];

describe("buildSessionItems", () => {
  it("session_items_pinned_first_then_recent", () => {
    const items = buildSessionItems(past, [], new Set(["a"]), "/s/c.jsonl");
    expect(items.map((item) => item.durableId)).toEqual(["a", "b", "c"]);
    expect(items.map((item) => [item.pinned, item.current])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
  });

  it("order_ignores_which_session_is_current_or_running_and_pinned_ones_sort_by_last_message", () => {
    const order = (current: string | undefined, liveRows: Parameters<typeof buildSessionItems>[1]): string[] =>
      buildSessionItems(past, liveRows, new Set(["a", "c"]), current).map((item) => item.durableId);
    const base = order(undefined, []);
    expect(base).toEqual(["c", "a", "b"]); // pins first, each group by last message
    expect(order("/s/a.jsonl", [{ sessionPath: "/s/a.jsonl", durableSessionId: "a", status: "idle", attachments: 2 }])).toEqual(base); // opening/attaching moves nothing
  });

  it("dead_pins_dropped", () => {
    const items = buildSessionItems(past, [], new Set(["gone", "b"]), undefined);
    expect(items.map((item) => item.durableId)).toEqual(["b", "c", "a"]);
    expect(items.every((item) => item.durableId !== "gone")).toBe(true);
  });

  it("running_comes_from_live_status", () => {
    const live = [{ sessionPath: "/s/c.jsonl", durableSessionId: "c", status: "running", attachments: 1 }];
    const items = buildSessionItems(past, live, new Set(), undefined);
    expect(items.filter((item) => item.running).map((item) => item.durableId)).toEqual(["c"]);
  });
});

describe("fetchLiveSessions", () => {
  it("asks_state_only_for_sessions_of_this_project", async () => {
    const asked: string[] = [];
    const client = {
      request: async (type: string, fields?: Record<string, unknown>): Promise<unknown> => {
        if (type === "list_sessions") {
          return {
            sessions: [
              { sessionId: "r1", sessionPath: "/s/a.jsonl", durableSessionId: "a", cwd: "/proj", status: "open", attachments: 0 },
              { sessionId: "r2", sessionPath: "/o/z.jsonl", durableSessionId: "z", cwd: "/other", status: "open", attachments: 0 },
            ],
          };
        }
        asked.push(`${type}:${String(fields?.["sessionId"])}:${String(fields?.["observe"])}`);
        return { isStreaming: true };
      },
    };
    expect(await fetchLiveSessions(client, ["/proj"])).toEqual([{ sessionPath: "/s/a.jsonl", durableSessionId: "a", status: "running", attachments: 0 }]);
    expect(asked).toEqual(["get_state:r1:true"]);
  });

  it("failure_means_no_live_sessions", async () => {
    expect(await fetchLiveSessions({ request: async () => Promise.reject(new Error("x")) }, ["/proj"])).toEqual([]);
  });
});

describe("archived sessions", () => {
  it("are_flagged_and_keep_their_place_in_the_order", () => {
    const items = buildSessionItems(past, [], new Set(), undefined, new Set(["b", "gone"]));
    expect(items.map((item) => [item.durableId, item.archived])).toEqual([
      ["b", true],
      ["c", false],
      ["a", false],
    ]);
    expect(buildSessionItems(past, [], new Set(), undefined).every((item) => !item.archived)).toBe(true);
  });

  it("with_archived_flips_one_flag_without_touching_the_list", () => {
    const items = buildSessionItems(past, [], new Set(), undefined);
    expect(withArchived(items, "c", true).map((item) => [item.durableId, item.archived])).toEqual([
      ["b", false],
      ["c", true],
      ["a", false],
    ]);
    expect(items.every((item) => !item.archived)).toBe(true);
  });
});

describe("withPin", () => {
  it("flips_one_flag_and_reorders", () => {
    const items = buildSessionItems(past, [], new Set(), undefined);
    expect(withPin(items, "a", true).map((item) => item.durableId)).toEqual(["a", "b", "c"]);
    expect(items.every((item) => !item.pinned)).toBe(true);
  });
});

describe("fetchLiveSessions cost", () => {
  it("states_are_asked_in_parallel_and_list_is_observed", async () => {
    let inFlight = 0;
    let peak = 0;
    const listFields: unknown[] = [];
    const client = {
      request: async (type: string, fields?: Record<string, unknown>): Promise<unknown> => {
        if (type === "list_sessions") {
          listFields.push(fields);
          return { sessions: ["r1", "r2", "r3"].map((id) => ({ sessionId: id, sessionPath: `/s/${id}`, durableSessionId: id, cwd: "/proj", status: "open" })) };
        }
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return { isStreaming: false };
      },
    };
    await fetchLiveSessions(client, ["/proj"]);
    expect(peak).toBe(3);
    expect(listFields).toEqual([{ observe: true }]);
  });
});

describe("runningCwds", () => {
  it("running_cwds_lists_cwds_of_running_sessions_only", async () => {
    const client = {
      request: async (type: string, fields?: Record<string, unknown>): Promise<unknown> => {
        if (type === "list_sessions") {
          expect(fields).toEqual({ observe: true });
          return {
            sessions: [
              { sessionId: "r1", sessionPath: "/s/a", durableSessionId: "a", cwd: "/a", status: "open" },
              { sessionId: "r2", sessionPath: "/s/b", durableSessionId: "b", cwd: "/b", status: "open" },
              { sessionId: "r3", sessionPath: "/s/c", durableSessionId: "c", status: "open" },
            ],
          };
        }
        return { isStreaming: fields?.["sessionId"] !== "r2" };
      },
    };
    expect(await runningCwds(client)).toEqual(["/a"]);
    await expect(runningCwds({ request: async () => Promise.reject(new Error("x")) })).rejects.toThrow(); // unknown is not "none"
  });
});
