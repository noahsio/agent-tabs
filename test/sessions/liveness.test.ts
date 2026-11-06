import { describe, expect, it } from "vitest";
import { INSTANT_TURN_MS, instantDeadTurn, openWorkText, systemAbortStall } from "../../src/sessions/liveness";

/** The entry OmO appends when its own liveness machinery calls the session stalled. */
function stallEntry(verdict: Record<string, unknown>, openWork: Record<string, unknown> = { kind: "none" }): Record<string, unknown> {
  return { type: "custom", customType: "turn-end-liveness", id: "e1", parentId: "e0", data: { verdict, openWork } };
}

/** The aborted assistant message of a turn that never reached the model — the live scratch host's own shape. */
function deadMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "aborted",
    errorMessage: "The operation was aborted.",
    usage: { totalTokens: 0 },
    timing: { requestedAt: 1793896968351, endedAt: 1793896968367 },
    ...over,
  };
}

describe("the stall OmO's own machinery writes", () => {
  it("reads_the_verdict_and_the_open_work", () => {
    expect(systemAbortStall(stallEntry({ kind: "stalled", reason: "aborted", abortSource: "system" }, { kind: "active-goal", goalId: "81ebe93c" }))).toEqual({
      kind: "active-goal",
    });
    expect(systemAbortStall(stallEntry({ kind: "stalled", reason: "aborted", abortSource: "system" }, { kind: "open-todos", count: 11 }))).toEqual({
      kind: "open-todos",
      count: 11,
    });
    // the live scratch host's own row: a stall with nothing left open is still a stall
    expect(systemAbortStall(stallEntry({ kind: "stalled", reason: "aborted", abortSource: "system" }))).toEqual({ kind: "none" });
  });

  it("is_nothing_for_every_other_verdict", () => {
    const rejected = [
      stallEntry({ kind: "done" }),
      stallEntry({ kind: "held", reason: "user-abort" }),
      stallEntry({ kind: "continuing", via: "retry" }),
      stallEntry({ kind: "waiting", on: [{ kind: "armed-timer" }] }),
      stallEntry({ kind: "stalled", reason: "no-wake" }),
      stallEntry({ kind: "stalled", reason: "provider-error" }),
      // an abort of ours, and the person's own «Стоп»: OmO leaves the source off entirely
      stallEntry({ kind: "stalled", reason: "aborted" }),
      stallEntry({ kind: "stalled", reason: "aborted", abortSource: "provider" }),
      // a row of another kind, and a shape that is not an entry at all
      { type: "custom", customType: "session-lifecycle", data: { verdict: { kind: "stalled", reason: "aborted", abortSource: "system" } } },
      { type: "message", message: { role: "assistant" } },
      undefined,
      "turn-end-liveness",
    ];
    for (const entry of rejected) expect(systemAbortStall(entry)).toBeUndefined();
  });
});

describe("the turn that never reached the model", () => {
  it("is_aborted_having_produced_nothing_in_no_time", () => {
    expect(instantDeadTurn(deadMessage())).toBe(true);
    // the person's own journal: the request abandoned as it was being made
    expect(instantDeadTurn(deadMessage({ timing: { requestedAt: 1793878416330, endedAt: 1793878416331 } }))).toBe(true);
    expect(instantDeadTurn(deadMessage({ content: [] }))).toBe(true);
  });

  it("is_not_a_turn_that_did_something_or_lasted", () => {
    const rejected = [
      // produced an answer, or called a tool: never repeated, whoever aborted it
      deadMessage({ content: [{ type: "text", text: "Пр" }] }),
      deadMessage({ content: [{ type: "toolCall", id: "t1", name: "read" }] }),
      deadMessage({ content: [{ type: "text", text: "" }, { type: "toolCall", id: "t1", name: "read" }] }),
      // lasted: a deadline abort, or the person's «Стоп» on a turn that was thinking
      deadMessage({ timing: { requestedAt: 1000, endedAt: 1000 + INSTANT_TURN_MS + 1 } }),
      deadMessage({ timing: { requestedAt: 1000, endedAt: 60_000 } }),
      // ended some other way, or says nothing about when
      deadMessage({ stopReason: "error" }),
      deadMessage({ stopReason: "endTurn" }),
      deadMessage({ timing: undefined }),
      deadMessage({ timing: { requestedAt: 1000 } }),
      deadMessage({ role: "user" }),
      undefined,
    ];
    for (const message of rejected) expect(instantDeadTurn(message)).toBe(false);
  });
});

describe("what is left open, in the person's language", () => {
  it("names_the_work_or_says_nothing", () => {
    expect(openWorkText({ kind: "active-goal" })).toContain("цель");
    expect(openWorkText({ kind: "open-todos", count: 11 })).toContain("11");
    expect(openWorkText({ kind: "open-todos" })).toBeTypeOf("string");
    expect(openWorkText({ kind: "none" })).toBeUndefined();
    expect(openWorkText({ kind: "something-omo-added-later" })).toBeUndefined();
  });
});
