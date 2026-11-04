import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redact, type OmoEnv } from "../../src/env";
import { StatePoster } from "../../src/panel/poster";
import { RpcClient } from "../../src/rpc/client";
import { AccountsService, type LoginEvent } from "../../src/settings/accounts";
import { ConnectionsHost, gatewayId, type ConnectionsView } from "../../src/settings/connections";
import { catReference, writeKeyFile } from "../../src/settings/gateway";
import { envPaths, type EnvPaths } from "../../src/settings/paths";
import { SettingsService } from "../../src/settings/service";
import { FakeDaemon, type Frame } from "../helpers/fakeDaemon";

const KEY = "gw-key-0123456789b7f3";
const TYPED_GATEWAY_KEY = "typed-gateway-key-555777";
const TYPED_API_KEY = "sk-typed-api-key-888999";

let server: http.Server;
let base: string;
let home: string;
let paths: EnvPaths;
let daemon: FakeDaemon;
let clients: RpcClient[];
let secrets: string[];
let logged: string[];
let changes: number;
let logins: LoginEvent[];
/** What the gateway answers: the accepted key and the models it lists. */
let gatewayKey: string;
let listed: string[];
let listDelayMs: number;
/** Delays only the next list request (a background refresh caught mid-flight). */
let delayNext: number;
let gatewayDown: boolean;
/** Whether the typed keys were already secrets when the gateway or OmO first saw them. */
let secretWhenSeen: boolean[];
let host: ConnectionsHost;

function reply(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function received(type: string): Frame[] {
  return daemon.requests.filter((request) => request["type"] === type);
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

function makeHost(overrides: Partial<ConstructorParameters<typeof ConnectionsHost>[0]> = {}): ConnectionsHost {
  return new ConnectionsHost({
    paths,
    accounts: () =>
      new AccountsService({
        connect: async () => {
          const client = await RpcClient.connect(daemon.socketPath, daemon.agentDir);
          clients.push(client);
          return client;
        },
        pluginDir: paths.pluginDir,
        openExternal: () => undefined,
        log: (text) => logged.push(redact(text, secrets)),
      }),
    addSecret: (value) => void secrets.push(value),
    changed: () => void (changes += 1),
    login: (event) => void logins.push(event),
    log: (text) => logged.push(redact(text, secrets)),
    ...overrides,
  });
}

/** A gateway as Task 3 leaves it: provider in models.json, key file, cache entry. */
function seedGateway(id: string, fetchedAt: string | undefined, models: string[] = ["m-haiku", "m-b", "m-c"], lastError?: string): void {
  const keyFile = path.join(paths.keysDir, `${id}.key`);
  writeKeyFile(keyFile, KEY);
  const file = fs.existsSync(paths.modelsJson) ? (JSON.parse(fs.readFileSync(paths.modelsJson, "utf8")) as { providers: Record<string, unknown> }) : { providers: {} };
  file.providers[id] = { baseUrl: base, api: "anthropic-messages", apiKey: catReference(keyFile), models: models.map((model) => ({ id: model, name: model })) };
  fs.mkdirSync(path.dirname(paths.modelsJson), { recursive: true });
  fs.writeFileSync(paths.modelsJson, JSON.stringify(file));
  const cachePath = paths.modelsCache;
  const cache = fs.existsSync(cachePath) ? (JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, unknown>) : {};
  cache[id] = { name: `Шлюз ${id}`, models: models.map((model) => ({ id: model })), ...(fetchedAt !== undefined ? { fetchedAt } : {}), ...(lastError !== undefined ? { lastError } : {}) };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache));
}

