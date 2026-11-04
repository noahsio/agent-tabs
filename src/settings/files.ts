import path from "node:path";
import { writeIfChanged } from "../../kit/lib/files.mjs";
import { writeHooksJson as writeHooksFiles } from "../../kit/lib/hooks.mjs";
import type { EnvPaths } from "./paths";

/**
 * Every settings write to an OmO file: only when the content differs, after a backup, atomically; an existing file
 * keeps its mode (`mode` applies only to a new one). The default backup is timestamped; `backup: "rolling"` (what the
 * settings UI uses, since it writes on every click) keeps one `<file>.bak-agent-tabs`, overwritten each time.
 */
export function writeOmoFile(file: string, content: string, options: { mode?: number; backup?: "timestamped" | "rolling" } = {}): "unchanged" | "written" {
  return writeIfChanged(file, content, options) === "unchanged" ? "unchanged" : "written";
}

/** Writes hooks.json and re-issues trust for the kit's own handlers (those under `~/.omo/kit/`); others stay untrusted. */
export function writeHooksJson(paths: EnvPaths, config: unknown): void {
  const kit = path.join(paths.home, ".omo", "kit") + path.sep;
  writeHooksFiles(paths.agentDir, config, { isOwn: (command) => command.includes(kit) });
}
