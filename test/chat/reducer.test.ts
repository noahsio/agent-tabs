import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { addOutgoing, applyEntries, applyFrame, applyTaskList, dropOutgoing, initialState, resolveDialog, reviseQueued, TOOL_OUTPUT_LIMIT } from "../../src/chat/reducer";

function loadFrames(name: string): any[] {
  return readFileSync(join(__dirname, "..", "fixtures", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function replay(frames: any[], from: ChatState = initialState()): ChatState {
  return frames.reduce((state, frame) => applyFrame(state, frame), from);
}

const tools = (state: ChatState) => state.blocks.filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool");

describe("chat reducer", () => {
  it("a_todo_call_carries_its_op_and_no_input_box", () => {
    const todo = tools(replay(loadFrames("abort"))).filter((block) => block.name === "todo");
    expect(todo.map((block) => block.todo)).toEqual([
      { op: "init", list: [{ phase: "Execution", items: ["Run echo permission-test into perm.txt via bash"] }] },
      { op: "drop", task: "Run echo permission-test into perm.txt via bash" },
    ]);
    expect(todo.map((block) => block.input)).toEqual([undefined, undefined]);
  });

  it("tool_turn_produces_text_thinking_and_tool_blocks", () => {
    const frames = loadFrames("tool_turn");
    const mid = replay(frames.slice(0, frames.findIndex((f) => f.type === "agent_settled")));
    expect(mid.running).toBe(true);

    const state = replay(frames);
    expect(state.running).toBe(false);
    const assistants = state.blocks.filter((b) => b.kind === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    const last = assistants[assistants.length - 1];
    expect(last?.kind === "assistant" && last.text.length).toBeGreaterThan(0);
    expect(last?.kind === "assistant" && last.streaming).toBe(false);
    expect(assistants.every((b) => b.kind === "assistant" && b.text + b.thinking !== "")).toBe(true);
    expect(tools(state).find((t) => t.name === "eval")).toMatchObject({ state: "ok" });
    expect(tools(state).find((t) => t.name === "read")).toMatchObject({ state: "error" });
    expect(tools(state).find((t) => t.name === "eval")?.summary).toContain("Listing files");
    // the user prompt is shown, internal custom messages are not
    expect(state.blocks.filter((b) => b.kind === "user")).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain("environment_context");
  });

  it("caps_tool_output_and_ignores_partial", () => {
    const sessionId = "rpc-1";
    let state = applyFrame(initialState(), { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 }, sessionId });
    const huge = "x".repeat(1_000_000);
    state = applyFrame(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial: { blob: huge } },
      message: { blob: huge },
      sessionId,
    });
    state = applyFrame(state, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" } });
    expect(state.blocks[0]).toMatchObject({ kind: "assistant", text: "Hi", thinking: "hm" });
    expect(JSON.stringify(state).length).toBeLessThan(1000);

    state = applyFrame(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "eval", args: { code: "1" } });
    state = applyFrame(state, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "eval",
      isError: false,
      result: { content: [{ type: "text", text: "y".repeat(50_000) }] },
    });
    const tool = tools(state)[0];
    expect(tool?.output).toHaveLength(TOOL_OUTPUT_LIMIT);
    expect(tool?.truncated).toBe(true);
    expect(TOOL_OUTPUT_LIMIT).toBe(20_000);
  });

  it("steer_and_follow_up_show_queued_then_merge", () => {
    const frames = loadFrames("steer_follow_up");
    const queuedAt = frames.findIndex((f) => f.type === "queue_update" && f.ordered?.length > 0);
    const queuedState = replay(frames.slice(0, queuedAt + 1));
    const queued = queuedState.blocks.filter((b) => b.kind === "user" && b.delivery !== undefined);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: "x-steer", delivery: { state: "queued", queuedId: "q_1", revision: 1 }, text: expect.stringContaining("STEERED") });

    const state = replay(frames);
    expect(state.blocks.some((b) => b.kind === "user" && b.delivery !== undefined)).toBe(false);
    const users = state.blocks.filter((b) => b.kind === "user");
    expect(users.map((b) => b.kind === "user" && b.text).join("|")).toContain("STEERED");
    expect(users.map((b) => b.kind === "user" && b.text).join("|")).toContain("FOLLOWED");
    expect(users.map((b) => b.id).filter((id) => id === "x-steer" || id === "x-follow")).toEqual(["x-steer", "x-follow"]); // never twice

    const followUp = applyFrame(initialState(), {
      type: "queue_update",
      ordered: [{ text: "later", mode: "followUp", queuedId: "q_2", clientMessageId: "x-follow" }],
    });
    expect(followUp.blocks[0]).toMatchObject({ kind: "user", id: "x-follow", delivery: { state: "queued", queuedId: "q_2" }, text: "later" });
  });

  describe("a sent message before it is in the conversation", () => {
    const sending = (id: string, text: string): ChatState => addOutgoing(initialState(), { id, text });
    const userStart = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text }], timestamp: 5, clientMessageId: id, ...extra },
    });

    it("appears_at_once_as_sending_and_is_replaced_in_place_by_the_real_message", () => {
      let state = sending("m1", "hello");
      expect(state.blocks).toEqual([{ kind: "user", id: "m1", text: "hello", delivery: { state: "sending" } }]);
      state = applyFrame(state, userStart("m1", "hello"));
      expect(state.blocks).toEqual([{ kind: "user", id: "m1", text: "hello", timestamp: 5 }]);
    });

    it("an_outgoing_message_shows_its_images_under_the_ids_the_real_one_uses", () => {
      const state = addOutgoing(initialState(), { id: "m1", text: "", images: [{ id: "m1:0", mimeType: "image/png" }] });
      expect(state.blocks[0]).toMatchObject({ images: [{ id: "m1:0", mimeType: "image/png" }], delivery: { state: "sending" } });
    });

    it.each([true, false])("merges an inline-image queue copy by ID first, then text (ID=%s)", (withId) => {
      const images = [{ id: "m1:0", mimeType: "image/png", name: "image.png" }];
      let state = addOutgoing(initialState(), { id: "m1", text: "когда модель ответит?", images });
      const ordered = [{ text: "[картинка 1]когда модель ответит?", queuedId: "q1", ...(withId ? { clientMessageId: "m1" } : {}) }];
      state = applyFrame(state, { type: "queue_update", ordered });
      expect(state.blocks).toEqual([{
        kind: "user", id: "m1", text: ordered[0]?.text, images, delivery: { state: "queued", queuedId: "q1" },
      }]);
      state = reviseQueued(state, "m1", "[картинка 1]а теперь?", 2);
      state = applyFrame(state, { type: "queue_update", ordered: [{ ...ordered[0], text: "[картинка 1]а теперь?", revision: 2 }] });
      expect(state.blocks).toHaveLength(1);
      const sink = vi.fn();
      state = applyFrame(state, userStart("m1", "", { content: [
        { type: "text", text: "[картинка 1]а теперь?" }, { type: "image", data: "QUJD", mimeType: "image/png", name: "image.png" },
      ] }), sink);
      expect(state.blocks).toEqual([{ kind: "user", id: "m1", text: "[картинка 1]а теперь?", timestamp: 5, images }]);
      expect(sink).toHaveBeenCalledWith(images[0], "QUJD");
    });

    it("merges an inline-image queue that arrived before the local bubble", () => {
      const queued = applyFrame(initialState(), { type: "queue_update", ordered: [{ queuedId: "q1", text: "[картинка 1]проверь" }] });
      const state = addOutgoing(queued, { id: "m1", text: "проверь", images: [{ id: "m1:0", mimeType: "image/png" }] });
      expect(state.blocks).toEqual([{
        kind: "user", id: "m1", text: "[картинка 1]проверь",
        images: [{ id: "m1:0", mimeType: "image/png" }], delivery: { state: "queued", queuedId: "q1" },
      }]);
    });

    it("never merges different client IDs or ambiguous repeated image messages", () => {
      let state = addOutgoing(initialState(), { id: "m1", text: "проверь", images: [{ id: "m1:0", mimeType: "image/png" }] });
      const different = applyFrame(state, { type: "queue_update", ordered: [{ clientMessageId: "m2", queuedId: "q1", text: "[картинка 1]проверь" }] });
      expect(different.blocks.map((block) => block.id)).toEqual(["m1", "m2"]);
      state = addOutgoing(state, { id: "m2", text: "проверь", images: [{ id: "m2:0", mimeType: "image/png" }] });
      const ambiguous = applyFrame(state, { type: "queue_update", ordered: [{ queuedId: "q1", text: "[картинка 1]проверь" }] });
      expect(ambiguous.blocks.map((block) => block.id)).toEqual(["m1", "m2", "queued:q1"]);
    });

    it("does not normalize a literal marker without its attached picture", () => {
      const state = applyFrame(sending("m1", "проверь"), { type: "queue_update", ordered: [{ queuedId: "q1", text: "[картинка 1]проверь" }] });
      expect(state.blocks.map((block) => block.id)).toEqual(["m1", "queued:q1"]);
      const withImage = addOutgoing(initialState(), { id: "m1", text: "проверь", images: [{ id: "m1:0", mimeType: "image/png" }] });
      const invalid = applyFrame(withImage, { type: "queue_update", ordered: [{ queuedId: "q1", text: "[картинка 2]проверь" }] });
      expect(invalid.blocks).toHaveLength(2);
    });

    it("turns_queued_in_place_and_follows_edits_from_queue_updates", () => {
      let state = applyFrame(sending("m1", "steer me"), { type: "assistant_placeholder" });
      state = applyFrame(state, { type: "queue_update", ordered: [{ text: "steer me", mode: "steer", queuedId: "q_3", revision: 1, clientMessageId: "m1" }] });
      expect(state.blocks).toEqual([{ kind: "user", id: "m1", text: "steer me", delivery: { state: "queued", queuedId: "q_3", revision: 1 } }]);
      state = applyFrame(state, { type: "queue_update", ordered: [{ text: "steer you", mode: "steer", queuedId: "q_3", revision: 2, clientMessageId: "m1" }] });
      expect(state.blocks).toEqual([{ kind: "user", id: "m1", text: "steer you", delivery: { state: "queued", queuedId: "q_3", revision: 2 } }]);
    });

    it("a_message_that_left_the_queue_waits_as_sending_and_lands_after_what_the_agent_did_meanwhile", () => {
      let state = sending("m1", "steer me");
      state = applyFrame(state, { type: "queue_update", ordered: [{ text: "steer me", mode: "steer", queuedId: "q_3", clientMessageId: "m1" }] });
      state = applyFrame(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
      state = applyFrame(state, { type: "queue_update", ordered: [] });
      expect(state.blocks[0]).toMatchObject({ id: "m1", delivery: { state: "sending" } });
      state = applyFrame(state, userStart("m1", "steer me"));
      expect(state.blocks.map((block) => block.id)).toEqual(["t1", "m1"]);
      expect(state.blocks[1]).not.toHaveProperty("delivery");
    });

    it("another_clients_queued_message_is_keyed_by_its_queued_id_and_goes_when_it_leaves_the_queue", () => {
      let state = applyFrame(initialState(), { type: "queue_update", ordered: [{ text: "theirs", mode: "followUp", queuedId: "q_9" }] });
      expect(state.blocks).toEqual([{ kind: "user", id: "queued:q_9", text: "theirs", delivery: { state: "queued", queuedId: "q_9" } }]);
      state = applyFrame(state, { type: "queue_update", ordered: [] });
      expect(state.blocks).toEqual([]);
    });

    it("agent_settled_drops_messages_still_sending_but_keeps_queued_ones", () => {
      let state = addOutgoing(sending("m1", "lost"), { id: "m2", text: "waiting" });
      state = applyFrame(state, { type: "queue_update", ordered: [{ text: "waiting", mode: "steer", queuedId: "q_1", clientMessageId: "m2" }] });
      state = applyFrame(state, { type: "agent_settled" });
      expect(state.blocks.map((block) => block.id)).toEqual(["m2"]);
    });

    it("dropping_an_outgoing_message_removes_only_an_undelivered_block", () => {
      const state = applyFrame(addOutgoing(sending("m1", "a"), { id: "m2", text: "b" }), userStart("m2", "b"));
      expect(dropOutgoing(state, "m1").blocks.map((block) => block.id)).toEqual(["m2"]);
      expect(dropOutgoing(state, "m2")).toBe(state);
    });

    it("a_resent_message_replaces_its_old_outgoing_block", () => {
      const state = addOutgoing(addOutgoing(sending("m1", "a"), { id: "m2", text: "b" }), { id: "m1", text: "a" });
      expect(state.blocks.map((block) => block.id)).toEqual(["m2", "m1"]);
    });

    it("the_journal_catch_up_turns_an_outgoing_block_into_the_real_message", () => {
      const state = applyEntries(sending("m1", "hello"), [{ type: "message", id: "e1", message: { role: "user", content: "hello", timestamp: 5, clientMessageId: "m1" } }]);
      expect(state.blocks).toEqual([{ kind: "user", id: "m1", text: "hello", timestamp: 5 }]);
    });

    it("an_edit_answer_updates_the_queued_text_at_once", () => {
      let state = applyFrame(sending("m1", "old"), { type: "queue_update", ordered: [{ text: "old", mode: "steer", queuedId: "q_1", revision: 1, clientMessageId: "m1" }] });
      state = reviseQueued(state, "m1", "new", 2);
      expect(state.blocks[0]).toEqual({ kind: "user", id: "m1", text: "new", delivery: { state: "queued", queuedId: "q_1", revision: 2 } });
    });

    describe("a resend that supersedes an earlier bubble (liveness recovery)", () => {
      // The old bubble is queued (OmO restored it on the reopen); the resend under a new id carries its old id.
      const withQueued = (): ChatState =>
        applyFrame(sending("m-old", "что происходит?"), { type: "queue_update", ordered: [{ text: "что происходит?", mode: "prompt", queuedId: "q_1", clientMessageId: "m-old" }] });

      it("drops_the_superseded_bubble_the_moment_the_resend_appears", () => {
        const state = addOutgoing(withQueued(), { id: "m-new", text: "что происходит?", supersedes: "m-old" });
        expect(state.blocks).toEqual([{ kind: "user", id: "m-new", text: "что происходит?", delivery: { state: "sending" }, supersedes: "m-old" }]);
      });

      it("never_relets_a_restored_queue_bring_the_old_id_back", () => {
        let state = addOutgoing(withQueued(), { id: "m-new", text: "что происходит?", supersedes: "m-old" });
        state = applyFrame(state, { type: "message_start", message: { role: "user", content: "что происходит?", clientMessageId: "m-new", timestamp: 7 } });
        expect(state.blocks).toEqual([{ kind: "user", id: "m-new", text: "что происходит?", timestamp: 7, supersedes: "m-old" }]); // delivered, keeps the marker
        state = applyFrame(state, { type: "queue_update", ordered: [{ text: "что происходит?", mode: "prompt", queuedId: "q_1", clientMessageId: "m-old" }] });
        expect(state.blocks).toEqual([{ kind: "user", id: "m-new", text: "что происходит?", timestamp: 7, supersedes: "m-old" }]); // the old id stayed gone
      });

      it("keeps_a_genuinely_different_queued_message", () => {
        let state = addOutgoing(withQueued(), { id: "m-new", text: "что происходит?", supersedes: "m-old" });
        state = applyFrame(state, {
          type: "queue_update",
          ordered: [
            { text: "что происходит?", mode: "prompt", queuedId: "q_1", clientMessageId: "m-old" }, // superseded: gone
            { text: "и логи тоже", mode: "follow_up", queuedId: "q_2", clientMessageId: "m-two" }, // different: stays
          ],
        });
        expect(state.blocks.map((block) => block.kind === "user" && { id: block.id, state: block.delivery?.state })).toEqual([
          { id: "m-new", state: "sending" },
          { id: "m-two", state: "queued" },
        ]);
      });
    });
  });

  it("abort_ends_the_turn_with_a_notice", () => {
    const state = replay(loadFrames("abort"));
    expect(state.running).toBe(false);
    expect(state.blocks.some((b) => b.kind === "notice" && b.text === "Ход остановлен")).toBe(true);
  });

  it("a_clean_turn_end_shows_no_stopped_line", () => {
    // A finished turn carries no `aborted`: «Ход остановлен» must greet a stop, never an ordinary end.
    const state = applyFrame({ ...initialState(), running: true }, { type: "agent_end", willRetry: false, clientMessageId: "p-1" });
    expect(state.blocks.some((b) => b.kind === "notice" && b.text === "Ход остановлен")).toBe(false);
  });

  it("a_system_abort_shows_no_bare_stopped_line", () => {
    // OmO's own abort (compaction / deadline / liveness) is not the person's «Стоп»: the controller tells that story.
    const state = applyFrame({ ...initialState(), running: true }, { type: "agent_end", willRetry: false, aborted: true, abortSource: "system", clientMessageId: "p-1" });
    expect(state.blocks.some((b) => b.kind === "notice" && b.text === "Ход остановлен")).toBe(false);
  });

  it("permission_select_becomes_dialog_and_resolves", () => {
    const frames = loadFrames("permission");
    const state = replay(frames);
    expect(state.dialogs.length).toBeGreaterThan(0);
    const dialog = state.dialogs[0]!;
    expect(dialog).toMatchObject({ method: "select", options: ["Allow once", "Allow always", "Deny", "Deny with feedback"] });
    expect(dialog.title).toContain("Permission required");
    const resolved = resolveDialog(state, dialog.id);
    expect(resolved.dialogs.find((d) => d.id === dialog.id)).toBeUndefined();
    expect(resolveDialog(resolved, "nope")).toBe(resolved);
  });

  it("question_frame_becomes_dialog", () => {
    const frames = loadFrames("question");
    const resolvedAt = frames.findIndex((f) => f.type === "question_resolved");
    const open = replay(frames.slice(0, resolvedAt));
    expect(open.dialogs).toHaveLength(1);
    expect(open.dialogs[0]).toMatchObject({ method: "question", title: "Which color do you pick?" });
    expect(open.dialogs[0]?.questions).toHaveLength(1);
    expect(replay(frames).dialogs).toHaveLength(0);
  });

  it("a_dialog_keeps_its_details_and_its_deadline", () => {
    const confirm = applyFrame(initialState(), { type: "extension_ui_request", id: "c", method: "confirm", title: "Clear?", message: "All messages will be lost.", deadlineAtMs: 1_900_000 });
    expect(confirm.dialogs[0]).toEqual({ id: "c", method: "confirm", title: "Clear?", message: "All messages will be lost.", deadlineAt: 1_900_000 });
    const input = applyFrame(initialState(), { type: "extension_ui_request", id: "i", method: "input", title: "Name", placeholder: "type something..." });
    expect(input.dialogs[0]).toMatchObject({ placeholder: "type something..." });
    const editor = applyFrame(initialState(), { type: "extension_ui_request", id: "e", method: "editor", title: "Edit", prefill: "Line 1\nLine 2" });
    expect(editor.dialogs[0]).toMatchObject({ prefill: "Line 1\nLine 2" });
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const timed = applyFrame(initialState(), { type: "extension_ui_request", id: "s", method: "select", title: "Pick", options: ["a"], timeout: 10_000 });
    expect(timed.dialogs[0]?.deadlineAt).toBe(11_000);
    vi.restoreAllMocks();
    const updated = applyFrame({ ...initialState(), dialogs: [{ id: "q", method: "question", title: "Q", deadlineAt: 5 }] }, { type: "question_updated", id: "q", deadlineAtMs: 99 });
    expect(updated.dialogs[0]?.deadlineAt).toBe(99);
  });

  it("notify_becomes_notice_and_status_widgets_are_ignored", () => {
    const state = applyFrame(initialState(), { type: "extension_ui_request", id: "n1", method: "notify", message: "Привет", notifyType: "warning" });
    expect(state.blocks[0]).toMatchObject({ kind: "notice", level: "warn", text: "Привет" });
    const widget = { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "todo" };
    expect(applyFrame(state, widget)).toBe(state);
  });

  it("an_identical_notify_repeated_shows_once_not_stacked", () => {
    // OmO re-sending the same reflection-paused notice (fresh id each time) must not pile up a copy per repeat.
    const notify = (id: string, message: string) => ({ type: "extension_ui_request", id, method: "notify", message, notifyType: "warning" as const });
    let state = applyFrame(initialState(), notify("n1", "reflection paused"));
    state = applyFrame(state, notify("n2", "reflection paused"));
    state = applyFrame(state, notify("n3", "reflection paused"));
    const notices = state.blocks.filter((b) => b.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: "warn", text: "reflection paused" });

    // A different line between two identical ones is not a repeat: it shows, and the next identical one shows again.
    state = applyFrame(state, notify("n4", "something else"));
    state = applyFrame(state, notify("n5", "reflection paused"));
    expect(state.blocks.filter((b) => b.kind === "notice")).toHaveLength(3);
  });

  it("model_profile_sets_auto_model", () => {
    const frames = loadFrames("model_profile");
    const state = replay(frames);
    expect(state.model).toEqual({ provider: "gw-anthropic", id: "claude-haiku-5-5" });
    expect(state.autoModel).toEqual({ provider: "gw-anthropic", id: "claude-haiku-5-5" });
    expect(state.cursor).toBe("e2");

    const manual = applyFrame(state, {
      type: "model_changed",
      model: { provider: "gw-anthropic", id: "claude-gateway/gpt-6-astra" },
      origin: { source: "rpc" },
    });
    expect(manual.model?.id).toBe("claude-gateway/gpt-6-astra");
    expect(manual.autoModel?.id).toBe("claude-haiku-5-5");

    const entry = {
      type: "entry_appended",
      entry: { type: "custom", customType: "omo-model-profile:applied", id: "p1", data: { details: { model: "gw-anthropic/claude-gateway/gpt-6-astra" } } },
    };
    expect(applyFrame(initialState(), entry).autoModel).toEqual({ provider: "gw-anthropic", id: "claude-gateway/gpt-6-astra" });
  });

  it("title_and_agents_follow_frames", () => {
    let state = applyFrame(initialState(), { type: "session_info_changed", name: "probe-one" });
    expect(state.title).toBe("probe-one");
    state = applyFrame(state, {
      type: "extension_event",
      name: "omo.task.updated",
      data: { parent_session_id: "p", tasks: [{ task_id: "t1", name: "explore", status: "running", model: "gw/haiku" }] },
    });
    state = applyFrame(state, {
      type: "extension_event",
      name: "omo.dag.updated",
      data: { runs: [{ run_id: "r1", nodes: [{ id: "n1", label: "build", state: "completed" }] }] },
    });
    expect(state.agents).toEqual([
      { id: "task:t1", taskId: "t1", label: "explore", status: "running", model: "gw/haiku" },
      { id: "dag:r1:n1", label: "build", status: "done" },
    ]);
    // An update that no longer mentions a task keeps its row; a task OmO stopped tracking while it ran was lost.
    state = applyFrame(state, { type: "extension_event", name: "omo.task.updated", data: { tasks: [] } });
    expect(state.agents.map((a) => [a.id, a.status])).toEqual([
      ["task:t1", "error"],
      ["dag:r1:n1", "done"],
    ]);
  });

  it("entries_rebuild_history_and_cursor", () => {
    const entries = [
      { type: "model_change", id: "e0", provider: "gw-anthropic", modelId: "claude-haiku-5-5" },
      { type: "custom_message", id: "e1", customType: "environment-context", content: "<environment_context/>", display: false },
      { type: "custom_message", id: "e2", customType: "senpi-task.usage", content: "<omo-senpi-task>" },
      { type: "custom", id: "e3", customType: "omo-memory:projection-pin", data: {} },
      { type: "message", id: "e4", message: { role: "user", content: [{ type: "text", text: "list files" }], timestamp: 10, clientMessageId: "m1" } },
      {
        type: "message",
        id: "e5",
        message: {
          role: "assistant",
          timestamp: 11,
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "ok" },
            { type: "toolCall", id: "tc1", name: "eval", arguments: { summary: "ls" } },
          ],
        },
      },
      { type: "message", id: "e6", message: { role: "toolResult", toolCallId: "tc1", toolName: "eval", isError: false, content: [{ type: "text", text: "a\nb" }] } },
      { type: "message", id: "e7", message: { role: "assistant", timestamp: 12, content: [{ type: "text", text: "a b" }] } },
      { type: "session_info", id: "e8", name: "named" },
    ];
    const state = applyEntries(initialState(), entries);
    expect(state.blocks.map((b) => b.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(state.blocks[0]).toMatchObject({ id: "m1", text: "list files" });
    expect(state.blocks[1]).toMatchObject({ thinking: "hmm", text: "ok", streaming: false });
    expect(state.blocks[2]).toMatchObject({ name: "eval", summary: "ls", output: "a\nb", state: "ok" });
    expect(state.cursor).toBe("e8");
    expect(state.title).toBe("named");
    expect(state.model).toEqual({ provider: "gw-anthropic", id: "claude-haiku-5-5" });

    // replaying the same journal over live-built state does not duplicate blocks
    expect(applyEntries(state, entries).blocks).toHaveLength(4);
    expect(applyEntries(state, [])).toBe(state);
  });

  it("displayed_custom_message_becomes_notice", () => {
    const state = applyEntries(initialState(), [{ type: "custom_message", id: "c1", customType: "my-ext", content: "hello", display: true }]);
    expect(state.blocks).toEqual([{ kind: "notice", id: "entry:c1", level: "info", text: "hello" }]);
  });

  it("unknown_frame_returns_same_state", () => {
    const state = initialState();
    for (const frame of [
      { type: "tool_hook_status", hookName: "PreToolUse" },
      { type: "loaded_surfaces_changed" },
      { type: "extension_ui_request", id: "s", method: "setStatus" },
      { type: "extension_event", name: "senpi.eval.execution", data: {} },
      { type: "something_new" },
      null,
    ]) {
      expect(applyFrame(state, frame)).toBe(state);
    }
  });
  it("replayed_message_over_loaded_entry_has_its_text_exactly_once", () => {
    const content = [{ type: "text", text: "Hello" }];
    const entry = { type: "message", id: "e1", message: { role: "assistant", timestamp: 7, content } };
    let state = applyEntries(initialState(), [entry]);
    state = applyFrame(state, { type: "message_start", message: { role: "assistant", content: [], timestamp: 7 } });
    expect(state.blocks[0]).toMatchObject({ id: "a:7", streaming: true, text: "" });
    state = applyFrame(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    state = applyFrame(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
    state = applyFrame(state, { type: "message_end", message: { role: "assistant", timestamp: 7, content } });
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ text: "Hello", streaming: false });
  });

  it("delta_without_streaming_target_never_duplicates_a_block_id", () => {
    const entry = { type: "message", id: "e1", message: { role: "assistant", timestamp: 7, content: [{ type: "text", text: "A" }] } };
    // one block with id a:1 exists, so the synthesized id for a new block (a:<blocks.length>) would collide
    const loaded = applyEntries(initialState(), [{ ...entry, message: { ...entry.message, timestamp: 1 } }]);
    const state = applyFrame(loaded, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
    const ids = state.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tool_update_without_text_parts_keeps_previous_output", () => {
    let state = applyFrame(initialState(), { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
    state = applyFrame(state, { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "tick 1" }] } });
    state = applyFrame(state, { type: "tool_execution_update", toolCallId: "t1", partialResult: { details: {} } });
    expect(tools(state)[0]).toMatchObject({ output: "tick 1", state: "running" });
    state = applyFrame(state, { type: "tool_execution_end", toolCallId: "t1", result: {}, isError: false });
    expect(tools(state)[0]).toMatchObject({ output: "tick 1", state: "ok" });
  });
});

