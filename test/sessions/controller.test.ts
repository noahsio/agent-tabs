import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonManager, hostSocketPath } from "../../src/daemon";
import type { OmoEnv } from "../../src/env";
import { ImageStore } from "../../src/sessions/images";
import { SessionController } from "../../src/sessions/controller";
import { Checkpointer } from "../../src/rewind/checkpointer";
import { CheckpointStore } from "../../src/rewind/store";
import { FakeDaemon, type Frame } from "../helpers/fakeDaemon";
import { makeRepo } from "../helpers/gitRepo";

let daemon: FakeDaemon;
let manager: DaemonManager;
let controller: SessionController | undefined;

const SESSION_FILE = "/tmp/agent/sessions/--proj--/2026_abc.jsonl";

function envFor(agentDir: string): OmoEnv {
  return {
    env: { OMO_CODING_AGENT_DIR: agentDir, GW_API_KEY: "sekret-key-123", PATH: "/usr/bin" },
    agentDir,
    omoPath: "/fake/omo",
    secrets: ["sekret-key-123"],
  };
}

async function settle(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 400 && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

function openData(handle: string, extra: Record<string, unknown> = {}): unknown {
  return {
    sessionId: handle,
    state: {
      sessionFile: SESSION_FILE,
      sessionId: "durable-1",
      isStreaming: false,
      pendingDialogs: [],
      model: { provider: "gw", id: "m1" },
      ...extra,
    },
  };
}

function types(): string[] {
  return daemon.requests.map((request) => String(request["type"]));
}

function ofType(type: string): Frame[] {
  return daemon.requests.filter((request) => request["type"] === type);
}

beforeEach(async () => {
  daemon = await FakeDaemon.start();
  await mkdir(join(daemon.agentDir, "rpc"), { recursive: true });
  await symlink(daemon.socketPath, hostSocketPath(daemon.agentDir));
  manager = new DaemonManager(envFor(daemon.agentDir));
  daemon.on("open_session", () => ({ data: openData("rpc-1") }));
  daemon.on("get_entries", () => ({ data: { entries: [], hasMore: false } }));
  daemon.on("prompt", (request) => ({ data: { disposition: "started", clientMessageId: request["clientMessageId"] } }));
  daemon.on("steer", () => ({ data: { disposition: "queued" } }));
  daemon.on("follow_up", () => ({ data: { disposition: "queued" } }));
  daemon.on("abort", () => ({}));
  daemon.on("set_session_name", () => ({}));
  daemon.on("set_model", () => ({}));
  daemon.on("extension_ui_response", () => ({}));
  daemon.on("release_attachment", () => ({ data: { deferred: false } }));
});

afterEach(async () => {
  controller?.release();
  controller = undefined;
  manager.dispose();
  await daemon.stop();
});

function frame(extra: Frame): Frame {
  return { sessionId: "rpc-1", ...extra };
}

describe("SessionController", () => {
  it("create_opens_session_without_model", async () => {
    controller = await SessionController.create(manager, "/tmp");
    const open = ofType("open_session")[0] as Frame;
    expect(open).toMatchObject({ retain_on_disconnect: true, promptSurface: "app", auto_title: true });
    expect(typeof open["cwd"]).toBe("string");
    expect(open).not.toHaveProperty("provider");
    expect(open).not.toHaveProperty("modelId");
    expect(controller.tabState.sessionPath).toBe(SESSION_FILE);
    expect(controller.tabState.modelMode).toBe("auto");
    expect(controller.state.model).toEqual({ provider: "gw", id: "m1" });
  });

  it("attach_loads_paged_history_and_pending_dialogs", async () => {
    const page = (id: string, text: string): Frame => ({ type: "message", id, message: { role: "user", content: text, timestamp: Number(id.slice(1)) } });
    daemon.on("open_session", () => ({
      data: openData("rpc-1", {
        pendingDialogs: [{ type: "extension_ui_request", id: "d1", method: "confirm", title: "Sure?" }],
      }),
    }));
    daemon.on("get_entries", (request) =>
      request["since"] === undefined
        ? { data: { entries: [page("e1", "one")], hasMore: true, nextSince: "e1" } }
        : { data: { entries: [page("e2", "two")], hasMore: false } },
    );
    controller = await SessionController.attach(manager, SESSION_FILE);
    expect(ofType("open_session")[0]).toMatchObject({ sessionPath: SESSION_FILE, retain_on_disconnect: true });
    expect(ofType("get_entries").map((request) => request["limit"])).toEqual([500, 500]);
    expect(controller.state.blocks.map((block) => block.kind === "user" && block.text)).toEqual(["one", "two"]);
    expect(controller.state.dialogs.map((dialog) => dialog.id)).toEqual(["d1"]);
  });

  it("send_idle_uses_prompt_running_uses_steer", async () => {
    controller = await SessionController.create(manager, "/tmp");
    await controller.send("hello", "auto");
    expect(types()).toContain("prompt");
    const prompt = ofType("prompt")[0] as Frame;
    expect(prompt).toMatchObject({ message: "hello", sessionId: "rpc-1" });
    expect(typeof prompt["clientMessageId"]).toBe("string");
    daemon.push(frame({ type: "agent_start" }));
    await settle(() => controller?.state.running === true);
    await controller.send("more", "auto");
    const steer = ofType("steer")[0] as Frame;
    expect(steer).toMatchObject({ message: "more", sessionId: "rpc-1" });
    expect(steer["clientMessageId"]).not.toBe(prompt["clientMessageId"]);
    expect(ofType("prompt")).toHaveLength(1);
  });

  it("follow_up_mode_uses_follow_up", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.push(frame({ type: "agent_start" }));
    await settle(() => controller?.state.running === true);
    await controller.send("later", "followUp");
    expect(ofType("follow_up")[0]).toMatchObject({ message: "later", sessionId: "rpc-1" });
  });

  it("stop_cancels_dialogs_before_abort", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.push(frame({ type: "extension_ui_request", id: "d1", method: "select", title: "Perm", options: ["Allow once"] }));
    daemon.push(frame({ type: "extension_ui_request", id: "d2", method: "confirm", title: "Sure?" }));
    await settle(() => controller?.state.dialogs.length === 2);
    await controller.stop();
    expect(types().slice(-3)).toEqual(["extension_ui_response", "extension_ui_response", "abort"]);
    expect(ofType("extension_ui_response").map((request) => [request["uiRequestId"], request["cancelled"]])).toEqual([
      ["d1", true],
      ["d2", true],
    ]);
    expect(controller.state.dialogs).toEqual([]);
  });

  it("ignores_frames_of_other_sessions", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.push({ type: "session_info_changed", name: "other", sessionId: "rpc-9" });
    daemon.push(frame({ type: "session_info_changed", name: "mine" }));
    await settle(() => controller?.state.title === "mine");
    expect(controller.state.title).toBe("mine");
    expect(controller.tabState.title).toBe("mine");
  });

  it("reattaches_after_daemon_restart_without_resending", async () => {
    controller = await SessionController.create(manager, "/tmp");
    await controller.send("work", "auto");
    daemon.push(frame({ type: "entry_appended", entry: { id: "cur1", type: "custom", customType: "x" } }));
    await settle(() => controller?.state.cursor === "cur1");
    daemon.on("open_session", () => ({ data: openData("rpc-7", { isStreaming: true }) }));
    daemon.on("get_entries", () => ({
      data: { entries: [{ type: "message", id: "cur2", message: { role: "assistant", timestamp: 5, content: [{ type: "text", text: "DONE" }] } }], hasMore: false },
    }));
    const before = daemon.requests.length;
    await daemon.restart();
    manager.reconnectNow();
    await settle(() => daemon.requests.slice(before).some((request) => request["type"] === "get_entries"));
    const after = daemon.requests.slice(before);
    expect(after.filter((request) => request["type"] === "open_session")).toHaveLength(1);
    expect(after.find((request) => request["type"] === "open_session")).toMatchObject({ sessionPath: SESSION_FILE, retain_on_disconnect: true });
    expect(after.filter((request) => request["type"] === "get_entries")).toHaveLength(1);
    expect(after.find((request) => request["type"] === "get_entries")).toMatchObject({ since: "cur1", sessionId: "rpc-7" });
    expect(after.filter((request) => request["type"] === "prompt")).toHaveLength(0);
    await settle(() => controller?.state.cursor === "cur2");
    expect(controller.state.running).toBe(true);
    // frames now route by the new handle
    daemon.push({ type: "session_info_changed", name: "old", sessionId: "rpc-1" });
    daemon.push({ type: "session_info_changed", name: "new", sessionId: "rpc-7" });
    await settle(() => controller?.state.title === "new");
  });

  it("unknown_cursor_after_reconnect_reloads_everything", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.push(frame({ type: "entry_appended", entry: { id: "gone", type: "custom", customType: "x" } }));
    await settle(() => controller?.state.cursor === "gone");
    const calls: Frame[] = [];
    daemon.on("get_entries", (request) => {
      calls.push(request);
      return request["since"] === "gone"
        ? { errorCode: "not_found", error: "unknown cursor" }
        : { data: { entries: [{ type: "message", id: "f1", message: { role: "user", content: "fresh", timestamp: 1 } }], hasMore: false } };
    });
    await daemon.restart();
    manager.reconnectNow();
    await settle(() => controller?.state.cursor === "f1");
    expect(calls.map((request) => request["since"])).toEqual(["gone", undefined]);
    expect(controller.state.blocks).toHaveLength(1);
  });

  it("set_model_auto_uses_profile_model", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.push(
      frame({
        type: "entry_appended",
        entry: { id: "p1", type: "custom", customType: "omo-model-profile:applied", data: { details: { model: "gw/profile-model" } } },
      }),
    );
    await settle(() => controller?.state.autoModel !== undefined);
    await controller.setModel({ provider: "gw", id: "manual-1" });
    expect(controller.tabState.modelMode).toBe("manual");
    expect(ofType("set_model")[0]).toMatchObject({ provider: "gw", modelId: "manual-1", sessionId: "rpc-1" });
    await controller.setModel("auto");
    expect(controller.tabState.modelMode).toBe("auto");
    expect(ofType("set_model")[1]).toMatchObject({ provider: "gw", modelId: "profile-model" });
  });

  it("surfaces_prompt_error_in_view", async () => {
    daemon.on("prompt", () => ({ errorCode: "provider_credentials_missing", error: "Missing credentials for sekret-key-123" }));
    controller = await SessionController.create(manager, "/tmp");
    expect(await controller.send("hi", "auto")).toBe(false);
    expect(controller.state.error).toContain("Missing credentials");
    expect(controller.state.error).not.toContain("sekret-key-123");
  });

  it("send_reports_success", async () => {
    controller = await SessionController.create(manager, "/tmp");
    expect(await controller.send("hi", "auto")).toBe(true);
  });

  describe("a message on its way", () => {
    const userStart = (id: string, text: string): Frame => frame({ type: "message_start", message: { role: "user", content: [{ type: "text", text }], timestamp: 9, clientMessageId: id } });

    it("shows_at_once_as_sending_under_the_callers_id_and_becomes_the_real_message", async () => {
      daemon.on("prompt", () => ({ data: { disposition: "started" }, delayMs: 150 }));
      controller = await SessionController.create(manager, "/tmp");
      const sent = controller.send("hello", "auto", [], "m-1");
      expect(controller.state.blocks).toEqual([{ kind: "user", id: "m-1", text: "hello", delivery: { state: "sending" } }]);
      expect(await sent).toBe(true);
      expect(ofType("prompt")[0]).toMatchObject({ clientMessageId: "m-1" });
      daemon.push(userStart("m-1", "hello"));
      await settle(() => controller?.state.blocks[0]?.kind === "user" && controller.state.blocks[0].delivery === undefined);
      expect(controller.state.blocks).toHaveLength(1);
    });

    it("an_outgoing_image_shows_at_once_under_the_id_the_real_message_uses", async () => {
      controller = await SessionController.create(manager, "/tmp");
      const sent = controller.send("", "auto", [{ mimeType: "image/png", data: "QUJD", name: "a.png" }], "m-1");
      expect(controller.state.blocks[0]).toMatchObject({ images: [{ id: "m-1:0", mimeType: "image/png", name: "a.png" }] });
      expect(await controller.image("m-1:0")).toEqual({ mimeType: "image/png", data: "QUJD" });
      await sent;
    });

    it("a_refused_message_is_taken_back", async () => {
      daemon.on("prompt", () => ({ errorCode: "invalid", error: "nope" }));
      controller = await SessionController.create(manager, "/tmp");
      expect(await controller.send("hi", "auto", [], "m-1")).toBe(false);
      expect(controller.state.blocks).toEqual([]);
      expect(controller.state.error).toBe("nope");
    });

    it("a_message_a_command_handled_is_taken_back", async () => {
      daemon.on("prompt", () => ({ data: { disposition: "handled" } }));
      controller = await SessionController.create(manager, "/tmp");
      expect(await controller.send("/hooks list", "auto")).toBe(true);
      expect(controller.state.blocks).toEqual([]);
    });

    it("a_message_sent_while_a_prompt_starts_its_turn_goes_as_one_steer_and_the_next_idle_one_as_a_prompt", async () => {
      daemon.on("prompt", () => ({ data: { disposition: "started" }, delayMs: 80 }));
      controller = await SessionController.create(manager, "/tmp");
      const first = controller.send("one", "auto");
      const second = controller.send("two", "auto");
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(types().filter((type) => type === "prompt" || type === "steer")).toEqual(["prompt", "steer"]);
      daemon.push(frame({ type: "agent_settled" }));
      await settle(() => !controller?.state.blocks.some((block) => block.kind === "user" && block.delivery?.state === "sending"));
      await controller.send("three", "auto");
      expect(types().filter((type) => type === "prompt" || type === "steer")).toEqual(["prompt", "steer", "prompt"]);
    });
  });

  describe("a queued message", () => {
    async function queued(id: string, text: string, revision = 1): Promise<void> {
      daemon.push(frame({ type: "agent_start" }));
      await settle(() => controller?.state.running === true);
      await controller?.send(text, "auto", [{ mimeType: "image/png", data: "QUJD" }], id);
      daemon.push(frame({ type: "queue_update", ordered: [{ text, mode: "steer", queuedId: "q_1", revision, clientMessageId: id }] }));
      await settle(() => controller?.state.blocks.some((block) => block.kind === "user" && block.delivery?.state === "queued") === true);
    }

    it("taken_back_leaves_the_feed_and_returns_its_text_and_images", async () => {
      daemon.on("dequeue_message", (request) => ({ data: { queuedId: request["queuedId"], status: "removed" } }));
      controller = await SessionController.create(manager, "/tmp");
      await queued("m-1", "later");
      expect(await controller.dequeue("m-1")).toEqual({ outcome: "removed", text: "later", images: [{ mimeType: "image/png", data: "QUJD" }] });
      expect(ofType("dequeue_message")[0]).toMatchObject({ queuedId: "q_1", sessionId: "rpc-1" });
      expect(controller.state.blocks).toEqual([]);
    });

    it("already_handed_to_the_agent_stays_and_says_so", async () => {
      daemon.on("dequeue_message", () => ({ data: { queuedId: "q_1", status: "already_delivered", reason: "delivered", action: "none" } }));
      controller = await SessionController.create(manager, "/tmp");
      await queued("m-1", "later");
      expect(await controller.dequeue("m-1")).toEqual({ outcome: "delivered" });
      expect(controller.state.blocks.map((block) => block.id)).toEqual(["m-1"]);
    });

    it("a_failed_dequeue_lands_in_the_error_redacted", async () => {
      daemon.on("dequeue_message", () => ({ errorCode: "internal", error: "broke sekret-key-123" }));
      controller = await SessionController.create(manager, "/tmp");
      await queued("m-1", "later");
      expect(await controller.dequeue("m-1")).toEqual({ outcome: "failed" });
      expect(controller.state.error).toContain("broke");
      expect(controller.state.error).not.toContain("sekret-key-123");
    });

    it("edited_in_place_with_its_revision_and_taken_back_with_the_new_text", async () => {
      daemon.on("edit_queued_message", (request) => ({ data: { queuedId: "q_1", status: "edited", text: request["text"], revision: 2 } }));
      daemon.on("dequeue_message", () => ({ data: { queuedId: "q_1", status: "removed" } }));
      controller = await SessionController.create(manager, "/tmp");
      await queued("m-1", "old");
      expect(await controller.editQueued("m-1", "new")).toEqual({ outcome: "edited" });
      expect(ofType("edit_queued_message")[0]).toMatchObject({ queuedId: "q_1", text: "new", expectedRevision: 1 });
      expect(controller.state.blocks[0]).toMatchObject({ text: "new", delivery: { state: "queued", revision: 2 } });
      expect(await controller.dequeue("m-1")).toMatchObject({ outcome: "removed", text: "new" });
    });

    it("an_edit_that_lost_a_race_says_why_and_one_that_came_late_says_delivered", async () => {
      daemon.on("edit_queued_message", () => ({ data: { queuedId: "q_1", status: "conflict", currentRevision: 2, reason: "conflict" } }));
      controller = await SessionController.create(manager, "/tmp");
      await queued("m-1", "old");
      expect(await controller.editQueued("m-1", "new")).toEqual({ outcome: "failed" });
      expect(controller.state.error).toBe("Сообщение в очереди уже изменили — изменение не применено");
      daemon.on("edit_queued_message", () => ({ data: { queuedId: "q_1", status: "already_delivered" } }));
      expect(await controller.editQueued("m-1", "new")).toEqual({ outcome: "delivered" });
    });

    it("a_message_that_is_not_queued_any_more_is_delivered", async () => {
      controller = await SessionController.create(manager, "/tmp");
      expect(await controller.dequeue("nope")).toEqual({ outcome: "delivered" });
      expect(ofType("dequeue_message")).toHaveLength(0);
    });
  });

  describe("agents history", () => {
    const task = (id: string, status: string) => ({ task_id: id, name: id, status, created_at: "2026-11-04T11:40:26.000Z", updated_at: "2026-11-04T11:40:35.000Z" });
    const rows = () => controller?.state.agents.map((row) => [row.id, row.status]);

    it("attach_restores_the_agents_from_omo_task_list", async () => {
      daemon.on("extension_request", (request) =>
        request["name"] === "omo.task.list" ? { data: { parent_session_id: "durable-1", tasks: [task("st_a", "completed"), task("st_b", "running")] } } : { data: { kind: "not_found" } },
      );
      controller = await SessionController.attach(manager, SESSION_FILE);
      expect(ofType("extension_request")).toEqual([
        expect.objectContaining({ name: "omo.task.list", sessionId: "rpc-1", data: { parent_session_id: "durable-1" } }),
      ]);
      expect(rows()).toEqual([
        ["task:st_a", "done"],
        ["task:st_b", "running"],
      ]);
    });

    it("attach_keeps_the_journals_tasks_when_omo_no_longer_lists_them", async () => {
      const journal = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "task_journal.json"), "utf8"));
      daemon.on("get_entries", () => ({ data: { entries: journal, hasMore: false } }));
      daemon.on("extension_request", () => ({ data: { parent_session_id: "durable-1", tasks: [] } }));
      controller = await SessionController.attach(manager, SESSION_FILE);
      expect(rows()).toEqual([
        ["task:st_01a1a65e", "done"],
        ["task:st_01a1a65f", "done"],
      ]);
    });

    it("a_reattach_keeps_finished_agents_and_takes_omos_list_again", async () => {
      daemon.on("extension_request", () => ({ data: { parent_session_id: "durable-1", tasks: [] } }));
      controller = await SessionController.create(manager, "/tmp");
      daemon.push(frame({ type: "extension_event", name: "omo.task.updated", data: { parent_session_id: "durable-1", tasks: [task("st_a", "completed"), task("st_b", "running")] } }));
      daemon.push(frame({ type: "entry_appended", entry: { id: "cur1", type: "custom", customType: "x" } }));
      await settle(() => controller?.state.cursor === "cur1");
      daemon.on("open_session", () => ({ data: openData("rpc-7") }));
      // a cold host: OmO forgot the finished task and reports the other one done
      daemon.on("extension_request", () => ({ data: { parent_session_id: "durable-1", tasks: [task("st_b", "completed")] } }));
      const before = daemon.requests.length;
      await daemon.restart();
      manager.reconnectNow();
      await settle(() => controller?.state.agents.find((row) => row.id === "task:st_b")?.status === "done");
      expect(daemon.requests.slice(before).find((request) => request["type"] === "extension_request")).toMatchObject({ name: "omo.task.list", sessionId: "rpc-7" });
      expect(rows()).toEqual([
        ["task:st_a", "done"],
        ["task:st_b", "done"],
      ]);
    });

    it("an_omo_without_the_task_list_still_attaches", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      expect(ofType("extension_request")).toHaveLength(1);
      expect(controller.state.agents).toEqual([]);
      expect(controller.state.error).toBeUndefined();
    });
  });

  it("successful_reattach_clears_the_error", async () => {
    daemon.on("prompt", () => ({ errorCode: "socket_closed", error: "connection lost" }));
    controller = await SessionController.create(manager, "/tmp");
    await controller.send("hi", "auto");
    expect(controller.state.error).toBe("connection lost");
    daemon.push(frame({ type: "entry_appended", entry: { id: "cur1", type: "custom", customType: "x" } }));
    await settle(() => controller?.state.cursor === "cur1"); // reattach then catches up instead of reloading
    const before = daemon.requests.length;
    await daemon.restart();
    manager.reconnectNow();
    await settle(() => daemon.requests.slice(before).some((request) => request["type"] === "get_entries"));
    await settle(() => controller?.state.error === undefined);
    expect(daemon.requests.slice(before).find((request) => request["type"] === "get_entries")).toMatchObject({ since: "cur1" });
  });

  it("names_session_from_first_message", async () => {
    controller = await SessionController.create(manager, "/tmp");
    const long = "x".repeat(100);
    await controller.send(long, "auto");
    expect(ofType("set_session_name")).toHaveLength(1);
    expect(ofType("set_session_name")[0]).toMatchObject({ name: "x".repeat(60), sessionId: "rpc-1" });
    await controller.send("second", "auto");
    expect(ofType("set_session_name")).toHaveLength(1);
  });

  it("answers_dialogs_and_lists_models_and_releases", async () => {
    daemon.on("get_available_models", () => ({ data: { models: [{ provider: "gw", id: "m1", name: "M1", extra: 1 }] } }));
    controller = await SessionController.create(manager, "/tmp");
    daemon.push(frame({ type: "extension_ui_request", id: "q1", method: "question", questions: [{ id: "a", question: "Pick?" }] }));
    await settle(() => controller?.state.dialogs.length === 1);
    await controller.answer("q1", { answers: { a: { selected: ["red"] } } });
    expect(ofType("extension_ui_response")[0]).toMatchObject({ uiRequestId: "q1", sessionId: "rpc-1", answers: { a: { selected: ["red"] } }, comment: "" });
    daemon.push(frame({ type: "extension_ui_request", id: "q2", method: "question", questions: [{ id: "a", question: "Pick?", multiSelect: true }] }));
    await settle(() => controller?.state.dialogs.length === 1);
    await controller.answer("q2", { answers: { a: { selected: ["red", "blue"], text: "own words" } } });
    const own = ofType("extension_ui_response")[1] as Frame;
    expect(own).toMatchObject({ uiRequestId: "q2", answers: { a: { selected: ["red", "blue"], text: "own words" } }, comment: "" });
    expect("value" in own || "confirmed" in own).toBe(false);
    expect(controller.state.dialogs).toEqual([]);
    expect(await controller.models()).toEqual([{ provider: "gw", id: "m1", name: "M1" }]);
    controller.release();
    await settle(() => ofType("release_attachment").length === 1);
    expect(ofType("release_attachment")[0]).toMatchObject({ sessionId: "rpc-1" });
  });
  it("an_answer_to_a_dialog_omo_already_closed_drops_it_and_says_so", async () => {
    controller = await SessionController.create(manager, "/tmp");
    for (const [id, code] of [
      ["d1", "unknown_extension_ui_request"],
      ["d2", "question_already_resolved"],
    ] as const) {
      daemon.on("extension_ui_response", () => ({ error: "gone", errorCode: code }));
      daemon.push(frame({ type: "extension_ui_request", id, method: "confirm", title: "Sure?" }));
      await settle(() => controller?.state.dialogs.length === 1);
      expect(await controller.answer(id, { confirmed: true })).toBe("closed");
      expect(controller.state.dialogs).toEqual([]);
      expect(controller.state.error).toBeUndefined();
    }
    expect(controller.state.blocks.filter((block) => block.kind === "notice").map((block) => (block as { text: string }).text)).toEqual(["Запрос уже закрыт", "Запрос уже закрыт"]);
  });

  it("a_failed_answer_keeps_the_dialog_and_reports_failed", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.on("extension_ui_response", () => ({ error: "boom", errorCode: "internal" }));
    daemon.push(frame({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Sure?" }));
    await settle(() => controller?.state.dialogs.length === 1);
    expect(await controller.answer("d1", { confirmed: true })).toBe("failed");
    expect(controller.state.dialogs).toHaveLength(1);
    daemon.on("extension_ui_response", () => ({}));
    expect(await controller.answer("d1", { confirmed: true })).toBe("applied");
  });

  it("a_dialog_past_its_deadline_is_dropped", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.push(frame({ type: "extension_ui_request", id: "t1", method: "select", title: "Pick", options: ["a"], deadlineAtMs: Date.now() + 30 }));
    daemon.push(frame({ type: "extension_ui_request", id: "t2", method: "confirm", title: "Forever?" }));
    await settle(() => controller?.state.dialogs.length === 2);
    await settle(() => controller?.state.dialogs.length === 1);
    expect(controller.state.dialogs.map((dialog) => dialog.id)).toEqual(["t2"]);
  });

  it("send_during_reconnect_never_uses_stale_handle", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.on("open_session", () => ({ data: openData("rpc-7"), delayMs: 150 }));
    const before = daemon.requests.length;
    await daemon.restart();
    manager.reconnectNow();
    await settle(() => daemon.requests.slice(before).some((request) => request["type"] === "open_session"));
    await controller.send("while reattaching", "auto");
    const prompts = ofType("prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionId: "rpc-7" });
    // a foreign frame under the old handle's number must not leak in
    daemon.push({ type: "session_info_changed", name: "foreign", sessionId: "rpc-1" });
    daemon.push({ type: "session_info_changed", name: "mine", sessionId: "rpc-7" });
    await settle(() => controller?.state.title === "mine");
  });

  it("release_during_reconnect_releases_the_new_attachment", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.on("open_session", () => ({ data: openData("rpc-7"), delayMs: 150 }));
    const before = daemon.requests.length;
    await daemon.restart();
    manager.reconnectNow();
    await settle(() => daemon.requests.slice(before).some((request) => request["type"] === "open_session"));
    await controller.release();
    const releases = ofType("release_attachment");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ sessionId: "rpc-7" });
  });

  it("pending_questions_survive_a_reconnect", async () => {
    controller = await SessionController.create(manager, "/tmp");
    const question = { type: "extension_ui_request", id: "q9", method: "question", questions: [{ id: "a", question: "Pick?" }] };
    daemon.push(frame(question));
    await settle(() => controller?.state.dialogs.length === 1);
    daemon.on("open_session", () => ({ data: openData("rpc-7", { pendingQuestions: [question] }) }));
    await daemon.restart();
    manager.reconnectNow();
    await settle(() => ofType("open_session").length === 2);
    await settle(() => ofType("get_entries").length === 2);
    await settle(() => controller?.state.dialogs.map((dialog) => dialog.id).join() === "q9");
  });

  it("models_errors_are_redacted", async () => {
    daemon.on("get_available_models", () => ({ errorCode: "boom", error: "bad key sekret-key-123" }));
    controller = await SessionController.create(manager, "/tmp");
    await expect(controller.models()).rejects.toThrow(/bad key/);
    await expect(controller.models()).rejects.not.toThrow(/sekret-key-123/);
  });

  it("attach_keeps_saved_model_mode_and_title", async () => {
    controller = await SessionController.attach(manager, SESSION_FILE, { modelMode: "manual", title: "Saved", sessionPath: "/stale" });
    expect(controller.tabState).toEqual({ modelMode: "manual", title: "Saved", sessionPath: SESSION_FILE, durableId: "durable-1" });
  });

  it("reattach_after_a_failed_reopen_opens_the_session_exactly_once", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.on("open_session", () => ({ errorCode: "open_failed", error: "cannot open right now" }));
    daemon.dropConnections();
    manager.reconnectNow();
    await settle(() => controller?.state.error === "cannot open right now");
    expect(manager.connected).toBe(true);
    expect(controller.attached).toBe(false);
    daemon.on("open_session", () => ({ data: openData("rpc-9") }));
    const before = daemon.requests.length;
    await controller.reattach();
    const opens = daemon.requests.slice(before).filter((request) => request["type"] === "open_session");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ sessionPath: SESSION_FILE, retain_on_disconnect: true });
    expect(controller.attached).toBe(true);
    expect(controller.state.error).toBeUndefined();
    await controller.send("after", "auto");
    expect(ofType("prompt").at(-1)).toMatchObject({ sessionId: "rpc-9" });
  });

  it("a_reopen_whose_history_fails_releases_its_handle_and_can_be_reattached", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.on("open_session", () => ({ data: openData("rpc-5") }));
    daemon.on("get_entries", () => ({ errorCode: "io", error: "journal unreadable" }));
    daemon.dropConnections();
    manager.reconnectNow();
    await settle(() => controller?.state.error === "journal unreadable");
    await settle(() => ofType("release_attachment").some((request) => request["sessionId"] === "rpc-5"));
    expect(controller.attached).toBe(false);
    daemon.on("get_entries", () => ({ data: { entries: [], hasMore: false } }));
    daemon.on("open_session", () => ({ data: openData("rpc-6") }));
    await controller.reattach();
    expect(controller.attached).toBe(true);
    expect(controller.state.error).toBeUndefined();
  });

  it("reattach_while_attached_releases_the_old_handle_first", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.on("open_session", () => ({ data: openData("rpc-2") }));
    await controller.reattach();
    expect(ofType("release_attachment")).toEqual([expect.objectContaining({ sessionId: "rpc-1" })]);
    expect(ofType("open_session")).toHaveLength(2);
    expect(controller.attached).toBe(true);
  });

  it("reseed_with_an_idle_session_clears_streaming_and_running_marks", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.push(frame({ type: "agent_start" }));
    daemon.push(frame({ type: "message_start", message: { role: "assistant", timestamp: 7, content: [] } }));
    daemon.push(frame({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 10" } }));
    await settle(() => controller?.state.blocks.some((block) => block.kind === "tool" && block.state === "running") === true);
    expect(controller.state.blocks.some((block) => block.kind === "assistant" && block.streaming)).toBe(true);
    daemon.push(frame({ type: "entry_appended", entry: { id: "cur1", type: "custom", customType: "x" } }));
    await settle(() => controller?.state.cursor === "cur1");
    await daemon.restart(); // the turn ended while we were away; the journal has nothing new
    manager.reconnectNow();
    await settle(() => ofType("open_session").length === 2 && ofType("get_entries").length === 2);
    await settle(() => controller?.state.running === false);
    expect(controller.state.blocks.some((block) => block.kind === "assistant" && block.streaming)).toBe(false);
    expect(controller.state.blocks.some((block) => block.kind === "tool" && block.state === "running")).toBe(false);
  });

  it("attach_without_saved_state_infers_manual_mode_from_a_non_profile_model", async () => {
    daemon.on("get_entries", () => ({
      data: {
        entries: [{ id: "p1", type: "custom", customType: "omo-model-profile:applied", data: { details: { model: "gw/profile-model" } } }],
        hasMore: false,
      },
    }));
    controller = await SessionController.attach(manager, SESSION_FILE);
    expect(controller.state.autoModel).toEqual({ provider: "gw", id: "profile-model" });
    expect(controller.state.model).toEqual({ provider: "gw", id: "m1" });
    expect(controller.tabState.modelMode).toBe("manual");
  });

  it("attach_without_saved_state_keeps_auto_when_the_model_is_the_profile_one", async () => {
    daemon.on("get_entries", () => ({
      data: {
        entries: [{ id: "p1", type: "custom", customType: "omo-model-profile:applied", data: { details: { model: "gw/m1" } } }],
        hasMore: false,
      },
    }));
    controller = await SessionController.attach(manager, SESSION_FILE);
    expect(controller.tabState.modelMode).toBe("auto");
  });

  it("attach_with_saved_state_keeps_its_model_mode", async () => {
    daemon.on("get_entries", () => ({
      data: {
        entries: [{ id: "p1", type: "custom", customType: "omo-model-profile:applied", data: { details: { model: "gw/profile-model" } } }],
        hasMore: false,
      },
    }));
    controller = await SessionController.attach(manager, SESSION_FILE, { modelMode: "auto" });
    expect(controller.tabState.modelMode).toBe("auto");
  });

  it("entries_paging_stops_when_next_since_does_not_advance", async () => {
    daemon.on("get_entries", () => ({ data: { entries: [], hasMore: true, nextSince: "same" } }));
    controller = await SessionController.attach(manager, SESSION_FILE);
    expect(ofType("get_entries").map((request) => request["since"])).toEqual([undefined, "same"]);
  });
  describe("redesign requests", () => {
    it("send_with_images_puts_image_parts", async () => {
      controller = await SessionController.create(manager, "/tmp");
      await controller.send("look", "auto", [{ mimeType: "image/png", data: "QUJD", name: "a.png" }]);
      expect((ofType("prompt")[0] as Frame)["images"]).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
      await controller.send("plain", "followUp");
      expect(ofType("follow_up")[0]).not.toHaveProperty("images");
    });

    it("image_only_send_reaches_the_prompt_and_leaves_naming_to_the_first_text", async () => {
      controller = await SessionController.create(manager, "/tmp");
      expect(await controller.send("", "auto", [{ mimeType: "image/png", data: "QUJD" }])).toBe(true);
      expect(ofType("prompt")[0]).toMatchObject({ message: "", images: [{ type: "image", data: "QUJD", mimeType: "image/png" }] });
      expect(ofType("set_session_name")).toHaveLength(0);
      await controller.send("почему так?", "followUp");
      expect(ofType("set_session_name")[0]).toMatchObject({ name: "почему так?" });
    });

    it("thinking_level_set_and_listed", async () => {
      daemon.on("open_session", () => ({ data: openData("rpc-1", { thinkingLevel: "low" }) }));
      daemon.on("set_thinking_level", () => ({}));
      daemon.on("get_available_thinking_levels", () => ({ data: { levels: ["off", "low", "high"] } }));
      controller = await SessionController.create(manager, "/tmp");
      expect(controller.state.thinkingLevel).toBe("low");
      await controller.setThinkingLevel("high");
      expect(ofType("set_thinking_level")[0]).toMatchObject({ level: "high", sessionId: "rpc-1" });
      expect(controller.state.thinkingLevel).toBe("high");
      expect(await controller.thinkingLevels()).toEqual(["off", "low", "high"]);
    });

    it("context_tokens_seeded_from_the_open_state", async () => {
      daemon.on("open_session", () => ({ data: openData("rpc-1", { contextUsage: { tokens: 754_900, contextWindow: 1_000_000, percent: 75 } }) }));
      controller = await SessionController.create(manager, "/tmp");
      expect(controller.state.contextTokens).toBe(754_900);
    });

    it("context_window_and_auto_compaction_are_seeded_from_the_open_state", async () => {
      daemon.on("open_session", () =>
        ({ data: openData("rpc-1", { autoCompactionEnabled: false, contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null } }) }),
      );
      controller = await SessionController.create(manager, "/tmp");
      expect(controller.state).toMatchObject({ contextWindow: 1_000_000, autoCompaction: false });
      expect(controller.state.contextTokens).toBeUndefined();
    });

    it("agent_settled_refreshes_the_context_from_session_stats", async () => {
      controller = await SessionController.create(manager, "/tmp");
      daemon.on("get_session_stats", () => ({ data: { contextUsage: { tokens: 42_000, contextWindow: 200_000, percent: 21 } } }));
      daemon.push(frame({ type: "agent_settled" }));
      await settle(() => controller?.state.contextTokens === 42_000);
      expect(controller.state.contextWindow).toBe(200_000);
    });

    it("compact_sends_the_request_and_a_refused_one_lands_in_the_error", async () => {
      controller = await SessionController.create(manager, "/tmp");
      daemon.on("compact", () => ({ data: {} }));
      await controller.compact();
      expect(ofType("compact")[0]).toMatchObject({ sessionId: "rpc-1" });
      daemon.on("compact", () => ({ error: "nothing to compact", errorCode: "x" }));
      await controller.compact();
      expect(controller.state.error).toBe("nothing to compact");
    });

    it("thinking_level_failure_is_redacted_and_state_unchanged", async () => {
      daemon.on("set_thinking_level", () => ({ error: "bad sekret-key-123", errorCode: "x" }));
      controller = await SessionController.create(manager, "/tmp");
      await controller.setThinkingLevel("high");
      expect(controller.state.error).toBe("bad ‹redacted›"); // shown in the tab, not only logged
      expect(controller.state.thinkingLevel).toBeUndefined();
    });

    it("commands_mapped_to_rows", async () => {
      daemon.on("get_commands", () => ({
        data: {
          commands: [
            { name: "fix", description: "Fix", source: "prompt", syntax: "slash", sourceInfo: { path: "/x" } },
            { name: "skill:s", source: "skill", syntax: "dollar" },
            { name: "bogus", source: "weird", syntax: "slash" },
          ],
        },
      }));
      controller = await SessionController.create(manager, "/tmp");
      expect(await controller.commands()).toEqual([
        { name: "fix", description: "Fix", source: "prompt", syntax: "slash" },
        { name: "skill:s", source: "skill", syntax: "dollar" },
      ]);
    });

    it("rename_sends_set_session_name", async () => {
      controller = await SessionController.create(manager, "/tmp");
      await controller.rename("New name");
      expect(ofType("set_session_name")[0]).toMatchObject({ name: "New name", sessionId: "rpc-1" });
      expect(controller.state.title).toBe("New name");
    });

    it("task_output_and_cancel_use_durable_parent", async () => {
      daemon.on("extension_request", (request) => ({
        data: request["name"] === "omo.task.output" ? { kind: "full", transcript: "log text", snapshot: {} } : { kind: "cancelled" },
      }));
      controller = await SessionController.create(manager, "/tmp");
      expect(await controller.taskOutput("t1")).toBe("log text");
      await controller.cancelTask("t1");
      const [output, cancel] = ofType("extension_request").filter((request) => request["name"] !== "omo.task.list");
      expect(output).toMatchObject({
        name: "omo.task.output",
        sessionId: "rpc-1",
        data: { task_id: "t1", mode: "full", parent_session_id: "durable-1" },
      });
      expect(cancel).toMatchObject({ name: "omo.task.cancel", data: { task_id: "t1", parent_session_id: "durable-1" } });
    });

    it("image_served_from_store", async () => {
      const entry: Frame = {
        type: "message",
        id: "e1",
        message: { role: "user", clientMessageId: "u1", content: [{ type: "text", text: "hi" }, { type: "image", data: "QUJD", mimeType: "image/png" }] },
      };
      daemon.on("get_entries", () => ({ data: { entries: [entry], hasMore: false } }));
      controller = await SessionController.attach(manager, SESSION_FILE);
      const block = controller.state.blocks[0];
      const refId = block?.kind === "user" ? (block.images?.[0]?.id as string) : "";
      expect(await controller.image(refId)).toEqual({ mimeType: "image/png", data: "QUJD" });
      expect(await controller.image("unknown")).toBeUndefined();
      expect(ofType("get_media")).toHaveLength(0);
    });

    it("tabs_share_one_image_store_each_in_its_own_scope", async () => {
      const store = new ImageStore(1_000);
      const entry = (data: string): Frame => ({
        type: "message",
        id: "e1",
        message: { role: "user", clientMessageId: "u1", content: [{ type: "image", data, mimeType: "image/png" }] }, // same ids in both sessions
      });
      daemon.on("get_entries", () => ({ data: { entries: [entry("QUFB")], hasMore: false } }));
      const first = await SessionController.attach(manager, SESSION_FILE, undefined, store);
      daemon.on("open_session", () => ({ data: { sessionId: "rpc-2", state: { sessionFile: "/tmp/other.jsonl", isStreaming: false } } }));
      daemon.on("get_entries", () => ({ data: { entries: [entry("QkJC")], hasMore: false } }));
      const second = await SessionController.attach(manager, "/tmp/other.jsonl", undefined, store);
      const refId = (controller: SessionController): string => {
        const block = controller.state.blocks[0];
        return block?.kind === "user" ? (block.images?.[0]?.id as string) : "";
      };
      expect(refId(first)).toBe(refId(second));
      expect((await first.image(refId(first)))?.data).toBe("QUFB");
      expect((await second.image(refId(second)))?.data).toBe("QkJC");
      expect(store.size).toBe(2);
      await first.release();
      expect(store.size).toBe(1); // a closed tab's images leave the shared store
      expect((await second.image(refId(second)))?.data).toBe("QkJC");
      controller = second;
    });

    it.each([
      ["not_found", { kind: "not_found", reason: "Task not found." }, "Task not found."],
      ["unavailable", { kind: "unavailable", reason: "No active parent session." }, "No active parent session."],
      ["invalid_arguments", { kind: "invalid_arguments", reason: "bad sekret-key-123" }, "bad ‹redacted›"],
      ["no_progress", { kind: "no_progress", task_id: "t1" }, "no_progress"],
    ])("task_%s_envelope_throws_on_both_methods", async (_name, envelope, message) => {
      daemon.on("extension_request", () => ({ data: envelope }));
      controller = await SessionController.create(manager, "/tmp");
      await expect(controller.taskOutput("t1")).rejects.toThrow(message);
      await expect(controller.cancelTask("t1")).rejects.toThrow(message);
    });

    it("rename_closed_session_opens_and_closes", async () => {
      daemon.on("close_session", () => ({}));
      await SessionController.renameClosed(manager, SESSION_FILE, "Old one");
      expect(types().filter((type) => ["open_session", "set_session_name", "close_session"].includes(type))).toEqual([
        "open_session",
        "set_session_name",
        "close_session",
      ]);
      expect(ofType("open_session")[0]).toEqual(expect.objectContaining({ sessionPath: SESSION_FILE }));
      expect(ofType("open_session")[0]).not.toHaveProperty("retain_on_disconnect");
      expect(ofType("set_session_name")[0]).toMatchObject({ name: "Old one", sessionId: "rpc-1" });
      expect(ofType("close_session")[0]).toMatchObject({ sessionId: "rpc-1" });
    });

    it("rename_live_session_releases_instead_of_closing", async () => {
      daemon.on("open_session", () => ({ data: { sessionId: "rpc-7", attached: true, state: { sessionFile: SESSION_FILE } } }));
      daemon.on("release_attachment", () => ({}));
      daemon.on("close_session", () => ({}));
      await SessionController.renameClosed(manager, SESSION_FILE, "Live one");
      expect(ofType("close_session")).toHaveLength(0);
      expect(ofType("release_attachment")[0]).toMatchObject({ sessionId: "rpc-7" });
    });

    it("rename_closed_session_closes_even_when_rename_fails", async () => {
      daemon.on("close_session", () => ({}));
      daemon.on("set_session_name", () => ({ error: "nope sekret-key-123", errorCode: "x" }));
      await expect(SessionController.renameClosed(manager, SESSION_FILE, "n")).rejects.toThrow(/^(?!.*sekret-key-123)/);
      expect(ofType("close_session")).toHaveLength(1);
    });
  });

  describe("checkpoints", () => {
    let store: CheckpointStore;
    let checkpointer: Checkpointer;
    let repo: string;

    beforeEach(async () => {
      store = new CheckpointStore(daemon.agentDir);
      checkpointer = new Checkpointer({ store, agentDir: daemon.agentDir });
      repo = await makeRepo({ "a.txt": "a" });
      daemon.on("get_protocol_info", () => ({ data: { capabilities: ["tool_barrier"] } }));
      daemon.on("prompt", (request) => ({ data: { disposition: "started", toolBarrier: request["toolBarrier"] === undefined ? undefined : "armed" } }));
      daemon.on("release_tool_barrier", () => ({ data: { released: true } }));
    });

    async function goRunning(): Promise<void> {
      daemon.push(frame({ type: "agent_start" }));
      await settle(() => controller?.state.running === true);
    }

    /** The turn a prompt started runs and settles, as the host reports it: the next message is a prompt again. */
    async function endTurn(): Promise<void> {
      await goRunning();
      daemon.push(frame({ type: "agent_settled" }));
      await settle(() => controller?.state.running === false);
    }

    it("idle_send_in_a_git_project_arms_the_barrier_snapshots_and_releases", async () => {
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      expect(controller.cwd).toBe(realpathSync(repo));
      expect(controller.sessionUuid).toBe("durable-1");
      let pointsAtRelease = -1;
      daemon.on("release_tool_barrier", async () => {
        pointsAtRelease = (await store.read("durable-1")).points.size;
        return { data: { released: true } };
      });
      expect(await controller.send("Fix it", "auto")).toBe(true);
      await settle(() => ofType("release_tool_barrier").length === 1);
      const prompt = ofType("prompt")[0] as Frame;
      expect(prompt["toolBarrier"]).toEqual({ id: expect.any(String), deadlineMs: 35_000 });
      const barrierId = (prompt["toolBarrier"] as { id: string }).id;
      expect(ofType("release_tool_barrier")[0]).toMatchObject({ barrierId, sessionId: "rpc-1" });
      const point = (await store.read("durable-1")).points.get(prompt["clientMessageId"] as string);
      expect(point).toMatchObject({ id: barrierId, repo: realpathSync(repo) });
      expect(pointsAtRelease).toBe(1);
      expect(ofType("get_protocol_info")).toHaveLength(1);
      await endTurn();
      await controller.send("again", "auto");
      await settle(() => ofType("release_tool_barrier").length === 2);
      expect(ofType("get_protocol_info")).toHaveLength(1);
    });

    it("messages_go_out_in_the_order_they_were_sent_while_the_barrier_is_prepared", async () => {
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      const first = controller.send("one", "auto");
      const second = controller.send("two", "followUp");
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(types().filter((type) => type === "prompt" || type === "follow_up")).toEqual(["prompt", "follow_up"]);
    });

    it("the_snapshot_budget_runs_from_the_moment_the_prompt_went_out", async () => {
      const tight = new Checkpointer({ store, agentDir: daemon.agentDir, budgetMs: 1_000 });
      daemon.on("prompt", () => ({ data: { disposition: "started", toolBarrier: "armed" }, delayMs: 1_100 }));
      controller = await SessionController.create(manager, repo, undefined, tight);
      expect(await controller.send("Fix it", "auto")).toBe(true);
      await settle(() => ofType("release_tool_barrier").length === 1);
      expect((await store.read("durable-1")).points.size).toBe(0);
    });

    it("a_prompt_that_meets_a_running_turn_is_steered_before_later_messages", async () => {
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      daemon.on("prompt", () => ({ error: "busy", errorCode: "streaming", delayMs: 50 }));
      const first = controller.send("one", "auto");
      const second = controller.send("two", "followUp");
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(types().filter((type) => ["prompt", "steer", "follow_up"].includes(type))).toEqual(["prompt", "steer", "follow_up"]);
    });

    it("a_failed_capability_question_is_asked_again_on_the_next_prompt", async () => {
      let asked = 0;
      daemon.on("get_protocol_info", () => (++asked === 1 ? { error: "not now", errorCode: "internal" } : { data: { capabilities: ["tool_barrier"] } }));
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      await controller.send("one", "auto");
      await endTurn();
      await controller.send("two", "auto");
      const prompts = ofType("prompt");
      expect(prompts[0]).not.toHaveProperty("toolBarrier");
      expect(prompts[1]?.["toolBarrier"]).toBeDefined();
      await endTurn();
      await controller.send("three", "auto");
      expect(asked).toBe(2); // a successful answer is kept
    });

    it("snapshot_failure_still_releases_the_barrier", async () => {
      const failing = new Checkpointer({ store, agentDir: daemon.agentDir, snapshot: () => Promise.reject(new Error("index.lock")) });
      controller = await SessionController.create(manager, repo, undefined, failing);
      expect(await controller.send("Fix it", "auto")).toBe(true);
      await settle(() => ofType("release_tool_barrier").length === 1);
      expect((await store.read("durable-1")).points.size).toBe(0);
      expect(controller.state.error).toBeUndefined();
    });

    it("outside_git_the_prompt_carries_no_barrier", async () => {
      controller = await SessionController.create(manager, mkdtempSync(join(tmpdir(), "plain-")), undefined, checkpointer);
      expect(await controller.send("hi", "auto")).toBe(true);
      expect(ofType("prompt")[0]).not.toHaveProperty("toolBarrier");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ofType("release_tool_barrier")).toHaveLength(0);
    });

    it("host_without_tool_barrier_gets_no_barrier", async () => {
      daemon.on("get_protocol_info", () => ({ data: { capabilities: [] } }));
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      await controller.send("hi", "auto");
      expect(ofType("prompt")[0]).not.toHaveProperty("toolBarrier");
    });

    it("without_a_checkpointer_nothing_changes", async () => {
      controller = await SessionController.create(manager, repo);
      await controller.send("hi", "auto");
      expect(ofType("prompt")[0]).not.toHaveProperty("toolBarrier");
      expect(ofType("get_protocol_info")).toHaveLength(0);
    });

    it("messages_sent_while_running_are_marked", async () => {
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      await goRunning();
      await controller.send("steer me", "auto");
      await controller.send("queue me", "followUp");
      const sent = (await store.read("durable-1")).sent;
      expect(sent.get(ofType("steer")[0]?.["clientMessageId"] as string)).toBe("steer");
      expect(sent.get(ofType("follow_up")[0]?.["clientMessageId"] as string)).toBe("followUp");
    });

    it("a_prompt_the_host_ignores_or_turns_into_a_steer_is_marked_steer", async () => {
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      daemon.on("prompt", () => ({ data: { disposition: "queued", toolBarrier: "ignored" } }));
      await controller.send("ignored", "auto");
      daemon.on("prompt", () => ({ error: "busy", errorCode: "streaming" }));
      await controller.send("fallback", "auto");
      const sent = (await store.read("durable-1")).sent;
      const [ignored, fallback] = ofType("prompt").map((request) => request["clientMessageId"] as string);
      expect(sent.get(ignored as string)).toBe("steer");
      expect(sent.get(fallback as string)).toBe("steer");
      expect(ofType("steer")[0]).not.toHaveProperty("toolBarrier");
      expect(ofType("release_tool_barrier")).toHaveLength(0);
    });

    it("own_frames_feed_the_after_hash_ledger", async () => {
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      daemon.push(frame({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "a.txt" } }));
      daemon.push(frame({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", isError: false }));
      daemon.push({ sessionId: "rpc-9", type: "tool_execution_start", toolCallId: "t2", toolName: "write", args: { path: "x.txt" } });
      daemon.push({ sessionId: "rpc-9", type: "tool_execution_end", toolCallId: "t2", toolName: "write", isError: false });
      await settle(() => controller?.state.blocks.some((block) => block.id === "t1" && block.kind === "tool" && block.state === "ok") === true);
      await checkpointer.settled();
      const after = (await store.read("durable-1")).after;
      expect([...after.keys()]).toEqual([join(realpathSync(repo), "a.txt")]);
    });

    it("attach_reads_the_cwd_from_the_session_header", async () => {
      const sessionFile = join(daemon.agentDir, "s.jsonl");
      writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "durable-1", cwd: realpathSync(repo) })}\n`);
      daemon.on("open_session", () => ({ data: { sessionId: "rpc-1", state: { sessionFile, sessionId: "durable-1", isStreaming: false } } }));
      controller = await SessionController.attach(manager, sessionFile, undefined, undefined, checkpointer);
      expect(controller.cwd).toBe(realpathSync(repo));
    });

    it("journal_pages_entries_and_returns_the_leaf", async () => {
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      daemon.on("get_entries", (request) =>
        request["since"] === undefined
          ? { data: { entries: [{ id: "e1" }, { id: "e2" }], hasMore: true, nextSince: "e2", leafId: "e3" } }
          : { data: { entries: [{ id: "e3" }], hasMore: false, leafId: "e3" } },
      );
      const journal = await controller.journal();
      expect(journal.entries).toHaveLength(3);
      expect(journal.leafId).toBe("e3");
    });

    it("note_adds_a_local_notice_block", async () => {
      controller = await SessionController.create(manager, repo, undefined, checkpointer);
      controller.note("info", "x");
      expect(controller.state.blocks[controller.state.blocks.length - 1]).toMatchObject({ kind: "notice", level: "info", text: "x" });
      expect(controller.state.blocks[controller.state.blocks.length - 1]?.id).toMatch(/^rewind:/);
    });
  });
});
