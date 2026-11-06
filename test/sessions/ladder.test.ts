import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRef } from "../../src/chat/model";
import type { OutgoingImage } from "../../src/sessions/controller";
import { ABORT_WAIT_MS, ModelLadder, type LadderModel, type LadderSession, type LadderView } from "../../src/sessions/ladder";
import { SILENCE_MS } from "../../src/sessions/ladderFailure";
import type { Ladder } from "../../src/settings/ladder";
import { DEFAULT_LADDER } from "../../src/settings/ladderDefault";

const OPUS_5_5 = { provider: "gw-anthropic", id: "claude-opus-5-5" };
const OPUS_5 = { provider: "gw-anthropic", id: "claude-opus-5" };
const OPUS_4_8 = { provider: "gw-anthropic", id: "claude-opus-4-8" };
const GPT = { provider: "gw-openai", id: "gpt-6.1-sol" };

const SERVED: LadderModel[] = [
  { ...OPUS_5_5, name: "Opus 5.5" },
  { ...OPUS_5, name: "Opus 5" },
  { ...OPUS_4_8, name: "Opus 4.8" },
  { ...GPT, name: "GPT 6.1 Sol" },
];

/** Everything the walk is allowed to do to a session, recorded in the order it did it. */
class FakeSession implements LadderSession {
  config: Ladder = DEFAULT_LADDER;
  served: LadderModel[] = SERVED;
  current: ModelRef | undefined = OPUS_5_5;
  isRunning = false;
  /** False: OmO answers the abort but still calls the turn running, so the walk must unwedge. */
  stopsOnAbort = true;
  sendOk = true;
  readonly calls: string[] = [];
  readonly switched: ModelRef[] = [];
  readonly sent: { id: string; text: string; images: OutgoingImage[] }[] = [];
  readonly notes: { level: "info" | "warn"; text: string }[] = [];
  readonly views: (LadderView | undefined)[] = [];

  ladder(): Ladder {
    return this.config;
  }
  async models(): Promise<LadderModel[]> {
    this.calls.push("models");
    return this.served;
  }
  model(): ModelRef | undefined {
    return this.current;
  }
  running(): boolean {
    return this.isRunning;
  }
  readonly abortReasons: string[] = [];
  async abort(reason: string): Promise<void> {
    this.calls.push("abort");
    this.abortReasons.push(reason);
    if (this.stopsOnAbort) this.isRunning = false;
  }
  async unwedge(): Promise<void> {
    this.calls.push("unwedge");
    this.isRunning = false;
  }
  async setModel(model: ModelRef): Promise<void> {
    this.calls.push("setModel");
    this.switched.push(model);
    this.current = model;
  }
  async send(id: string, text: string, images: OutgoingImage[]): Promise<boolean> {
    this.calls.push("send");
    if (!this.sendOk) return false;
    this.sent.push({ id, text, images });
    return true;
  }
  note(level: "info" | "warn", text: string): void {
    this.notes.push({ level, text });
  }
  view(view: LadderView | undefined): void {
    this.views.push(view);
  }

  get lastNote(): string | undefined {
    return this.notes.at(-1)?.text;
  }
  get noteTexts(): string[] {
    return this.notes.map((note) => note.text);
  }
}

let session: FakeSession;
let ladder: ModelLadder;

