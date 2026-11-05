import { describe, expect, it } from "vitest";
import {
  emptyAnswer,
  endFailure,
  lifecyclePolicyRejection,
  SILENCE_MS,
  tally,
  type TurnTally,
} from "../../src/sessions/ladderFailure";

const EMPTY: TurnTally = { text: false, tools: false };

/** The person's own refusal, live, `claude-opus-4-8` (research doc §2.1, journal line 2463). */
const CYBER = {
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "gw-anthropic",
  model: "claude-opus-4-8",
  stopReason: "error",
  rawStopReason: "refusal",
  errorMessage:
    "This request triggered cyber-related safeguards. To learn about the Cyber Verification Program and apply for access, visit our help center: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.",
  stopDetails: { type: "refusal", explanation: "This request triggered cyber-related safeguards. …" },
  diagnostics: [{ type: "provider_retry_failure", timestamp: 1793823522323, details: { kind: "unknown" } }],
};

/** The second live variant, on a different model, whose wording shares no substring with the first. */
const USAGE_POLICY = {
  role: "assistant",
  stopReason: "error",
  rawStopReason: "refusal",
  content: [],
  errorMessage:
    "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.",
  stopDetails: { type: "refusal", explanation: "This request triggered restrictions on violative cyber content …" },
};

describe("the ladder's four failure classes", () => {
  it("both_live_anthropic_refusal_variants_are_a_refusal", () => {
    for (const message of [CYBER, USAGE_POLICY]) expect(endFailure(message)).toBe("refusal");
  });

  it("a_typed_refusal_without_a_raw_stop_reason_is_still_a_refusal", () => {
    expect(endFailure({ stopReason: "error", stopDetails: { type: "refusal" } })).toBe("refusal");
  });

  it("an_openai_content_filter_is_a_refusal_and_a_length_stop_is_not", () => {
    expect(
      endFailure({ stopReason: "error", rawStopReason: "incomplete.content_filter", errorMessage: "Response incomplete: content_filter" }),
    ).toBe("refusal");
    expect(endFailure({ stopReason: "length", rawStopReason: "incomplete.max_output_tokens" })).toBeUndefined();
    expect(endFailure({ stopReason: "error", rawStopReason: "incomplete" })).toBeUndefined();
  });

  it("a_typed_network_diagnostic_is_a_transport_break", () => {
    expect(
      endFailure({
        stopReason: "error",
        content: [],
        errorMessage: "Connection error.",
        providerDiagnostic: { category: "network", evidence: "structured_transport", code: "ENOTFOUND" },
        diagnostics: [{ type: "provider_retry_failure", details: { kind: "connection" } }],
      }),
    ).toBe("transport");
  });

  it("a_refusal_outranks_a_transport_diagnostic_on_the_same_message", () => {
    expect(endFailure({ ...CYBER, providerDiagnostic: { category: "network" } })).toBe("refusal");
  });

  it("near_misses_are_not_failures", () => {
    const misses: unknown[] = [
      // the soft refusal: prose decline, envelope-identical to a good answer (research §2.2, LIVE)
      { stopReason: "stop", rawStopReason: "end_turn", content: [{ type: "text", text: "я не буду помогать свипать средства" }] },
      { stopReason: "error", content: [] }, // `error` on its own
      { stopReason: "error", content: [] }, // empty content on its own
      { stopReason: "error", content: [], diagnostics: [{ type: "provider_retry_failure", details: { kind: "connection" } }] },
      { stopReason: "error", content: [], errorMessage: "ECONNRESET: The socket connection was closed unexpectedly", willRetry: true },
      { stopReason: "error", providerDiagnostic: { category: "rate_limit", code: "rate_limit_error", httpStatus: 429 } },
      { stopReason: "error", providerDiagnostic: { category: "quota", code: "insufficient_quota", httpStatus: 429 } },
      { stopReason: "error", providerDiagnostic: { category: "provider_unavailable", code: "overloaded_error", httpStatus: 503 } },
      { stopReason: "error", providerDiagnostic: { category: "auth", code: "invalid_api_key", httpStatus: 401 } },
      { stopReason: "error", providerDiagnostic: { category: "context_limit", code: "context_length_exceeded", httpStatus: 400 } },
      { stopReason: "error", providerDiagnostic: { category: "invalid_request" } },
      { stopReason: "error", providerDiagnostic: { category: "unknown" } },
      { stopReason: "error", errorMessage: "Provider stream start timed out after 60000ms" },
      { stopReason: "error", errorMessage: "prompt is too long" },
      { stopReason: "aborted", content: [] },
      // `failure.category: "request_refused"` is an auth failure, a pure name collision (research §3)
      { stopReason: "error", credentialServedRecently: true, providerDiagnostic: { category: "auth" } },
    ];
    for (const message of misses) expect(endFailure(message)).toBeUndefined();
  });

  it("the_live_gpt_moderation_rejection_is_its_own_class", () => {
    // journal, verbatim: tg_channels_manager 2026-11-04T18:51:29Z line 608 — nothing typed on it at all
    expect(
      endFailure({
        role: "assistant",
        content: [{ type: "thinking", thinking: "…" }],
        api: "openai-responses",
        provider: "gw-openai",
        model: "gpt-6-astra",
        usage: { totalTokens: 0 },
        stopReason: "error",
        errorMessage: "This content was flagged for possible cybersecurity risk. …",
        timing: { requestedAt: 1793880159994, firstTokenAt: 1793880178285, lastTokenAt: 1793880178285, endedAt: 1793880180189, generationMs: 1 },
      }),
    ).toBe("rejected");
  });

  it("the_shapes_that_only_look_like_a_rejection_are_still_nothing", () => {
    // all three have totalTokens 0 and words of their own; none of them ever began a response
    const base = { role: "assistant", content: [], stopReason: "error", usage: { totalTokens: 0 } };
    for (const near of [
      { ...base, errorMessage: "Our servers are currently overloaded. Please try again later.", timing: { requestedAt: 1, endedAt: 10_007 } },
      { ...base, errorMessage: "An error occurred while processing your request.", timing: { requestedAt: 1, endedAt: 28_629 } },
      { ...base, errorMessage: "Idle timeout waiting for provider stream after 300000ms", timing: { requestedAt: 1, endedAt: 300_565 } },
    ]) {
      expect(endFailure(near)).toBeUndefined();
    }
  });

  it("a_sensitive_stop_is_left_alone_because_the_specs_table_does_not_list_it", () => {
    expect(endFailure({ stopReason: "error", stopDetails: { type: "sensitive" } })).toBeUndefined();
  });

  it("anything_that_is_not_a_message_is_not_a_failure", () => {
    for (const value of [undefined, null, "refusal", 1, [], { role: "user" }]) expect(endFailure(value)).toBeUndefined();
  });

  it("only_policy_rejection_reads_off_the_lifecycle", () => {
    expect(lifecyclePolicyRejection({ lastTurnEnd: { endedBy: "policy-rejection", budgetSpent: false, deadlineStop: false } })).toBe(true);
    for (const endedBy of ["clean", "user-abort", "system-abort", "provider-abort", "unknown-abort", "provider-error"]) {
      expect(lifecyclePolicyRejection({ lastTurnEnd: { endedBy } })).toBe(false);
    }
    for (const value of [undefined, null, {}, { lastTurnEnd: {} }, { endedBy: "policy-rejection" }]) {
      expect(lifecyclePolicyRejection(value)).toBe(false);
    }
  });

  it("a_turn_with_no_text_and_no_tool_call_is_an_empty_answer", () => {
    expect(emptyAnswer({ text: false, tools: false })).toBe(true);
    expect(emptyAnswer({ text: true, tools: false })).toBe(false);
    expect(emptyAnswer({ text: false, tools: true })).toBe(false);
    expect(emptyAnswer({ text: true, tools: true })).toBe(false);
  });

  it("the_tally_counts_text_and_tool_calls", () => {
    expect(tally(EMPTY, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "а" } })).toEqual({ text: true, tools: false });
    expect(tally(EMPTY, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "t1", name: "bash" } } })).toEqual({
      text: false,
      tools: true,
    });
    expect(tally(EMPTY, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" })).toEqual({ text: false, tools: true });
    expect(
      tally(EMPTY, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "write" }] } }),
    ).toEqual({ text: false, tools: true });
    expect(tally(EMPTY, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "готово" }] } })).toEqual({
      text: true,
      tools: false,
    });
  });

  it("the_tally_ignores_everything_that_is_not_an_answer", () => {
    for (const frame of [
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "…" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } },
      { type: "message_end", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "привет" }] } },
      { type: "session_lifecycle", lifecycle: { state: "running" } },
      { type: "agent_start" },
      "nonsense",
    ]) {
      expect(tally(EMPTY, frame)).toEqual(EMPTY);
    }
  });

  it("the_tally_never_forgets_what_the_turn_already_did", () => {
    const done: TurnTally = { text: true, tools: true };
    expect(tally(done, { type: "agent_settled" })).toEqual(done);
    expect(tally(done, { type: "message_end", message: { role: "assistant", content: [] } })).toEqual(done);
  });

  it("the_silence_threshold_is_five_minutes", () => {
    expect(SILENCE_MS).toBe(300_000);
  });
});
