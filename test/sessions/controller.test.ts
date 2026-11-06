import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEntries, initialState } from "../../src/chat/reducer";
import { DaemonManager, hostSocketPath } from "../../src/daemon";
import type { OmoEnv } from "../../src/env";
import { claimAutoUnwedge, resetAutoUnwedge } from "../../src/sessions/autoUnwedge";
import { ImageStore } from "../../src/sessions/images";
import type { LadderView } from "../../src/sessions/ladder";
import { SessionController } from "../../src/sessions/controller";
import type { Ladder } from "../../src/settings/ladder";
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

  it("a_non_blocking_question_is_idle_so_a_typed_message_is_delivered_not_queued", async () => {
    controller = await SessionController.create(manager, "/tmp");
    // request_user_input / ask_user_question with waitForAnswer:false: the turn ended, OmO holds a standing invitation.
    daemon.push(frame({ type: "extension_ui_request", id: "q1", method: "question", waitForAnswer: false, questions: [{ id: "a", question: "Which color?" }] }));
    daemon.push(frame({ type: "session_lifecycle", lifecycle: { state: "waiting_human", runId: "r1", waitingOn: { children: 0, background: [{ source: "ask-user", activeCount: 1 }], human: [{ kind: "question", requestId: "r1", revision: 1 }] } } }));
    await settle(() => controller?.state.dialogs.length === 1);
    expect(controller.state.running).toBe(false); // idle: the tab is not locked
    expect(controller.state.dialogs[0]).toMatchObject({ method: "question", blocking: false });

    await controller.send("green", "auto");
    expect(ofType("prompt").at(-1)).toMatchObject({ message: "green" }); // delivered as a message, not stranded in the queue
    expect(ofType("steer")).toEqual([]);
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

  /**
   * The person switched the model while a turn ran and the new model's first request failed. OmO ends that run with
   * `turn_end`/`agent_end` and never sends `agent_settled`; its lifecycle keeps saying "running" while naming that very
   * run as the one it stopped. The turn has to end in the tab too, with the error, and the composer has to stay usable —
   * or every further message is steered into a turn that is over and waits in a queue nothing will ever drain.
   */
  it("a_turn_whose_model_request_fails_ends_in_the_tab_with_the_error", async () => {
    controller = await SessionController.create(manager, "/tmp");
    expect(await controller.send("посчитай", "auto")).toBe(true);
    daemon.push(frame({ type: "session_lifecycle", lifecycle: { state: "running", runId: "run-1", activity: { kind: "model" } } }));
    await settle(() => controller?.state.running === true);

    await controller.setModel({ provider: "gw", id: "m2" });
    daemon.push(frame({ type: "extension_ui_request", id: "n1", method: "notify", notifyType: "error", message: "Connection error." }));
    daemon.push(frame({ type: "turn_end" }));
    daemon.push(frame({ type: "agent_end" }));
    daemon.push(frame({ type: "session_lifecycle", lifecycle: { state: "running", runId: "run-1", lastStop: { runId: "run-1", cause: "error" } } }));

    await settle(() => controller?.state.running === false);
    expect(controller.state.blocks.some((block) => block.kind === "notice" && block.text === "Connection error.")).toBe(true);
    expect(await controller.send("ещё раз", "auto")).toBe(true);
    expect(ofType("steer")).toEqual([]); // the composer prompts again instead of steering a turn that is over
    expect(ofType("prompt").length).toBe(2);
  });

  it("a_set_model_that_fails_leaves_the_model_and_the_composer_alone", async () => {
    controller = await SessionController.create(manager, "/tmp");
    daemon.push(frame({ type: "session_lifecycle", lifecycle: { state: "running", runId: "run-1" } }));
    await settle(() => controller?.state.running === true);
    daemon.on("set_model", () => ({ errorCode: "unknown_model", error: "no such model for sekret-key-123" }));

    await controller.setModel({ provider: "gw", id: "nope" });
    expect(controller.state.error).toContain("no such model");
    expect(controller.state.error).not.toContain("sekret-key-123");
    expect(controller.state.model).toEqual({ provider: "gw", id: "m1" }); // nothing half-switched
    expect(controller.tabState.modelMode).toBe("auto");
    expect(controller.state.running).toBe(true); // the turn it ran during is left alone
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

    // «Стоп» ends the running turn, but OmO does not start what was queued behind it (measured on 5.1.59: the follow_up
    // stays `queued` forever). The person expects it to go out, so the tab delivers the queue once the turn has ended.
    it("stop_delivers_the_queued_message_once_the_turn_ends", async () => {
      daemon.on("dequeue_message", (request) => ({ data: { queuedId: request["queuedId"], status: "removed" } }));
      controller = await SessionController.create(manager, "/tmp");
      await queued("m-1", "позже");
      await controller.stop();
      expect(ofType("dequeue_message")).toHaveLength(0); // the turn is still ending: not yet
      daemon.push(frame({ type: "agent_end", aborted: true }));
      daemon.push(frame({ type: "session_lifecycle", lifecycle: { state: "done", runId: "r1" } }));
      await settle(() => ofType("prompt").length === 1);

      expect(ofType("dequeue_message")[0]).toMatchObject({ queuedId: "q_1" }); // taken out of OmO's queue first
      expect((ofType("prompt")[0] as Frame)["message"]).toBe("позже"); // then sent as the next turn
      expect(ofType("prompt")).toHaveLength(1); // exactly once
      expect(controller.state.blocks.some((block) => block.kind === "user" && block.text === "позже" && block.delivery?.state !== "queued")).toBe(true);
    });

    it("stop_with_an_empty_queue_sends_only_the_abort", async () => {
      controller = await SessionController.create(manager, "/tmp");
      daemon.push(frame({ type: "agent_start" }));
      await settle(() => controller?.state.running === true);
      await controller.stop();
      daemon.push(frame({ type: "session_lifecycle", lifecycle: { state: "done", runId: "r1" } }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(ofType("abort")).toHaveLength(1);
      expect(ofType("dequeue_message")).toHaveLength(0);
      expect(ofType("prompt")).toHaveLength(0);
    });

    it("a_queued_message_omo_delivered_after_the_stop_is_not_sent_again", async () => {
      daemon.on("dequeue_message", () => ({ data: { queuedId: "q_1", status: "already_delivered", reason: "delivered", action: "none" } }));
      controller = await SessionController.create(manager, "/tmp");
      await queued("m-1", "позже");
      await controller.stop();
      daemon.push(frame({ type: "session_lifecycle", lifecycle: { state: "done", runId: "r1" } }));
      await settle(() => ofType("dequeue_message").length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(ofType("prompt")).toHaveLength(0); // OmO ran it after all: never a second copy
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
      await settle(() => rows()?.length === 2); // asked for after the open, merged whenever it answers
      expect(ofType("extension_request")).toEqual([
        expect.objectContaining({ name: "omo.task.list", sessionId: "rpc-1", data: { parent_session_id: "durable-1" } }),
      ]);
      expect(rows()).toEqual([
        ["task:st_a", "done"],
        ["task:st_b", "running"],
      ]);
    });

    it("attach_does_not_wait_for_a_task_list_that_never_answers", async () => {
      daemon.on("extension_request", () => ({ silent: true })); // what OmO 5.1.59 does on a session it reopens
      const startedAt = Date.now();
      controller = await SessionController.attach(manager, SESSION_FILE);
      // Over long before the list's own deadline, which is itself far short of the client's 30-second default that the
      // open used to sit on with the whole conversation already in hand.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(controller.state.error).toBeUndefined();
      await settle(() => ofType("extension_request").length === 1);
    });

    it("a_journal_that_comes_in_pages_ends_in_the_state_one_page_would_give", async () => {
      const entries = Array.from({ length: 1_200 }, (_, index) => ({
        id: `e${index}`,
        type: "message",
        message: {
          role: index % 3 === 0 ? "user" : "assistant",
          timestamp: 1_700_000_000_000 + index,
          content: [{ type: "text", text: `line ${index}` }],
        },
      }));
      daemon.on("get_entries", (request) => {
        const since = request["since"];
        const from = since === undefined ? 0 : entries.findIndex((entry) => entry.id === since) + 1;
        const page = entries.slice(from, from + 500);
        const last = page[page.length - 1];
        return { data: { entries: page, hasMore: from + page.length < entries.length, nextSince: last?.id } };
      });
      controller = await SessionController.attach(manager, SESSION_FILE);
      expect(ofType("get_entries")).toHaveLength(3);
      expect(controller.state.blocks).toEqual(applyEntries(initialState(), entries).blocks);
      expect(controller.state.cursor).toBe("e1199");
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
      await settle(() => ofType("extension_request").length === 1);
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

  /**
   * OmO 5.1.59 resumes a session with a stopped goal by saying, in English, that the client must resume it itself; the
   * goal stays a human wait in the lifecycle meanwhile, so a tab that believed it was a running turn queued every
   * message the person sent and answered none of them.
   */
  describe("a resumed session whose goal OmO stopped", () => {
    const RESUME_NOTICE = "Goal remains blocked after session resume. Resume it explicitly after the session finishes loading.";
    const GOAL_CARD = "Goal active\nObjective: ship it\nStatus: active\nTime used: 2s\nTokens used: 0";
    const blockedGoal = {
      lifecycle: { state: "waiting_human", runId: "r1", waitingOn: { children: 0, background: [], human: [{ kind: "goal_blocked", requestId: "goal:1", revision: 1 }] } },
    };

    function openWithStoppedGoal(): void {
      daemon.on("open_session", () => ({
        data: openData("rpc-1", blockedGoal),
        frames: [frame({ type: "extension_ui_request", id: "n1", method: "notify", notifyType: "info", message: RESUME_NOTICE })],
      }));
    }

    const notices = () => (controller?.state.blocks ?? []).filter((block) => block.kind === "notice");
    const texts = () => notices().map((block) => (block.kind === "notice" ? block.text : ""));
    const goalPrompts = () => ofType("prompt").filter((request) => request["message"] === "/goal resume");

    it("the_tab_resumes_the_goal_itself_and_the_person_s_message_is_delivered", async () => {
      openWithStoppedGoal();
      daemon.on("prompt", (request) =>
        request["message"] === "/goal resume"
          ? { data: { disposition: "handled" }, frames: [frame({ type: "extension_ui_request", id: "n2", method: "notify", notifyType: "info", message: GOAL_CARD })] }
          : { data: { disposition: "started", clientMessageId: request["clientMessageId"] } },
      );
      controller = await SessionController.attach(manager, SESSION_FILE);
      await settle(() => goalPrompts().length === 1);
      await settle(() => texts().includes("Цель сессии была остановлена — возобновил её, агент продолжает работу"));

      // nothing English reached the feed: not OmO's instruction, not the goal card its own command answered with
      expect(texts().some((text) => /Goal remains|Objective:/.test(text))).toBe(false);
      expect(controller.state.running).toBe(false); // the composer is usable, nothing waits for an answer

      expect(await controller.send("продолжи", "auto")).toBe(true);
      const sent = ofType("prompt").filter((request) => request["message"] === "продолжи");
      expect(sent).toHaveLength(1); // a prompt, not a steer that would only queue
      expect(ofType("steer")).toHaveLength(0);
      daemon.push(frame({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "продолжи" }], clientMessageId: sent[0]?.["clientMessageId"] } }));
      await settle(() => controller?.state.blocks.some((block) => block.kind === "user" && block.text === "продолжи" && block.delivery === undefined) === true);
    });

    it("a_refused_resume_says_so_in_russian_and_leaves_the_tab_idle", async () => {
      openWithStoppedGoal();
      daemon.on("prompt", (request) =>
        request["message"] === "/goal resume" ? { error: "goal store contains an invalid goal", errorCode: "open_failed" } : { data: { disposition: "started" } },
      );
      controller = await SessionController.attach(manager, SESSION_FILE);
      await settle(() => notices().length === 1);
      expect(notices()[0]).toMatchObject({
        level: "warn",
        text: "Цель сессии остановлена, и возобновить её не удалось — агент сам не продолжит, напишите, что делать дальше",
      });
      expect(controller.state.running).toBe(false);
      expect(controller.state.error).toBeUndefined(); // one line, not a banner about a command the person never sent
    });

    it("a_turn_that_is_running_after_all_is_left_alone", async () => {
      openWithStoppedGoal();
      daemon.on("prompt", (request) =>
        request["message"] === "/goal resume" ? { error: "Agent is already processing.", errorCode: "streaming" } : { data: { disposition: "started" } },
      );
      controller = await SessionController.attach(manager, SESSION_FILE);
      await settle(() => goalPrompts().length === 1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(notices()).toEqual([]);
    });

    it("overlapping_notices_resume_the_goal_once", async () => {
      openWithStoppedGoal();
      daemon.on("prompt", (request) =>
        request["message"] === "/goal resume" ? { data: { disposition: "handled" }, delayMs: 20 } : { data: { disposition: "started" } },
      );
      controller = await SessionController.attach(manager, SESSION_FILE);
      daemon.push(frame({ type: "extension_ui_request", id: "n3", method: "notify", notifyType: "info", message: RESUME_NOTICE }));
      daemon.push(frame({ type: "extension_ui_request", id: "n4", method: "notify", notifyType: "info", message: RESUME_NOTICE }));
      await settle(() => goalPrompts().length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(goalPrompts()).toHaveLength(1);
      expect(notices()).toHaveLength(1); // and one line, however many times OmO says it
    });
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

    it("a_message_sent_during_compaction_is_queued_not_errored_and_delivered_after_it_ends", async () => {
      controller = await SessionController.create(manager, "/tmp");
      daemon.push(frame({ type: "compaction_start" }));
      await settle(() => controller?.state.compacting === true);
      await controller.send("while compacting", "auto");
      expect(ofType("prompt")).toHaveLength(0); // never offered to OmO as a prompt, so never refused
      const followUp = ofType("follow_up")[0] as Frame;
      expect(followUp).toMatchObject({ message: "while compacting", sessionId: "rpc-1" });
      expect(controller?.state.error).toBeUndefined(); // no banner
      const id = String(followUp["clientMessageId"]);
      daemon.push(frame({ type: "queue_update", ordered: [{ clientMessageId: id, queuedId: "q1", text: "while compacting" }] }));
      await settle(() => controller?.state.blocks.some((block) => block.kind === "user" && block.delivery?.state === "queued") === true);
      // OmO drains the queue when the compaction ends: the message leaves the queue and starts its turn.
      daemon.push(frame({ type: "compaction_end" }));
      daemon.push(frame({ type: "queue_update", ordered: [] }));
      daemon.push(frame({ type: "message_start", message: { role: "user", clientMessageId: id, content: "while compacting" } }));
      await settle(() => controller?.state.blocks.some((block) => block.kind === "user" && block.text === "while compacting" && block.delivery === undefined) === true);
      expect(controller?.state.error).toBeUndefined();
    });

    it("a_prompt_that_races_a_compaction_is_re_routed_to_the_queue_not_the_banner", async () => {
      // OmO began compacting after `type` was chosen (the flag had not reached us): it refuses the prompt by its text.
      daemon.on("prompt", () => ({ error: "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry." }));
      controller = await SessionController.create(manager, "/tmp");
      const ok = await controller.send("racer", "auto");
      expect(ok).toBe(true);
      expect(ofType("prompt")).toHaveLength(1); // it tried the prompt first
      expect(ofType("follow_up")[0]).toMatchObject({ message: "racer", sessionId: "rpc-1" }); // then re-routed to the queue
      expect(controller?.state.error).toBeUndefined(); // the English refusal never reaches the banner
      // same id both times: OmO answers a repeat from its record, never a second message
      expect((ofType("follow_up")[0] as Frame)["clientMessageId"]).toBe((ofType("prompt")[0] as Frame)["clientMessageId"]);
    });

    it("a_genuine_action_failure_still_reaches_the_banner", async () => {
      daemon.on("set_model", () => ({ error: "no such provider", errorCode: "x" }));
      controller = await SessionController.create(manager, "/tmp");
      await controller.setModel({ provider: "gw", id: "nope" });
      expect(controller?.state.error).toBe("no such provider"); // a must-act error is still shown at the top
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

  /**
   * OmO's own liveness machinery kills the turn a millisecond after it starts. The two records that say so are real:
   * the aborted assistant message is the one a live scratch host wrote (16 ms, one empty text part), and the stall row
   * is the shape of all four in the person's journal.
   */
  describe("a turn OmO killed by itself", () => {
    /** The assistant message of a turn abandoned as it was being made. */
    const deadTurn = (over: Frame = {}): Frame =>
      frame({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "aborted",
          errorMessage: "The operation was aborted.",
          usage: { totalTokens: 0 },
          timing: { requestedAt: 1793896968351, endedAt: 1793896968367 },
          ...over,
        },
      });

    /** A real turn result: the model answered, so the message that turn answered is delivered and must not be resent. */
    const goodTurn = (): Frame =>
      frame({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "готово" }], stopReason: "endTurn", timing: { requestedAt: 1, endedAt: 5000 } },
      });

    /** OmO's own stall row, as `entry_appended` carries it. */
    const stall = (openWork: Frame = { kind: "active-goal", goalId: "81ebe93c" }): Frame =>
      frame({
        type: "entry_appended",
        entry: {
          type: "custom",
          customType: "turn-end-liveness",
          id: "e9",
          data: { verdict: { kind: "stalled", reason: "aborted", abortSource: "system" }, openWork },
        },
      });

    function notices(): string[] {
      return (controller as SessionController).state.blocks.flatMap((block) => (block.kind === "notice" ? [block.text] : []));
    }

    beforeEach(() => {
      resetAutoUnwedge(); // the ration lives in the extension process, not in the controller
      daemon.on("unload_session", () => ({ data: { outcome: "unloaded" } }));
    });

    it("says_what_happened_names_the_open_work_and_stops_claiming_it_works", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(deadTurn());
      daemon.push(stall());
      await settle(() => notices().length > 0);

      expect(notices()[0]).toBe("OmO оборвал ход сам, сразу после старта — ответа на это сообщение не будет (у сессии осталась незакрытая цель)");
      expect(controller.state.running).toBe(false);
    });

    it("unloads_the_session_once_and_sends_the_message_again_under_a_new_id", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(deadTurn());
      daemon.push(stall({ kind: "none" }));
      await settle(() => ofType("prompt").length === 2);

      expect(ofType("unload_session")).toHaveLength(1);
      expect(types().indexOf("unload_session")).toBeLessThan(types().lastIndexOf("prompt"));
      const repeat = ofType("prompt")[1] as Frame;
      expect(repeat["message"]).toBe("разбери кошельки");
      expect(repeat["clientMessageId"]).not.toBe("m-own"); // the old id comes back from OmO's record without running anything
      expect(notices()).toContain("Перезапустил сессию и отправил сообщение заново");
    });

    /** The resend's new id, once the recovery has put the message back in. */
    async function recovered(text: string, id: string): Promise<string> {
      await controller!.send(text, "auto", [], id);
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(deadTurn());
      daemon.push(stall({ kind: "none" }));
      await settle(() => ofType("prompt").length === 2);
      return String((ofType("prompt")[1] as Frame)["clientMessageId"]);
    }

    function userBlocks(text: string): { id: string; queued: boolean }[] {
      return (controller as SessionController).state.blocks.flatMap((block) =>
        block.kind === "user" && block.text === text ? [{ id: block.id, queued: block.delivery?.state === "queued" }] : [],
      );
    }

    // The person's own bug: the message shows delivered (the resend) and still queued (the old id OmO restored on
    // the reopen) at the same time. The resend supersedes the old id, so the old bubble must leave the feed.
    it("removes_the_old_queued_bubble_the_resend_superseded", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      const newId = await recovered("что происходит?", "m-own");
      // OmO restored its queue on the reopen: the old message is listed queued again, both before and after the
      // resend is delivered under its new id — neither listing may leave a second bubble on screen.
      const requeue = (): void =>
        daemon.push(frame({ type: "queue_update", ordered: [{ text: "что происходит?", mode: "prompt", queuedId: "q_old", clientMessageId: "m-own" }] }));
      requeue();
      daemon.push(frame({ type: "message_start", message: { role: "user", content: "что происходит?", clientMessageId: newId, timestamp: 2 } }));
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(goodTurn());
      daemon.push(frame({ type: "agent_settled" }));
      requeue();
      await settle(() => controller?.state.blocks.some((block) => block.kind === "assistant" && block.text === "готово") === true);

      const shown = userBlocks("что происходит?");
      expect(shown).toEqual([{ id: newId, queued: false }]); // once, delivered, never also queued
    });

    // A different message the person genuinely queued behind the resend must survive — only the superseded old id goes.
    it("leaves_a_genuinely_different_queued_message_alone", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      const newId = await recovered("что происходит?", "m-own");
      daemon.push(
        frame({
          type: "queue_update",
          ordered: [
            { text: "что происходит?", mode: "prompt", queuedId: "q_old", clientMessageId: "m-own" }, // the superseded old id
            { text: "а потом посмотри логи", mode: "follow_up", queuedId: "q_two", clientMessageId: "m-other" }, // a real, different one
          ],
        }),
      );
      daemon.push(frame({ type: "message_start", message: { role: "user", content: "что происходит?", clientMessageId: newId, timestamp: 2 } }));
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(goodTurn());
      await settle(() => controller?.state.blocks.some((block) => block.kind === "assistant" && block.text === "готово") === true);

      expect(userBlocks("что происходит?")).toEqual([{ id: newId, queued: false }]);
      expect(userBlocks("а потом посмотри логи")).toEqual([{ id: "m-other", queued: true }]); // still queued, still the person's to edit
    });

    it("never_recovers_the_same_message_twice", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(deadTurn());
      daemon.push(stall());
      await settle(() => ofType("prompt").length === 2);
      // the resend dies exactly the same way
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(deadTurn());
      daemon.push(stall());
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(ofType("unload_session")).toHaveLength(1);
      expect(ofType("prompt")).toHaveLength(2);
      expect(notices()).toContain("Отправьте сообщение заново — а если повторится, перезапустите сессию кнопкой «Снять зависание»");
    });

    it("gives_up_into_the_honest_line_when_the_ration_is_spent", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      expect(claimAutoUnwedge("durable-1")).toBe(true); // the composer's own automatic unwedge took it
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(deadTurn());
      daemon.push(stall());
      await settle(() => notices().length > 1);

      expect(ofType("unload_session")).toHaveLength(0);
      expect(ofType("prompt")).toHaveLength(1);
      expect(notices()).toContain("Отправьте сообщение заново — а если повторится, перезапустите сессию кнопкой «Снять зависание»");
    });

    it("never_resends_when_omo_would_not_unload_the_session", async () => {
      daemon.on("unload_session", () => ({ data: { outcome: "refused", reason: "work_pending" } }));
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(deadTurn());
      daemon.push(stall());
      await settle(() => notices().length > 1);

      expect(ofType("prompt")).toHaveLength(1); // without the reopen a resend would die the same way
      expect(notices().at(-1)).toContain("Осталась незавершённая работа");
    });

    it("leaves_the_persons_own_compaction_alone", async () => {
      daemon.on("compact", () => ({ data: {} }));
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      await controller.compact(); // OmO's compaction aborts the running turn with the same provenance
      daemon.push(deadTurn());
      daemon.push(stall());
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(notices()).toEqual([]);
      expect(ofType("unload_session")).toHaveLength(0);
      expect(ofType("prompt")).toHaveLength(1);
    });

    it("does_not_resend_a_delivered_message_when_a_later_autonomous_turn_is_aborted", async () => {
      // The person's own shape: a message they sent earlier was answered (delivered), then OmO continued the goal by
      // itself and killed that autonomous turn — with no new message from the person. The earlier message must not be
      // put back in, or the person sees a second copy of what they already sent.
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(goodTurn()); // the model answered: the message is delivered
      daemon.push(frame({ type: "agent_settled" }));
      daemon.push(frame({ type: "agent_start" })); // OmO carries the goal on by itself
      daemon.push(deadTurn());
      daemon.push(stall()); // active-goal
      await settle(() => notices().length > 0);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(ofType("unload_session")).toHaveLength(0);
      expect(ofType("prompt")).toHaveLength(1); // the earlier, delivered message is never resent
      expect(notices()).toContain("Отправьте сообщение заново — а если повторится, перезапустите сессию кнопкой «Снять зависание»");
    });

    it("resends_only_the_newly_aborted_message_after_an_earlier_one_was_delivered", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("первое сообщение", "auto", [], "m-a");
      daemon.push(frame({ type: "agent_start" }));
      await settle(() => controller?.state.running === true);
      daemon.push(goodTurn()); // first message delivered
      daemon.push(frame({ type: "agent_settled" }));
      await settle(() => controller?.state.running === false);
      await controller.send("второе сообщение", "auto", [], "m-b"); // a fresh message whose turn dies instantly
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(deadTurn());
      daemon.push(stall({ kind: "none" }));
      await settle(() => ofType("prompt").length === 3);

      const messages = (ofType("prompt") as Frame[]).map((request) => request["message"]);
      expect(messages).toEqual(["первое сообщение", "второе сообщение", "второе сообщение"]); // only the second one is put back
      expect((ofType("prompt")[2] as Frame)["clientMessageId"]).not.toBe("m-b"); // and under a new id
      expect(ofType("unload_session")).toHaveLength(1);
    });

    it("needs_both_records_and_only_this_shape", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      // a stall row with no dead turn before it, an abort of ours (no source), and a turn that did something
      daemon.push(stall());
      daemon.push(deadTurn({ content: [{ type: "text", text: "начал" }] }));
      daemon.push(stall());
      daemon.push(deadTurn());
      daemon.push(
        frame({
          type: "entry_appended",
          entry: { type: "custom", customType: "turn-end-liveness", id: "e8", data: { verdict: { kind: "stalled", reason: "aborted" }, openWork: { kind: "none" } } },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(notices()).toEqual([]);
      expect(ofType("unload_session")).toHaveLength(0);
      expect(ofType("prompt")).toHaveLength(1);
    });

    /**
     * The other shape, from the person's journal: the turn ran real work (tool calls, model output over ~2 minutes)
     * and only then was aborted `"system"`. The final assistant message is aborted + empty but lasted far past the
     * instant-dead bound, so `instantDeadTurn` is false and there is no dead turn to put back — the message was answered.
     * Before this the feed showed a bare «Ход остановлен»; now it says what happened and leaves the tab usable.
     */
    const workedThenAborted = (over: Frame = {}): Frame =>
      frame({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "aborted",
          errorMessage: "The operation was aborted.",
          timing: { requestedAt: 1, endedAt: 120_000 },
          ...over,
        },
      });

    const systemAbortEnd = (): Frame => frame({ type: "agent_end", willRetry: false, aborted: true, abortSource: "system", clientMessageId: "m-own" });

    it("after_real_work_says_omo_stopped_itself_names_the_plan_and_leaves_the_tab_usable", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(workedThenAborted());
      daemon.push(systemAbortEnd()); // the reducer must NOT greet this with a bare «Ход остановлен»
      daemon.push(stall({ kind: "open-todos", count: 9 }));
      daemon.push(frame({ type: "agent_settled" })); // the turn is over with nothing resuming → a genuine park
      await settle(() => notices().length > 0);

      expect(notices()).toContain("OmO остановил ход сам (в плане остались незакрытые пункты: 9)");
      expect(notices()).not.toContain("Ход остановлен");
      expect(controller.state.running).toBe(false); // the tab is usable, not stuck on «Работаю…»
      expect(ofType("unload_session")).toHaveLength(0); // the message was answered — nothing to resend
      expect(ofType("prompt")).toHaveLength(1);
    });

    it("a_compaction_abort_reassures_and_does_not_wedge", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(workedThenAborted());
      daemon.push(systemAbortEnd());
      daemon.push(stall({ kind: "open-todos", count: 9 }));
      daemon.push(frame({ type: "compaction_start", reason: "overflow" })); // OmO is compacting and will carry on
      await settle(() => notices().length > 0);

      expect(notices()).toContain("OmO сжимает контекст и продолжит сам");
      expect(notices()).not.toContain("Ход остановлен");
      expect(notices().some((text) => text.startsWith("OmO остановил ход сам"))).toBe(false);
      expect(ofType("unload_session")).toHaveLength(0);
      expect(ofType("prompt")).toHaveLength(1);
      // the turn resumes on its own — the tab must not be left wedged
      daemon.push(frame({ type: "compaction_end" }));
      daemon.push(frame({ type: "agent_start" }));
      await settle(() => controller?.state.running === true);
    });

    it("a_normal_completed_turn_shows_no_stopped_line", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(goodTurn());
      daemon.push(frame({ type: "agent_end", willRetry: false, clientMessageId: "m-own" }));
      daemon.push(frame({ type: "agent_settled" }));
      await settle(() => controller?.state.running === false);

      expect(notices()).toEqual([]);
    });
  });

  describe("the model ladder", () => {
    const LADDER: Ladder = {
      rungs: [
        { id: "top", action: { kind: "model", provider: "gw", id: "m1" }, on: [] },
        { id: "next", action: { kind: "model", provider: "gw", id: "m2" }, on: ["refusal", "rejected", "empty", "silence", "transport"] },
        { id: "ask", action: { kind: "ask" }, on: ["refusal", "rejected", "empty", "silence", "transport"] },
      ],
    };
    let views: (LadderView | undefined)[];
    let lines: string[];

    function withLadder(): void {
      views = [];
      (controller as SessionController).setLadder({ ladder: () => LADDER, view: (view) => views.push(view) });
    }

    const refusal = (): Frame =>
      frame({
        type: "message_end",
        message: { role: "assistant", timestamp: 7, content: [], stopReason: "error", rawStopReason: "refusal", stopDetails: { type: "refusal", explanation: "нет" } },
      });

    /** The live `gw-openai` moderation rejection, verbatim in shape: nothing typed, begun, not one token produced. */
    const rejection = (): Frame =>
      frame({
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 8,
          content: [{ type: "thinking", thinking: "…" }],
          api: "openai-responses",
          usage: { totalTokens: 0 },
          stopReason: "error",
          errorMessage: "This content was flagged for possible cybersecurity risk. …",
          timing: { requestedAt: 1, firstTokenAt: 18_291, lastTokenAt: 18_291, endedAt: 20_195, generationMs: 1 },
        },
      });

    beforeEach(() => {
      lines = [];
      daemon.on("get_available_models", () => ({ data: { models: [{ provider: "gw", id: "m1", name: "Первая" }, { provider: "gw", id: "m2", name: "Вторая" }] } }));
    });

    it("every_abort_we_send_names_its_path_and_its_reason_in_the_channel", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE, undefined, undefined, undefined, (text) => lines.push(text));
      withLadder();
      controller.watchForLadder("m-own", "привет", []);
      await controller.send("привет", "auto", [], "m-own");
      daemon.push(frame({ type: "message_start", message: { role: "user", clientMessageId: "m-own", content: [{ type: "text", text: "привет" }] } }));
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(refusal());
      await settle(() => ofType("abort").length === 1);
      // the ladder's own abort says which rung it is going to and why it is going there
      expect(lines.filter((text) => text.startsWith("Прерываю ход"))).toEqual([
        "Прерываю ход: лесенка моделей — Модель отказалась, ступенька 2 (Вторая)",
      ]);
    });

    it("the_persons_own_stop_is_logged_as_theirs", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE, undefined, undefined, undefined, (text) => lines.push(text));
      await controller.stop();
      expect(lines).toContain("Прерываю ход: «Стоп» — попросил человек");
    });

    it("an_unwedge_says_who_asked_for_it", async () => {
      daemon.on("unload_session", () => ({ data: { outcome: "refused", reason: "turn_active" } }));
      controller = await SessionController.attach(manager, SESSION_FILE, undefined, undefined, undefined, (text) => lines.push(text));
      await controller.unwedgeSession();
      await controller.unwedgeSession("перезапуск после «Стоп»");
      expect(lines.filter((text) => text.startsWith("Выгружаю сессию"))).toEqual([
        "Выгружаю сессию: «Снять зависание» — попросил человек",
        "Выгружаю сессию: «Снять зависание» — перезапуск после «Стоп»",
      ]);
    });

    it("a_provider_rejection_moves_the_message_on_and_never_reaches_the_banner", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      withLadder();
      controller.watchForLadder("m-own", "собери статистику каналов", []);
      await controller.send("собери статистику каналов", "auto", [], "m-own");
      daemon.push(frame({ type: "message_start", message: { role: "user", clientMessageId: "m-own", content: [{ type: "text", text: "собери статистику каналов" }] } }));
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(rejection());
      await settle(() => ofType("set_model").length === 1);
      await settle(() => ofType("prompt").length === 2);

      expect(ofType("abort")).toHaveLength(1);
      expect(ofType("set_model")[0]).toMatchObject({ provider: "gw", modelId: "m2" });
      expect((ofType("prompt")[1] as Frame)["message"]).toBe("собери статистику каналов");
      expect(controller.state.error).toBeUndefined(); // the English sentence never becomes the red banner
      const notices = controller.state.blocks.filter((block) => block.kind === "notice").map((block) => (block.kind === "notice" ? block.text : ""));
      expect(notices).toContain("Провайдер отклонил запрос — смените модель для этой сессии");
      expect(notices).toContain("Провайдер отклонил запрос — перешёл на Вторая и повторил");
    });

    it("a_refusal_on_the_persons_message_aborts_switches_and_repeats_it_under_a_new_id", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      withLadder();
      controller.watchForLadder("m-own", "разбери кошельки", []);
      await controller.send("разбери кошельки", "auto", [], "m-own");
      daemon.push(frame({ type: "message_start", message: { role: "user", clientMessageId: "m-own", content: [{ type: "text", text: "разбери кошельки" }] } }));
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(refusal());
      await settle(() => ofType("set_model").length === 1);
      await settle(() => ofType("prompt").length === 2);

      expect(ofType("abort")).toHaveLength(1);
      expect(types().indexOf("abort")).toBeLessThan(types().indexOf("set_model"));
      expect(ofType("set_model")[0]).toMatchObject({ provider: "gw", modelId: "m2" });
      const repeat = ofType("prompt")[1] as Frame;
      expect(repeat["message"]).toBe("разбери кошельки");
      expect(repeat["clientMessageId"]).not.toBe("m-own"); // a repeat under the same id would come back from OmO's record
      expect(views.at(-1)).toEqual({ state: "walking", rung: 2, total: 3, label: "Вторая" });
      const notices = controller.state.blocks.filter((block) => block.kind === "notice").map((block) => (block.kind === "notice" ? block.text : ""));
      expect(notices).toContain("Модель отказалась — перешёл на Вторая и повторил");
    });

    it("a_goal_resume_prompt_never_arms_the_ladder", async () => {
      daemon.on("open_session", () => ({
        data: openData("rpc-1", {
          lifecycle: { state: "waiting_human", runId: "r1", waitingOn: { children: 0, background: [], human: [{ kind: "goal_blocked", requestId: "g1", revision: 1 }] } },
        }),
        frames: [
          frame({
            type: "extension_ui_request",
            id: "n1",
            method: "notify",
            notifyType: "info",
            message: "Goal remains blocked after session resume. Resume it explicitly after the session finishes loading.",
          }),
        ],
      }));
      daemon.on("prompt", (request) =>
        request["message"] === "/goal resume" ? { data: { disposition: "handled" } } : { data: { disposition: "started", clientMessageId: request["clientMessageId"] } },
      );
      controller = await SessionController.attach(manager, SESSION_FILE);
      withLadder();
      await settle(() => ofType("prompt").some((request) => request["message"] === "/goal resume"));

      daemon.push(frame({ type: "agent_start" }));
      daemon.push(refusal());
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(ofType("set_model")).toHaveLength(0);
      expect(ofType("abort")).toHaveLength(0);
      expect(views).toEqual([]);
    });

    it("without_a_ladder_a_refusal_changes_nothing", async () => {
      controller = await SessionController.attach(manager, SESSION_FILE);
      controller.watchForLadder("m-own", "привет", []);
      await controller.send("привет", "auto", [], "m-own");
      daemon.push(frame({ type: "message_start", message: { role: "user", clientMessageId: "m-own", content: [] } }));
      daemon.push(frame({ type: "agent_start" }));
      daemon.push(refusal());
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(ofType("set_model")).toHaveLength(0);
      expect(ofType("abort")).toHaveLength(0);
    });
  });
});
