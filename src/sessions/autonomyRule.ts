import path from "node:path";
import { writeOmoFile } from "../settings/files";
import type { EnvPaths } from "../settings/paths";

/**
 * What the extension's host appends to every system prompt (`--append-system-prompt <file>`), so work goes on while the
 * person is away (spec 2026-11-08). OmO itself already tells the model to go on after a question times out; this adds
 * what it does not say: write the assumption down, never act on one for anything irreversible, reconcile a late answer,
 * and never work around a command the guard deferred. English: the model reads it.
 */
export const AUTONOMY_RULE = [
  "Autonomy: the person may be away for hours, and work must not stand still waiting for them.",
  "When a question to the person times out or they defer it, go on with the recommended option, write one line starting with 'Assumption:', and do not ask it again.",
  "Never act on an assumption for anything irreversible (deploy, delete, push, payments, messages to people): leave that part and do other work.",
  "A deferred answer may arrive later as a normal message; then check the assumption against it and redo what it changed.",
  "If the guard defers a command until the person decides, do not work around it with other commands; carry on with the rest of the work.",
].join("\n");

/** Writes the rule into the plugin's own folder (only when it changed) and returns the file the host is given. */
export function writeAutonomyRule(paths: EnvPaths): string {
  const file = path.join(paths.pluginDir, "autonomy-rule.md");
  writeOmoFile(file, `${AUTONOMY_RULE}\n`, { backup: "rolling" });
  return file;
}
