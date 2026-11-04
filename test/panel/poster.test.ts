import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFrame, initialState } from "../../src/chat/reducer";
import { StatePoster } from "../../src/panel/poster";
import type { Block } from "../../src/chat/model";
import type { StateDelta, StateMessage } from "../../src/panel/protocol";

const SECRET = "gw-secret-token-42";

function message(text: string): StateMessage {
  return {
    type: "state",
    state: { ...initialState(), blocks: [{ kind: "notice", id: "n1", level: "info", text }] },
    tab: { modelMode: "auto" },
    reconnectable: true,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("StatePoster", () => {
  it("state_message_is_redacted_before_post", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), [SECRET, 'quo"te-secret']);

    poster.push(message(`token ${SECRET} and quo"te-secret here`));

    expect(posted).toHaveLength(1);
    const json = posted[0] as string;
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('quo\\"te-secret');
    const parsed = JSON.parse(json) as StateMessage;
    const block = parsed.state.blocks[0];
    expect(block?.kind === "notice" && block.text).toBe("token ‹redacted› and ‹redacted› here");
  });

  it("literal_and_numeric_secrets_keep_the_message_valid", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), ["true", "2000", "user", "auto"]);
    const state: StateMessage["state"] = {
      ...initialState(),
      running: true,
      model: { provider: "true-gw", id: "m-2000" },
      blocks: [
        { kind: "user", id: "u-2000", text: "wait 2000 ms, true" },
        { kind: "tool", id: "true-1", name: "bash", summary: "", args: { timeout: 2000, flag: true }, output: "", truncated: false, state: "ok" },
      ],
      dialogs: [{ id: "d-true", method: "confirm", title: "ok?" }],
    };

    poster.push({ type: "state", state, tab: { modelMode: "auto" }, reconnectable: true });

    const parsed = JSON.parse(posted[0] as string) as StateMessage;
    expect(parsed.state.running).toBe(true);
    expect(parsed.reconnectable).toBe(true);
    expect(parsed.tab.modelMode).toBe("auto");
    expect(parsed.state.model).toEqual({ provider: "true-gw", id: "m-2000" });
    expect(parsed.state.blocks.map((block) => [block.kind, block.id])).toEqual([
      ["user", "u-2000"],
      ["tool", "true-1"],
    ]);
    const [user, tool] = parsed.state.blocks;
    expect(user?.kind === "user" && user.text).toBe("wait ‹redacted› ms, ‹redacted›");
    expect(tool).not.toHaveProperty("args"); // tool args never leave the host
    expect(parsed.state.dialogs[0]?.id).toBe("d-true");
  });

  it("free_form_payloads_are_redacted_whatever_their_keys", () => {
    const posted: string[] = [];
    const secret = "sekrit-value";
    const poster = new StatePoster((json) => posted.push(json), [secret]);
    const sessionPath = `/agent/${secret}/s.jsonl`;
    const state: StateMessage["state"] = {
      ...initialState(),
      blocks: [
        {
          kind: "tool",
          id: `tool-${secret}`,
          name: "bash",
          summary: "",
          args: { id: secret, status: secret, sessionPath: secret, nested: { type: secret, kind: [secret] } },
          output: "",
          truncated: false,
          state: "ok",
        },
      ],
      dialogs: [{ id: `d-${secret}`, method: "question", title: "q", questions: [{ id: secret, question: secret }] }],
    };

    poster.push({ type: "state", state, tab: { sessionPath, modelMode: "auto" }, reconnectable: true });

    const json = posted[0] as string;
    const parsed = JSON.parse(json) as StateMessage;
    const tool = parsed.state.blocks[0];
    expect(tool).not.toHaveProperty("args");
    expect(parsed.state.dialogs[0]?.questions).toEqual([{ id: "‹redacted›", question: "‹redacted›" }]);
    // the host's own structural fields stay intact
    expect(tool?.id).toBe(`tool-${secret}`);
    expect(parsed.state.dialogs[0]?.id).toBe(`d-${secret}`);
    expect(parsed.tab.sessionPath).toBe(sessionPath);
  });

  it("immediate_messages_are_redacted_too", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), [SECRET]);
    poster.push(message("first"));
    poster.send({ type: "sent", id: "1", ok: false });
    expect(posted).toHaveLength(2);
    expect(JSON.parse(posted[1] as string)).toEqual({ type: "sent", id: "1", ok: false });
  });

  it("session_path_survives_redaction_for_restore", () => {
    const posted: string[] = [];
    const agentDir = "/Users/me/.omo/agent";
    const poster = new StatePoster((json) => posted.push(json), [agentDir]);
    const sessionPath = `${agentDir}/sessions/--p--/s.jsonl`;

    poster.push({ ...message(`wrote ${agentDir}/x`), tab: { sessionPath, modelMode: "manual", title: `about ${agentDir}` } });

    const parsed = JSON.parse(posted[0] as string) as StateMessage;
    expect(parsed.tab).toEqual({ sessionPath, modelMode: "manual", title: "about ‹redacted›" });
    expect(JSON.stringify(parsed.state)).not.toContain(agentDir);
  });

  it("posts_at_most_every_50ms_and_keeps_the_latest", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), []);

    poster.push(message("one"));
    poster.push(message("two"));
    poster.push(message("three"));
    expect(posted).toHaveLength(1);

    vi.advanceTimersByTime(49);
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("three");
    expect(posted.join()).not.toContain("two");
  });

  it("a_reply_never_overtakes_the_state_waiting_for_its_turn", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), []);
    poster.push(message("one"));
    poster.push(message("two"));
    poster.send({ type: "sent", id: "m1", ok: true });
    expect(posted.map((json) => (JSON.parse(json) as { type: string }).type)).toEqual(["state", "delta", "sent"]);
    expect(posted[1]).toContain("two");
    vi.advanceTimersByTime(100);
    expect(posted).toHaveLength(3);
  });

  it("a_messages_delivery_survives_redaction", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), ["queued", "q_1"]);
    const state = { ...initialState(), blocks: [{ kind: "user", id: "m1", text: "x", delivery: { state: "queued", queuedId: "q_1", revision: 2 } } as Block] };
    poster.push({ type: "state", state, tab: { modelMode: "auto" }, reconnectable: true });
    expect((JSON.parse(posted[0] as string) as StateMessage).state.blocks[0]).toEqual(state.blocks[0]);
  });

  it("dispose_drops_a_pending_post", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), []);
    poster.push(message("one"));
    poster.push(message("two"));
    poster.dispose();
    vi.advanceTimersByTime(100);
    expect(posted).toHaveLength(1);
  });

  it("image_data_url_bypasses_redaction_but_other_fields_do_not", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), ["QUJD"]);
    poster.send({ type: "image", id: "i1", dataUrl: "data:image/png;base64,QUJD" });
    expect(JSON.parse(posted[0] as string)).toEqual({ type: "image", id: "i1", dataUrl: "data:image/png;base64,QUJD" });
  });

  it("commands_and_thinking_levels_are_structural", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), ["skill", "high", SECRET]);
    poster.send({
      ...message("x"),
      commands: [{ name: `run-${SECRET}`, description: `d ${SECRET}`, source: "skill", syntax: "slash" }],
      thinkingLevels: ["low", "high"],
    });
    const parsed = JSON.parse(posted[0] as string) as StateMessage;
    expect(parsed.commands).toEqual([{ name: "run-‹redacted›", description: "d ‹redacted›", source: "skill", syntax: "slash" }]);
    expect(parsed.thinkingLevels).toEqual(["low", "high"]);
  });

  it("session_items_keep_ids_and_redact_titles", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), [SECRET]);
    poster.send({
      type: "sessions",
      items: [{ sessionPath: "/s/a.jsonl", durableId: "d-1", title: `t ${SECRET}`, updatedAt: 1, running: false, pinned: true, archived: false, current: false }],
    });
    const item = (JSON.parse(posted[0] as string) as { items: Record<string, unknown>[] }).items[0];
    expect(item).toMatchObject({ sessionPath: "/s/a.jsonl", durableId: "d-1", title: "t ‹redacted›" });
  });

  it("first_post_is_a_full_state_then_deltas_carry_only_what_changed", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), []);
    const blocks: Block[] = Array.from({ length: 500 }, (_, index) =>
      index % 2 === 0
        ? { kind: "assistant", id: `a:${index}`, text: "Some markdown text ".repeat(50), thinking: "", streaming: false }
        : { kind: "tool", id: `t:${index}`, name: "read", summary: "x.ts", args: { path: "x.ts" }, output: "line\n".repeat(4_000), truncated: false, state: "ok" },
    );
    const live: Block = { kind: "assistant", id: "a:live", text: "Hel", thinking: "", streaming: true };
    const first: StateMessage = { type: "state", state: { ...initialState(), blocks: [...blocks, live], running: true }, tab: { modelMode: "auto" }, reconnectable: true };
    poster.push(first);
    vi.advanceTimersByTime(50);
    poster.push({ ...first, state: { ...first.state, blocks: [...blocks, { ...live, text: "Hello" }] } });

    expect(posted).toHaveLength(2);
    expect((JSON.parse(posted[0] as string) as StateMessage).type).toBe("state");
    const delta = JSON.parse(posted[1] as string) as StateDelta;
    expect(delta.type).toBe("delta");
    expect(delta.changed).toEqual([{ ...live, text: "Hello" }]);
    expect((posted[0] as string).length / (posted[1] as string).length).toBeGreaterThan(10);
  });

  it("reset_makes_the_next_post_a_full_state", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), []);
    poster.push(message("one"));
    poster.reset();
    vi.advanceTimersByTime(50);
    poster.push(message("one"));
    expect(posted.map((json) => (JSON.parse(json) as { type: string }).type)).toEqual(["state", "state"]);
  });

  it("deltas_are_redacted_drop_tool_args_and_keep_block_ids_verbatim", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), [SECRET, "a:1"]);
    const keep: Block = { kind: "user", id: "a:1", text: "first" };
    const gone: Block = { kind: "notice", id: "n:a:1", level: "info", text: "bye" };
    const base: StateMessage = { type: "state", state: { ...initialState(), blocks: [keep, gone] }, tab: { modelMode: "auto" }, reconnectable: true };
    poster.push(base);
    vi.advanceTimersByTime(50);
    const tool: Block = { kind: "tool", id: "t1", name: "write", summary: `a ${SECRET}`, args: { content: "WHOLE FILE" }, output: `out ${SECRET}`, truncated: false, state: "ok" };
    poster.push({ ...base, state: { ...base.state, blocks: [keep, tool], error: `boom ${SECRET}` } });

    const delta = JSON.parse(posted[1] as string) as StateDelta;
    expect(delta.removed).toEqual(["n:a:1"]);
    expect(delta.order).toEqual(["a:1", "t1"]);
    expect(delta.changed).toEqual([{ kind: "tool", id: "t1", name: "write", summary: "a ‹redacted›", output: "out ‹redacted›", truncated: false, state: "ok" }]);
    expect(delta.state.error).toBe("boom ‹redacted›");
    expect(posted[1]).not.toContain("WHOLE FILE");
  });

  it("the_settings_environment_path_is_shown_while_section_strings_stay_redacted", () => {
    const posted: string[] = [];
    const agentDir = "/Users/u/.omo-second/agent";
    const poster = new StatePoster((json) => posted.push(json), [agentDir, SECRET]);
    poster.send({ type: "settings", state: { env: { name: "second", agentDir }, connections: { agentDir: SECRET, note: `${agentDir}/keys` } } });
    expect(JSON.parse(posted[0] as string)).toEqual({
      type: "settings",
      state: { env: { name: "second", agentDir }, connections: { agentDir: "‹redacted›", note: "‹redacted›/keys" } },
    });
  });
});

