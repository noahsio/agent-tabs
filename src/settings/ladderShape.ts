import type { FailureClass } from "../sessions/ladderFailure";
import type { RolesView } from "./roles";

/**
 * The model ladder's shape, and nothing else. This module is imported by the webview as well as the host, so it stays
 * free of `node:` — the file the ladder lives in, and the settings section that edits it, are in `./ladder`.
 */

/** The failure classes in the order the settings section lists them, which is also the order a rung stores them in. */
export const FAILURE_CLASSES = ["refusal", "rejected", "empty", "silence", "transport"] as const;

/** What a rung does when it is reached. */
export type RungAction =
  /** Switch this session to that model and repeat the person's message. */
  | { kind: "model"; provider: string; id: string }
  /** Send the person's own phrase instead («продолжи»). */
  | { kind: "text"; text: string }
  /** End the ladder: the person decides. */
  | { kind: "ask" };

/** A rung: an action plus the failures it answers. The first rung answers nothing — it is where a session starts. */
export type Rung = { id: string; action: RungAction; on: FailureClass[] };

/**
 * The shape version a stored ladder was last written at. 2 added «отклонение» — a class that did not exist when 1
 * was written, so a rung stored then could not have been asked about it. `migrateLadder` answers for those rungs
 * once; after that the person's own ticks are the only thing that decides.
 */
export const LADDER_VERSION = 2;

export type Ladder = { rungs: Rung[]; version?: number };

/** What the person sees in «Лесенка моделей»: how each rung reads, and whether this environment can serve it. */
export type LadderRungView = Rung & { label: string; missing?: true };
export type LadderSectionView = { rungs: LadderRungView[]; models: RolesView["models"] };

export type LadderSectionAction =
  | { kind: "rung.add" }
  | { kind: "rung.remove"; id: string }
  | { kind: "rung.move"; id: string; to: number }
  | { kind: "rung.action"; id: string; action: RungAction }
  | { kind: "rung.on"; id: string; failure: FailureClass; on: boolean }
  | { kind: "reset" };

export const ASK_LABEL = "Остановиться и спросить";

/** More rungs than this is not a ladder; the cap keeps a hand-edited file from walking forever. */
const MAX_RUNGS = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFailureClass(value: unknown): value is FailureClass {
  return (FAILURE_CLASSES as readonly unknown[]).includes(value);
}

export function parseAction(raw: unknown): RungAction | undefined {
  if (!isObject(raw)) return undefined;
  if (raw["kind"] === "ask") return { kind: "ask" };
  if (raw["kind"] === "text") {
    const text = raw["text"];
    return typeof text === "string" && text.trim() !== "" ? { kind: "text", text } : undefined;
  }
  if (raw["kind"] !== "model") return undefined;
  const { provider, id } = raw;
  return typeof provider === "string" && provider !== "" && typeof id === "string" && id !== "" ? { kind: "model", provider, id } : undefined;
}

function parseRung(raw: unknown): Rung | undefined {
  if (!isObject(raw) || typeof raw["id"] !== "string" || raw["id"] === "") return undefined;
  const action = parseAction(raw["action"]);
  if (action === undefined || !Array.isArray(raw["on"])) return undefined;
  if (raw["on"].some((item) => !isFailureClass(item))) return undefined;
  // kept in the section's own order, each class once: the stored order must not depend on how it was clicked
  const on = FAILURE_CLASSES.filter((failure) => (raw["on"] as unknown[]).includes(failure));
  return { id: raw["id"], action, on };
}

/** The one boundary check: anything a hand-edited file or the webview sends that is not a ladder is refused. */
export function parseLadder(raw: unknown): Ladder | undefined {
  if (!isObject(raw) || !Array.isArray(raw["rungs"])) return undefined;
  if (raw["rungs"].length === 0 || raw["rungs"].length > MAX_RUNGS) return undefined;
  const rungs: Rung[] = [];
  for (const item of raw["rungs"]) {
    const rung = parseRung(item);
    if (rung === undefined || rungs.some((other) => other.id === rung.id)) return undefined;
    rungs.push(rung);
  }
  const version = raw["version"];
  return { ...(typeof version === "number" ? { version } : {}), rungs };
}

/**
 * A stored ladder brought up to the current shape. Version 1 knew four failures; «отклонение» is a fifth, and a
 * rung written then was never offered it. Every rung that already answers «отказ» or «пустой ответ» — the two that
 * mean *this model did not answer you* — gains it, which is exactly what the default table says. A rung that only
 * watched for silence or a broken connection is left alone: those are about the link, not the answer.
 *
 * It runs once. The migrated ladder carries the new version, so an untick after it sticks.
 */
export function migrateLadder(ladder: Ladder): Ladder {
  if (ladder.version === LADDER_VERSION) return ladder;
  return {
    version: LADDER_VERSION,
    rungs: ladder.rungs.map((rung) =>
      rung.on.includes("refusal") || rung.on.includes("empty")
        ? { ...rung, on: FAILURE_CLASSES.filter((failure) => failure === "rejected" || rung.on.includes(failure)) }
        : rung,
    ),
  };
}
