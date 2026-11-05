import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRef } from "../chat/model";

/**
 * OmO's own per-model memory of thinking levels: `set_thinking_level` writes `modelThinkingLevels` into
 * `<agentDir>/state.json` the moment a level is picked (no turn has to run), and it is shared by every client and
 * window of that environment. We only read it — the level is recorded by OmO itself, so there is no second store.
 */
export type RememberedLevels = Readonly<Record<string, string>>;

const NONE: RememberedLevels = {};
const STORE = "state.json";

/** The map OmO keeps, from the text of its store; anything else is no memory at all. */
export function parseRememberedLevels(text: string): RememberedLevels {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NONE;
  }
  if (typeof raw !== "object" || raw === null) return NONE;
  const map = (raw as Record<string, unknown>)["modelThinkingLevels"];
  if (typeof map !== "object" || map === null || Array.isArray(map)) return NONE;
  const levels: Record<string, string> = {};
  for (const [model, level] of Object.entries(map)) if (typeof level === "string") levels[model] = level;
  return levels;
}

/** OmO's store for this environment; an unreadable or absent one is simply no memory. */
export function readRememberedLevels(agentDir: string): RememberedLevels {
  try {
    return parseRememberedLevels(readFileSync(join(agentDir, STORE), "utf8"));
  } catch {
    return NONE;
  }
}

export function rememberedLevel(levels: RememberedLevels, model: ModelRef | undefined): string | undefined {
  return model === undefined ? undefined : levels[`${model.provider}/${model.id}`];
}

/** What `get_model_thinking_level` says about one model in one session. */
export type ModelLevel = { level: string; source?: string; availableLevels: string[] };

/**
 * The level a brand-new session has to be moved to, or undefined to leave OmO's own restore alone.
 *
 * OmO restores a model's remembered level on a model switch, but the model a session *starts* on takes its level from
 * the profile first: a `model_profile: "provider/model:level"` pin (like a favourite's `:level`) outranks
 * `modelThinkingLevels` and is stamped as the session's `explicit` level, so the level the person chose was lost in
 * every new session. A session that is one millisecond old has no choice of its own, so that `explicit` can only be
 * the pin — and then the memory wins. Every other source means OmO already restored or defaulted correctly.
 */
export function levelToApply(current: ModelLevel | undefined, remembered: string | undefined): string | undefined {
  if (current === undefined || remembered === undefined) return undefined;
  if (current.source !== "explicit" || current.level === remembered) return undefined;
  return current.availableLevels.includes(remembered) ? remembered : undefined;
}
