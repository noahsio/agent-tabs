import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { buildHooksState, sourceKeyHash } from "../../kit/lib/trust.mjs";

const HOOKS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "/abs/init.sh" }] }],
    PreToolUse: [{ matcher: "Bash|bash", hooks: [{ type: "command", command: "/abs/guard.sh", timeout: 15, statusMessage: "guard" }] }],
  },
};
const SOURCE = "/tmp/omo-vec/agent/hooks.json";

describe("trust hashes", () => {
  it("matches the vector produced by the spike script (trust-hooks.mjs)", () => {
    const state = buildHooksState(HOOKS, SOURCE, {}, "2026-01-01T00:00:00.000Z");
    expect(sourceKeyHash("global", SOURCE)).toBe("1daab1c1dc45");
    expect(state.hooks["hk_1daab1c1dc45_SessionStart_0_0"].trustedHash).toBe(
      "sha256:824a2b9f3d93383d904f14354fefe182e974adf0be97936c8ac24c8bad9c6c1f",
    );
    expect(state.hooks["hk_1daab1c1dc45_PreToolUse_0_0"].trustedHash).toBe(
      "sha256:6e5a49b5920ff9c1650db1c7539c6d90eafccf11cb7cc5e75e33732cbde5a9b6",
    );
  });

  it("changes the hash when a hook command changes and keeps untouched records", () => {
    const first = buildHooksState(HOOKS, SOURCE, {}, "t1");
    const edited = structuredClone(HOOKS);
    edited.hooks.SessionStart[0]!.hooks[0]!.command = "/abs/other.sh";
    const second = buildHooksState(edited, SOURCE, first, "t2");
    const id = "hk_1daab1c1dc45_SessionStart_0_0";
    expect(second.hooks[id].trustedHash).not.toBe(first.hooks[id].trustedHash);
    expect(second.hooks[id].updatedAt).toBe("t2");
    expect(second.hooks["hk_1daab1c1dc45_PreToolUse_0_0"]).toBe(first.hooks["hk_1daab1c1dc45_PreToolUse_0_0"]);
  });
});
