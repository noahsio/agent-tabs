// The kit side of turning protection on and off, as the extension uses it (src/guard/protection.ts): one typed entry
// over install/rules/sockets. The extension is a CommonJS bundle without import.meta.url, so everything that reads a
// kit file is told the kit's guard dir (`source`) instead of finding it itself.
import fs from "node:fs";
import path from "node:path";
import { migrateRules } from "./rules.mjs";

export { guardFilesDir, guardHandlers, guardHookEntry, guardHookEvents, installGuardFiles, setGuardHook } from "./install.mjs";
export { servicePaths, socketAlive } from "./sockets.mjs";

const asJson = (value) => JSON.stringify(value, null, 2) + "\n";

/**
 * What rules.json should become before the service starts: no file -> the defaults of `source`/default-rules.json;
 * a v1 file -> its v2 migration; anything else (v2, or a file the service will report as invalid) -> undefined, kept.
 */
export function rulesToWrite(rulesFile, source) {
  const defaultsText = () => fs.readFileSync(path.join(source, "default-rules.json"), "utf8");
  let text;
  try {
    text = fs.readFileSync(rulesFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return defaultsText();
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return raw !== null && typeof raw === "object" && raw.version === 1 ? asJson(migrateRules(raw, JSON.parse(defaultsText()))) : undefined;
}
