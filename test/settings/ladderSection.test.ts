import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LadderHost, readLadder, type LadderSectionAction, type LadderSectionView } from "../../src/settings/ladder";
import { DEFAULT_LADDER } from "../../src/settings/ladderDefault";
import type { EnvPaths } from "../../src/settings/paths";
import type { RolesView } from "../../src/settings/roles";

const MODELS: RolesView["models"] = [
  {
    connection: "Шлюз (Anthropic API)",
    items: [
      { value: "gw-anthropic/claude-opus-5-5", label: "Opus 5.5" },
      { value: "gw-anthropic/claude-opus-5", label: "Opus 5" },
      { value: "gw-anthropic/claude-opus-4-8", label: "Opus 4.8" },
    ],
  },
];

let dir: string;
let paths: EnvPaths;
let host: LadderHost;
let changed: number;

const ids = (): string[] => readLadder(paths).rungs.map((rung) => rung.id);
const view = (): Promise<LadderSectionView> => host.view() as Promise<LadderSectionView>;

/** Puts an action through the section the way the service does: parse at the boundary, then perform. */
async function act(raw: Record<string, unknown>): Promise<void> {
  const action = host.parse(raw);
  expect(action).toBeDefined();
  await host.perform(action as LadderSectionAction);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-section-"));
  paths = { home: dir, agentDir: path.join(dir, "agent"), pluginDir: path.join(dir, "agent", "agent-tabs") } as EnvPaths;
  fs.mkdirSync(paths.pluginDir, { recursive: true });
  changed = 0;
  host = new LadderHost({ paths, models: async () => MODELS, changed: () => (changed += 1) });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("«Лесенка моделей» on the host", () => {
  it("the_section_is_the_ladder_one", () => {
    expect(host.section).toBe("ladder");
  });

  it("an_untouched_environment_shows_the_specs_default", async () => {
    expect((await view()).rungs.map((rung) => rung.id)).toEqual(DEFAULT_LADDER.rungs.map((rung) => rung.id));
    expect(fs.existsSync(path.join(paths.pluginDir, "ladder.json"))).toBe(false); // reading changes nothing
  });

  it("the_view_names_each_rung_and_marks_a_model_the_environment_does_not_serve", async () => {
    const rungs = (await view()).rungs;
    expect(rungs.map((rung) => rung.label)).toEqual(["Opus 5.5", "Opus 5", "Opus 4.8", "gpt-6.1-sol", "Остановиться и спросить"]);
    expect(rungs.map((rung) => rung.missing)).toEqual([undefined, undefined, undefined, true, undefined]);
    expect((await view()).models).toEqual(MODELS);
  });

  it("a_failure_is_ticked_and_unticked_and_stays_in_the_specs_order", async () => {
    await act({ kind: "rung.on", id: "opus-5", failure: "refusal", on: true });
    expect(readLadder(paths).rungs[1]?.on).toEqual(["refusal", "rejected", "empty", "silence", "transport"]);
    expect(changed).toBe(1);
    await act({ kind: "rung.on", id: "opus-5", failure: "silence", on: false });
    expect(readLadder(paths).rungs[1]?.on).toEqual(["refusal", "rejected", "empty", "transport"]);
    await act({ kind: "rung.on", id: "opus-5", failure: "rejected", on: false });
    expect(readLadder(paths).rungs[1]?.on).toEqual(["refusal", "empty", "transport"]);
  });

  it("the_top_rung_answers_nothing", async () => {
    await expect(act({ kind: "rung.on", id: "opus-5-5", failure: "refusal", on: true })).rejects.toThrow(/перв/i);
    expect(readLadder(paths).rungs[0]?.on).toEqual([]);
  });

  it("a_rung_moves_and_the_one_it_displaces_keeps_its_place", async () => {
    await act({ kind: "rung.move", id: "gpt-6-1-sol", to: 1 });
    expect(ids()).toEqual(["opus-5-5", "gpt-6-1-sol", "opus-5", "opus-4-8", "ask"]);
    await act({ kind: "rung.move", id: "gpt-6-1-sol", to: 3 });
    expect(ids()).toEqual(["opus-5-5", "opus-5", "opus-4-8", "gpt-6-1-sol", "ask"]);
  });

  it("a_move_off_either_end_is_clamped_not_refused", async () => {
    await act({ kind: "rung.move", id: "ask", to: -5 });
    expect(ids()[0]).toBe("ask");
    await act({ kind: "rung.move", id: "ask", to: 99 });
    expect(ids().at(-1)).toBe("ask");
  });

  it("a_rungs_action_is_replaced", async () => {
    await act({ kind: "rung.action", id: "gpt-6-1-sol", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-4-8" } });
    expect(readLadder(paths).rungs[3]?.action).toEqual({ kind: "model", provider: "gw-anthropic", id: "claude-opus-4-8" });
    await act({ kind: "rung.action", id: "gpt-6-1-sol", action: { kind: "text", text: "продолжи" } });
    expect(readLadder(paths).rungs[3]?.action).toEqual({ kind: "text", text: "продолжи" });
    await act({ kind: "rung.action", id: "gpt-6-1-sol", action: { kind: "ask" } });
    expect(readLadder(paths).rungs[3]?.action).toEqual({ kind: "ask" });
  });

  it("a_rung_is_added_at_the_end_answering_nothing_yet_and_removed_again", async () => {
    await act({ kind: "rung.add" });
    const added = ids().at(-1) as string;
    expect(ids()).toHaveLength(6);
    expect(readLadder(paths).rungs.at(-1)).toMatchObject({ action: { kind: "ask" }, on: [] });
    await act({ kind: "rung.remove", id: added });
    expect(ids()).toEqual(DEFAULT_LADDER.rungs.map((rung) => rung.id));
  });

  it("the_first_rung_cannot_be_removed", async () => {
    await expect(act({ kind: "rung.remove", id: "opus-5-5" })).rejects.toThrow(/перв/i);
    expect(ids()).toHaveLength(5);
  });

  it("reset_puts_the_specs_table_back", async () => {
    await act({ kind: "rung.remove", id: "ask" });
    await act({ kind: "reset" });
    expect(readLadder(paths)).toEqual(DEFAULT_LADDER);
  });

  it("an_action_for_a_rung_that_is_no_longer_there_is_refused", async () => {
    await expect(act({ kind: "rung.remove", id: "ghost" })).rejects.toThrow(/нет/i);
    await expect(act({ kind: "rung.on", id: "ghost", failure: "refusal", on: true })).rejects.toThrow(/нет/i);
    await expect(act({ kind: "rung.move", id: "ghost", to: 0 })).rejects.toThrow(/нет/i);
  });

  it("a_malformed_action_never_reaches_perform", () => {
    const bad: Record<string, unknown>[] = [
      { kind: "nope" },
      { kind: "rung.on", id: "opus-5", failure: "weather", on: true },
      { kind: "rung.on", id: "opus-5", failure: "refusal", on: "yes" },
      { kind: "rung.on", id: 7, failure: "refusal", on: true },
      { kind: "rung.move", id: "opus-5", to: "1" },
      { kind: "rung.move", id: "opus-5", to: 1.5 },
      { kind: "rung.remove" },
      { kind: "rung.action", id: "opus-5", action: { kind: "text", text: "   " } },
      { kind: "rung.action", id: "opus-5", action: { kind: "model", provider: "p" } },
      { kind: "rung.action", id: "opus-5" },
    ];
    for (const raw of bad) expect(host.parse(raw)).toBeUndefined();
  });

  it("a_ladder_the_person_built_round_trips_through_the_section", async () => {
    await act({ kind: "rung.on", id: "opus-5", failure: "refusal", on: true });
    await act({ kind: "rung.add" });
    const added = ids().at(-1) as string;
    await act({ kind: "rung.action", id: added, action: { kind: "text", text: "продолжи" } });
    await act({ kind: "rung.on", id: added, failure: "silence", on: true });
    await act({ kind: "rung.move", id: added, to: 1 });
    const rungs = (await view()).rungs;
    expect(rungs[1]).toMatchObject({ id: added, action: { kind: "text", text: "продолжи" }, on: ["silence"], label: "продолжи" });
    expect(rungs[2]).toMatchObject({ id: "opus-5", on: ["refusal", "rejected", "empty", "silence", "transport"] });
    expect(readLadder(paths).rungs).toEqual(rungs.map(({ id, action, on }) => ({ id, action, on })));
  });

  it("a_models_list_that_will_not_load_still_shows_the_rungs", async () => {
    host = new LadderHost({ paths, models: async () => Promise.reject(new Error("шлюз молчит")), changed: () => undefined });
    const shown = await view();
    expect(shown.models).toEqual([]);
    expect(shown.rungs.map((rung) => rung.label)).toEqual(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "gpt-6.1-sol", "Остановиться и спросить"]);
    expect(shown.rungs.every((rung) => rung.missing === undefined)).toBe(true); // nothing is known to be missing
  });
});
