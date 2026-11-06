import { messageRefusal, messageRejected, messageTransport } from "../chat/providerStop";

/**
 * The five failures that move the model ladder, and only they, read off typed and structural fields alone.
 *
 * The shapes a provider's stop can take live in `src/chat/providerStop.ts`, which the feed reads too, so a refusal
 * and a rejection mean the same thing in the line the person sees and in the step the ladder takes. The one rule
 * both keep: **never match on error text.** The person's own journal holds two Anthropic refusals for the same ban
 * whose wordings share no substring, and the OpenAI rejection is a third wording again.
 *
 * Just as important is what is NOT a failure: a rate limit, a quota, provider overload, a bad key, an exceeded
 * context, our own connection to the host, a `provider_retry_failure` diagnostic (it rides on refusals *and* on DNS
 * failures), `stopReason: "error"` on its own, empty content on its own, any `failure.category`, any abort, and a
 * model declining in prose — which is envelope-identical to a good answer and must be left to the person.
 */

export { messageRefusal, messageRejected, messageTransport };

/** The five failures that move the ladder. */
export type FailureClass = "refusal" | "rejected" | "empty" | "silence" | "transport";

/** What one turn has produced so far: an empty answer, and the refusal to repeat a turn, both read off this. */
export type TurnTally = { text: boolean; tools: boolean };

/** A turn that sent nothing for this long is silent. A constant, by the spec: not a setting until someone asks. */
export const SILENCE_MS = 300_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OmO's own verdict on the turn that just ended, from the `session-lifecycle` entry: zero false positives over 1 257
 * classified turn-ends in the person's corpus, and gated on OmO having given up retrying. It is **sticky** — one
 * refusal re-emits this row 15–20 times — so the caller keys its step to the message being answered and ignores the
 * rest. Every other `endedBy` value, the aborts included, says nothing to the ladder.
 */
export function lifecyclePolicyRejection(lifecycle: unknown): boolean {
  if (!isObject(lifecycle)) return false;
  const end = lifecycle["lastTurnEnd"];
  return isObject(end) && end["endedBy"] === "policy-rejection";
}

/** Who ended a turn, when a frame says it was aborted. OmO lays an abort that arrived over RPC — the person's «Стоп»
 *  among them — at the person's feet as `"user"`; its own liveness, deadline and compaction aborts as `"system"`. */
export type AbortSource = "user" | "system" | "provider" | "unknown";

/**
 * The abort that ended a turn, read off the typed fields of the frame that carries the verdict — never off prose. Three
 * frames can carry it, and the source is pinned down as they arrive: the aborted assistant `message_end` says the turn
 * was aborted but names no source (`"unknown"`); an `agent_end` stamps the source as `abortSource`; the
 * `session_lifecycle` row names the same thing under `lastTurnEnd.endedBy`. An aborted turn is never an empty answer,
 * and a user abort is the person's own decision and no failure of any model — so the ladder reads this to refuse to
 * step. Undefined for a clean end and for every non-abort frame.
 */
export function frameAbort(frame: unknown): AbortSource | undefined {
  if (!isObject(frame)) return undefined;
  if (frame["type"] === "message_end") {
    const message = frame["message"];
    if (isObject(message) && (message["role"] === undefined || message["role"] === "assistant") && message["stopReason"] === "aborted") return "unknown";
    return undefined;
  }
  if (frame["type"] === "agent_end" && frame["aborted"] === true) {
    const source = frame["abortSource"];
    return source === "user" || source === "system" || source === "provider" ? source : "unknown";
  }
  if (frame["type"] === "session_lifecycle") {
    const lifecycle = frame["lifecycle"];
    const end = isObject(lifecycle) ? lifecycle["lastTurnEnd"] : undefined;
    const endedBy = isObject(end) ? end["endedBy"] : undefined;
    if (endedBy === "user-abort") return "user";
    if (endedBy === "system-abort") return "system";
    if (endedBy === "provider-abort") return "provider";
    if (endedBy === "unknown-abort") return "unknown";
  }
  return undefined;
}

/**
 * The class an assistant message names, if any: a classifier refusal first, then a provider rejection, then a
 * transport break. The three cannot overlap — a rejection is defined as having neither of the others' markers.
 */
export function endFailure(message: unknown): FailureClass | undefined {
  if (messageRefusal(message)) return "refusal";
  if (messageRejected(message)) return "rejected";
  if (messageTransport(message)) return "transport";
  return undefined;
}

/** A turn that ended having said nothing and called nothing. */
export function emptyAnswer(tally: TurnTally): boolean {
  return !tally.text && !tally.tools;
}

/** Whether a message's content parts carry prose, and whether they carry a tool call. */
function contentTally(content: unknown): TurnTally {
  if (typeof content === "string") return { text: content !== "", tools: false };
  if (!Array.isArray(content)) return { text: false, tools: false };
  const typed = content.filter(isObject);
  return {
    text: typed.some((part) => part["type"] === "text" && typeof part["text"] === "string" && part["text"] !== ""),
    tools: typed.some((part) => part["type"] === "toolCall"),
  };
}

/**
 * What one frame adds to the turn's tally. Thinking is not an answer (a turn that only thought and died answered
 * nothing), and a tool *execution* counts as much as the call that asked for it: either way the turn did something,
 * and a turn that did something is never repeated.
 */
export function tally(previous: TurnTally, frame: unknown): TurnTally {
  if (!isObject(frame)) return previous;
  const added = (part: TurnTally): TurnTally =>
    part.text === previous.text && part.tools === previous.tools ? previous : { text: previous.text || part.text, tools: previous.tools || part.tools };
  switch (frame["type"]) {
    case "message_update": {
      const event = frame["assistantMessageEvent"];
      if (!isObject(event)) return previous;
      if (event["type"] === "toolcall_end") return added({ text: false, tools: true });
      const delta = event["delta"];
      return event["type"] === "text_delta" && typeof delta === "string" && delta !== "" ? added({ text: true, tools: false }) : previous;
    }
    case "tool_execution_start":
      return added({ text: false, tools: true });
    case "message_end": {
      const message = frame["message"];
      if (!isObject(message) || message["role"] !== "assistant") return previous;
      return added(contentTally(message["content"]));
    }
    default:
      return previous;
  }
}
