import { emptyAnswer } from "./ladderFailure";

/**
 * The turn OmO killed by itself, read off typed fields alone — never off the words.
 *
 * The person's journal has four of these: a message sent, the turn dead in the same millisecond, no answer, and the
 * tab still saying «Работаю…». Whose abort it is was settled by a live investigation: not ours.
 * An abort that arrives over RPC («Стоп», the model ladder, «Снять зависание») is labelled `"user"` by OmO's own
 * dispatcher, and `heldReason` answers `"user-abort"` before the stall rules are ever reached, so it leaves no row of
 * this kind at all. Only OmO's own three callers pass `"system"`.
 *
 * Two records make the shape, and both are required. The stall row is the only one that names the abort's source; the
 * message is the only one that says the turn produced nothing and never reached the model. A `"system"` abort on its
 * own is not enough: the loop guard and the repetition watcher abort with that same provenance, but only after tool
 * calls or stream deltas — work that must never be repeated.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How long a turn may have lasted and still be one that never reached the model. The person's own four are 0–1 ms
 * (`endedAt − requestedAt`), a live scratch host's is 16 ms, and no provider round trip finishes inside 100 ms — so
 * past this bound a turn may have been answered, and nothing here may repeat it.
 */
export const INSTANT_TURN_MS = 100;

/** OmO's own word for the work the session still has open when it stalls (`openWork` on the stall row). */
export type OpenWork = { kind: string; count?: number };

/**
 * The work left open by a turn OmO itself aborted at once, or undefined for every other way a turn can end.
 *
 * `entry` is a journal entry — the `entry` of an `entry_appended` frame, or a line of the session file, which are the
 * same shape. The three literals are OmO's own: `TURN_END_RULES` reaches the `aborted` rule only for
 * `endedBy ∈ {system-abort, provider-abort, unknown-abort}`, and `abortSourceOf` labels just the first of those
 * `"system"`. `openWork.kind: "none"` is a stall all the same — the `aborted` rule stands above every rule that needs
 * work to be open, and the synthetic `{kind: "stalled"}` wait is minted off `system-abort` alone.
 */
export function systemAbortStall(entry: unknown): OpenWork | undefined {
  if (!isObject(entry) || entry["customType"] !== "turn-end-liveness") return undefined;
  const data = entry["data"];
  if (!isObject(data)) return undefined;
  const verdict = data["verdict"];
  if (!isObject(verdict) || verdict["kind"] !== "stalled" || verdict["reason"] !== "aborted" || verdict["abortSource"] !== "system") return undefined;
  const work = data["openWork"];
  const kind = isObject(work) ? work["kind"] : undefined;
  if (typeof kind !== "string") return { kind: "none" };
  const count = isObject(work) ? work["count"] : undefined;
  return typeof count === "number" ? { kind, count } : { kind };
}

/**
 * Whether this assistant message is the turn that was abandoned as it was being made: aborted, carrying neither prose
 * nor a tool call, and over within `INSTANT_TURN_MS` of the request going out. That is what makes the message safe to
 * send again — the model never saw it — and it is the half of the shape the stall row cannot tell us.
 */
export function instantDeadTurn(value: unknown): boolean {
  if (!isObject(value) || (value["role"] !== undefined && value["role"] !== "assistant")) return false;
  if (value["stopReason"] !== "aborted") return false;
  if (!emptyAnswer(messageTally(value["content"]))) return false;
  const timing = value["timing"];
  if (!isObject(timing)) return false;
  const requestedAt = timing["requestedAt"];
  const endedAt = timing["endedAt"];
  if (typeof requestedAt !== "number" || typeof endedAt !== "number") return false;
  const lasted = endedAt - requestedAt;
  return lasted >= 0 && lasted <= INSTANT_TURN_MS;
}

/** What a message's content parts produced: the same question the ladder asks of a turn, asked of one message. */
function messageTally(content: unknown): { text: boolean; tools: boolean } {
  if (typeof content === "string") return { text: content !== "", tools: false };
  if (!Array.isArray(content)) return { text: false, tools: false };
  const parts = content.filter(isObject);
  return {
    text: parts.some((part) => part["type"] === "text" && typeof part["text"] === "string" && part["text"] !== ""),
    tools: parts.some((part) => part["type"] === "toolCall"),
  };
}

/** The open work in the person's language, or nothing when there is none to name (or OmO has added a kind). */
export function openWorkText(work: OpenWork): string | undefined {
  if (work.kind === "active-goal") return "у сессии осталась незакрытая цель";
  if (work.kind === "open-todos") return work.count === undefined ? "в плане остались незакрытые пункты" : `в плане остались незакрытые пункты: ${work.count}`;
  return undefined;
}
