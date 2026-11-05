import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const MODEL_ID = /claude-(opus|sonnet|haiku)-\d|gpt-\d/;

function filesMatching(dirs: string[], pattern: RegExp, options: { exclude?: string[] } = {}): string[] {
  const excluded = (options.exclude ?? []).map((item) => path.join(ROOT, item));
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (excluded.includes(dir) || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!excluded.includes(full) && /\.(ts|tsx|js|mjs|css|html|json)$/.test(entry.name) && pattern.test(fs.readFileSync(full, "utf8"))) {
        found.push(path.relative(ROOT, full));
      }
    }
  };
  for (const dir of dirs) walk(path.join(ROOT, dir));
  return found;
}

describe("no hard-coded model lists", () => {
  it("no_model_ids_in_plugin_source", () => {
    // webview/dev: the sample state of the dev page; kit/verify-omo-live.mjs: a dev-only live check, never shipped.
    // src/settings/ladderDefault.ts: the frozen spec's default model ladder — not a catalogue a picker offers, but the
    // first value of one editable per-environment preference (<agentDir>/agent-tabs/ladder.json), whose rungs the walk
    // skips when the environment does not serve them. A stale id there costs a skipped step, never a wrong picker.
    expect(
      filesMatching(["src", "webview", "kit"], MODEL_ID, {
        exclude: ["webview/dev", "kit/verify-omo-live.mjs", "src/settings/ladderDefault.ts"],
      }),
    ).toEqual([]);
  });

  it("the_scan_itself_finds_a_model_id", () => {
    const dir = fs.mkdtempSync(path.join(ROOT, ".scan-"));
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), 'const m = "claude-opus-4";');
      fs.writeFileSync(path.join(dir, "rules.json"), '{"model": "gw/claude-haiku-5-5"}');
      expect(filesMatching([path.basename(dir)], MODEL_ID).sort()).toEqual([path.join(path.basename(dir), "a.ts"), path.join(path.basename(dir), "rules.json")]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
