// Classifies every command of <raw_dir>/corpus_all.jsonl with the repo's guard and default rules
// into <raw_dir>/classified_all.jsonl.  Usage: node classify-run.mjs <raw_dir>
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { classify } from "../../kit/guard/classify.mjs";
import { loadDefaultRules } from "../../kit/guard/rules.mjs";

const rawDir = process.argv[2];
if (!rawDir) {
  console.error("usage: classify-run.mjs <raw_dir>");
  process.exit(2);
}
const rules = loadDefaultRules();
const out = createWriteStream(join(rawDir, "classified_all.jsonl"));
let rows = 0;
let errors = 0;
for await (const line of createInterface({ input: createReadStream(join(rawDir, "corpus_all.jsonl")) })) {
  const row = JSON.parse(line);
  let tier = "error";
  let reasons = [];
  try {
    ({ tier, reasons } = classify({ tool_name: "bash", tool_input: { command: row.command }, cwd: row.cwd }, rules));
  } catch (error) {
    errors += 1;
    reasons = [String(error.message).slice(0, 80)];
  }
  out.write(`${JSON.stringify({ command: row.command, project: row.project, count: row.count, tier, reasons: reasons.map((reason) => reason.slice(0, 200)) })}\n`);
  rows += 1;
}
out.end();
console.error(`classified: ${rows}, classifier errors: ${errors}`);