describe("chat reducer: redesigned-UI model", () => {
  const IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";

  it("user_block_carries_timestamp_and_image_refs", () => {
    const sink = vi.fn();
    const frame = {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "look" }, { type: "image", data: IMAGE_B64, mimeType: "image/png" }],
        timestamp: 77,
        clientMessageId: "m1",
      },
    };
    const state = applyFrame(initialState(), frame, sink);
    expect(state.blocks[0]).toMatchObject({ kind: "user", id: "m1", text: "look", timestamp: 77, images: [{ id: "m1:0", mimeType: "image/png" }] });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({ id: "m1:0", mimeType: "image/png" }, IMAGE_B64);
    expect(JSON.stringify(state)).not.toContain(IMAGE_B64);
    // a replayed start for the same id must not hand the bytes over again
    applyFrame(state, frame, sink);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("journal_user_images_go_to_the_sink", () => {
    const sink = vi.fn();
    const state = applyEntries(
      initialState(),
      [{ type: "message", id: "e1", message: { role: "user", content: [{ type: "image", data: IMAGE_B64, mimeType: "image/jpeg" }, { type: "text", text: "x" }], timestamp: 5, clientMessageId: "m2" } }],
      sink,
    );
    expect(state.blocks[0]).toMatchObject({ kind: "user", timestamp: 5, images: [{ id: "m2:0", mimeType: "image/jpeg" }] });
    expect(sink).toHaveBeenCalledWith({ id: "m2:0", mimeType: "image/jpeg" }, IMAGE_B64);
    expect(JSON.stringify(state)).not.toContain(IMAGE_B64);
  });

  it("thinking_duration_measured", () => {
    const clock = vi.fn<() => number>();
    let state = applyFrame(initialState(), { type: "message_start", message: { role: "assistant", content: [], timestamp: 9 } }, undefined, clock);
    clock.mockReturnValue(1000);
    state = applyFrame(state, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, undefined, clock);
    clock.mockReturnValue(5000);
    state = applyFrame(state, { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "" } }, undefined, clock);
    expect(state.blocks[0]).toMatchObject({ kind: "assistant", timestamp: 9, thinkingMs: 4000 });
  });

  it("task_tool_row_has_role_description_model", () => {
    const clock = vi.fn<() => number>().mockReturnValue(100);
    let state = applyFrame(
      initialState(),
      { type: "tool_execution_start", toolCallId: "t1", toolName: "task", args: { category: "quick", subagent_type: "explore", description: "Find usages\nsecond line" } },
      undefined,
      clock,
    );
    expect(tools(state)[0]).toMatchObject({ role: "quick", description: "Find usages", timestamp: 100 });
    expect(tools(state)[0]?.model).toBeUndefined();
    clock.mockReturnValue(350);
    state = applyFrame(
      state,
      { type: "tool_execution_end", toolCallId: "t1", toolName: "task", result: { content: [{ type: "text", text: "ok" }], details: { resolved_model: "gw/haiku" } }, isError: false },
      undefined,
      clock,
    );
    expect(tools(state)[0]).toMatchObject({ state: "ok", model: "gw/haiku", durationMs: 250 });
    const other = applyFrame(initialState(), { type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { description: "d" } }, undefined, clock);
    expect(tools(other)[0]?.role).toBeUndefined();
    expect(tools(other)[0]?.description).toBeUndefined();
  });

  it("agents_rows_from_task_updated", () => {
    const task = (id: string, status: string, extra: object = {}) => ({ task_id: id, name: id, status, ...extra });
    const state = applyFrame(initialState(), {
      type: "extension_event",
      name: "omo.task.updated",
      data: {
        tasks: [
          task("a", "running", { category: "deep", agent_type: "oracle", effective_model: "gw/x", created_at: "2026-11-03T10:00:00.000Z", live_progress: { activity: "reading", started_at: 1793700000000 } }),
          task("b", "completed", { created_at: "2026-11-03T10:00:00.000Z", updated_at: "2026-11-03T10:00:09.000Z" }),
          task("c", "interrupted"),
          task("d", "pending"),
          task("e", "paused"),
        ],
      },
    });
    expect(state.agents.map((row) => row.status)).toEqual(["running", "done", "error", "waiting", "waiting"]);
    expect(state.agents[0]).toMatchObject({ role: "deep", activity: "reading", model: "gw/x", startedAt: 1793700000000 });
    expect(state.agents[0]?.endedAt).toBeUndefined();
    expect(state.agents[1]).toMatchObject({ endedAt: Date.parse("2026-11-03T10:00:09.000Z") });
  });

  describe("agents history", () => {
    const updated = (tasks: object[], extra: object = {}) => ({ type: "extension_event", name: "omo.task.updated", data: { parent_session_id: "p", tasks, ...extra } });
    const rows = (state: ChatState) => state.agents.map((row) => [row.id, row.status]);

    it("finished_agents_stay_when_later_updates_no_longer_mention_them", () => {
      let state = applyFrame(initialState(), updated([{ task_id: "a", status: "completed", name: "alpha" }, { task_id: "b", status: "running" }]));
      state = applyFrame(state, updated([{ task_id: "b", status: "completed" }, { task_id: "c", status: "pending" }]));
      expect(rows(state)).toEqual([
        ["task:a", "done"],
        ["task:b", "done"],
        ["task:c", "waiting"],
      ]);
      expect(state.agents[0]?.label).toBe("alpha");
      state = applyFrame(state, updated([]));
      expect(rows(state)).toEqual([
        ["task:a", "done"],
        ["task:b", "done"],
        ["task:c", "error"],
      ]);
    });

    it("a_truncated_update_does_not_call_unmentioned_tasks_lost", () => {
      let state = applyFrame(initialState(), updated([{ task_id: "a", status: "paused" }]));
      state = applyFrame(state, updated([{ task_id: "b", status: "running" }], { truncated_tasks: 3 }));
      expect(rows(state)).toEqual([
        ["task:a", "waiting"],
        ["task:b", "running"],
      ]);
    });

    it("an_update_without_a_tasks_list_changes_nothing", () => {
      const state = applyFrame(initialState(), updated([{ task_id: "a", status: "running" }]));
      expect(applyFrame(state, { type: "extension_event", name: "omo.task.updated", data: { parent_session_id: "p" } })).toBe(state);
      expect(applyFrame(state, updated([{ task_id: "a", status: "running" }]))).toEqual(state);
    });

    it("omo_task_list_rows_are_the_update_rows_and_a_failure_kind_changes_nothing", () => {
      const frame = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "task_updated.json"), "utf8"));
      const fromList = applyTaskList(initialState(), frame.data);
      expect(fromList.agents).toEqual(applyFrame(initialState(), frame).agents);
      expect(fromList.agents.map((row) => [row.id, row.status, row.label, row.role, row.model, row.tokens])).toEqual([
        ["task:st_01a1a284", "done", "test-explore", "explore", "gw-anthropic/claude-opus-5-5", 55152],
        ["task:st_01a1a285", "done", "test-quick", "quick", "gw-openai/gpt-6-astra", 68708],
      ]);
      // merged into what the tab already shows, never replacing it
      const shown = applyFrame(initialState(), updated([{ task_id: "older", status: "completed" }]));
      expect(applyTaskList(shown, frame.data).agents.map((row) => row.id)).toEqual(["task:older", "task:st_01a1a284", "task:st_01a1a285"]);
      for (const failure of [{ kind: "unavailable", reason: "No active parent session." }, { kind: "not_found" }, undefined, null]) {
        expect(applyTaskList(shown, failure)).toBe(shown);
      }
    });

    it("the_journal_restores_spawned_and_finished_tasks", () => {
      const entries = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "task_journal.json"), "utf8"));
      const state = applyEntries(initialState(), entries);
      expect(state.agents.map((row) => [row.id, row.taskId, row.label, row.status, row.role, row.model, row.tokens])).toEqual([
        ["task:st_01a1a65e", "st_01a1a65e", "alpha", "done", "quick", "gw-anthropic/claude-haiku-5-5", 120559],
        ["task:st_01a1a65f", "st_01a1a65f", "beta", "done", "quick", "gw-anthropic/claude-haiku-5-5", 120477],
      ]);
      expect(state.agents[0]?.startedAt).toBe(1793792591755);
      expect(state.agents[0]?.endedAt).toBe(Date.parse("2026-11-04T11:43:20.641Z"));

      // Only the spawn results so far: the tasks show as OmO reported them then.
      const spawned = applyEntries(initialState(), entries.slice(0, 3));
      expect(spawned.agents.map((row) => [row.id, row.status])).toEqual([
        ["task:st_01a1a65e", "running"],
        ["task:st_01a1a65f", "running"],
      ]);
    });

    it("a_batch_spawn_result_restores_each_item", () => {
      const resolved = { source: "category", provider: "gw-anthropic", model_id: "claude-haiku-5-5", display: "Claude Haiku 5.5" };
      const details = {
        task_id: "st_1",
        status: "running",
        mode: "spawn",
        run_in_background: true,
        items: [
          { task_id: "st_1", name: "alpha", category: "quick", resolved_model: resolved, status: "running" },
          { task_id: "st_2", name: "beta", category: "quick", resolved_model: resolved, status: "running" },
        ],
      };
      const entry = { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "task", content: [], details, isError: false, timestamp: 7 } };
      const state = applyEntries(initialState(), [entry]);
      expect(state.agents.map((row) => [row.id, row.label, row.status, row.role, row.model, row.startedAt])).toEqual([
        ["task:st_1", "alpha", "running", "quick", "gw-anthropic/claude-haiku-5-5", 7],
        ["task:st_2", "beta", "running", "quick", "gw-anthropic/claude-haiku-5-5", 7],
      ]);
    });

    it("a_catch_up_never_turns_a_row_back_to_what_the_spawn_result_said", () => {
      const entries = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "task_journal.json"), "utf8"));
      const live = applyFrame(initialState(), updated([{ task_id: "st_01a1a65e", status: "completed", name: "alpha", run_stats: { total_tokens: 5 } }]));
      const caught = applyEntries(live, entries.slice(0, 3));
      expect(caught.agents.find((row) => row.id === "task:st_01a1a65e")).toEqual(live.agents[0]);
      expect(caught.agents.map((row) => [row.id, row.status])).toEqual([
        ["task:st_01a1a65e", "done"],
        ["task:st_01a1a65f", "running"],
      ]);
    });

    it("dag_rows_still_follow_each_dag_update", () => {
      let state = applyFrame(initialState(), updated([{ task_id: "a", status: "completed" }]));
      state = applyFrame(state, { type: "extension_event", name: "omo.dag.updated", data: { runs: [{ run_id: "r", nodes: [{ id: "n1", state: "running" }, { id: "n2", state: "running" }] }] } });
      state = applyFrame(state, { type: "extension_event", name: "omo.dag.updated", data: { runs: [{ run_id: "r", nodes: [{ id: "n1", state: "completed" }] }] } });
      expect(rows(state)).toEqual([
        ["task:a", "done"],
        ["dag:r:n1", "done"],
      ]);
    });
  });

  it("an_agent_row_takes_the_model_the_task_actually_ran_on_from_omos_model_record", () => {
    const frame = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "task_updated.json"), "utf8"));
    expect(applyFrame(initialState(), frame).agents.map((row) => row.model)).toEqual(["gw-anthropic/claude-opus-5-5", "gw-openai/gpt-6-astra"]);
    // A fallback: OmO planned one model (`model`) and the child ran on another (`effective_model`, an object).
    const quick = { ...frame.data.tasks[1], model: "gw-anthropic/claude-opus-5-5" };
    const fallback = applyFrame(initialState(), { ...frame, data: { tasks: [quick] } });
    expect(fallback.agents[0]?.model).toBe("gw-openai/gpt-6-astra");

    // A task tool's result details carry the same record objects.
    let state = applyFrame(initialState(), { type: "tool_execution_start", toolCallId: "t1", toolName: "task", args: {} });
    const resolved = { provider: "gw-openai", model_id: "gpt-6-astra", display: "GPT 6 Astra", variant: "low", source: "category" };
    state = applyFrame(state, { type: "tool_execution_end", toolCallId: "t1", toolName: "task", result: { content: [], details: { model: "gw-openai/gpt-6-astra", resolved_model: resolved } }, isError: false });
    expect(tools(state)[0]?.model).toBe("gw-openai/gpt-6-astra");

    // Other spellings: `id` for `model_id`. A display (or name) only when no record or `model` is qualified anywhere.
    const rowModel = (task: object) => applyFrame(initialState(), { ...frame, data: { tasks: [{ task_id: "st_x", status: "running", ...task }] } }).agents[0]?.model;
    expect(rowModel({ effective_model: { provider: "gw-openai", id: "gpt-6-astra" } })).toBe("gw-openai/gpt-6-astra");
    expect(rowModel({ effective_model: { display: "GPT 6 Astra" }, model: "gw-openai/gpt-6-astra" })).toBe("gw-openai/gpt-6-astra");
    expect(rowModel({ effective_model: { display: "GPT 6 Astra" }, resolved_model: { provider: "gw-openai", model_id: "gpt-6-astra" } })).toBe("gw-openai/gpt-6-astra");
    expect(rowModel({ effective_model: { display: "GPT 6 Astra", name: "astra" } })).toBe("GPT 6 Astra");
    expect(rowModel({ resolved_model: { name: "astra" } })).toBe("astra");
  });

  it("agent_tokens_come_from_run_stats_and_context_tokens_from_assistant_usage", () => {
    let state = applyFrame(initialState(), {
      type: "extension_event",
      name: "omo.task.updated",
      data: { tasks: [{ task_id: "a", status: "completed", run_stats: { total_tokens: 58_100 } }, { task_id: "b", status: "running", run_stats: { total_tokens: -1 } }, { task_id: "c", status: "running" }] },
    });
    expect(state.agents.map((row) => row.tokens)).toEqual([58_100, undefined, undefined]);

    const usage = { input: 1000, output: 200, cacheRead: 50_000, cacheWrite: 300, totalTokens: 51_500 };
    state = applyFrame(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage } });
    expect(state.contextTokens).toBe(51_500);
    state = applyFrame(state, { type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 } } });
    expect(state.contextTokens).toBe(115); // no total: the parts
    const same = applyFrame(state, { type: "message_end", message: { role: "user", content: "x", usage } });
    expect(same.contextTokens).toBe(115); // only the assistant's usage counts
  });

  it("activity_from_lifecycle", () => {
    const life = (lifecycle: object) => ({ type: "session_lifecycle", lifecycle });
    let state = applyFrame(initialState(), life({ state: "running", activity: { kind: "tool", toolName: "bash", toolCallId: "c" } }));
    expect(state).toMatchObject({ running: true, activity: "tool", activityTool: "bash" });
    state = applyFrame(state, life({ state: "running", activity: { kind: "model", since: 1 } }));
    expect(state.activity).toBe("thinking");
    expect(state.activityTool).toBeUndefined();
    state = applyFrame(state, life({ state: "waiting_human" }));
    expect(state.activity).toBe("waiting_human");
    state = applyFrame(state, life({ state: "done" }));
    expect(state).toMatchObject({ running: false, activity: "idle" });
  });

  it.each(["waiting_background", "waiting_children"])("ends the turn at %s while retaining background work", (state) => {
    // OmO 5.1.59 live scratch capture: no runActive field on the wire, no activity, isStreaming=false.
    const waitingOn = {
      children: 2,
      background: [{ source: "terminal-background-sessions", activeCount: 3, items: [{ id: "bash_1", label: "sleep 90" }], omittedItems: 2 }],
      human: [],
    };
    let chat = applyFrame(initialState(), { type: "agent_start" });
    chat = applyFrame(chat, { type: "agent_end", messages: [] });
    chat = applyFrame(chat, { type: "session_lifecycle", lifecycle: { state, seq: 3, runId: "active", waitingOn } });
    expect(chat).toMatchObject({ running: false, activity: "idle", background: { count: 5 } });
    const same = applyFrame(chat, { type: "session_lifecycle", lifecycle: { state, seq: 3, runId: "active", waitingOn } });
    expect(same).toBe(chat);
    chat = applyFrame(chat, { type: "session_lifecycle", lifecycle: { state: "running", waitingOn, activity: { kind: "model" } } });
    expect(chat).toMatchObject({ running: true, activity: "thinking", background: { count: 5 } });
    chat = applyFrame(chat, { type: "session_lifecycle", lifecycle: { state: "done", waitingOn: { children: 0, background: [], human: [] } } });
    expect(chat.background).toBeUndefined();
  });

  it("a_run_the_host_already_stopped_is_not_running", () => {
    const life = (lifecycle: object) => ({ type: "session_lifecycle", lifecycle });
    // a turn whose model request errored out: turn_end and agent_end arrive, agent_settled never does, and the
    // lifecycle still reads "running" while naming this very run as the one it stopped
    let state = applyFrame(initialState(), life({ state: "running", runId: "r1", activity: { kind: "model" } }));
    expect(state).toMatchObject({ running: true, activity: "thinking" });
    state = applyFrame(state, { type: "turn_end" });
    state = applyFrame(state, life({ state: "running", runId: "r1", lastStop: { runId: "r1", cause: "error" } }));
    expect(state).toMatchObject({ running: false, activity: "idle" });
    // the next turn has its own run: the older stop says nothing about it
    state = applyFrame(state, life({ state: "running", runId: "r2", lastStop: { runId: "r1", cause: "error" } }));
    expect(state.running).toBe(true);
    // a state the lifecycle has no word on leaves the turn as it was
    expect(applyFrame(state, life({ state: "paused", runId: "r2" })).running).toBe(true);
  });

  it("thinking_level_tracked", () => {
    let state = applyFrame(initialState(), { type: "model_changed", model: { provider: "p", id: "m" }, thinkingLevel: "xhigh" });
    expect(state).toMatchObject({ thinkingLevel: "xhigh", model: { provider: "p", id: "m" } });
    state = applyFrame(state, { type: "entry_appended", entry: { type: "thinking_level_change", id: "t1", thinkingLevel: "low" } });
    expect(state).toMatchObject({ thinkingLevel: "low", cursor: "t1" });
    state = applyEntries(state, [{ type: "thinking_level_change", id: "t2", thinkingLevel: "off" }]);
    expect(state.thinkingLevel).toBe("off");
  });

  it("same_lifecycle_frame_returns_same_object", () => {
    const frame = { type: "session_lifecycle", lifecycle: { state: "running", activity: { kind: "tool", toolName: "bash" } } };
    const once = applyFrame(initialState(), frame);
    expect(applyFrame(once, { ...frame })).toBe(once);
    const done = applyFrame(once, { type: "session_lifecycle", lifecycle: { state: "done" } });
    expect(applyFrame(done, { type: "session_lifecycle", lifecycle: { state: "done" } })).toBe(done);
  });
});

