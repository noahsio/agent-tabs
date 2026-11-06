import type { CommandRow } from "../sessions/controller";
import type { ModelInfo } from "./protocol";

/**
 * The pickers' lists a session last loaded in this environment. OmO answers them per session only, so a draft (no
 * session yet) offers these; they are stored per agent dir and refreshed whenever a session loads its lists.
 */
export type Catalog = { models?: ModelInfo[]; commands?: CommandRow[]; thinkingLevels?: string[] };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModel(value: unknown): value is ModelInfo {
  return (
    isObject(value) &&
    typeof value["provider"] === "string" &&
    typeof value["id"] === "string" &&
    (value["name"] === undefined || typeof value["name"] === "string") &&
    (value["reasoning"] === undefined || typeof value["reasoning"] === "boolean") &&
    (value["acceptsImages"] === undefined || typeof value["acceptsImages"] === "boolean")
  );
}

function isCommand(value: unknown): value is CommandRow {
  return (
    isObject(value) &&
    typeof value["name"] === "string" &&
    (value["description"] === undefined || typeof value["description"] === "string") &&
    (value["source"] === "extension" || value["source"] === "prompt" || value["source"] === "skill") &&
    (value["syntax"] === "slash" || value["syntax"] === "dollar")
  );
}

/** Stored data is outside data: only well-formed rows are kept, a missing or broken list is left out. */
export function parseCatalog(raw: unknown): Catalog {
  if (!isObject(raw)) return {};
  const list = <T>(value: unknown, keep: (item: unknown) => item is T): T[] | undefined => (Array.isArray(value) ? value.filter(keep) : undefined);
  const models = list(raw["models"], isModel);
  const commands = list(raw["commands"], isCommand);
  const thinkingLevels = list(raw["thinkingLevels"], (item): item is string => typeof item === "string");
  return {
    ...(models !== undefined ? { models } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(thinkingLevels !== undefined ? { thinkingLevels } : {}),
  };
}