const userStart = (id: string): Record<string, unknown> => ({
  type: "message_start",
  message: { role: "user", clientMessageId: id, content: [{ type: "text", text: "привет" }] },
});
const refusalEnd = (): Record<string, unknown> => ({
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "error", rawStopReason: "refusal", stopDetails: { type: "refusal", explanation: "…" } },
});
const transportEnd = (): Record<string, unknown> => ({
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "error", providerDiagnostic: { category: "network", code: "ENOTFOUND" } },
});
/** The live `gw-openai` moderation rejection: nothing typed, a response begun and not one token produced. */
const rejectionEnd = (): Record<string, unknown> => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "…" }],
    provider: "gw-openai",
    model: "gpt-6-astra",
    usage: { totalTokens: 0 },
    stopReason: "error",
    errorMessage: "This content was flagged for possible cybersecurity risk. …",
    timing: { requestedAt: 1, firstTokenAt: 18_291, lastTokenAt: 18_291, endedAt: 20_195, generationMs: 1 },
  },
});
const overloadEnd = (): Record<string, unknown> => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    provider: "gw-openai",
    usage: { totalTokens: 0 },
    stopReason: "error",
    errorMessage: "Our servers are currently overloaded. Please try again later.",
    timing: { requestedAt: 1, endedAt: 10_007 },
  },
});
const goodEnd = (): Record<string, unknown> => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "готово" }] },
});
const toolCall = (name: string): Record<string, unknown> => ({
  type: "message_update",
  assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "t1", name, arguments: {} } },
});
const policyRejection = (): Record<string, unknown> => ({
  type: "session_lifecycle",
  lifecycle: { state: "done", lastTurnEnd: { endedBy: "policy-rejection", budgetSpent: false, deadlineStop: false } },
});

/** Lets every await inside a step run, without crossing the abort or silence deadlines. */
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(5).then(() => undefined);

/** The person's message reaching the conversation, and the turn for it starting. */
function begin(id = "m1", text = "привет"): void {
  ladder.armed(id, text, []);
  ladder.observe(userStart(id));
  session.isRunning = true;
  ladder.observe({ type: "agent_start" });
}

/** The turn for whatever the ladder is watching starts and ends having answered nothing at all. */
async function emptyTurn(): Promise<void> {
  session.isRunning = true;
  ladder.observe({ type: "agent_start" });
  session.isRunning = false;
  ladder.observe({ type: "agent_settled" });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  session = new FakeSession();
  ladder = new ModelLadder(session);
});

afterEach(() => {
  ladder.dispose();
  vi.useRealTimers();
});