describe("chat reducer: image sink on catch-up", () => {
  it("redelivered_journal_user_message_does_not_resend_bytes", () => {
    const sink = vi.fn();
    const entries = [{ type: "message", id: "e1", message: { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 5, clientMessageId: "m3" } }];
    const once = applyEntries(initialState(), entries, sink);
    applyEntries(once, entries, sink);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe("chat reducer: user id stability", () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };

  it("live_and_journal_ids_match_with_timestamp_only", () => {
    const sink = vi.fn();
    const message = { role: "user", content: [{ type: "text", text: "hi" }, image], timestamp: 42 };
    const live = applyFrame(initialState(), { type: "message_start", message }, sink);
    const both = applyEntries(live, [{ type: "message", id: "e1", message }], sink);
    expect(both.blocks).toHaveLength(1);
    expect(both.blocks[0]?.id).toBe("u:42");
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("unstable_id_never_sinks_images", () => {
    const sink = vi.fn();
    const message = { role: "user", content: [{ type: "text", text: "hi" }, image] };
    const state = applyFrame(initialState(), { type: "message_start", message }, sink);
    expect(state.blocks[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(state.blocks[0]).not.toHaveProperty("images");
    applyEntries(initialState(), [{ type: "message", id: "e1", message }], sink);
    expect(sink).not.toHaveBeenCalled();
  });

  it("journal_merges_images_into_existing_imageless_block", () => {
    const sink = vi.fn();
    const live = applyFrame(initialState(), { type: "message_start", message: { role: "user", content: "hi", timestamp: 7, clientMessageId: "m9" } });
    const merged = applyEntries(live, [{ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "hi" }, image], timestamp: 7, clientMessageId: "m9" } }], sink);
    expect(merged.blocks).toHaveLength(1);
    expect(merged.blocks[0]).toMatchObject({ images: [{ id: "m9:0" }] });
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe("chat reducer: a tool step's input", () => {
  const start = (toolName: string, args: unknown) => tools(applyFrame(initialState(), { type: "tool_execution_start", toolCallId: "t1", toolName, args }))[0];

  it("bash_and_monitor_show_the_command", () => {
    expect(start("bash", { command: "ls -la\npwd", description: "list" })).toMatchObject({ input: "ls -la\npwd" });
    expect(start("monitor", { command: "tail -f log", timeout: 5 })).toMatchObject({ input: "tail -f log" });
  });

  it("eval_shows_the_code_and_its_language", () => {
    expect(start("eval", { language: "python", summary: "s", code: "print(1)" })).toMatchObject({ input: "print(1)", inputLang: "python" });
  });

  it("write_shows_the_whole_content_as_added", () => {
    expect(start("write", { path: "/a/x.ts", content: "one\ntwo\n" })).toMatchObject({ file: "/a/x.ts", input: "+one\n+two", added: 2, removed: 0 });
  });

  it("edit_shows_a_line_diff_of_each_change_with_its_context", () => {
    const edits = [
      { oldText: "keep\nold 1\nold 2\ntail", newText: "keep\nnew\ntail" },
      { old_string: "x", new_string: "y" },
    ];
    expect(start("edit", { path: "/a/x.ts", edits })).toMatchObject({ file: "/a/x.ts", input: " keep\n-old 1\n-old 2\n+new\n tail\n@@\n-x\n+y", added: 2, removed: 3 });
    expect(start("edit", { file_path: "/a/y.ts", old_string: "a", new_string: "b" })).toMatchObject({ file: "/a/y.ts", input: "-a\n+b", added: 1, removed: 1 });
  });

  it("apply_patch_shows_its_hunks_and_names_the_first_file", () => {
    const input = "*** Begin Patch\n*** Update File: /a/x.ts\n@@ fn\n ctx\n-a\n+b\n+c\n*** Add File: /a/new.ts\n+n\n*** End Patch";
    expect(start("apply_patch", { input })).toMatchObject({
      file: "/a/x.ts",
      input: "*** Update File: /a/x.ts\n@@ fn\n ctx\n-a\n+b\n+c\n*** Add File: /a/new.ts\n+n",
      added: 3,
      removed: 1,
    });
  });

  it("read_names_the_file_and_the_lines_it_asked_for", () => {
    expect(start("read", { path: "/a/x.ts", offset: 10, limit: 40 })).toMatchObject({ file: "/a/x.ts", fromLine: 10, toLine: 49 });
    const whole = start("read", { path: "/a/x.ts" });
    expect(whole).toMatchObject({ file: "/a/x.ts" });
    expect(whole).not.toHaveProperty("fromLine");
    expect(whole).not.toHaveProperty("input");
  });

  it("task_shows_the_prompt_or_description", () => {
    expect(start("task", { category: "quick", description: "Find", prompt: "Find all usages" })?.input).toBe("Find all usages");
    expect(start("task", { tasks: [{ description: "one", prompt: "do one" }, { description: "two" }] })?.input).toBe("do one\n\ntwo");
  });

  it("other_tools_show_compact_json_of_their_args", () => {
    expect(start("grep", { pattern: "x", path: "/a" })?.input).toBe('{"pattern":"x","path":"/a"}');
    expect(start("ls", undefined)?.input).toBeUndefined();
  });

  it("a_huge_input_is_capped", () => {
    expect(start("bash", { command: "y".repeat(50_000) })?.input).toHaveLength(TOOL_OUTPUT_LIMIT);
  });

  it("the_input_survives_output_updates_and_the_end", () => {
    let state = applyFrame(initialState(), { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "make" } });
    state = applyFrame(state, { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "tick" }] } });
    state = applyFrame(state, { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "done" }] }, isError: false });
    expect(tools(state)[0]).toMatchObject({ input: "make", output: "done", state: "ok" });
  });

  it("compaction_frames_toggle_compacting_and_a_finished_one_forgets_the_token_count", () => {
    let state = applyFrame({ ...initialState(), contextTokens: 90_000 }, { type: "compaction_start", reason: "manual" });
    expect(state.compacting).toBe(true);
    expect(state.contextTokens).toBe(90_000);
    state = applyFrame(state, { type: "compaction_end", reason: "manual", aborted: false });
    expect(state.compacting).toBe(false);
    expect(state.contextTokens).toBeUndefined();
    const kept = applyFrame({ ...initialState(), contextTokens: 90_000, compacting: true }, { type: "compaction_end", reason: "manual", aborted: true });
    expect(kept.compacting).toBe(false);
    expect(kept.contextTokens).toBe(90_000);
  });
});

