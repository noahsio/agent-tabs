import { homedir } from "node:os";
import { REDACTED } from "./redacted";

export type EnvVar = { name: string; value: string };
export type OmoEnv = {
  env: Record<string, string>;
  agentDir: string;
  omoPath: string;
  secrets: string[];
};
export type BuildOmoEnvResult =
  | { ok: true; value: OmoEnv }
  | { ok: false; missing: string[] };

const SCRUBBED_PREFIXES: readonly string[] = [
  "OMO_",
  "SENPI_",
  "PI_",
  "ANTHROPIC_",
  "OPENAI_",
  "CLAUDE_CONFIG_DIR",
  "GW_",
];
const REQUIRED_VARS: readonly string[] = ["OMO_CODING_AGENT_DIR"];
const PATH_VARS: readonly string[] = ["OMO_CODING_AGENT_DIR"];
const SECRET_NAME = /API_KEY|TOKEN|SECRET/;
const MIN_SECRET_LENGTH = 4;

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}

export function buildOmoEnv(
  base: NodeJS.ProcessEnv,
  vars: EnvVar[],
  omoPath: string,
): BuildOmoEnvResult {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SCRUBBED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  for (const { name, value } of vars) {
    env[name] = PATH_VARS.includes(name) ? expandTilde(value) : value;
  }

  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) return { ok: false, missing };

  const secrets = new Set<string>();
  for (const { value } of vars) {
    if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  }
  for (const [name, value] of Object.entries(env)) {
    if (value && SECRET_NAME.test(name)) secrets.add(value);
  }

  return {
    ok: true,
    value: {
      env,
      secrets: [...secrets],
      agentDir: env["OMO_CODING_AGENT_DIR"] as string,
      omoPath: expandTilde(omoPath),
    },
  };
}

export function redact(text: string, secrets: readonly string[]): string {
  const longestFirst = [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  let result = text;
  for (const secret of longestFirst) result = result.split(secret).join(REDACTED);
  return result;
}
