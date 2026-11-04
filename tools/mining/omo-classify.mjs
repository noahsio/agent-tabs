// Classifies the OmO tool-call corpus (omo-extract.py) the way the guard service does, before any decider or person:
// file-writing tools by their protected targets, everything else by classify + guardStateReason.
// Usage: node omo-classify.mjs <omo-calls.jsonl>  -> weighted tier shares overall and per tool, top escalation/deny classes.
import { readFileSync } from "node:fs";
import os from "node:os";
import { classify, fileWriteTargets, FILE_WRITE_TOOLS } from "../../kit/guard/classify.mjs";
import { commandText, guardStateReason, protectedTarget } from "../../kit/guard/protect.mjs";
import { loadDefaultRules } from "../../kit/guard/rules.mjs";

/** { tier, reasons } of one call as the service's rules see it (service.mjs evaluate, up to the decider). */
export function serviceTier({ tool: rawTool, input, cwd, agent_dir: agentDir }, rules, home = os.homedir()) {
  const tool = String(rawTool).toLowerCase();
  const where = { cwd, agentDir, home };
  if (FILE_WRITE_TOOLS.has(tool)) {
    const hit = fileWriteTargets({ tool_name: tool, tool_input: input }).find((target) => protectedTarget(target, where));
    return hit ? { tier: "deny", reasons: ["protected-write: a write to the guard / hooks / kit files"] } : { tier: "allow", reasons: [] };
  }
  const verdict = classify({ tool_name: rawTool, tool_input: input, cwd, agent_dir: agentDir, home }, rules);
  const guardState = guardStateReason(commandText(tool, input), where);
  if (verdict.tier === "deny") return { tier: "deny", reasons: verdict.reasons };
  if (verdict.tier === "allow" && !guardState) return { tier: "allow", reasons: [] };
  return { tier: "escalate", reasons: guardState ? [...verdict.reasons, `guard-state: ${guardState}`] : verdict.reasons };
}

export const readCorpus = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** A reason without the command text it quotes: its rule id, plus the tool name for unknown tools. */
const reasonClass = (reason, tool) => {
  const id = reason.split(":")[0];
  if (id === "unknown-tool" || id === "unknown-write-tool") return `${id} (${tool})`;
  if (id === "guard-state" || id === "unparsed eval") return reason.split(":").slice(0, 2).join(":").slice(0, 120);
  return id;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: omo-classify.mjs <omo-calls.jsonl>");
    process.exit(2);
  }
  const rules = loadDefaultRules();
  const totals = { all: 0, allow: 0, escalate: 0, deny: 0 };
  const perTool = new Map();
  const classes = new Map();
  for (const row of readCorpus(file)) {
    const { tier, reasons } = serviceTier(row, rules);
    totals.all += row.count;
    totals[tier] += row.count;
    const toolRow = perTool.get(row.tool) ?? { all: 0, allow: 0, escalate: 0, deny: 0 };
    toolRow.all += row.count;
    toolRow[tier] += row.count;
    perTool.set(row.tool, toolRow);
    if (tier === "allow") continue;
    for (const name of new Set(reasons.map((reason) => `${tier} ${reasonClass(reason, row.tool)}`))) classes.set(name, (classes.get(name) ?? 0) + row.count);
  }
  const pct = (part, whole) => `${((100 * part) / whole).toFixed(2)} %`;
  console.log(`calls ${totals.all}: allow ${pct(totals.allow, totals.all)}, escalate ${pct(totals.escalate, totals.all)} (${totals.escalate}), deny ${pct(totals.deny, totals.all)} (${totals.deny})`);
  for (const [tool, row] of [...perTool].sort((left, right) => right[1].all - left[1].all)) {
    console.log(`  ${tool}: ${row.all} — escalate ${row.escalate}, deny ${row.deny}`);
  }
  console.log("top classes:");
  for (const [name, count] of [...classes].sort((left, right) => right[1] - left[1]).slice(0, 15)) console.log(`  ${count}  ${name}`);
}