describe("a goal OmO stopped is not a turn waiting for an answer", () => {
  const life = (lifecycle: object) => ({ type: "session_lifecycle", lifecycle });
  const waits = (...kinds: string[]) => ({
    state: "waiting_human",
    runId: "r1",
    waitingOn: { children: 0, background: [], human: kinds.map((kind, index) => ({ kind, requestId: `w${index}`, revision: 1 })) },
  });

  // Live, OmO 5.1.59: a session resumed with a blocked goal reports waiting_human whose only human wait is the goal
  // itself (`{kind: "goal_blocked"}`), with no pending dialog and no pending question — and it stays that way.
  it("a_goal_or_stall_attention_ends_the_turn", () => {
    for (const kind of ["goal_blocked", "goal_paused", "stalled", "interrupted_run"]) {
      const state = applyFrame({ ...initialState(), running: true, activity: "thinking" }, life(waits(kind)));
      expect(state, kind).toMatchObject({ running: false, activity: "idle" });
    }
    expect(applyFrame(initialState(), life(waits("goal_blocked", "goal_paused")))).toMatchObject({ running: false, activity: "idle" });
  });

  it("a_question_or_approval_still_waits", () => {
    for (const kinds of [["question"], ["approval"], ["goal_blocked", "question"]]) {
      const state = applyFrame(initialState(), life(waits(...kinds)));
      expect(state, kinds.join("+")).toMatchObject({ running: true, activity: "waiting_human" });
    }
  });

  it("a_host_that_reports_no_waits_keeps_waiting", () => {
    expect(applyFrame(initialState(), life({ state: "waiting_human", runId: "r1" }))).toMatchObject({ running: true, activity: "waiting_human" });
    expect(applyFrame(initialState(), life(waits()))).toMatchObject({ running: true, activity: "waiting_human" });
  });

  it("the_stopped_run_still_wins", () => {
    const stopped = life({ ...waits("question"), lastStop: { runId: "r1", cause: "aborted" } });
    expect(applyFrame({ ...initialState(), running: true }, stopped)).toMatchObject({ running: false, activity: "idle" });
  });

  // Measured live (omo 5.1.59, scratch host): both question shapes report waiting_human with a `question` human wait,
  // but a non-blocking one (waitForAnswer:false) also carries an `ask-user` wait in waitingOn.background — the turn has
  // ended, it is a standing invitation. A blocking one (waitForAnswer:true) carries no background wait: the turn runs.
  const askUserBackground = { source: "ask-user", activeCount: 1, items: [{ id: "toolu_1", label: "Color" }] };
  it("a_non_blocking_question_is_an_ended_turn_the_tab_is_idle", () => {
    const lifecycle = {
      state: "waiting_human",
      runId: "r1",
      waitingOn: { children: 0, background: [askUserBackground], human: [{ kind: "question", requestId: "toolu_1", revision: 1 }] },
    };
    expect(applyFrame({ ...initialState(), running: true, activity: "thinking" }, life(lifecycle))).toMatchObject({ running: false, activity: "idle" });
  });

  // Seen live (omo 5.1.64, 2026-11-11): a reply that ends by asking the person something ends the turn, and OmO raises a
  // `question` wait of its own, keyed `question:<runId>:<n>`, with no `ask-user` background wait and no tool call blocked.
  it("a_turn_that_ended_with_a_question_is_idle", () => {
    const lifecycle = {
      state: "waiting_human",
      runId: "r1",
      waitingOn: {
        children: 0,
        background: [{ source: "terminal-background-sessions", activeCount: 1 }],
        human: [{ kind: "question", requestId: "question:r1:1", revision: 1 }],
      },
    };
    expect(applyFrame({ ...initialState(), running: true, activity: "thinking" }, life(lifecycle))).toMatchObject({ running: false, activity: "idle" });
  });

  it("a_blocking_question_still_runs", () => {
    const lifecycle = {
      state: "waiting_human",
      runId: "r1",
      waitingOn: { children: 0, background: [], human: [{ kind: "question", requestId: "toolu_1", revision: 1 }] },
    };
    expect(applyFrame(initialState(), life(lifecycle))).toMatchObject({ running: true, activity: "waiting_human" });
  });

  /**
   * Seen live (2026-11-08): a non-blocking question was answered at 12:37 — the journal holds its `ask-user:settlement`
   * — yet every one of 25 reopens that followed put its card back, from OmO's `pendingQuestions`. The card could not be
   * closed for good: an answer came back «already resolved» and the next reopen showed it again.
   */
  describe("a question OmO already settled never comes back", () => {
    const REQUEST = "call_c3d6|fc_0caa";
    const asked = (id = "q1") => ({
      type: "extension_ui_request",
      method: "question",
      id,
      requestId: REQUEST,
      toolCallId: REQUEST,
      waitForAnswer: false,
      questions: [{ id: "a", header: "Перевод ZEC", question: "Пересобрали?" }],
    });
    const settlement = { type: "custom", customType: "ask-user:settlement", id: "e1", data: { requestId: REQUEST, status: "answered" } };

    it("the_journals_settlement_removes_the_card_the_open_state_listed", () => {
      const opened = applyFrame(initialState(), asked()); // `pendingQuestions` of open_session, applied first
      expect(opened.dialogs).toHaveLength(1);
      expect(applyEntries(opened, [settlement]).dialogs).toEqual([]);
    });

    it("once_settled_a_later_listing_of_it_is_ignored", () => {
      const settled = applyEntries(initialState(), [settlement]); // the journal of an earlier open
      expect(applyFrame(settled, asked("q-again")).dialogs).toEqual([]); // a reopen's stale `pendingQuestions`
      const resolved = applyFrame(applyFrame(initialState(), asked()), { type: "question_resolved", id: "q1", requestId: REQUEST, outcome: "answered" });
      expect(applyFrame(resolved, asked("q-again")).dialogs).toEqual([]);
    });

    it("a_settlement_appended_live_removes_the_card_too", () => {
      const opened = applyFrame(initialState(), asked());
      expect(applyFrame(opened, { type: "entry_appended", entry: settlement }).dialogs).toEqual([]);
    });

    it("another_question_is_not_touched", () => {
      const opened = applyFrame(initialState(), { ...asked("q2"), requestId: "other", toolCallId: "other" });
      expect(applyEntries(opened, [settlement]).dialogs).toHaveLength(1);
    });
  });

  it("a_question_frame_is_tagged_blocking_by_its_waitForAnswer", () => {
    const frame = (waitForAnswer: unknown) => ({
      type: "extension_ui_request",
      method: "question",
      id: "q1",
      ...(waitForAnswer === undefined ? {} : { waitForAnswer }),
      questions: [{ id: "a", question: "Pick?" }],
    });
    expect(applyFrame(initialState(), frame(false)).dialogs[0]).toMatchObject({ method: "question", blocking: false });
    expect(applyFrame(initialState(), frame(true)).dialogs[0]?.blocking).toBeUndefined();
    expect(applyFrame(initialState(), frame(undefined)).dialogs[0]?.blocking).toBeUndefined();
  });

  it("omo_s_english_resume_notice_never_reaches_the_feed", () => {
    const notify = (message: string) => applyFrame(initialState(), { type: "extension_ui_request", method: "notify", id: "n1", message, notifyType: "info" });
    for (const status of ["blocked", "paused"]) {
      expect(notify(`Goal remains ${status} after session resume. Resume it explicitly after the session finishes loading.`).blocks).toEqual([]);
    }
    expect(notify("Goal active\nObjective: ship it\nStatus: active").blocks).toHaveLength(1); // a card the person asked for
  });
});

