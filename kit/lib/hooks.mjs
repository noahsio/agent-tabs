// The one writer of hooks.json: every write re-issues the trust records of our own handlers in hooks-state.json.
import fs from "node:fs";
import path from "node:path";
import { writeIfChanged } from "./files.mjs";
import { buildHooksState } from "./trust.mjs";

const asJson = (value) => JSON.stringify(value, null, 2) + "\n";

/**
 * Write `config` to `<agentDir>/hooks.json` and re-issue trust for the handlers whose command satisfies `isOwn`
 * (foreign handlers are written but never trusted). The previous hooks-state.json is read before anything is
 * written, so a malformed one aborts the whole write. Returns each file's `writeIfChanged` outcome; with dryRun
 * nothing touches the disk; `backup` as in writeIfChanged.
 */
export function writeHooksJson(agentDir, config, { isOwn, now = new Date(), dryRun = false, backup }) {
  const hooksFile = path.join(agentDir, "hooks.json");
  const stateFile = path.join(agentDir, "hooks-state.json");
  const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  const state = buildHooksState(config, hooksFile, previous, now.toISOString(), { isOwn });
  return {
    hooks: writeIfChanged(hooksFile, asJson(config), { mode: 0o644, now, dryRun, backup }),
    state: writeIfChanged(stateFile, asJson(state), { mode: 0o600, now, dryRun, backup }),
  };
}