function cacheIds(): string[] {
  return Object.keys(JSON.parse(fs.readFileSync(paths.modelsCache, "utf8")) as Record<string, unknown>);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function providers(): Record<string, Record<string, unknown>> {
  return (JSON.parse(fs.readFileSync(paths.modelsJson, "utf8")) as { providers: Record<string, Record<string, unknown>> }).providers;
}

beforeEach(async () => {
  gatewayKey = KEY;
  listed = ["m-haiku", "m-b", "m-c"];
  listDelayMs = 0;
  delayNext = 0;
  gatewayDown = false;
  secretWhenSeen = [];
  server = http.createServer((req, res) => {
    const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (key === TYPED_GATEWAY_KEY || key === `${TYPED_GATEWAY_KEY}-wrong`) secretWhenSeen.push(secrets.includes(String(key)));
    req.resume();
    req.on("end", () => {
      if (gatewayDown) return reply(res, 503, {});
      if (key !== gatewayKey) return reply(res, 401, { error: `bad key ${String(key)}` });
      if (req.method === "POST") return reply(res, 200, {});
      const delay = listDelayMs + delayNext;
      delayNext = 0;
      setTimeout(() => reply(res, 200, { data: listed.map((id) => ({ id })) }), delay);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-connections-"));
  const agentDir = path.join(home, "agent");
  const env: OmoEnv = { env: { OMO_CODING_AGENT_DIR: agentDir }, agentDir, omoPath: "/fake/omo", secrets: [] };
  paths = envPaths(env, home);
  fs.mkdirSync(paths.pluginDir, { recursive: true });

  daemon = await FakeDaemon.start();
  clients = [];
  secrets = [];
  logged = [];
  changes = 0;
  logins = [];
  daemon.on("open_session", () => ({ data: { sessionId: "svc-1", state: { sessionFile: "/sessions/svc.jsonl" } } }));
  daemon.on("close_session", () => ({}));
  daemon.on("get_auth_providers", () => ({ data: { providers: [] } }));
  daemon.on("get_provider_accounts", () => ({ data: { accounts: [] } }));
  daemon.on("get_protocol_info", () => ({ data: { capabilities: ["auth_key_verify"] } }));
  daemon.on("login_start", () => ({ data: {} }));
  daemon.on("login_cancel", () => ({}));
  daemon.on("extension_ui_response", () => ({}));
  host = makeHost();
});

afterEach(async () => {
  await host.dispose();
  for (const client of clients) client.close();
  await daemon.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

async function view(): Promise<ConnectionsView> {
  return host.view();
}

describe("ConnectionsHost view", () => {
  it("a_gateway_shows_its_hint_count_and_status_and_the_view_never_carries_a_key", async () => {
    seedGateway("gw-anthropic", new Date().toISOString());
    const shown = await view();
    expect(shown.gateways).toEqual([
      {
        id: "gw-anthropic",
        name: "Шлюз gw-anthropic",
        protocol: "anthropic-messages",
        baseUrl: base,
        keyHint: "••••••b7f3",
        modelCount: 3,
        fetchedAt: expect.any(String),
        status: "ok",
      },
    ]);
    expect(shown.any).toBe(true);
    expect(JSON.stringify(shown)).not.toContain(KEY);
  });

  it("the_view_never_carries_a_key", async () => {
    seedGateway("gw-anthropic", new Date().toISOString());
    daemon.on("get_auth_providers", () => ({ data: { providers: [{ id: "anthropic", name: "Anthropic", authType: "api_key", status: { configured: true }, keyHint: "9999" }] } }));
    expect(JSON.stringify(await host.view())).not.toContain(KEY);
  });

  it("accounts_and_api_keys_come_from_omo", async () => {
    daemon.on("get_auth_providers", () => ({
      data: {
        providers: [
          { id: "anthropic", name: "Anthropic", authType: "api_key", status: { configured: true }, keyHint: "4321" },
          { id: "openai", name: "OpenAI", authType: "api_key", status: { configured: false } },
          { id: "anthropic-subscription", name: "Claude", authType: "oauth", status: { configured: true } },
        ],
      },
    }));
    daemon.on("get_provider_accounts", (request) =>
      request["provider"] === "anthropic-subscription" ? { data: { accounts: [{ name: "work", displayName: "Работа", blocked: false }, { name: "home", blocked: true }] } } : { data: { accounts: [] } },
    );
    const shown = await view();
    expect(shown.apiKeys).toEqual([{ provider: "anthropic", keyHint: "••••••4321" }]);
    expect(shown.accounts).toEqual([
      { provider: "anthropic-subscription", name: "work", displayName: "Работа", status: "вход выполнен" },
      { provider: "anthropic-subscription", name: "home", status: "заблокирован" },
    ]);
    expect(shown.any).toBe(true);
    expect(shown.omoUnavailable).toBeUndefined();
  });

  it("without_omo_the_view_comes_at_once_from_gateways_alone", async () => {
    seedGateway("gw-anthropic", new Date().toISOString());
    host = makeHost({
      accounts: () =>
        new AccountsService({
          // OmO that answers too late: the connection fails only after the view has long gone out
          connect: () => new Promise<RpcClient>((_resolve, reject) => setTimeout(() => reject(new Error("no omo")), 2_000)),
          pluginDir: paths.pluginDir,
          openExternal: () => undefined,
          log: () => undefined,
        }),
    });
    const started = Date.now();
    const shown = await view();
    expect(Date.now() - started).toBeLessThan(1_800);
    expect(shown.any).toBe(true);
    expect(shown.accounts).toEqual([]);
    expect(shown.omoUnavailable).toBe("нет связи с OmO");
  });

  it("nothing_connected_is_any_false", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [{ id: "openai", name: "OpenAI", authType: "api_key", status: { configured: false } }] } }));
    expect((await view()).any).toBe(false);
  });

  it("a_configured_provider_row_alone_counts_as_connected", async () => {
    daemon.on("get_auth_providers", () => ({ data: { providers: [{ id: "my-env-provider", name: "X", authType: "api_key", status: { configured: true } }] } }));
    expect((await view()).any).toBe(true);
  });

  it("a_stale_list_is_refreshed_in_the_background_and_the_section_reposted", async () => {
    seedGateway("gw-anthropic", "2020-01-01T00:00:00.000Z");
    listed = ["m-haiku", "m-b", "m-c", "m-d"];
    listDelayMs = 300;
    const started = Date.now();
    const first = await view();
    expect(Date.now() - started).toBeLessThan(250); // the refresh does not hold the view
    expect(first.gateways[0]?.modelCount).toBe(3);
    await eventually(() => changes > 0);
    const second = await view();
    expect(second.gateways[0]?.modelCount).toBe(4);
    expect(second.gateways[0]?.status).toBe("ok");
  });

  it("a_failed_refresh_shows_as_error_with_its_text", async () => {
    seedGateway("gw-anthropic", "2020-01-01T00:00:00.000Z");
    gatewayDown = true;
    await view();
    await eventually(() => changes > 0);
    const shown = (await view()).gateways[0];
    expect(shown?.status).toBe("error");
    expect(shown?.error).toContain("503");
    expect(shown?.modelCount).toBe(3); // the last list stays
  });

  it("a_gateway_removed_during_a_background_refresh_is_not_resurrected", async () => {
    seedGateway("gw-anthropic", "2020-01-01T00:00:00.000Z");
    delayNext = 400;
    await view(); // the refresh now waits on the server
    await host.perform({ kind: "gateway.remove", id: "gw-anthropic" });
    await sleep(700);
    expect(providers()).toEqual({});
    expect(cacheIds()).toEqual([]);
  });

  it("an_edit_made_during_a_background_refresh_is_kept", async () => {
    seedGateway("gw-anthropic", "2020-01-01T00:00:00.000Z");
    delayNext = 400;
    await view();
    await host.perform({ kind: "gateway.save", draft: { id: "gw-anthropic", name: "Новое имя", protocol: "anthropic-messages", baseUrl: `${base}/` } });
    await sleep(700);
    expect(providers()["gw-anthropic"]?.["baseUrl"]).toBe(`${base}/`);
    expect((await view()).gateways.map((gateway) => [gateway.name, gateway.baseUrl])).toEqual([["Новое имя", `${base}/`]]);
  });

  it("new_omo_data_reposts_once_however_many_tabs_reread", async () => {
    const tabs = 3;
    host = makeHost({
      changed: () => {
        changes += 1;
        for (let tab = 0; tab < tabs; tab++) void host.view(); // every open modal re-reads
      },
    });
    await view();
    daemon.on("get_provider_accounts", (request) => (request["provider"] === "chatgpt-subscription" ? { data: { accounts: [{ name: "me" }] } } : { data: { accounts: [] } }));
    await Promise.all(Array.from({ length: tabs }, () => host.view()));
    await sleep(300);
    expect(changes).toBe(1);
    expect((await view()).accounts).toEqual([{ provider: "chatgpt-subscription", name: "me", status: "вход выполнен" }]);
  });

  it("the_gateways_are_read_after_omo_answered", async () => {
    let releaseOmo: () => void = () => undefined;
    daemon.on("get_auth_providers", () => new Promise((resolve) => (releaseOmo = () => resolve({ data: { providers: [] } }))));
    const pending = view();
    await eventually(() => received("get_auth_providers").length === 1);
    seedGateway("gw-late", new Date().toISOString()); // added while OmO was being asked
    releaseOmo();
    expect((await pending).gateways.map((gateway) => gateway.id)).toEqual(["gw-late"]);
  });

  it("a_legacy_id_is_shown_read_only", async () => {
    seedGateway("Legacy_GW", new Date().toISOString());
    const shown = await view();
    expect(shown.gateways.map((gateway) => [gateway.id, gateway.legacy])).toEqual([["Legacy_GW", true]]);
  });
});

describe("ConnectionsHost gateways", () => {
  it("a_new_gateway_gets_a_gw_id_from_its_name_and_is_saved", async () => {
    gatewayKey = TYPED_GATEWAY_KEY;
    await host.perform({ kind: "gateway.save", draft: { name: "Мой шлюз", protocol: "anthropic-messages", baseUrl: base, key: TYPED_GATEWAY_KEY } });
    expect(Object.keys(providers())).toEqual(["gw-moy-shlyuz"]);
    const shown = await view();
    expect(shown.gateways.map((gateway) => [gateway.id, gateway.name, gateway.modelCount, gateway.status])).toEqual([["gw-moy-shlyuz", "Мой шлюз", 3, "ok"]]);
  });

  it("ids_are_unique_and_never_empty", () => {
    expect(gatewayId("Мой шлюз", new Set())).toBe("gw-moy-shlyuz");
    expect(gatewayId("Мой шлюз", new Set(["gw-moy-shlyuz"]))).toBe("gw-moy-shlyuz-2");
    expect(gatewayId("日本", new Set(["gw-1"]))).toBe("gw-2");
    expect(gatewayId("  Proxy.Box!  ", new Set())).toBe("gw-proxy-box");
  });

  it("editing_keeps_the_id_and_the_key_when_the_field_is_empty", async () => {
    seedGateway("gw-anthropic", new Date().toISOString());
    listed = ["m-haiku"];
    await host.perform({ kind: "gateway.save", draft: { id: "gw-anthropic", name: "Переименован", protocol: "anthropic-messages", baseUrl: base } });
    expect(Object.keys(providers())).toEqual(["gw-anthropic"]);
    expect(fs.readFileSync(path.join(paths.keysDir, "gw-anthropic.key"), "utf8")).toBe(KEY);
    const shown = (await view()).gateways[0];
    expect([shown?.name, shown?.modelCount]).toEqual(["Переименован", 1]);
  });

  it("an_edit_without_an_address_or_name_keeps_the_stored_ones", async () => {
    seedGateway("gw-anthropic", new Date().toISOString());
    await host.perform({ kind: "gateway.save", draft: { id: "gw-anthropic", name: "", protocol: "anthropic-messages" } });
    expect(providers()["gw-anthropic"]?.["baseUrl"]).toBe(base);
    expect((await view()).gateways[0]?.name).toBe("Шлюз gw-anthropic");
  });

  it("a_rejected_key_is_a_field_error_and_nothing_is_written", async () => {
    await expect(
      host.perform({ kind: "gateway.save", draft: { name: "X", protocol: "anthropic-messages", baseUrl: base, key: `${TYPED_GATEWAY_KEY}-wrong` } }),
    ).rejects.toMatchObject({ errors: [{ field: "key", message: expect.stringContaining("401") }] });
    expect(fs.existsSync(paths.modelsJson)).toBe(false);
  });

  it("a_new_gateway_without_a_key_or_name_is_refused_by_field", async () => {
    await expect(host.perform({ kind: "gateway.save", draft: { name: " ", protocol: "anthropic-messages", baseUrl: "ftp://x" } })).rejects.toMatchObject({
      errors: [
        { field: "name", message: expect.any(String) },
        { field: "baseUrl", message: expect.any(String) },
        { field: "key", message: expect.any(String) },
      ],
    });
  });

  it("check_records_a_failure_as_the_gateway_status", async () => {
    seedGateway("gw-anthropic", new Date().toISOString());
    gatewayKey = "another";
    await expect(host.perform({ kind: "gateway.check", id: "gw-anthropic" })).rejects.toMatchObject({ message: expect.stringContaining("401") });
    expect(changes).toBe(1);
    expect((await view()).gateways[0]?.status).toBe("error");
    gatewayKey = KEY;
    await host.perform({ kind: "gateway.check", id: "gw-anthropic" });
    expect((await view()).gateways[0]?.status).toBe("ok");
  });

  it("refresh_rereads_the_list_now", async () => {
    seedGateway("gw-anthropic", new Date().toISOString());
    listed = ["m-1", "m-2"];
    await host.perform({ kind: "gateway.refresh", id: "gw-anthropic" });
    expect((await view()).gateways[0]?.modelCount).toBe(2);
  });

  it("remove_deletes_the_gateway", async () => {
    seedGateway("gw-anthropic", new Date().toISOString());
    await host.perform({ kind: "gateway.remove", id: "gw-anthropic" });
    expect((await view()).gateways).toEqual([]);
  });

  it("parse_refuses_malformed_actions", () => {
    expect(host.parse({ kind: "gateway.save", draft: { name: "x", protocol: "grpc", baseUrl: "https://x" } })).toBeUndefined();
    expect(host.parse({ kind: "gateway.remove" })).toBeUndefined();
    expect(host.parse({ kind: "account.login", provider: "nope" })).toBeUndefined();
    expect(host.parse({ kind: "apiKey.save", provider: "anthropic" })).toBeUndefined();
    expect(host.parse({ kind: "gateway.save", draft: { name: "x", protocol: "openai-responses", baseUrl: "https://x", key: "" } })).toEqual({
      kind: "gateway.save",
      draft: { name: "x", protocol: "openai-responses", baseUrl: "https://x" },
    });
    expect(host.parse({ kind: "gateway.save", draft: { id: "gw-a", name: "", protocol: "openai-responses", baseUrl: "" } })).toEqual({
      kind: "gateway.save",
      draft: { id: "gw-a", name: "", protocol: "openai-responses" },
    });
  });
});

describe("ConnectionsHost accounts", () => {
  it("login_events_reach_the_modal_and_an_end_reposts", async () => {
    await host.perform({ kind: "account.login", provider: "anthropic-subscription" });
    expect(received("login_start")).toHaveLength(1);
    daemon.push({ type: "extension_ui_request", id: "q1", method: "select", options: ["A", "B"], sessionId: "svc-1" });
    await eventually(() => logins.length === 1);
    expect(logins[0]).toEqual({ kind: "ask", requestId: "q1", type: "select", options: ["A", "B"] });
    await host.perform({ kind: "account.answer", requestId: "q1", value: "B" });
    await eventually(() => received("extension_ui_response").length === 1);
    daemon.on("get_provider_accounts", (request) => (request["provider"] === "anthropic-subscription" ? { data: { accounts: [{ name: "work" }] } } : { data: { accounts: [] } }));
    daemon.push({ type: "auth_login_end", provider: "anthropic-subscription", success: true, account: "work" });
    await eventually(() => changes > 0);
    expect(logins.at(-1)).toEqual({ kind: "end", success: true, account: "work" });
    expect((await view()).accounts).toEqual([{ provider: "anthropic-subscription", name: "work", status: "вход выполнен" }]);
  });

  it("cancel_ends_the_login_and_the_next_one_starts", async () => {
    await host.perform({ kind: "account.login", provider: "chatgpt-subscription" });
    await host.perform({ kind: "account.cancel" });
    await eventually(() => received("login_cancel").length === 1);
    expect(logins.at(-1)).toMatchObject({ kind: "end", success: false });
    await host.perform({ kind: "account.login", provider: "chatgpt-subscription" });
    expect(received("login_start")).toHaveLength(2);
  });

  it("cancel_without_a_login_opens_nothing", async () => {
    await host.perform({ kind: "account.cancel" });
    expect(clients).toHaveLength(0);
  });

  it("logout_and_remove_go_to_omo", async () => {
    daemon.on("logout", () => ({}));
    daemon.on("account_remove", () => ({}));
    await host.perform({ kind: "account.logout", provider: "anthropic" });
    await host.perform({ kind: "account.remove", provider: "anthropic-subscription", name: "work" });
    expect(received("logout").map((frame) => frame["provider"])).toEqual(["anthropic"]);
    expect(received("account_remove").map((frame) => [frame["provider"], frame["name"]])).toEqual([["anthropic-subscription", "work"]]);
  });

  it("a_rejected_api_key_is_a_field_error", async () => {
    daemon.on("verify_api_key", () => ({ data: { ok: false, reason: "rejected" } }));
    await expect(host.perform({ kind: "apiKey.save", provider: "openai", key: TYPED_API_KEY })).rejects.toMatchObject({ errors: [{ field: "key" }] });
    expect(received("login_api_key")).toHaveLength(0);
  });
});

describe("first run", () => {
  it("is_offered_once_and_only_when_nothing_is_connected", async () => {
    expect(await host.firstRun()).toBe(true);
    expect(await host.firstRun()).toBe(false);
    seedGateway("gw-anthropic", new Date().toISOString());
    expect(await makeHost().firstRun()).toBe(false);
  });

  it("no_answer_from_omo_is_not_a_first_run", async () => {
    host = makeHost({
      accounts: () =>
        new AccountsService({ connect: async () => Promise.reject(new Error("no omo")), pluginDir: paths.pluginDir, openExternal: () => undefined, log: () => undefined }),
    });
    expect(await host.firstRun()).toBe(false);
  });

  it("an_account_alone_means_no_first_run", async () => {
    daemon.on("get_provider_accounts", (request) => (request["provider"] === "chatgpt-subscription" ? { data: { accounts: [{ name: "me" }] } } : { data: { accounts: [] } }));
    expect(await host.firstRun()).toBe(false);
  });
});

describe("typed keys (P12)", () => {
  it("a_typed_gateway_key_and_api_key_never_reach_a_message_or_the_log_even_on_failure", async () => {
    const posted: string[] = [];
    const poster = new StatePoster((json) => posted.push(json), secrets);
    const service = new SettingsService({ name: "second", agentDir: paths.agentDir }, (text) => logged.push(redact(text, secrets)));
    service.register(host as never);
    daemon.on("verify_api_key", (request) => {
      secretWhenSeen.push(secrets.includes(String(request["key"])));
      return { error: `verify exploded for ${String(request["key"])}` };
    });
    const act = async (id: string, action: Record<string, unknown>): Promise<void> => {
      poster.send({ type: "settingsResult", id, ...(await service.perform("connections", action)) });
      poster.send({ type: "settings", state: await service.state() });
    };

    await act("a1", { kind: "gateway.save", draft: { name: "Bad", protocol: "openai-completions", baseUrl: base, key: `${TYPED_GATEWAY_KEY}-wrong` } });
    gatewayKey = TYPED_GATEWAY_KEY;
    await act("a2", { kind: "gateway.save", draft: { name: "Good", protocol: "openai-responses", baseUrl: base, key: TYPED_GATEWAY_KEY } });
    await act("a3", { kind: "apiKey.save", provider: "anthropic", key: TYPED_API_KEY });

    expect(secretWhenSeen.length).toBeGreaterThan(0);
    expect(secretWhenSeen.every(Boolean)).toBe(true); // a secret before the gateway or OmO ever saw it
    expect(secrets).toEqual(expect.arrayContaining([`${TYPED_GATEWAY_KEY}-wrong`, TYPED_GATEWAY_KEY, TYPED_API_KEY]));
    expect(posted.some((json) => json.includes('"ok":false'))).toBe(true);
    for (const text of [...posted, ...logged]) {
      expect(text).not.toContain(TYPED_GATEWAY_KEY);
      expect(text).not.toContain(TYPED_API_KEY);
    }
  });
});