describe("StatePoster: a tool step's input and output", () => {
  it("the_input_and_output_shown_in_a_tool_box_are_redacted", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), [SECRET]);
    const started = applyFrame(initialState(), { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: `curl -H "Authorization: ${SECRET}" x` } });
    const state = applyFrame(started, { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: `token=${SECRET}` }] }, isError: false });
    poster.push({ type: "state", state, tab: { modelMode: "auto" }, reconnectable: true });

    expect(posted[0]).not.toContain(SECRET);
    const tool = (JSON.parse(posted[0] as string) as StateMessage).state.blocks[0];
    expect(tool).toMatchObject({ input: 'curl -H "Authorization: ‹redacted›" x', output: "token=‹redacted›" });
  });

  it("a_secret_inside_a_diff_is_redacted_and_the_counts_survive", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), [SECRET]);
    const args = { path: `/repo/${SECRET}/.env`, edits: [{ oldText: "KEY=old", newText: `KEY=${SECRET}` }] };
    const state = applyFrame(initialState(), { type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args });
    poster.push({ type: "state", state, tab: { modelMode: "auto" }, reconnectable: true });

    expect(posted[0]).not.toContain(SECRET);
    const tool = (JSON.parse(posted[0] as string) as StateMessage).state.blocks[0];
    expect(tool).toMatchObject({ file: "/repo/‹redacted›/.env", input: "-KEY=old\n+KEY=‹redacted›", added: 1, removed: 1 });
  });
});

