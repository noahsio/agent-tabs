import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEnv } from "../../kit/lib/envs.mjs";
import { parseJsonc } from "../../kit/lib/jsonc.mjs";

export const sourceEnv = resolveEnv(process.env["AGENT_TABS_LIVE_ENV"] ?? "system", homedir());
export const modelsSource = process.env["AGENT_TABS_LIVE_MODELS"] ?? join(sourceEnv.agentDir, "models.json");

/** Read credentials only inside an explicitly enabled live test. */
export function readLiveKey(): string {
  const keyFile = process.env["AGENT_TABS_LIVE_KEY"];
  const settingsFile = process.env["AGENT_TABS_LIVE_SETTINGS"];
  if (keyFile || !settingsFile) return readFileSync(keyFile ?? join(sourceEnv.agentDir, "keys/gw.key"), "utf8").trim();
  const settings = parseJsonc(readFileSync(settingsFile, "utf8"));
  if (settings !== null && typeof settings === "object" && "agentTabs.environmentVariables" in settings) {
    const entries = settings["agentTabs.environmentVariables"];
    if (Array.isArray(entries)) {
      const entry = entries.find((item: unknown) => item !== null && typeof item === "object" && "name" in item && (item.name === "GW_API_KEY" || item.name === "ANTHROPIC_AUTH_TOKEN"));
      if (entry && typeof entry.value === "string" && entry.value) return entry.value;
    }
  }
  throw new Error("No gateway key in AGENT_TABS_LIVE_SETTINGS; set AGENT_TABS_LIVE_KEY to a key file");
}

export function liveModel(kind: "" | "AUTO_" | "MANUAL_" = ""): { provider: string; id: string } {
  return {
    provider: process.env[`AGENT_TABS_LIVE_${kind}PROVIDER`] ?? (kind === "MANUAL_" ? "gw-openai" : "gw-anthropic"),
    id: process.env[`AGENT_TABS_LIVE_${kind}MODEL`] ?? (kind === "MANUAL_" ? "gpt-6-astra" : kind === "AUTO_" ? "claude-opus-5-5" : "claude-haiku-5-5"),
  };
}