describe("a provider refusal", () => {
  // Verbatim from the person's journal (2026-11-04T20:18:42Z, gw-anthropic/claude-opus-4-8).
  const PROVIDER_TEXT =
    "This request triggered cyber-related safeguards. To learn about the Cyber Verification Program and apply for access, " +
    "visit our help center: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.";
  const message = {
    role: "assistant",
    content: [],
    timestamp: 1793823520826,
    stopReason: "error",
    rawStopReason: "refusal",
    errorMessage: PROVIDER_TEXT,
    stopDetails: { type: "refusal", explanation: PROVIDER_TEXT },
    diagnostics: [{ type: "provider_retry_failure" }],
  };
  const notices = (state: ChatState) => state.blocks.filter((block): block is Extract<Block, { kind: "notice" }> => block.kind === "notice");

  it("ends_the_turn_with_one_russian_line_and_the_provider_s_words_folded_away", () => {
    const running: ChatState = { ...initialState(), running: true, activity: "thinking" };
    const state = applyFrame(running, { type: "message_end", message });
    expect(state).toMatchObject({ running: false, activity: "idle" });
    expect(state.error).toBeUndefined(); // no banner: the English sentence reaches nothing the person reads
    const lines = notices(state);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", text: "Модель отказалась отвечать на этот запрос — смените модель для этой сессии" });
    expect(lines[0]?.details).toBe(PROVIDER_TEXT);
  });

  it("the_journal_shows_the_same_one_line_and_a_catch_up_adds_no_second", () => {
    const live = applyFrame(initialState(), { type: "message_end", message });
    const reloaded = applyEntries(initialState(), [{ type: "message", id: "e1", message }]);
    expect(notices(reloaded).map((line) => line.id)).toEqual(notices(live).map((line) => line.id));
    expect(notices(reloaded)[0]?.details).toBe(PROVIDER_TEXT);
    expect(notices(applyEntries(live, [{ type: "message", id: "e1", message }]))).toHaveLength(1);
  });

  it("an_ordinary_turn_error_still_reaches_the_banner", () => {
    const state = applyFrame(initialState(), { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 upstream" } });
    expect(state.error).toBe("503 upstream");
    expect(notices(state)).toEqual([]);
  });
});

describe("a provider rejection", () => {
  /**
   * Verbatim from the person's journal — `tg_channels_manager`, 2026-11-04T18:51:29Z line 608, `gw-openai/gpt-6-astra`.
   * Nothing typed on it: the 0.4.14 refusal detector cannot see it, so its English sentence went to the red banner.
   */
  const PROVIDER_TEXT =
    "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. " +
    "If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access " +
    "via https://platform.openai.com/settings/organization/status-and-access before retrying.";
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "…" }],
    api: "openai-responses",
    provider: "gw-openai",
    model: "gpt-6-astra",
    timestamp: 1793880180189,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason: "error",
    errorMessage: PROVIDER_TEXT,
    timing: { requestedAt: 1793880159994, firstTokenAt: 1793880178285, lastTokenAt: 1793880178285, endedAt: 1793880180189, generationMs: 1 },
  };
  const notices = (state: ChatState) => state.blocks.filter((block): block is Extract<Block, { kind: "notice" }> => block.kind === "notice");

  it("reads_as_the_quiet_russian_line_and_never_as_the_banner", () => {
    const running: ChatState = { ...initialState(), running: true, activity: "thinking" };
    const state = applyFrame(running, { type: "message_end", message });
    expect(state.error).toBeUndefined(); // the whole point: this English sentence reached the red banner before
    expect(state).toMatchObject({ running: false, activity: "idle" });
    const lines = notices(state);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", text: "Провайдер отклонил запрос — смените модель для этой сессии" });
    expect(lines[0]?.details).toBe(PROVIDER_TEXT);
  });

  it("the_thinking_the_model_did_before_it_was_rejected_is_kept_and_carries_no_prose", () => {
    const bubbles = applyFrame(initialState(), { type: "message_end", message }).blocks.filter((block) => block.kind === "assistant");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ text: "", thinking: "…", streaming: false });
  });

  it("the_journal_shows_the_same_one_line_and_a_catch_up_adds_no_second", () => {
    const live = applyFrame(initialState(), { type: "message_end", message });
    const reloaded = applyEntries(initialState(), [{ type: "message", id: "e1", message }]);
    expect(notices(reloaded).map((line) => line.id)).toEqual(notices(live).map((line) => line.id));
    expect(notices(reloaded)[0]?.details).toBe(PROVIDER_TEXT);
    expect(notices(applyEntries(live, [{ type: "message", id: "e1", message }]))).toHaveLength(1);
  });

  it("the_shapes_that_only_look_like_it_still_reach_the_banner", () => {
    // every one of these carries totalTokens 0 and words of its own; none of them ever began a response
    const near = [
      { ...message, content: [], errorMessage: "Our servers are currently overloaded. Please try again later.", timing: { requestedAt: 1, endedAt: 10_007 } },
      { ...message, content: [], errorMessage: "Idle timeout waiting for provider stream after 300000ms", timing: { requestedAt: 1, endedAt: 300_565 } },
      { ...message, providerDiagnostic: { category: "rate_limit", code: "rate_limit_error", httpStatus: 429 } },
      { ...message, providerDiagnostic: { category: "context_limit", code: "context_length_exceeded" } },
      { ...message, providerDiagnostic: { category: "auth", code: "invalid_api_key" } },
    ];
    for (const candidate of near) {
      const state = applyFrame(initialState(), { type: "message_end", message: candidate });
      expect(state.error).toBe(candidate.errorMessage);
      expect(notices(state)).toEqual([]);
    }
  });
});

