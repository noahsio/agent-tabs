/**
 * What a provider's stop really was, read off typed and structural fields — never off the words.
 *
 * Both the feed (which draws a quiet line instead of a red banner) and the model ladder (which steps off the model)
 * ask the same questions here, so there is one answer to each and not two.
 *
 * The rule this file exists to keep: **never match on error text.** One Anthropic ban has two wordings in the
 * person's own journal with no shared substring, and the OpenAI rejection below is a third wording again. What
 * separates these shapes is never prose; it is which fields are there.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** An assistant message, as the three end frames and the journal carry it; anything else is nothing to classify. */
function assistantMessage(value: unknown): Json | undefined {
  return isObject(value) && (value["role"] === undefined || value["role"] === "assistant") ? value : undefined;
}

/** How a provider ended a turn without answering, when it said so itself. */
export type ProviderStopKind =
  /** A classifier refused the content: Anthropic's typed marker, or OpenAI's `incomplete.content_filter`. */
  | "refusal"
  /** The provider began a response and ended it with an error having produced nothing. */
  | "rejected";

export type ProviderStop = { kind: ProviderStopKind; detail: string };

/**
 * A classifier refusal the message itself carries: the typed marker OmO's own `isClassifierRefusal` reads first
 * (`stopDetails.type`), the raw provider value beside it, and the OpenAI `incomplete` shape. The OpenAI value is
 * anchored whole: `startsWith("incomplete.")` would swallow `incomplete.max_output_tokens`, which is a length stop
 * and wants compaction, not another model.
 */
export function messageRefusal(value: unknown): boolean {
  const message = assistantMessage(value);
  if (message === undefined || message["stopReason"] !== "error") return false;
  const details = isObject(message["stopDetails"]) ? message["stopDetails"] : undefined;
  return message["rawStopReason"] === "refusal" || details?.["type"] === "refusal" || message["rawStopReason"] === "incomplete.content_filter";
}

/**
 * A provider rejection: the provider **began** a response and then ended it with an error having produced not one
 * token. Measured, not guessed — across the person's 118 journals and all 129 assistant messages with
 * `stopReason: "error"`, 37 have `totalTokens: 0` and no typed diagnostic, and exactly one of those has a
 * `timing.firstTokenAt`: the live `gw-openai` moderation rejection. The other 36 — every «Our servers are currently
 * overloaded», every «An error occurred while processing your request», every idle-stream timeout — never began a
 * response at all, and that is the whole difference between «this model will not answer you» and «this model could
 * not be reached just now».
 *
 * `providerDiagnostic` being present at all disqualifies: it means OmO already typed the failure as a rate limit, a
 * quota, auth, an exceeded context, overload, an invalid request or a network break — every one of which the ladder
 * must leave alone, and none of which carried one in the corpus.
 */
export function messageRejected(value: unknown): boolean {
  const message = assistantMessage(value);
  if (message === undefined || message["stopReason"] !== "error") return false;
  if (messageRefusal(message)) return false; // it already has a class of its own
  if (isObject(message["providerDiagnostic"])) return false; // OmO typed this failure, and never as a rejection
  const detail = asString(message["errorMessage"]);
  if (detail === undefined || detail === "") return false; // nothing to show the person behind «Подробнее»
  const usage = message["usage"];
  if (!isObject(usage) || usage["totalTokens"] !== 0) return false; // it produced output: not a rejection of the request
  const timing = message["timing"];
  return isObject(timing) && typeof timing["firstTokenAt"] === "number"; // …but it had begun one
}

/**
 * A provider transport break, by OmO's own typed verdict: `providerDiagnostic.category === "network"`. That category
 * is the one in its vocabulary meaning the request never reached the provider, and it is disjoint from `rate_limit`,
 * `quota`, `auth`, `context_limit`, `provider_unavailable`, `invalid_request` and `unknown` — none of which may move
 * the ladder. Our own connection to the host never produces one of these at all.
 */
export function messageTransport(value: unknown): boolean {
  const message = assistantMessage(value);
  if (message === undefined || message["stopReason"] !== "error") return false;
  const diagnostic = isObject(message["providerDiagnostic"]) ? message["providerDiagnostic"] : undefined;
  return diagnostic?.["category"] === "network";
}

/**
 * The provider said it would not answer, and what it said. Undefined for every other way a turn can end — a transport
 * break, a rate limit, an exceeded context, an abort — which are the error banner's business, not this line's.
 */
export function providerStop(value: unknown): ProviderStop | undefined {
  const message = assistantMessage(value);
  if (message === undefined) return undefined;
  const details = isObject(message["stopDetails"]) ? message["stopDetails"] : undefined;
  const detail = asString(message["errorMessage"]) ?? asString(details?.["explanation"]) ?? "";
  if (messageRefusal(message)) return { kind: "refusal", detail };
  return messageRejected(message) ? { kind: "rejected", detail } : undefined;
}
