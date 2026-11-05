import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LADDER_VERSION, ladderFile, parseLadder, readLadder, writeLadder, type Ladder } from "../../src/settings/ladder";
import { DEFAULT_LADDER } from "../../src/settings/ladderDefault";
import type { EnvPaths } from "../../src/settings/paths";

let dir: string;
let paths: EnvPaths;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-store-"));
  paths = { home: dir, agentDir: path.join(dir, "agent"), pluginDir: path.join(dir, "agent", "agent-tabs") } as EnvPaths;
  fs.mkdirSync(paths.pluginDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const custom: Ladder = {
  rungs: [
    { id: "r1", action: { kind: "model", provider: "gw-x", id: "m1" }, on: [] },
    { id: "r2", action: { kind: "text", text: "продолжи" }, on: ["silence"] },
    { id: "r3", action: { kind: "ask" }, on: ["refusal", "empty", "silence", "transport"] },
  ],
};

describe("the ladder's default and its per-environment store", () => {
  it("the_default_ladder_is_the_specs_table_plus_the_provider_rejection", () => {
    expect(DEFAULT_LADDER.rungs).toHaveLength(5);
    expect(DEFAULT_LADDER.rungs.map((rung) => rung.on)).toEqual([
      [],
      // «отклонение» descends the whole ladder: a rejection seen on one model is no evidence about the next
      ["rejected", "empty", "silence", "transport"],
      ["rejected", "empty", "silence", "transport"],
      ["refusal", "rejected", "empty", "silence", "transport"],
      ["refusal", "rejected", "empty", "silence", "transport"],
    ]);
    expect(DEFAULT_LADDER.rungs.slice(0, 4).map((rung) => rung.action.kind)).toEqual(["model", "model", "model", "model"]);
    expect(DEFAULT_LADDER.rungs.at(-1)?.action).toEqual({ kind: "ask" });
    // a refusal jumps straight past the two Anthropic steps: the cyber ban is the provider's, not the model's
    expect(DEFAULT_LADDER.rungs.findIndex((rung) => rung.on.includes("refusal"))).toBe(3);
  });

  it("the_default_ladder_passes_its_own_boundary_check", () => {
    expect(parseLadder(JSON.parse(JSON.stringify(DEFAULT_LADDER)))).toEqual(DEFAULT_LADDER);
  });

  it("the_fourth_rung_is_a_provider_of_its_own", () => {
    const providers = DEFAULT_LADDER.rungs.flatMap((rung) => (rung.action.kind === "model" ? [rung.action.provider] : []));
    expect(new Set(providers).size).toBe(2);
    expect(providers[3]).not.toBe(providers[0]);
  });

  it("the_file_lives_in_this_environments_plugin_dir", () => {
    expect(ladderFile(paths)).toBe(path.join(paths.pluginDir, "ladder.json"));
  });

  it("a_missing_or_broken_file_gives_the_default", () => {
    expect(readLadder(paths)).toEqual(DEFAULT_LADDER);
    fs.writeFileSync(ladderFile(paths), "{ not json");
    expect(readLadder(paths)).toEqual(DEFAULT_LADDER);
    fs.writeFileSync(ladderFile(paths), JSON.stringify({ rungs: [{ id: "a", action: { kind: "nope" }, on: [] }] }));
    expect(readLadder(paths)).toEqual(DEFAULT_LADDER);
  });

  it("a_ladder_round_trips_and_comes_back_stamped_with_the_shape_it_was_written_at", () => {
    writeLadder(paths, custom);
    expect(readLadder(paths)).toEqual({ version: LADDER_VERSION, ...custom });
    // stamped, so it is never migrated again: a rung that answers «отказ» without «отклонение» stays that way
    expect(readLadder(paths).rungs[2]?.on).toEqual(custom.rungs[2]?.on);
  });

  it("a_second_identical_write_leaves_the_file_alone_and_the_first_change_backs_it_up", () => {
    writeLadder(paths, custom);
    const first = fs.readFileSync(ladderFile(paths), "utf8");
    writeLadder(paths, custom);
    expect(fs.readFileSync(ladderFile(paths), "utf8")).toBe(first);
    expect(fs.existsSync(`${ladderFile(paths)}.bak-agent-tabs`)).toBe(false);
    writeLadder(paths, { rungs: custom.rungs.slice(0, 2) });
    expect(fs.readFileSync(`${ladderFile(paths)}.bak-agent-tabs`, "utf8")).toBe(first);
  });

  it("a_bad_shape_is_refused_at_the_boundary", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "no",
      {},
      { rungs: "no" },
      { rungs: [] },
      { rungs: [{ id: "a", action: { kind: "nope" }, on: [] }] },
      { rungs: [{ id: "a", action: { kind: "ask" }, on: ["weather"] }] },
      { rungs: [{ id: "a", action: { kind: "text", text: "  " }, on: [] }] },
      { rungs: [{ id: "a", action: { kind: "model", provider: "", id: "m" }, on: [] }] },
      { rungs: [{ id: "a", action: { kind: "model", provider: "p" }, on: [] }] },
      { rungs: [{ id: "", action: { kind: "ask" }, on: [] }] },
      { rungs: [{ id: "a", action: { kind: "ask" }, on: [] }, { id: "a", action: { kind: "ask" }, on: [] }] }, // two rungs, one id
      { rungs: Array.from({ length: 21 }, (_item, at) => ({ id: `r${at}`, action: { kind: "ask" }, on: [] })) },
    ];
    for (const raw of bad) expect(parseLadder(raw)).toBeUndefined();
  });

  it("the_boundary_check_drops_a_duplicated_failure_and_keeps_the_specs_order", () => {
    const parsed = parseLadder({ rungs: [{ id: "a", action: { kind: "ask" }, on: ["silence", "refusal", "silence"] }] });
    expect(parsed?.rungs[0]?.on).toEqual(["refusal", "silence"]);
  });

  it("the_boundary_check_keeps_nothing_it_was_not_given", () => {
    const parsed = parseLadder({ rungs: [{ id: "a", action: { kind: "model", provider: "p", id: "m", secret: "k" }, on: [], note: "x" }], extra: 1 });
    expect(parsed).toEqual({ rungs: [{ id: "a", action: { kind: "model", provider: "p", id: "m" }, on: [] }] });
  });
});