describe("the ladder's walk", () => {
  it("a_refusal_jumps_to_the_rung_that_answers_it_and_sends_its_continuation", async () => {
    begin();
    ladder.observe(refusalEnd());
    await flush();
    expect(session.switched).toEqual([GPT]);
    // the default's fourth rung is GPT 6.1 Sol + «продолжай»: it switches the model and continues, not replays
    expect(session.sent.map((item) => item.text)).toEqual(["продолжай"]);
    expect(session.lastNote).toBe("Модель отказалась — перешёл на GPT 6.1 Sol и отправил «продолжай»");
    expect(session.views.at(-1)).toEqual({ state: "walking", rung: 4, total: 5, label: "GPT 6.1 Sol" });
  });

  it("an_empty_answer_takes_the_very_next_rung", async () => {
    begin();
    await emptyTurn();
    expect(session.switched).toEqual([OPUS_5]);
    expect(session.sent.map((item) => item.text)).toEqual(["продолжай"]);
    expect(session.lastNote).toBe("Модель ответила пусто — перешёл на Opus 5 и отправил «продолжай»");
    expect(session.views.at(-1)).toEqual({ state: "walking", rung: 2, total: 5, label: "Opus 5" });
  });

  /**
   * A turn OmO killed by itself answered nothing, so `emptyAnswer` is true of it — but it is no failure of any model,
   * and the controller is the one that puts the message back (and arms this ladder on its resend). Stepping here would
   * switch the model and send a second copy of the message behind the recovery's own.
   */
  it("a_turn_omo_killed_by_itself_moves_nothing", async () => {
    begin();
    session.isRunning = false;
    ladder.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "aborted",
        errorMessage: "The operation was aborted.",
        timing: { requestedAt: 1793896968351, endedAt: 1793896968367 },
      },
    });
    ladder.observe({ type: "agent_settled" });
    await flush();

    expect(session.switched).toEqual([]);
    expect(session.sent).toEqual([]);
    expect(session.calls).toEqual([]);
    expect(session.noteTexts).toEqual([]);
    expect(session.views.at(-1)).toBeUndefined();
  });

  it("a_provider_rejection_descends_the_ladder_one_rung_at_a_time", async () => {
    begin();
    ladder.observe(rejectionEnd());
    await flush();
    // unlike a classifier refusal, a rejection is no evidence about the next model: it does not skip the Anthropic steps
    expect(session.switched).toEqual([OPUS_5]);
    expect(session.sent.map((item) => item.text)).toEqual(["продолжай"]);
    expect(session.lastNote).toBe("Провайдер отклонил запрос — перешёл на Opus 5 и отправил «продолжай»");
    expect(session.views.at(-1)).toEqual({ state: "walking", rung: 2, total: 5, label: "Opus 5" });
  });

  it("a_provider_that_never_began_a_response_moves_nothing", async () => {
    begin();
    ladder.observe(overloadEnd());
    await flush();
    expect(session.calls).toEqual([]);
    expect(session.notes).toEqual([]);
    expect(session.views).toEqual([]);
  });

  it("a_pure_model_replay_rung_still_stops_after_the_turn_ran_a_tool", async () => {
    // a bare model switch repeats the person's own message, which a turn that ran a tool must not do again
    session.config = {
      rungs: [DEFAULT_LADDER.rungs[0] as never, { id: "replay", action: { kind: "model", provider: GPT.provider, id: GPT.id }, on: ["rejected"] }],
    };
    begin("m1", "почини сборку");
    ladder.observe(toolCall("bash"));
    ladder.observe(rejectionEnd());
    await flush();
    expect(session.sent).toEqual([]);
    expect(session.switched).toEqual([]);
    expect(session.calls.filter((call) => call !== "models")).toEqual([]); // nothing was aborted, switched or sent
    expect(session.lastNote).toBe("Провайдер отклонил запрос, но ход уже выполнил действия — не повторяю, решите сами");
    expect(session.notes.at(-1)?.level).toBe("warn");
  });

  it("a_provider_transport_break_takes_the_very_next_rung", async () => {
    begin();
    ladder.observe(transportEnd());
    await flush();
    expect(session.switched).toEqual([OPUS_5]);
    expect(session.lastNote).toBe("Связь с моделью оборвалась — перешёл на Opus 5 и отправил «продолжай»");
  });

  it("the_repeat_goes_out_under_a_new_id_so_omo_cannot_answer_it_from_its_record", async () => {
    begin("m1", "разбери кошельки");
    ladder.observe(refusalEnd());
    await flush();
    expect(session.sent).toHaveLength(1);
    // the fourth rung is a continuation, so what goes out is its phrase — under a fresh id, not the person's own
    expect(session.sent[0]?.text).toBe("продолжай");
    expect(session.sent[0]?.id).not.toBe("m1");
  });

  it("a_sticky_policy_rejection_steps_once", async () => {
    begin();
    ladder.observe(refusalEnd());
    session.isRunning = false;
    for (let at = 0; at < 20; at++) ladder.observe(policyRejection());
    await flush();
    for (let at = 0; at < 20; at++) ladder.observe(policyRejection());
    await flush();
    expect(session.switched).toEqual([GPT]);
    expect(session.sent).toHaveLength(1);
  });

  it("a_policy_rejection_alone_steps_once_even_without_a_message_end", async () => {
    begin();
    session.isRunning = false;
    for (let at = 0; at < 15; at++) ladder.observe(policyRejection());
    await flush();
    expect(session.switched).toEqual([GPT]);
    expect(session.notes.filter((note) => note.text.includes("Модель отказалась"))).toHaveLength(1);
  });

  it("a_rung_fires_at_most_once_per_message", async () => {
    begin();
    await emptyTurn(); // rung 2
    await emptyTurn(); // rung 3 — never rung 2 again
    await emptyTurn(); // rung 4
    await emptyTurn(); // rung 5 is «остановиться и спросить»
    expect(session.switched).toEqual([OPUS_5, OPUS_4_8, GPT]);
    expect(session.lastNote).toBe("Модель ответила пусто — дальше решайте сами");
    expect(session.views.at(-1)).toBeUndefined();
  });

  it("an_unknown_model_rung_is_skipped_with_a_line_in_the_feed", async () => {
    session.served = SERVED.filter((model) => model.id !== OPUS_5.id); // this environment does not serve rung 2
    begin();
    await emptyTurn();
    expect(session.noteTexts).toContain("Ступенька 2 пропущена: claude-opus-5 нет в этой среде");
    expect(session.switched).toEqual([OPUS_4_8]);
  });

  it("a_skipped_rung_is_not_offered_again", async () => {
    session.served = SERVED.filter((model) => model.id !== OPUS_5.id);
    begin();
    await emptyTurn();
    await emptyTurn();
    expect(session.noteTexts.filter((text) => text.includes("Ступенька 2 пропущена"))).toHaveLength(1);
    expect(session.switched).toEqual([OPUS_4_8, GPT]);
  });

  it("the_last_rung_stops_with_one_honest_line", async () => {
    session.config = { rungs: DEFAULT_LADDER.rungs.slice(0, 3) }; // no «остановиться и спросить» rung at all
    begin();
    await emptyTurn();
    await emptyTurn();
    await emptyTurn();
    expect(session.switched).toEqual([OPUS_5, OPUS_4_8]);
    expect(session.lastNote).toBe("Дальше некуда: перепробовал 3 модели");
    expect(session.views.at(-1)).toBeUndefined();
  });

  it("the_honest_line_counts_in_russian", async () => {
    session.config = { rungs: [DEFAULT_LADDER.rungs[0] as never, DEFAULT_LADDER.rungs[1] as never] };
    begin();
    await emptyTurn();
    await emptyTurn();
    expect(session.lastNote).toBe("Дальше некуда: перепробовал 2 модели");
  });

  it("a_step_aborts_the_turn_before_it_switches_or_repeats", async () => {
    begin();
    ladder.observe(refusalEnd());
    await flush();
    const order = session.calls.filter((call) => call !== "models");
    expect(order).toEqual(["abort", "setModel", "send"]);
    // the abort carries why it is happening: OmO cannot tell our abort from the person's, so only our own log can
    expect(session.abortReasons).toEqual(["Модель отказалась, ступенька 4 (GPT 6.1 Sol)"]);
  });

  it("a_step_unwedges_when_the_abort_does_not_take", async () => {
    session.stopsOnAbort = false;
    begin();
    ladder.observe(refusalEnd());
    await vi.advanceTimersByTimeAsync(ABORT_WAIT_MS + 500);
    expect(session.calls.filter((call) => call !== "models")).toEqual(["abort", "unwedge", "setModel", "send"]);
  });

  it("a_text_rung_fires_after_the_turn_ran_a_tool_and_never_replays_the_original", async () => {
    // the live case: a model refused after a read-only Eval. A pure replay would be blocked, but the default's GPT
    // rung carries «продолжай» — a continuation re-runs nothing, so it fires, switches the model and carries on.
    begin("m1", "почини сборку");
    ladder.observe(toolCall("read"));
    ladder.observe(refusalEnd());
    await flush();
    expect(session.switched).toEqual([GPT]);
    expect(session.sent.map((item) => item.text)).toEqual(["продолжай"]);
    expect(session.sent.some((item) => item.text === "почини сборку")).toBe(false); // the original is never replayed
    expect(session.lastNote).toBe("Модель отказалась — перешёл на GPT 6.1 Sol и отправил «продолжай»");
  });

  it("a_text_rung_fires_after_a_tool_execution_too", async () => {
    begin();
    ladder.observe({ type: "tool_execution_start", toolCallId: "t1", toolName: "write" });
    ladder.observe(transportEnd());
    await flush();
    expect(session.switched).toEqual([OPUS_5]);
    expect(session.sent.map((item) => item.text)).toEqual(["продолжай"]);
    expect(session.lastNote).toBe("Связь с моделью оборвалась — перешёл на Opus 5 и отправил «продолжай»");
  });

  it("a_combined_rung_switches_model_and_sends_text_in_one_step", async () => {
    session.config = {
      rungs: [
        DEFAULT_LADDER.rungs[0] as never,
        { id: "combo", action: { kind: "model", provider: GPT.provider, id: GPT.id, text: "продолжай" }, on: ["empty"] },
        { id: "ask", action: { kind: "ask" }, on: ["empty"] },
      ],
    };
    begin();
    await emptyTurn();
    expect(session.switched).toEqual([GPT]);
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.text).toBe("продолжай");
    expect(session.sent[0]?.images).toEqual([]);
    expect(session.lastNote).toBe("Модель ответила пусто — перешёл на GPT 6.1 Sol и отправил «продолжай»");
    expect(session.views.at(-1)).toEqual({ state: "walking", rung: 2, total: 3, label: "GPT 6.1 Sol" });
  });

  it("a_sticky_failure_does_not_fire_a_text_rung_twice", async () => {
    // after a tool call the GPT continuation fires once; the sticky policy-rejection rows that follow must not re-fire it
    begin("m1", "почини сборку");
    ladder.observe(toolCall("read"));
    ladder.observe(refusalEnd());
    session.isRunning = false;
    for (let at = 0; at < 20; at++) ladder.observe(policyRejection());
    await flush();
    for (let at = 0; at < 20; at++) ladder.observe(policyRejection());
    await flush();
    expect(session.switched).toEqual([GPT]);
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.text).toBe("продолжай");
  });

  it("a_turn_that_only_ran_a_tool_is_no_failure_at_all", async () => {
    begin();
    ladder.observe({ type: "tool_execution_start", toolCallId: "t1", toolName: "write" });
    session.isRunning = false;
    ladder.observe({ type: "agent_settled" });
    await flush();
    expect(session.notes).toEqual([]);
    expect(session.calls).toEqual([]);
  });

  it("a_message_steered_into_a_running_turn_is_never_replayed_but_a_continuation_still_fires", async () => {
    session.isRunning = true; // the person wrote while the agent was working: the message joined that turn
    ladder.armed("m1", "и ещё", []);
    ladder.observe(userStart("m1"));
    ladder.observe(refusalEnd());
    await flush();
    // the joined-in message is never replayed, but the default's GPT rung carries «продолжай», which re-runs nothing
    expect(session.sent.some((item) => item.text === "и ещё")).toBe(false);
    expect(session.switched).toEqual([GPT]);
    expect(session.sent.map((item) => item.text)).toEqual(["продолжай"]);
  });

  it("a_pure_model_rung_never_repeats_a_message_steered_into_a_running_turn", async () => {
    session.config = {
      rungs: [DEFAULT_LADDER.rungs[0] as never, { id: "replay", action: { kind: "model", provider: GPT.provider, id: GPT.id }, on: ["refusal"] }],
    };
    session.isRunning = true;
    ladder.armed("m1", "и ещё", []);
    ladder.observe(userStart("m1"));
    ladder.observe(refusalEnd());
    await flush();
    expect(session.sent).toEqual([]);
    expect(session.switched).toEqual([]);
    expect(session.lastNote).toContain("ход уже выполнил действия");
  });

  it("a_message_queued_behind_a_turn_is_rescued_once_its_own_turn_starts", async () => {
    session.isRunning = true;
    ladder.armed("m1", "и ещё", []);
    ladder.observe(userStart("m1"));
    await emptyTurn(); // its own turn: agent_start wipes what the previous turn did
    expect(session.switched).toEqual([OPUS_5]);
    expect(session.sent.map((item) => item.text)).toEqual(["продолжай"]);
  });

  it("five_minutes_without_a_frame_is_a_silence_and_any_frame_resets_the_clock", async () => {
    begin();
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000);
    ladder.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "…" } });
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000);
    expect(session.switched).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.lastNote).toBe("От модели не было ответа 5 минут — перешёл на Opus 5 и отправил «продолжай»");
  });

  it("an_idle_session_is_never_called_silent", async () => {
    begin();
    session.isRunning = false;
    ladder.observe(goodEnd());
    ladder.observe({ type: "agent_settled" });
    await vi.advanceTimersByTimeAsync(SILENCE_MS * 2);
    expect(session.switched).toEqual([]);
  });

  it("nothing_fires_for_a_turn_the_person_did_not_start", async () => {
    session.isRunning = true;
    ladder.observe({ type: "agent_start" });
    ladder.observe(toolCall("task"));
    ladder.observe(refusalEnd());
    for (let at = 0; at < 5; at++) ladder.observe(policyRejection());
    await vi.advanceTimersByTimeAsync(SILENCE_MS * 2);
    expect(session.calls).toEqual([]);
    expect(session.notes).toEqual([]);
    expect(session.views).toEqual([]);
  });

  it("a_message_that_never_reached_the_conversation_is_not_watched", async () => {
    ladder.armed("m1", "привет", []); // no message_start for it: it was refused, or a command ate it
    session.isRunning = true;
    ladder.observe({ type: "agent_start" });
    ladder.observe(refusalEnd());
    await flush();
    expect(session.calls).toEqual([]);
  });

  it("interrupting_while_the_model_is_being_switched_still_repeats_nothing", async () => {
    session.config = {
      rungs: [DEFAULT_LADDER.rungs[0] as never, { id: "nudge", action: { kind: "text", text: "продолжи" }, on: ["refusal"] }],
    };
    begin();
    ladder.observe(refusalEnd());
    await flush();
    expect(session.sent.map((item) => item.text)).toEqual(["продолжи"]);
    session.sent.length = 0;
    // and once interrupted mid-step, the same ladder sends nothing more
    ladder.interrupt();
    ladder.observe(refusalEnd());
    await flush();
    expect(session.sent).toEqual([]);
  });

  it("interrupting_leaves_the_session_where_it_is_and_repeats_nothing", async () => {
    session.stopsOnAbort = false;
    begin();
    ladder.observe(refusalEnd());
    ladder.interrupt();
    await vi.advanceTimersByTimeAsync(ABORT_WAIT_MS + 500);
    expect(session.sent).toEqual([]);
    expect(session.switched).toEqual([]);
    expect(session.views.at(-1)).toBeUndefined();
  });

  it("a_rescued_message_leaves_the_line_offering_the_first_model_back", async () => {
    begin();
    await emptyTurn();
    session.isRunning = true;
    ladder.observe({ type: "agent_start" });
    ladder.observe(goodEnd());
    session.isRunning = false;
    ladder.observe({ type: "agent_settled" });
    await flush();
    expect(session.views.at(-1)).toEqual({
      state: "settled",
      model: "Opus 5",
      back: { provider: "gw-anthropic", id: "claude-opus-5-5", label: "Opus 5.5" },
    });
  });

  it("a_message_answered_without_a_walk_leaves_no_line_at_all", async () => {
    begin();
    ladder.observe(goodEnd());
    session.isRunning = false;
    ladder.observe({ type: "agent_settled" });
    await flush();
    expect(session.views).toEqual([]);
  });

  it("the_next_message_clears_the_line_the_last_walk_left", async () => {
    begin();
    await emptyTurn();
    session.isRunning = true;
    ladder.observe({ type: "agent_start" });
    ladder.observe(goodEnd());
    session.isRunning = false;
    ladder.observe({ type: "agent_settled" });
    ladder.armed("m2", "дальше", []);
    await flush(); // the settled line's own model lookup must not land after the next message
    expect(session.views.at(-1)).toBeUndefined();
  });

  it("a_text_rung_sends_the_persons_own_phrase", async () => {
    session.config = {
      rungs: [
        DEFAULT_LADDER.rungs[0] as never,
        { id: "nudge", action: { kind: "text", text: "продолжи" }, on: ["silence", "empty"] },
        { id: "ask", action: { kind: "ask" }, on: ["refusal", "empty", "silence", "transport"] },
      ],
    };
    begin();
    await emptyTurn();
    expect(session.switched).toEqual([]);
    expect(session.sent.map((item) => item.text)).toEqual(["продолжи"]);
    expect(session.lastNote).toBe("Модель ответила пусто — отправил «продолжи»");
  });

  it("a_repeat_that_does_not_go_out_says_so_and_stops", async () => {
    session.sendOk = false;
    begin();
    ladder.observe(refusalEnd());
    await flush();
    expect(session.lastNote).toBe("Модель отказалась — не удалось повторить сообщение");
    expect(session.views.at(-1)).toBeUndefined();
  });

  it("a_ladder_whose_rungs_answer_nothing_stops_at_once", async () => {
    session.config = { rungs: [DEFAULT_LADDER.rungs[0] as never, { id: "b", action: { kind: "ask" }, on: [] }] };
    begin();
    await emptyTurn();
    expect(session.switched).toEqual([]);
    expect(session.lastNote).toBe("Дальше некуда: перепробовал 1 модель");
  });

  it("a_session_on_a_model_outside_the_ladder_starts_from_the_top", async () => {
    session.current = { provider: "gw-q", id: "dsv41-flash-uncensored" };
    begin();
    await emptyTurn();
    expect(session.switched).toEqual([OPUS_5]);
  });

  /**
   * The invariant the person's day depends on: the ladder sends an abort only for a turn it has itself just
   * classified as failed. OmO labels an abort that arrives over RPC `user`, exactly as it labels the person's own
   * «Стоп», so a stray one is indistinguishable from them pressing stop — it would simply look like the agent dying.
   */
  describe("a freshly started turn survives every stale state a previous message can leave", () => {
    /** Walks m1 to a step, so there is a used rung, a rescuer, a position on the ladder and a step in flight. */
    async function walkThenNewMessage(): Promise<void> {
      begin("m1", "первое");
      await emptyTurn(); // steps to rung 2 and resends
      session.calls.length = 0;
      session.abortReasons.length = 0;
      session.switched.length = 0;
      session.sent.length = 0;
      session.notes.length = 0;
      session.views.length = 0;
    }

    it("a_new_message_after_a_walk_is_not_aborted_when_its_turn_starts", async () => {
      await walkThenNewMessage();
      begin("m2", "второе");
      ladder.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "отвечаю" } });
      await flush();
      expect(session.calls).toEqual([]);
      expect(session.abortReasons).toEqual([]);
    });

    it("the_silence_clock_of_an_older_message_never_fires_on_a_new_one", async () => {
      begin("m1", "первое");
      await vi.advanceTimersByTimeAsync(SILENCE_MS - 2_000); // nearly silent
      begin("m2", "второе"); // the person sent something else first
      await vi.advanceTimersByTimeAsync(3_000); // past the OLD deadline, nowhere near the new one
      expect(session.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(SILENCE_MS - 4_000);
      expect(session.calls).toEqual([]); // still the new message's own clock, not the old one's
    });

    it("a_step_in_flight_is_abandoned_when_the_person_sends_something_new", async () => {
      session.stopsOnAbort = false; // the step is stuck waiting out the abort
      begin("m1", "первое");
      ladder.observe(refusalEnd());
      ladder.armed("m2", "второе", []); // the person did not wait
      await vi.advanceTimersByTimeAsync(ABORT_WAIT_MS + 500);
      expect(session.switched).toEqual([]); // the stranded step never switches
      expect(session.sent).toEqual([]); // and never repeats
    });

    it("a_turn_that_only_the_old_walk_would_have_called_failed_is_left_alone", async () => {
      await walkThenNewMessage();
      // the frames of the OLD turn arriving late, after the person moved on
      ladder.armed("m2", "второе", []);
      ladder.observe(refusalEnd()); // m2 has not reached the conversation yet: nothing is watched
      await flush();
      expect(session.calls).toEqual([]);
    });
  });

  it("the_walk_stops_when_the_tab_goes_away", async () => {
    begin();
    ladder.dispose();
    await vi.advanceTimersByTimeAsync(SILENCE_MS * 2);
    expect(session.calls).toEqual([]);
  });
});
