import fs from "node:fs";
import path from "node:path";
import { parseJsonc, setJsoncPath } from "../../kit/lib/jsonc.mjs";
import { writeOmoFile } from "./files";
import type { EnvPaths } from "./paths";

/**
 * How long OmO waits on an unanswered question before it tells the agent to go on by its own judgment
 * (`askUser.timeoutMinutes` of the environment's settings.json; OmO's own default is 30, clamped to 1–120). Five minutes
 * keeps a night's work from standing still on a question nobody is there to answer (spec 2026-11-08).
 */
export const QUESTION_TIMEOUT_DEFAULT = 5;
const MIN = 1;
const MAX = 120;
const KEY = ["askUser", "timeoutMinutes"];

const settingsFile = (paths: EnvPaths): string => path.join(paths.agentDir, "settings.json");

function readText(paths: EnvPaths): string | undefined {
  try {
    return fs.readFileSync(settingsFile(paths), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The minutes settings.json holds, or undefined when it says nothing (or cannot be read as an object). */
export function readQuestionTimeout(paths: EnvPaths): number | undefined {
  const text = readText(paths);
  if (text === undefined) return undefined;
  let config: unknown;
  try {
    config = parseJsonc(text);
  } catch {
    return undefined;
  }
  const askUser = isObject(config) ? config["askUser"] : undefined;
  const minutes = isObject(askUser) ? askUser["timeoutMinutes"] : undefined;
  return typeof minutes === "number" && Number.isFinite(minutes) ? minutes : undefined;
}

/** Writes the minutes, keeping everything else in the file as it was; whole minutes OmO accepts only. */
export function writeQuestionTimeout(paths: EnvPaths, minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < MIN || minutes > MAX) throw new Error(`Время ожидания — целое число минут от ${MIN} до ${MAX}`);
  const text = readText(paths);
  const next = text === undefined ? `${JSON.stringify({ askUser: { timeoutMinutes: minutes } }, null, 2)}\n` : setJsoncPath(text, KEY, minutes);
  writeOmoFile(settingsFile(paths), next, { backup: "rolling" });
}

/** A fresh environment gets the default once; a value the person chose, or a file that cannot be read, is left alone. */
export function ensureQuestionTimeout(paths: EnvPaths): "written" | "kept" {
  if (readQuestionTimeout(paths) !== undefined) return "kept";
  const text = readText(paths);
  if (text !== undefined) {
    try {
      if (!isObject(parseJsonc(text))) return "kept";
    } catch {
      return "kept";
    }
  }
  writeQuestionTimeout(paths, QUESTION_TIMEOUT_DEFAULT);
  return "written";
}
