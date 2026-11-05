import { describe, expect, it } from "vitest";
import { messageRefusal, messageRejected, messageTransport, providerStop } from "../../src/chat/providerStop";

/**
 * The live OpenAI moderation rejection, verbatim from the person's journal — `tg_channels_manager`,
 * `2026-11-04T18-51-29-297Z_01a1a7e6-e491-7bd2-ae28-a814280ae250.jsonl` line 608. Nothing typed on it at all: no
 * `rawStopReason`, no `stopDetails`, no `providerDiagnostic`. The provider began a response (there is a
 * `firstTokenAt`, and a thinking block) and ended it with an error having produced not one token.
 */
const GPT_REJECTION = {
  role: "assistant",
  content: [{ type: "thinking", thinking: "…" }],
  api: "openai-responses",
  provider: "gw-openai",
  model: "gpt-6-astra",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  stopReason: "error",
  responseId: "resp_0e07ae5c0acc0aa3016aec7063543487d2b4fd885314af0962",
  errorMessage:
    "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.",
  thinkingLevel: "xhigh",
  timing: { requestedAt: 1793880159994, firstTokenAt: 1793880178285, lastTokenAt: 1793880178285, endedAt: 1793880180189, generationMs: 1 },
};

/** The same gateway, same model, the shape that is NOT a rejection: no response ever began. Journal, verbatim. */
const OPENAI_5XX = {
  role: "assistant",
  content: [],
  api: "openai-responses",
  provider: "gw-openai",
  model: "gpt-6-astra",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  stopReason: "error",
  responseId: "resp_094e14c0bfc85f35016ae9c73635c88195bb4de5c2d4742d6c",
  errorMessage:
    "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 632a90e1-6b6b-47bb-9ae4-21cef02d678f in your message.",
  thinkingLevel: "xhigh",
  timing: { requestedAt: 1793705776544, endedAt: 1793705805173 },
};

const OVERLOADED = { ...OPENAI_5XX, errorMessage: "Our servers are currently overloaded. Please try again later.", timing: { requestedAt: 1, endedAt: 10_007 } };
const STALL = { ...OPENAI_5XX, errorMessage: "Idle timeout waiting for provider stream after 300000ms", timing: { requestedAt: 1, endedAt: 300_565 } };

/** The person's Anthropic classifier refusal, which already had a class and must keep it. */
const ANTHROPIC_REFUSAL = {
  role: "assistant",
  content: [],
  stopReason: "error",
  rawStopReason: "refusal",
  errorMessage: "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.",
  stopDetails: { type: "refusal", explanation: "This request triggered restrictions on violative cyber content …" },
};

describe("what a provider's stop really was", () => {
  it("the_live_gpt_moderation_rejection_is_a_rejection", () => {
    expect(messageRejected(GPT_REJECTION)).toBe(true);
    expect(messageRefusal(GPT_REJECTION)).toBe(false); // nothing typed on it: the old detector cannot see it
    expect(messageTransport(GPT_REJECTION)).toBe(false);
    expect(providerStop(GPT_REJECTION)).toEqual({ kind: "rejected", detail: GPT_REJECTION.errorMessage });
  });

  it("a_provider_that_never_began_a_response_is_not_a_rejection", () => {
    // every one of these has totalTokens 0 and an errorMessage too; the whole difference is that nothing started
    for (const message of [OPENAI_5XX, OVERLOADED, STALL]) {
      expect(messageRejected(message)).toBe(false);
      expect(providerStop(message)).toBeUndefined();
    }
  });

  it("a_classifier_refusal_stays_a_refusal_and_never_becomes_a_rejection", () => {
    expect(messageRefusal(ANTHROPIC_REFUSAL)).toBe(true);
    expect(messageRejected(ANTHROPIC_REFUSAL)).toBe(false);
    expect(providerStop(ANTHROPIC_REFUSAL)).toEqual({ kind: "refusal", detail: ANTHROPIC_REFUSAL.errorMessage });
  });

  it("a_refusal_with_no_words_still_has_its_class_and_an_empty_detail", () => {
    expect(providerStop({ stopReason: "error", stopDetails: { type: "refusal" } })).toEqual({ kind: "refusal", detail: "" });
  });

  it("anything_omo_typed_itself_is_never_a_rejection", () => {
    // all 21 invalid_request entries in the corpus are «Requested token count exceeds the model's maximum»
    const typed = ["network", "rate_limit", "quota", "auth", "context_limit", "provider_unavailable", "invalid_request", "unknown"];
    for (const category of typed) {
      const message = { ...GPT_REJECTION, providerDiagnostic: { category, code: "x" } };
      expect(messageRejected(message)).toBe(false);
      expect(providerStop(message)).toBeUndefined();
    }
  });

  it("a_provider_that_produced_output_is_not_a_rejection", () => {
    // the uncensored gateway's mid-stream parse failures: tens of thousands of tokens already streamed
    const streamed = {
      ...GPT_REJECTION,
      usage: { totalTokens: 53_134 },
      errorMessage: "Could not parse Anthropic SSE event content_block_delta: JSON Parse error: Unexpected EOF",
      timing: { requestedAt: 1, firstTokenAt: 2, lastTokenAt: 2_785, endedAt: 2_786, generationMs: 2_784 },
    };
    expect(messageRejected(streamed)).toBe(false);
  });

  it("a_rejection_needs_words_to_show_the_person", () => {
    expect(messageRejected({ ...GPT_REJECTION, errorMessage: "" })).toBe(false);
    const { errorMessage: _none, ...wordless } = GPT_REJECTION;
    expect(messageRejected(wordless)).toBe(false);
  });

  it("a_turn_that_did_not_error_is_never_a_rejection", () => {
    for (const stopReason of ["stop", "length", "toolUse", "aborted"]) {
      expect(messageRejected({ ...GPT_REJECTION, stopReason })).toBe(false);
    }
  });

  it("a_missing_usage_or_timing_is_not_guessed_at", () => {
    const { usage: _u, ...noUsage } = GPT_REJECTION;
    const { timing: _t, ...noTiming } = GPT_REJECTION;
    expect(messageRejected(noUsage)).toBe(false);
    expect(messageRejected(noTiming)).toBe(false);
    expect(messageRejected({ ...GPT_REJECTION, timing: { requestedAt: 1, firstTokenAt: "soon" } })).toBe(false);
  });

  it("nothing_that_is_not_an_assistant_message_is_classified", () => {
    for (const value of [undefined, null, "error", 7, [], { ...GPT_REJECTION, role: "user" }, { ...GPT_REJECTION, role: "toolResult" }]) {
      expect(messageRejected(value)).toBe(false);
      expect(providerStop(value)).toBeUndefined();
    }
  });

  it("the_detector_never_reads_the_words", () => {
    // the same shape with any wording at all is still a rejection: two Anthropic bans share no substring
    for (const errorMessage of ["нечто совсем другое", "x", "Daybreak access", "{}"]) {
      expect(messageRejected({ ...GPT_REJECTION, errorMessage })).toBe(true);
    }
  });
});