describe("housekeeping notices", () => {
  const notify = (message: string, notifyType?: string) =>
    applyFrame(initialState(), { type: "extension_ui_request", method: "notify", id: `n:${message}`, message, ...(notifyType === undefined ? {} : { notifyType }) });

  it("hot_reload_chatter_never_reaches_the_feed", () => {
    for (const text of ["Hot-reloading: /a/models.json", "Hot-reloaded: /a/models.json", "Reloading settings"]) {
      expect(notify(text).blocks).toEqual([]);
    }
  });

  it("a_warning_or_error_about_the_same_file_still_shows", () => {
    expect(notify("Hot-reload failed: /a/models.json", "error").blocks).toHaveLength(1);
    expect(notify("Reloading stopped", "warning").blocks).toHaveLength(1);
  });

  it("an_ordinary_notice_still_shows", () => {
    expect(notify("Сервер вернул 500").blocks).toHaveLength(1);
  });
});

/**
 * The two ways OmO records an answer to `ask_user_question`, both measured against a live host (see
 * test/live/answeredQuestion.live.test.ts): with `waitForAnswer: false` the answer arrives as a user message of protocol
 * text whose questions live only in the call's arguments, and with `waitForAnswer: true` the call's own result carries
 * questions and answers together. Either way the feed gets one answer card and never OmO's wording.
 */
