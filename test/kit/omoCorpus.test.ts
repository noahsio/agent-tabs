// Regression on the real OmO tool-call corpus (personal data, never committed): runs locally when the corpus exists.
// Regenerate with `python3 -I tools/mining/omo-extract.py .superpowers/research/actions/omo-calls.jsonl <agent_dir>...`;
// report with `node tools/mining/omo-classify.mjs .superpowers/research/actions/omo-calls.jsonl`.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { readCorpus, serviceTier } from "../../tools/mining/omo-classify.mjs";
// @ts-expect-error plain ESM without types
import { loadDefaultRules } from "../../kit/guard/rules.mjs";

const CORPUS = new URL("../../.superpowers/research/actions/omo-calls.jsonl", import.meta.url).pathname;

type Row = { tool: string; input: unknown; cwd: string; agent_dir: string; count: number };

describe.skipIf(!existsSync(CORPUS))("real_omo_call_corpus", () => {
  const rules = existsSync(CORPUS) ? loadDefaultRules() : null;
  const rows = existsSync(CORPUS) ? (readCorpus(CORPUS) as Row[]).map((row) => ({ ...row, tier: serviceTier(row, rules).tier as string })) : [];
  const weight = (tier: string): number => rows.filter((row) => tier === "all" || row.tier === tier).reduce((sum, row) => sum + row.count, 0);

  it("covers_the_corpus", () => {
    expect(weight("all")).toBeGreaterThan(1000);
  });

  it("no_denies", () => {
    // Only the count is reported: the calls are personal data.
    expect(rows.filter((row) => row.tier === "deny").length).toBe(0);
  });

  it("weighted_escalations_within_1_percent", () => {
    expect(weight("escalate") / weight("all")).toBeLessThanOrEqual(0.01);
  });
});
