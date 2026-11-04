import path from "node:path";
import type { EnvVar } from "../env";
import { catReference, readModelsFile, writeKeyFile, writeModelsFile } from "./gateway";
import type { EnvPaths } from "./paths";

const LEGACY_REFERENCES: readonly string[] = ["$GW_API_KEY", "${GW_API_KEY}", "GW_API_KEY"];

function usesLegacyKey(apiKey: unknown): boolean {
  if (typeof apiKey === "string") return LEGACY_REFERENCES.includes(apiKey);
  return typeof apiKey === "object" && apiKey !== null && (apiKey as Record<string, unknown>)["$env"] === "GW_API_KEY";
}

/**
 * Moves the `GW_API_KEY` setting into `keys/gw.key`, points the providers that used it at the file, and only then
 * drops the setting. In this order a crash at any point is repaired by running it again.
 */
export async function migrateGwApiKey(
  vars: EnvVar[],
  paths: EnvPaths,
  updateVars: (vars: EnvVar[]) => Promise<void>,
): Promise<"none" | "migrated"> {
  const key = vars.find((item) => item.name === "GW_API_KEY")?.value;
  if (key === undefined || key === "") return "none";
  const keyFile = path.join(paths.keysDir, "gw.key");
  writeKeyFile(keyFile, key);
  const file = readModelsFile(paths);
  const providers = { ...(file.providers ?? {}) };
  for (const [id, provider] of Object.entries(providers)) {
    if (usesLegacyKey(provider["apiKey"])) {
      providers[id] = { ...provider, apiKey: catReference(keyFile) };
    }
  }
  if (file.providers !== undefined) writeModelsFile(paths, { ...file, providers });
  await updateVars(vars.filter((item) => item.name !== "GW_API_KEY"));
  return "migrated";
}
