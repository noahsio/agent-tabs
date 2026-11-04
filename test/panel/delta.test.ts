import { describe, expect, it } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import { applyDelta, diffState } from "../../src/panel/delta";
import type { StateMessage } from "../../src/panel/protocol";

const user: Block = { kind: "user", id: "u1", text: "hi" };
const tool: Block = { kind: "tool", id: "t1", name: "read", summary: "a.ts", args: undefined, output: "x".repeat(100), truncated: false, state: "ok" };
const reply: Block = { kind: "assistant", id: "a1", text: "he", thinking: "", streaming: true };
const models = [{ provider: "gw", id: "m1" }];

function message(state: Partial<ChatState>, extra: Partial<StateMessage> = {}): StateMessage {
  return { type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "auto" }, reconnectable: true, models, ...extra };
}

describe("diffState / applyDelta", () => {
  it("a_streamed_token_sends_only_the_changed_block", () => {
    const before = message({ blocks: [user, tool, reply], running: true });
    const after = message({ blocks: [user, tool, { ...reply, text: "hello" }], running: true });
    const delta = diffState(before, after);
    expect(delta.changed).toEqual([{ ...reply, text: "hello" }]);
    expect(delta.removed).toEqual([]);
    expect(delta).not.toHaveProperty("order"); // same ids in the same order
    expect(delta).not.toHaveProperty("models"); // the same list: the webview keeps its own
    expect(delta.state).toEqual({ dialogs: [], agents: [], running: true });
    expect(applyDelta(before, delta)).toEqual(after);
  });

  it("added_removed_and_reordered_blocks_carry_the_order", () => {
    const before = message({ blocks: [user, tool, reply] });
    const queued: Block = { kind: "user", id: "queued:1", text: "next", delivery: { state: "queued", queuedId: "q_1" } };
    const after = message({ blocks: [user, reply, queued] });
    const delta = diffState(before, after);
    expect(delta.changed).toEqual([queued]);
    expect(delta.removed).toEqual(["t1"]);
    expect(delta.order).toEqual(["u1", "a1", "queued:1"]);
    expect(applyDelta(before, delta)).toEqual(after);
  });

  it("lists_are_sent_only_when_they_change_and_unchanged_blocks_keep_their_identity", () => {
    const before = message({ blocks: [user, tool] });
    const after = message({ blocks: [user, tool], error: "boom" }, { models: [...models, { provider: "gw", id: "m2" }], thinkingLevels: ["low"] });
    const delta = diffState(before, after);
    expect(delta.changed).toEqual([]);
    expect(delta.models).toEqual(after.models);
    expect(delta.thinkingLevels).toEqual(["low"]);
    const applied = applyDelta(before, delta);
    expect(applied).toEqual(after);
    expect(applied.state.blocks[1]).toBe(before.state.blocks[1]); // the webview's per-block cache relies on this
  });
});
