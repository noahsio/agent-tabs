// Regression on the real-command corpus (personal data, never committed): runs locally when the corpus exists.
// Regenerate with `sh tools/mining/run.sh`; tune with `python3 -I tools/mining/misses.py --top 5000`.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { classify } from "../../kit/guard/classify.mjs";
// @ts-expect-error plain ESM without types
import { loadDefaultRules } from "../../kit/guard/rules.mjs";

const DIR = new URL("../../.superpowers/research/actions/", import.meta.url).pathname;
const CORPUS = `${DIR}corpus.jsonl`;
const EXPECTED_DENY = `${DIR}expected-deny.txt`;

type Row = { command: string; cwd: string; count: number; tier: string };

function classified(): Row[] {
  const rules = loadDefaultRules();
  return readFileSync(CORPUS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as { command: string; cwd: string; count: number };
      return { ...row, tier: classify({ tool_name: "bash", tool_input: { command: row.command }, cwd: row.cwd }, rules).tier };
    });
}

describe.skipIf(!existsSync(CORPUS))("real_command_corpus", () => {
  const rows = existsSync(CORPUS) ? classified() : [];
  const weight = (tier: string): number => rows.filter((row) => tier === "all" || row.tier === tier).reduce((sum, row) => sum + row.count, 0);
  const expectedDeny = new Set(existsSync(EXPECTED_DENY) ? readFileSync(EXPECTED_DENY, "utf8").split("\n").filter(Boolean) : []);

  it("covers the corpus", () => {
    expect(rows.length).toBeGreaterThan(1000);
  });

  it("no_unexpected_denies", () => {
    // Only the count is reported: the commands are personal data.
    expect(rows.filter((row) => row.tier === "deny" && !expectedDeny.has(row.command)).length).toBe(0);
  });

  // Spec target 0.5 %; ruling P24 (safety first) accepts up to 0.7 % when the excess is escalations the rules demand.
  it("weighted_escalations_within_the_accepted_budget", () => {
    expect(weight("escalate") / weight("all")).toBeLessThanOrEqual(0.007);
  });
});
