import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { levelToApply, parseRememberedLevels, readRememberedLevels, rememberedLevel } from "../../src/sessions/rememberedLevels";

const scratch = (): string => mkdtempSync(join(tmpdir(), "agent-tabs-levels-"));

describe("OmO's own per-model memory", () => {
  it("keeps_the_level_of_every_model_it_names", () => {
    const levels = parseRememberedLevels('{"modelThinkingLevels":{"gw-anthropic/claude-opus-5-5":"medium","gw-openai/gpt-6-astra":"xhigh"}}');
    expect(levels).toEqual({ "gw-anthropic/claude-opus-5-5": "medium", "gw-openai/gpt-6-astra": "xhigh" });
  });

  it("anything_that_is_not_a_model_to_level_map_is_no_memory_at_all", () => {
    expect(parseRememberedLevels('{"modelThinkingLevels":{"gw/m1":7,"gw/m2":null,"gw/m3":"high"}}')).toEqual({ "gw/m3": "high" });
    expect(parseRememberedLevels('{"modelThinkingLevels":[1,2]}')).toEqual({});
    expect(parseRememberedLevels('{"other":1}')).toEqual({});
    expect(parseRememberedLevels("not json")).toEqual({});
  });

  it("a_model_is_found_by_provider_and_id_and_nothing_else", () => {
    const levels = { "gw-anthropic/claude-opus-5-5": "medium" };
    expect(rememberedLevel(levels, { provider: "gw-anthropic", id: "claude-opus-5-5" })).toBe("medium");
    expect(rememberedLevel(levels, { provider: "gw-anthropic", id: "claude-sonnet-5-5" })).toBeUndefined();
    expect(rememberedLevel(levels, undefined)).toBeUndefined();
  });

  it("reads_the_store_omo_writes_and_an_absent_one_is_simply_empty", () => {
    const agentDir = scratch();
    expect(readRememberedLevels(agentDir)).toEqual({});
    writeFileSync(join(agentDir, "state.json"), JSON.stringify({ modelThinkingLevels: { "gw/m1": "low" } }));
    expect(readRememberedLevels(agentDir)).toEqual({ "gw/m1": "low" });
  });
});

describe("what a brand-new session's level must become", () => {
  const available = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  it("a_pinned_profile_level_gives_way_to_the_remembered_one", () => {
    expect(levelToApply({ level: "high", source: "explicit", availableLevels: available }, "medium")).toBe("medium");
  });

  it("a_level_omo_restored_itself_is_left_alone", () => {
    for (const source of ["global", "session", "model-default", "default", "fallback", "clamped"]) {
      expect(levelToApply({ level: "high", source, availableLevels: available }, "medium")).toBeUndefined();
    }
  });

  it("nothing_to_restore_and_nothing_to_ask_leave_the_session_as_it_is", () => {
    expect(levelToApply({ level: "high", source: "explicit", availableLevels: available }, undefined)).toBeUndefined();
    expect(levelToApply(undefined, "medium")).toBeUndefined(); // a host without get_model_thinking_level
    expect(levelToApply({ level: "medium", source: "explicit", availableLevels: available }, "medium")).toBeUndefined(); // already there
  });

  it("a_remembered_level_the_model_cannot_run_is_left_alone", () => {
    expect(levelToApply({ level: "off", source: "explicit", availableLevels: ["off"] }, "medium")).toBeUndefined();
  });
});