describe("chat reducer: an answered question", () => {
  const ID = "toolu_01Ch2MZAiBWY6S1fa8Lm31mg";
  const CACHE = {
    header: "Кэш",
    question: "Как хранить кэш каталога?",
    multiSelect: false,
    options: [
      { label: "TTL и запасной кэш", description: "Кэш с временем жизни и запасным слоем" },
      { label: "Только на диске", description: "Кэш хранится в файлах на диске" },
      { label: "Без кэша" },
    ],
  };
  const KEY = {
    header: "Ключ",
    question: "Какой ключ использовать?",
    multiSelect: false,
    options: [
      { label: "age", description: "Современное шифрование age" },
      { label: "gpg", description: "Шифрование через GnuPG" },
    ],
  };
  const QUESTIONS = [CACHE, KEY];

  /** OmO's own answer text, part for part as it writes it: a chosen option, then words in a section of their own. */
  const ANSWER_PARTS = [
    { type: "text", text: `[Answer to question ${ID}]\nКэш: Только на диске\nКлюч: (see [The user's answer to Ключ for question ${ID}] below)` },
    { type: "text", text: `[The user's answer to Ключ for question ${ID}]` },
    { type: "text", text: "не понимаю что это" },
  ];
  const RAW = ANSWER_PARTS.map((part) => part.text).join("");

  const prompt = (text: string, id = "c1") => ({ type: "message", id: "e1", message: { role: "user", content: text, clientMessageId: id, timestamp: 1 } });
  const call = (questions: unknown[] = QUESTIONS) => ({
    type: "message",
    id: "e2",
    message: { role: "assistant", content: [{ type: "toolCall", id: ID, name: "ask_user_question", arguments: { questions, waitForAnswer: false } }], timestamp: 2 },
  });
  const accepted = () => ({
    type: "message",
    id: "e3",
    message: {
      role: "toolResult",
      toolCallId: ID,
      toolName: "ask_user_question",
      content: [{ type: "text", text: "Question accepted; the answer will arrive as a user message." }],
      details: { accepted: true, requestId: ID, status: "pending" },
    },
  });
  const answerEntry = (parts: unknown[] = ANSWER_PARTS) => ({ type: "message", id: "e4", message: { role: "user", content: parts, timestamp: 4 } });

  const card = (state: ChatState) => state.blocks.flatMap((block) => ((block.kind === "user" || block.kind === "tool") && block.answer ? [block.answer] : []));

  it("a_journal_answer_becomes_a_card_of_the_questions_options_and_descriptions", () => {
    const state = applyEntries(initialState(), [prompt("почини каталог"), call(), accepted(), answerEntry()]);
    expect(card(state)).toEqual([
      {
        questionId: ID,
        forkFrom: "c1",
        questions: [
          {
            header: "Кэш",
            text: "Как хранить кэш каталога?",
            options: [
              { label: "TTL и запасной кэш", description: "Кэш с временем жизни и запасным слоем", chosen: false },
              { label: "Только на диске", description: "Кэш хранится в файлах на диске", chosen: true },
              { label: "Без кэша", chosen: false },
            ],
          },
          {
            header: "Ключ",
            text: "Какой ключ использовать?",
            options: [
              { label: "age", description: "Современное шифрование age", chosen: false },
              { label: "gpg", description: "Шифрование через GnuPG", chosen: false },
            ],
            words: "не понимаю что это",
          },
        ],
      },
    ]);
    // the answer's own block keeps OmO's text (the queue is matched by it), and the call shows no JSON of its own
    const answered = state.blocks.find((block) => block.kind === "user" && block.answer !== undefined);
    expect(answered?.kind === "user" && answered.text).toBe(RAW);
    expect(tools(state).find((block) => block.name === "ask_user_question")?.input).toBeUndefined();
  });

  it("a_question_left_alone_is_in_the_card_as_unanswered", () => {
    const text = `[Answer to question ${ID}]\nКэш: Без кэша\nUnanswered: Ключ`;
    const state = applyEntries(initialState(), [prompt("почини каталог"), call(), accepted(), answerEntry([{ type: "text", text }])]);
    const [answer] = card(state);
    expect(answer?.questions.map((question) => [question.header, question.skipped === true])).toEqual([
      ["Кэш", false],
      ["Ключ", true],
    ]);
    expect(answer?.questions[1]?.options?.every((option) => !option.chosen)).toBe(true);
  });

  it("a_question_the_agent_waited_on_builds_the_same_card_from_its_own_result", () => {
    const result = {
      type: "message",
      id: "e3",
      message: {
        role: "toolResult",
        toolCallId: ID,
        toolName: "ask_user_question",
        content: [{ type: "text", text: `Кэш: Только на диске\nКлюч: (see [The user's answer to Ключ for question ${ID}] below)` }],
        details: {
          questions: QUESTIONS,
          answers: { "Как хранить кэш каталога?": "Только на диске", "Какой ключ использовать?": "не понимаю что это" },
          unanswered: [],
          status: "answered",
        },
      },
    };
    const state = applyEntries(initialState(), [prompt("почини каталог"), call(), result]);
    const [answer] = card(state);
    expect(answer?.forkFrom).toBe("c1");
    expect(answer?.questions[0]?.options?.find((option) => option.chosen)?.label).toBe("Только на диске");
    expect(answer?.questions[1]?.words).toBe("не понимаю что это");
    expect(answer?.questions[1]?.options?.map((option) => option.description)).toEqual(["Современное шифрование age", "Шифрование через GnuPG"]);
  });

  it("live_frames_build_the_card_as_the_journal_does", () => {
    const asked = applyFrame(
      applyFrame(initialState(), { type: "message_start", message: { role: "user", content: "почини каталог", clientMessageId: "c1", timestamp: 1 } }),
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCall: { id: ID, name: "ask_user_question", arguments: { questions: QUESTIONS } } } },
    );
    const answered = applyFrame(asked, { type: "message_start", message: { role: "user", content: ANSWER_PARTS, timestamp: 4 } });
    const [answer] = card(answered);
    expect(answer?.questionId).toBe(ID);
    expect(answer?.forkFrom).toBe("c1");
    expect(answer?.questions.map((question) => question.header)).toEqual(["Кэш", "Ключ"]);

    // and the other way round: the call the agent waited on, settled by its own result frame
    const waited = applyFrame(asked, {
      type: "tool_execution_end",
      toolCallId: ID,
      toolName: "ask_user_question",
      result: { content: [{ type: "text", text: "Кэш: Без кэша" }], details: { questions: QUESTIONS, answers: { "Как хранить кэш каталога?": "Без кэша" }, status: "answered" } },
    });
    expect(card(waited)[0]?.questions[0]?.options?.find((option) => option.chosen)?.label).toBe("Без кэша");
  });

  it("an_answer_waiting_in_omos_queue_is_already_a_card", () => {
    const asked = applyEntries(initialState(), [prompt("почини каталог"), call(), accepted()]);
    const queued = applyFrame(asked, { type: "queue_update", ordered: [{ text: RAW, queuedId: "q_1" }] });
    const waiting = queued.blocks.find((block) => block.kind === "user" && block.delivery !== undefined);
    expect(waiting?.kind === "user" && waiting.answer?.questions[0]?.text).toBe("Как хранить кэш каталога?");
  });

  it("an_answer_whose_question_is_gone_keeps_the_words_and_invents_nothing", () => {
    const state = applyEntries(initialState(), [prompt("почини каталог"), answerEntry()]);
    expect(card(state)).toEqual([
      {
        questionId: ID,
        forkFrom: "c1",
        questions: [
          { header: "Кэш", words: "Только на диске" },
          { header: "Ключ", words: "не понимаю что это" },
        ],
      },
    ]);
  });

  it("an_ordinary_message_that_merely_mentions_the_wording_is_still_a_message", () => {
    const state = applyEntries(initialState(), [prompt("смотри: [Answer to question …] — что это за текст?")]);
    expect(card(state)).toEqual([]);
  });
});
