import { describe, expect, it } from "vitest";
import { DEFER_QUESTION_COMMENT, isExternalLink, parseDeferredHostMessage, parseWebviewMessage, rejectedSendId } from "../../src/panel/protocol";

describe("parseWebviewMessage", () => {
  it("parses_deferred_actions_without_trusting_paths_or_blank_answers", () => {
    expect(parseWebviewMessage({ type: "listDeferred" })).toEqual({ type: "listDeferred" });
    expect(parseWebviewMessage({ type: "answerDeferredQuestion", id: "q", answers: ["  Файл  ", "Да"], sessionPath: "/untrusted" }))
      .toEqual({ type: "answerDeferredQuestion", id: "q", answers: ["Файл", "Да"] });
    expect(parseWebviewMessage({ type: "dismissDeferredQuestion", id: "q" })).toEqual({ type: "dismissDeferredQuestion", id: "q" });
    expect(parseWebviewMessage({ type: "answerDeferredApproval", id: "g", decision: "deny", message: "  Позже  " }))
      .toEqual({ type: "answerDeferredApproval", id: "g", decision: "deny", message: "Позже" });
    for (const answers of [[], [""], [" "], [1], ["x".repeat(2001)], Array(4).fill("a")]) {
      expect(parseWebviewMessage({ type: "answerDeferredQuestion", id: "q", answers })).toBeUndefined();
    }
    for (const id of ["", 1, "x".repeat(201)]) expect(parseWebviewMessage({ type: "dismissDeferredQuestion", id })).toBeUndefined();
    expect(parseWebviewMessage({ type: "answerDeferredApproval", id: "g", decision: "allow-always" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "answerDeferredApproval", id: "g", decision: "allow-once", message: "Нет" })).toBeUndefined();
  });
  it("validates_deferred_host_lists_and_confirmations_before_rendering", () => {
    const item = { kind: "question", id: "q", sessionPath: "/agent/sessions/q.jsonl", sessionTitle: "Сессия", createdAt: 1, deferredAt: 2,
      questions: [{ header: "Вопрос", question: "Где?", options: [{ label: "Здесь" }], multiSelect: false }], decided: "Здесь" };
    expect(parseDeferredHostMessage({ type: "deferred", items: [item] })).toEqual({ type: "deferred", items: [item] });
    expect(parseDeferredHostMessage({ type: "deferredResult", kind: "question", id: "q", ok: true })).toEqual({ type: "deferredResult", kind: "question", id: "q", ok: true });
    expect(parseDeferredHostMessage({ type: "deferredResult", kind: "approval", id: "g", ok: false, reason: "Нет связи" })).toMatchObject({ reason: "Нет связи" });
    for (const bad of [null, { type: "deferred", items: {} }, { type: "deferred", items: [{ ...item, questions: [null] }] },
      { type: "deferred", items: [{ ...item, createdAt: "now" }] }, { type: "deferred", items: [{ ...item, createdAt: 1e100 }] },
      { type: "deferred", items: [{ ...item, questions: [{ ...item.questions[0], options: [null] }] }] },
      { type: "deferredResult", id: "q", kind: "other", ok: true }, { type: "deferredResult", id: "q", kind: "question", ok: false },
      { type: "deferred", items: [], deliveries: [{ id: "g", kind: "approval", createdAt: 1, text: 2, reason: "Нет" }] }]) {
      expect(parseDeferredHostMessage(bad)).toBeUndefined();
    }
  });
  it("accepts_well_formed_messages", () => {
    expect(parseWebviewMessage({ type: "send", id: "1", text: "hi", mode: "followUp" })).toEqual({ type: "send", id: "1", text: "hi", mode: "followUp" });
    expect(parseWebviewMessage({ type: "setModel", model: { provider: "p", id: "m", extra: 1 } })).toEqual({ type: "setModel", model: { provider: "p", id: "m" } });
    expect(parseWebviewMessage({ type: "setMode", mode: "ulw" })).toEqual({ type: "setMode", mode: "ulw" });
    expect(parseWebviewMessage({ type: "setMode", mode: null })).toEqual({ type: "setMode", mode: null });
    expect(parseWebviewMessage({ type: "answer", dialogId: "d", answer: { answers: { q1: { selected: ["a"] } } } })).toEqual({
      type: "answer",
      dialogId: "d",
      answer: { answers: { q1: { selected: ["a"] } } },
    });
  });

  it("a_deferred_question_is_answered_with_a_comment_alone", () => {
    const comment = DEFER_QUESTION_COMMENT;
    expect(parseWebviewMessage({ type: "answer", dialogId: "d", answer: { answers: {}, comment } })).toEqual({ type: "answer", dialogId: "d", answer: { answers: {}, comment } });
    expect(parseWebviewMessage({ type: "answer", dialogId: "d", answer: { answers: {}, comment: 7 } })).toEqual({ type: "answer", dialogId: "d", answer: { answers: {} } });
    expect(parseWebviewMessage({ type: "answer", dialogId: "d", answer: { answers: {}, comment: "x".repeat(2001) } })).toBeUndefined();
  });

  it("an_answer_to_a_question_set_passes_through_as_omo_reads_it", () => {
    const answers = { q1: { selected: [], text: "свой ответ" }, q2: { selected: ["Юнит-тесты", "Линтер"], text: "snapshot" } };
    expect(parseWebviewMessage({ type: "answer", dialogId: "d", answer: { answers } })).toEqual({ type: "answer", dialogId: "d", answer: { answers } });
  });

  it("a_guard_deny_may_carry_words_for_the_agent_within_bounds", () => {
    expect(parseWebviewMessage({ type: "guardAnswer", id: "a", decision: "deny", message: "  иначе  " })).toEqual({ type: "guardAnswer", id: "a", decision: "deny", message: "иначе" });
    expect(parseWebviewMessage({ type: "guardAnswer", id: "a", decision: "deny", message: "x".repeat(2000) })).toMatchObject({ message: "x".repeat(2000) });
    expect(parseWebviewMessage({ type: "guardAnswer", id: "a", decision: "deny", message: "x".repeat(2001) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "guardAnswer", id: "a", decision: "deny", message: "  " })).toBeUndefined();
    expect(parseWebviewMessage({ type: "guardAnswer", id: "a", decision: "allow-once", message: "ok" })).toBeUndefined();
  });

  it("drops_malformed_messages", () => {
    expect(parseWebviewMessage({ type: "send", id: "1", text: 1, mode: "auto" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "send", text: "x", mode: "auto" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "send", id: "1", text: "x", mode: "steer" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "setModel", model: "gpt" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "setMode", mode: "foo" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "rm -rf" })).toBeUndefined();
    expect(parseWebviewMessage("send")).toBeUndefined();
  });

  it("only_web_links_are_external", () => {
    expect(isExternalLink("https://example.com")).toBe(true);
    expect(isExternalLink("command:workbench.action.reloadWindow")).toBe(false);
    expect(isExternalLink("file:///etc/passwd")).toBe(false);
  });

  it("open_file_takes_a_local_path_and_a_positive_line_never_a_uri", () => {
    expect(parseWebviewMessage({ type: "openFile", path: "/repo/src/a.ts", line: 12 })).toEqual({ type: "openFile", path: "/repo/src/a.ts", line: 12 });
    expect(parseWebviewMessage({ type: "openFile", path: "/repo/src/a.ts" })).toEqual({ type: "openFile", path: "/repo/src/a.ts" });
    expect(parseWebviewMessage({ type: "openFile", path: "C:\\repo\\a.ts" })).toEqual({ type: "openFile", path: "C:\\repo\\a.ts" });
    // a tool's own relative path: the host resolves it against the session's cwd
    expect(parseWebviewMessage({ type: "openFile", path: "shots/1180x820-dark-normal.png" })).toEqual({ type: "openFile", path: "shots/1180x820-dark-normal.png" });
    for (const path of ["command:workbench.action.reloadWindow", "file:///etc/passwd", "https://x.y/a", "/a\0b", "", 7]) {
      expect(parseWebviewMessage({ type: "openFile", path })).toBeUndefined();
    }
    for (const line of [0, -1, 1.5, "3"]) expect(parseWebviewMessage({ type: "openFile", path: "/a.ts", line })).toBeUndefined();
  });

  it("send_accepts_valid_images", () => {
    const images = [{ mimeType: "image/png", data: "QUJD", name: "a.png" }, { mimeType: "image/webp", data: "QUJD==" }];
    expect(parseWebviewMessage({ type: "send", id: "1", text: "x", mode: "auto", images })).toEqual({ type: "send", id: "1", text: "x", mode: "auto", images });
  });

  it("send_accepts_image_only_message", () => {
    const images = [{ mimeType: "image/png", data: "QUJD" }];
    expect(parseWebviewMessage({ type: "send", id: "1", text: "", mode: "auto", images })).toEqual({ type: "send", id: "1", text: "", mode: "auto", images });
  });

  it("send_rejects_images_over_the_per_message_total", () => {
    const base = { type: "send", id: "1", text: "x", mode: "auto" };
    const image = (chars: number) => ({ mimeType: "image/png", data: "A".repeat(chars) });
    expect(parseWebviewMessage({ ...base, images: [image(4_000_000), image(4_000_000), image(4_000_000)] })).toBeDefined(); // exactly 12 000 000
    expect(parseWebviewMessage({ ...base, images: [image(4_000_000), image(4_000_000), image(4_000_004)] })).toBeUndefined();
    expect(rejectedSendId({ ...base, images: [image(5_000_000), image(5_000_000), image(5_000_000)] })).toBe("1"); // still acked ok:false
  });

  it("send_rejects_six_images_and_bad_images", () => {
    const image = { mimeType: "image/png", data: "QUJD" };
    const base = { type: "send", id: "1", text: "x", mode: "auto" };
    expect(parseWebviewMessage({ ...base, images: Array(6).fill(image) })).toBeUndefined();
    expect(parseWebviewMessage({ ...base, images: Array(5).fill(image) })).toBeDefined();
    expect(parseWebviewMessage({ ...base, images: [image, { mimeType: "image/svg+xml", data: "QUJD" }] })).toBeUndefined();
    expect(parseWebviewMessage({ ...base, images: [{ mimeType: "image/png", data: "not base64!" }] })).toBeUndefined();
    expect(parseWebviewMessage({ ...base, images: [{ mimeType: "image/png", data: 5 }] })).toBeUndefined();
    expect(parseWebviewMessage({ ...base, images: "x" })).toBeUndefined();
    expect(parseWebviewMessage({ ...base, images: [{ mimeType: "image/png", data: "A".repeat(5_242_881) }] })).toBeUndefined();
    expect(parseWebviewMessage({ ...base, images: [{ mimeType: "image/png", data: "A".repeat(5_242_880) }] })).toBeDefined();
    expect(rejectedSendId({ ...base, images: Array(6).fill(image) })).toBe("1");
    expect(rejectedSendId({ type: "stop" })).toBeUndefined();
  });

  it("round_trips_the_new_messages", () => {
    const cases: unknown[] = [
      { type: "setThinking", level: "high" },
      { type: "rename", name: "n" },
      { type: "rename", name: "n", sessionPath: "/p" },
      { type: "pin", durableId: "d", pinned: true },
      { type: "archive", durableId: "d", archived: true },
      { type: "archive", durableId: "d", archived: false },
      { type: "listSessions" },
      { type: "openSession", sessionPath: "/p" },
      { type: "newSession" },
      { type: "forkSession" },
      { type: "restartHost" },
      { type: "compact" },
      { type: "getImage", id: "i" },
      { type: "agentOutput", taskId: "t" },
      { type: "agentCancel", taskId: "t" },
      { type: "agentDetails", taskId: "t" },
      { type: "unwedge" },
      { type: "unwedge", auto: true },
      { type: "ladderInterrupt" },
    ];
    for (const raw of cases) expect(parseWebviewMessage(raw)).toEqual(raw);
    expect(parseWebviewMessage({ type: "ladderInterrupt", nonsense: 1 })).toEqual({ type: "ladderInterrupt" });
    expect(parseWebviewMessage({ type: "unwedge", auto: "yes" })).toEqual({ type: "unwedge" }); // only a real flag asks for the automatic one
    expect(parseWebviewMessage({ type: "pin", durableId: "d", pinned: "yes" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "archive", durableId: "d", archived: "yes" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "archive", durableId: 7, archived: true })).toBeUndefined();
    expect(parseWebviewMessage({ type: "archive", archived: true })).toBeUndefined();
    expect(parseWebviewMessage({ type: "rename", name: 1 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "agentOutput" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "agentDetails", taskId: 7 })).toBeUndefined();
  });

  it("settings_messages_name_a_known_section_and_carry_an_object_action", () => {
    expect(parseWebviewMessage({ type: "settingsGet", extra: 1 })).toEqual({ type: "settingsGet" });
    expect(parseWebviewMessage({ type: "settingsAction", id: "a1", section: "tools", action: { kind: "x" }, extra: 1 })).toEqual({
      type: "settingsAction",
      id: "a1",
      section: "tools",
      action: { kind: "x" },
    });
    expect(parseWebviewMessage({ type: "settingsAction", id: "a1", section: "billing", action: {} })).toBeUndefined();
    expect(parseWebviewMessage({ type: "settingsAction", id: "a1", section: "tools", action: ["x"] })).toBeUndefined();
    expect(parseWebviewMessage({ type: "settingsAction", section: "tools", action: {} })).toBeUndefined();
  });
});