describe("a ladder stored before «отклонение» existed", () => {
  /** Exactly what 0.4.24 wrote to the person's own `<agentDir>/agent-tabs/ladder.json`: no version, no «отклонение». */
  const STORED_BY_0_4_24 = {
    rungs: [
      { id: "opus-5-5", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5-5" }, on: [] },
      { id: "opus-5", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5" }, on: ["empty", "silence", "transport"] },
      { id: "opus-4-8", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-4-8" }, on: ["empty", "silence", "transport"] },
      { id: "gpt-6-1-sol", action: { kind: "model", provider: "gw-openai", id: "gpt-6.1-sol" }, on: ["refusal", "empty", "silence", "transport"] },
      { id: "ask", action: { kind: "ask" }, on: ["refusal", "empty", "silence", "transport"] },
    ],
  };

  it("the_persons_own_stored_ladder_learns_the_new_class_without_being_asked", () => {
    fs.writeFileSync(ladderFile(paths), JSON.stringify(STORED_BY_0_4_24));
    expect(readLadder(paths)).toEqual(DEFAULT_LADDER);
  });

  it("a_rung_that_answered_nothing_like_it_is_left_alone", () => {
    fs.writeFileSync(
      ladderFile(paths),
      JSON.stringify({
        rungs: [
          { id: "top", action: { kind: "model", provider: "p", id: "a" }, on: [] },
          { id: "quiet", action: { kind: "model", provider: "p", id: "b" }, on: ["silence"] },
          { id: "broken", action: { kind: "model", provider: "p", id: "c" }, on: ["transport"] },
          { id: "said-no", action: { kind: "ask" }, on: ["refusal"] },
        ],
      }),
    );
    // only a rung that already answers «this model did not answer» gains «отклонение»
    expect(readLadder(paths).rungs.map((rung) => rung.on)).toEqual([[], ["silence"], ["transport"], ["refusal", "rejected"]]);
  });

  it("the_migration_runs_once_and_a_later_untick_sticks", () => {
    fs.writeFileSync(ladderFile(paths), JSON.stringify(STORED_BY_0_4_24));
    const migrated = readLadder(paths);
    writeLadder(paths, { ...migrated, rungs: migrated.rungs.map((rung) => ({ ...rung, on: rung.on.filter((failure) => failure !== "rejected") })) });
    expect(readLadder(paths).rungs.every((rung) => !rung.on.includes("rejected"))).toBe(true);
  });

  it("reading_never_writes", () => {
    fs.writeFileSync(ladderFile(paths), JSON.stringify(STORED_BY_0_4_24));
    const before = fs.readFileSync(ladderFile(paths), "utf8");
    readLadder(paths);
    expect(fs.readFileSync(ladderFile(paths), "utf8")).toBe(before);
  });
});
