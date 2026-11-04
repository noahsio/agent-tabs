import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcClient } from "../../src/rpc/client";
import { AccountsService, type LoginEvent } from "../../src/settings/accounts";
import { FakeDaemon, type Frame } from "../helpers/fakeDaemon";

const KEY = "sk-test-0123456789abcdef";
const PROVIDER = "anthropic-subscription";
const SESSION_ID = "rpc-7";

let daemon: FakeDaemon;
let pluginDir: string;
let service: AccountsService;
let clients: RpcClient[];
let opened: string[];
let logLines: string[];
let events: LoginEvent[];
let sessionCounter: number;

function received(type: string): Frame[] {
  return daemon.requests.filter((request) => request["type"] === type);
}

function nth(type: string, index: number): Frame {
  const frame = received(type)[index];
  if (frame === undefined) throw new Error(`no ${type} #${index}`);
  return frame;
}

function without(frame: Frame, ...names: string[]): Frame {
  const copy = { ...frame };
  for (const name of ["id", "type", ...names]) delete copy[name];
  return copy;
}

function makeService(): AccountsService {
  return new AccountsService({
    connect: async () => {
      const client = await RpcClient.connect(daemon.socketPath, daemon.agentDir);
      clients.push(client);
      return client;
    },
    pluginDir,
    openExternal: (url) => opened.push(url),
    log: (text) => logLines.push(text),
  });
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

const select = (id: string, options: string[]): Frame => ({ type: "extension_ui_request", id, method: "select", title: "Login method", options, sessionId: SESSION_ID });
const input = (id: string): Frame => ({ type: "extension_ui_request", id, method: "input", title: "Paste code", placeholder: "code", sessionId: SESSION_ID });
const urlFrame = (url: string): Frame => ({ type: "auth_login_url", provider: PROVIDER, url });
const end = (fields: Frame): Frame => ({ type: "auth_login_end", provider: PROVIDER, ...fields });

beforeEach(async () => {
  daemon = await FakeDaemon.start();
  pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-"));
  clients = [];
  opened = [];
  logLines = [];
  events = [];
  sessionCounter = 0;
  daemon.on("open_session", (request) => {
    sessionCounter += 1;
    const sessionPath = typeof request["sessionPath"] === "string" ? request["sessionPath"] : `/sessions/service-${sessionCounter}.jsonl`;
    return { data: { sessionId: SESSION_ID, state: { sessionFile: sessionPath } } };
  });
  daemon.on("close_session", () => ({}));
  daemon.on("get_protocol_info", () => ({ data: { capabilities: ["auth_key_verify"] } }));
  daemon.on("verify_api_key", () => ({ data: { ok: true, status: 200 } }));
  daemon.on("login_api_key", () => ({}));
  daemon.on("login_start", () => ({ data: {} }));
  daemon.on("login_cancel", () => ({}));
  daemon.on("extension_ui_response", () => ({}));
  service = makeService();
});

afterEach(async () => {
  for (const client of clients) client.close();
  await daemon.stop();
  fs.rmSync(pluginDir, { recursive: true, force: true });
});

async function startBrowserLogin(): Promise<void> {
  await service.startLogin(PROVIDER, (event) => events.push(event));
  daemon.push(select("q1", ["Browser login (default)", "Copy code login (headless)"]));
  await eventually(() => events.some((event) => event.kind === "ask"));
}

describe("AccountsService login", () => {
  it("browser_login_relays_the_select_then_opens_the_url_and_ends", async () => {
    await startBrowserLogin();
    expect(events).toContainEqual({ kind: "ask", requestId: "q1", type: "select", title: "Login method", options: ["Browser login (default)", "Copy code login (headless)"] });
    expect(received("login_start").map((frame) => without(frame))).toEqual([{ provider: PROVIDER, sessionId: SESSION_ID }]);

    service.answer("q1", "Browser login (default)");
    await eventually(() => received("extension_ui_response").length === 1);
    expect(without(nth("extension_ui_response", 0))).toEqual({ uiRequestId: "q1", sessionId: SESSION_ID, value: "Browser login (default)" });

    daemon.push(urlFrame("https://claude.ai/oauth/authorize?x"));
    daemon.push({ type: "auth_login_progress", provider: PROVIDER, text: "waiting" });
    daemon.push(end({ success: true, account: "work" }));
    await eventually(() => events.some((event) => event.kind === "end"));
    expect(opened).toEqual(["https://claude.ai/oauth/authorize?x"]);
    expect(events).toContainEqual({ kind: "url", url: "https://claude.ai/oauth/authorize?x" });
    expect(events).toContainEqual({ kind: "progress", text: "waiting" });
    expect(events.at(-1)).toEqual({ kind: "end", success: true, account: "work" });
  });

  it("an_input_prompt_is_relayed_with_its_placeholder", async () => {
    await service.startLogin(PROVIDER, (event) => events.push(event));
    daemon.push(input("q2"));
    await eventually(() => events.length === 1);
    expect(events[0]).toEqual({ kind: "ask", requestId: "q2", type: "input", title: "Paste code", placeholder: "code" });
  });

  it("a_cancelled_prompt_cancels_the_login", async () => {
    await startBrowserLogin();
    service.answer("q1", undefined);
    await eventually(() => received("login_cancel").length === 1);
    expect(without(nth("extension_ui_response", 0))).toEqual({ uiRequestId: "q1", sessionId: SESSION_ID, cancelled: true });
    expect(without(nth("login_cancel", 0))).toEqual({ provider: PROVIDER, sessionId: SESSION_ID });
  });

  it("cancel_login_sends_login_cancel_for_the_running_provider", async () => {
    await startBrowserLogin();
    service.cancelLogin();
    await eventually(() => received("login_cancel").length === 1);
    expect(without(nth("login_cancel", 0))).toEqual({ provider: PROVIDER, sessionId: SESSION_ID });
  });

  it("a_second_login_while_one_runs_is_rejected", async () => {
    await startBrowserLogin();
    await expect(service.startLogin("chatgpt-subscription", () => undefined)).rejects.toThrow("Вход уже идёт");
    expect(received("login_start")).toHaveLength(1);
  });

  it("a_new_login_is_allowed_after_the_previous_ended", async () => {
    await startBrowserLogin();
    daemon.push(end({ success: false, error: "Login cancelled" }));
    await eventually(() => events.some((event) => event.kind === "end"));
    await service.startLogin(PROVIDER, () => undefined);
    expect(received("login_start")).toHaveLength(2);
  });

  it("a_failed_login_start_frees_the_slot", async () => {
    daemon.on("login_start", () => ({ error: "boom", errorCode: "failed" }));
    await expect(service.startLogin(PROVIDER, () => undefined)).rejects.toThrow("boom");
    daemon.on("login_start", () => ({ data: {} }));
    await service.startLogin(PROVIDER, () => undefined);
  });
});

describe("AccountsService login always ends", () => {
  const ends = (): LoginEvent[] => events.filter((event) => event.kind === "end");

  it("a_lost_connection_ends_the_login_and_a_new_one_can_start", async () => {
    await startBrowserLogin();
    daemon.dropConnections();
    await eventually(() => ends().length === 1);
    expect(ends()[0]).toEqual({ kind: "end", success: false, error: "Соединение с OmO потеряно" });
    await service.startLogin(PROVIDER, () => undefined);
    expect(received("login_start")).toHaveLength(2);
  });

  it("cancel_ends_the_login_at_once_and_a_new_one_can_start", async () => {
    await startBrowserLogin();
    service.cancelLogin();
    expect(ends()).toEqual([{ kind: "end", success: false, error: "Вход отменён" }]);
    await eventually(() => received("login_cancel").length === 1);
    await service.startLogin(PROVIDER, () => undefined);
  });

  it("a_late_login_end_after_cancel_is_ignored", async () => {
    await startBrowserLogin();
    service.cancelLogin();
    daemon.push(end({ success: false, error: "Login cancelled" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ends()).toHaveLength(1);
  });

  it("a_cancelled_prompt_still_cancels_the_login_when_the_response_errors", async () => {
    await startBrowserLogin();
    daemon.on("extension_ui_response", () => ({ error: "stale", errorCode: "unknown_request" }));
    service.answer("q1", undefined);
    await eventually(() => received("login_cancel").length === 1);
    expect(ends()).toHaveLength(1);
  });

  it("answer_and_cancel_without_a_login_open_no_session", async () => {
    service.answer("q1", "x");
    service.cancelLogin();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received("open_session")).toEqual([]);
  });

  it("frames_of_another_session_are_ignored", async () => {
    await service.startLogin(PROVIDER, (event) => events.push(event));
    daemon.push({ ...select("q9", ["a"]), sessionId: "rpc-99" });
    daemon.push({ ...end({ success: true }), sessionId: "rpc-99" });
    daemon.push(select("q1", ["a"]));
    await eventually(() => events.length === 1);
    expect(events[0]).toMatchObject({ kind: "ask", requestId: "q1" });
  });

  it("verify_capability_is_re_read_after_a_reconnect", async () => {
    expect(await service.saveKey("openai", KEY)).toEqual({ ok: true });
    daemon.on("get_protocol_info", () => ({ data: { capabilities: [] } }));
    daemon.dropConnections();
    await eventually(() => clients.every((client) => (client as unknown as { closed: boolean }).closed));
    expect(await service.saveKey("openai", KEY)).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("AccountsService keys", () => {
  it("a_rejected_key_is_never_saved", async () => {
    daemon.on("verify_api_key", () => ({ data: { ok: false, reason: "rejected", status: 401 } }));
    expect(await service.saveKey("anthropic", KEY)).toEqual({ ok: false, reason: "rejected" });
    expect(received("login_api_key")).toEqual([]);
  });

  it("a_verified_key_is_saved_once", async () => {
    expect(await service.saveKey("openai", KEY)).toEqual({ ok: true });
    expect(received("verify_api_key").map((frame) => without(frame))).toEqual([{ provider: "openai", key: KEY, sessionId: SESSION_ID }]);
    expect(received("login_api_key").map((frame) => without(frame))).toEqual([{ provider: "openai", key: KEY, sessionId: SESSION_ID }]);
  });

  it("without_the_verify_capability_the_key_is_unsupported_and_not_saved", async () => {
    daemon.on("get_protocol_info", () => ({ data: { capabilities: [] } }));
    expect(await service.saveKey("openai", KEY)).toEqual({ ok: false, reason: "unsupported" });
    expect(received("verify_api_key")).toEqual([]);
    expect(received("login_api_key")).toEqual([]);
  });

  it("the_key_never_reaches_the_log_or_an_error", async () => {
    daemon.on("login_api_key", () => ({ error: `bad key ${KEY}`, errorCode: "failed" }));
    const error = await service.saveKey("openai", KEY).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(KEY);
    expect(logLines.join("\n")).not.toContain(KEY);
  });
});

describe("AccountsService reads and removal", () => {
  it("providers_accounts_and_models_are_mapped_and_carry_the_session", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [{ id: "openai", name: "OpenAI", authType: "api_key", status: { configured: true }, keyHint: "cdef" }, { id: "x", name: "X", authType: "oauth", status: {} }, "junk"] } }));
    daemon.on("get_provider_accounts", () => ({ data: { accounts: [{ name: "work", displayName: "Work", blocked: false, pinned: true, source: "cli" }] } }));
    daemon.on("get_available_models", () => ({ data: { models: [{ provider: "openai", id: "gpt-6", name: "GPT" }, { nope: 1 }] } }));
    expect(await service.providers()).toEqual([
      { id: "openai", name: "OpenAI", authType: "api_key", configured: true, keyHint: "cdef" },
      { id: "x", name: "X", authType: "oauth", configured: false },
    ]);
    expect(await service.accounts(PROVIDER)).toEqual([{ name: "work", displayName: "Work", blocked: false, pinned: true }]);
    expect(await service.availableModels()).toEqual([{ provider: "openai", id: "gpt-6", name: "GPT" }]);
    expect(received("get_provider_accounts").map((frame) => without(frame))).toEqual([{ provider: PROVIDER, sessionId: SESSION_ID }]);
    expect(received("get_available_models").map((frame) => without(frame))).toEqual([{ sessionId: SESSION_ID }]);
  });

  it("logout_and_remove_account_send_the_provider_and_session", async () => {
    daemon.on("logout", () => ({}));
    daemon.on("account_remove", () => ({}));
    await service.logout("openai");
    await service.removeAccount(PROVIDER, "work");
    expect(received("logout").map((frame) => without(frame))).toEqual([{ provider: "openai", sessionId: SESSION_ID }]);
    expect(received("account_remove").map((frame) => without(frame))).toEqual([{ provider: PROVIDER, name: "work", sessionId: SESSION_ID }]);
  });
});

describe("AccountsService service session", () => {
  it("one_service_session_opened_and_closed", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [] } }));
    daemon.on("get_available_models", () => ({ data: { models: [] } }));
    await Promise.all([service.providers(), service.availableModels()]);
    await service.saveKey("openai", KEY);
    expect(received("open_session")).toHaveLength(1);
    expect(received("new_session")).toEqual([]);
    expect(received("switch_session")).toEqual([]);
    expect(received("close_session")).toEqual([]);
    await service.dispose();
    expect(received("close_session").map((frame) => without(frame))).toEqual([{ sessionId: SESSION_ID }]);
  });

  it("the_session_opens_in_the_service_dir_under_the_plugin_dir", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [] } }));
    await service.providers();
    const cwd = String(nth("open_session", 0)["cwd"]);
    expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(path.join(pluginDir, "service")));
  });

  it("nothing_is_opened_until_the_first_call_and_dispose_without_a_session_closes_nothing", async () => {
    await service.dispose();
    expect(received("open_session")).toEqual([]);
    expect(received("close_session")).toEqual([]);
  });

  it("service_session_reopened_by_path", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [] } }));
    await service.providers();
    await service.dispose();
    const remembered = JSON.parse(fs.readFileSync(path.join(pluginDir, "service-session.json"), "utf8")) as { sessionPath: string };
    expect(remembered.sessionPath).toBe("/sessions/service-1.jsonl");

    const second = makeService();
    await second.providers();
    expect(nth("open_session", 1)["sessionPath"]).toBe("/sessions/service-1.jsonl");
    expect(nth("open_session", 1)["cwd"]).toBeUndefined();
  });

  it("a_vanished_session_file_falls_back_to_a_fresh_open_and_the_next_start_reopens_it", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [] } }));
    fs.writeFileSync(path.join(pluginDir, "service-session.json"), JSON.stringify({ sessionPath: "/gone.jsonl" }));
    daemon.on("open_session", (request) =>
      typeof request["sessionPath"] === "string"
        ? { error: "not found", errorCode: "not_found" }
        : { data: { sessionId: SESSION_ID, state: { sessionFile: "/sessions/fresh.jsonl" } } },
    );
    await service.providers();
    expect(received("open_session")).toHaveLength(2);
    expect(String(nth("open_session", 1)["cwd"])).toContain("service");
    const remembered = JSON.parse(fs.readFileSync(path.join(pluginDir, "service-session.json"), "utf8")) as { sessionPath: string };
    expect(remembered.sessionPath).toBe("/sessions/fresh.jsonl");
    daemon.on("open_session", () => ({ data: { sessionId: SESSION_ID, state: { sessionFile: "/sessions/fresh.jsonl" } } }));
    await makeService().providers();
    expect(received("open_session")).toHaveLength(3);
    expect(nth("open_session", 2)["sessionPath"]).toBe("/sessions/fresh.jsonl");
  });

  it("a_garbled_memory_file_falls_back_to_a_fresh_open", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [] } }));
    fs.writeFileSync(path.join(pluginDir, "service-session.json"), "{not json");
    await service.providers();
    expect(received("open_session")).toHaveLength(1);
    expect(nth("open_session", 0)["sessionPath"]).toBeUndefined();
  });

  it("a_failed_reopen_opens_fresh_and_keeps_the_memory", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [] } }));
    const memory = path.join(pluginDir, "service-session.json");
    fs.writeFileSync(memory, JSON.stringify({ sessionPath: "/busy.jsonl" }));
    daemon.on("open_session", (request) =>
      typeof request["sessionPath"] === "string"
        ? { error: "in use", errorCode: "session_path_in_use" }
        : { data: { sessionId: SESSION_ID, state: { sessionFile: "/sessions/other.jsonl" } } },
    );
    await service.providers();
    expect(received("open_session")).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(memory, "utf8"))).toEqual({ sessionPath: "/busy.jsonl" });
    expect(logLines.join("\n")).toContain("session_path_in_use");
  });
});