describe("message action requests", () => {
  it("parses_message_action_requests", () => {
    expect(parseWebviewMessage({ type: "messageActions", blockId: "c1" })).toEqual({ type: "messageActions", blockId: "c1" });
    expect(parseWebviewMessage({ type: "rewindPreview", blockId: "c1", fork: true })).toEqual({ type: "rewindPreview", blockId: "c1", fork: true });
    expect(parseWebviewMessage({ type: "rewind", blockId: "u:17", fork: false, fingerprint: "ab" })).toEqual({ type: "rewind", blockId: "u:17", fork: false, fingerprint: "ab" });
    expect(parseWebviewMessage({ type: "rewind", blockId: "u:17", fork: false })).toBeUndefined();
    expect(parseWebviewMessage({ type: "rewind", blockId: "u:17", fork: false, fingerprint: "f".repeat(129) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "fork", blockId: "c1", extra: 1 })).toEqual({ type: "fork", blockId: "c1" });
    expect(parseWebviewMessage({ type: "fork", blockId: "" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "messageActions", blockId: "x".repeat(201) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "messageActions", blockId: "x".repeat(200) })).toEqual({ type: "messageActions", blockId: "x".repeat(200) });
    expect(parseWebviewMessage({ type: "rewind", blockId: "c1", fork: "yes", fingerprint: "ab" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "rewindPreview", blockId: "c1" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "fork", blockId: 3 })).toBeUndefined();
  });
});

describe("queued message requests", () => {
  it("parses_dequeue_and_edit_of_a_queued_message", () => {
    expect(parseWebviewMessage({ type: "dequeue", blockId: "m1" })).toEqual({ type: "dequeue", blockId: "m1" });
    expect(parseWebviewMessage({ type: "editQueued", blockId: "m1", text: "new" })).toEqual({ type: "editQueued", blockId: "m1", text: "new" });
    expect(parseWebviewMessage({ type: "dequeue", blockId: "" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "editQueued", blockId: "m1" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "editQueued", blockId: "m1", text: "   " })).toBeUndefined();
  });

  it("a_send_id_becomes_the_messages_client_id_so_it_is_bounded", () => {
    expect(parseWebviewMessage({ type: "send", id: "", text: "x", mode: "auto" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "send", id: "x".repeat(201), text: "x", mode: "auto" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "send", id: "x".repeat(200), text: "x", mode: "auto" })).toMatchObject({ id: "x".repeat(200) });
  });
});