describe("message action posts", () => {
  it("rewind_preview_keeps_enum_words_and_redacts_paths", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), ["restore", "sekret-key-123", "changed"]);
    poster.send({
      type: "rewindPreview",
      blockId: "restore-1",
      fork: false,
      excerpt: "use sekret-key-123",
      ok: true,
      fingerprint: "restore-fp",
      items: [
        { path: "/x/sekret-key-123/a", action: "restore", changed: "yes" },
        { path: "b", action: "skip", reason: "не откатить: вне проекта", changed: "no" },
      ],
    });
    const parsed = JSON.parse(posted[0] as string) as { blockId: string; excerpt: string; items: { path: string; action: string; changed: string }[] };
    expect(parsed.blockId).toBe("restore-1");
    expect((parsed as unknown as { fingerprint: string }).fingerprint).toBe("restore-fp");
    expect(parsed.items[0]?.action).toBe("restore");
    expect(parsed.items[0]?.changed).toBe("yes");
    expect(parsed.items[0]?.path).not.toContain("sekret-key-123");
    expect(parsed.excerpt).not.toContain("sekret-key-123");
    poster.send({ type: "messageActions", blockId: "restore-1", fork: { ok: true }, rewind: { ok: false, reason: "has sekret-key-123" } });
    expect(posted[1]).not.toContain("sekret-key-123");
    expect(JSON.parse(posted[1] as string).blockId).toBe("restore-1");
  });

  it("draft_images_are_posted_unredacted_and_text_redacted", () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), ["QUJD", "image/png"]);
    poster.send({ type: "draft", text: "see QUJD", images: [{ data: "QUJD", mimeType: "image/png" }] });
    const parsed = JSON.parse(posted[0] as string) as { text: string; images: { data: string; mimeType: string }[] };
    expect(parsed.images).toEqual([{ data: "QUJD", mimeType: "image/png" }]);
    expect(parsed.text).not.toContain("QUJD");
  });
});
