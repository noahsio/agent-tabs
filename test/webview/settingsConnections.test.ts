// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import { RpcClient } from "../../src/rpc/client";
import { AccountsService, type LoginEvent } from "../../src/settings/accounts";
import { ConnectionsHost, type ConnectionsView } from "../../src/settings/connections";
import { envPaths } from "../../src/settings/paths";
import { SettingsService } from "../../src/settings/service";
import { ChatView } from "../../webview/render";
import { FakeDaemon } from "../helpers/fakeDaemon";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

const ENV = { name: "second", agentDir: "/a" };
const MINUTE = 60_000;

const view1: ConnectionsView = {
  gateways: [
    {
      id: "gw-anthropic",
      name: "Шлюз (Anthropic API)",
      protocol: "anthropic-messages",
      baseUrl: "https://ai.example.ru/api/gw",
      keyHint: "••••••b7f3",
      modelCount: 3,
      fetchedAt: new Date(Date.now() - 2 * MINUTE).toISOString(),
      status: "ok",
    },
    {
      id: "gw-broken",
      name: "Сломанный",
      protocol: "openai-completions",
      baseUrl: "https://down.example",
      keyHint: "••••••0000",
      modelCount: 9,
      status: "error",
      error: "Шлюз «Сломанный» ответил 503",
    },
  ],
  accounts: [{ provider: "chatgpt-subscription", name: "me", status: "вход выполнен" }],
  apiKeys: [{ provider: "anthropic", keyHint: "••••••4321" }],
  any: true,
};

function modal(): HTMLElement {
  return root.querySelector('[data-popover="settings"]') as HTMLElement;
}

function section(): HTMLElement {
  return modal().querySelector('[data-section-body="connections"]') as HTMLElement;
}

function role(name: string): HTMLElement {
  return section().querySelector(`[data-role="${name}"]`) as HTMLElement;
}

function show(connections: ConnectionsView): void {
  view.settings({ env: ENV, connections });
}

function card(id: string): HTMLElement {
  return section().querySelector(`[data-gateway="${id}"]`) as HTMLElement;
}

function claudeCard(): HTMLElement {
  return section().querySelector('[data-add="anthropic-subscription"]') as HTMLElement;
}

function field(name: string): HTMLInputElement | HTMLSelectElement {
  return section().querySelector(`[data-field="${name}"]`) as HTMLInputElement | HTMLSelectElement;
}

function optionLabels(name: string): string[] {
  return [...(field(name) as HTMLSelectElement).options].map((option) => option.textContent ?? "");
}

function buttonIn(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label && !candidate.closest("[hidden]"));
  if (found === undefined) throw new Error(`no button «${label}»`);
  return found;
}

function click(label: string): void {
  buttonIn(section(), label).click();
}

function set(name: string, value: string): void {
  const control = field(name);
  control.value = value;
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function openForm(): void {
  (section().querySelector('[data-add="key-or-gateway"]') as HTMLElement).click();
}

function fill(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) set(name, value);
}

function submit(): void {
  click("Проверить и сохранить");
}

function actions(): Record<string, unknown>[] {
  return posted.flatMap((message) => (message.type === "settingsAction" ? [message.action] : []));
}

function lastAction(): Record<string, unknown> | undefined {
  return actions().at(-1);
}

function lastId(): string {
  const last = posted.filter((message) => message.type === "settingsAction").at(-1);
  if (last?.type !== "settingsAction") throw new Error("no action");
  return last.id;
}

function login(event: LoginEvent): void {
  view.settingsLogin(event);
}

function key(target: EventTarget, name: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  view.update({ type: "state", state: initialState(), tab: { modelMode: "auto", sessionPath: "/s/a.jsonl", durableId: "d1" }, reconnectable: true });
  view.openSettings("connections");
});

afterEach(() => {
  key(document, "Escape");
});

describe("«Подключения»", () => {
  it("a_gateway_card_shows_hint_count_age_and_status", () => {
    show(view1);
    expect(card("gw-anthropic").textContent).toMatch(/работает.*••••••b7f3.*3 модели.*2 мин назад/s); // the status sits beside the name
    expect(card("gw-broken").textContent).toMatch(/ошибка.*9 моделей.*ответил 503/s);
    expect(section().querySelector('[data-account="chatgpt-subscription:me"]')?.textContent).toMatch(/ChatGPT.*me.*вход выполнен/s);
    expect(section().querySelector('[data-api-key="anthropic"]')?.textContent).toContain("••••••4321");
  });

  it("the_gateway_buttons_post_their_actions", () => {
    show(view1);
    buttonIn(card("gw-anthropic"), "Проверить").click();
    expect(lastAction()).toEqual({ kind: "gateway.check", id: "gw-anthropic" });
    buttonIn(card("gw-anthropic"), "обновить список").click();
    expect(lastAction()).toEqual({ kind: "gateway.refresh", id: "gw-anthropic" });
    buttonIn(card("gw-anthropic"), "Удалить").click();
    expect(lastAction()).toEqual({ kind: "gateway.refresh", id: "gw-anthropic" }); // the first press only asks
    buttonIn(card("gw-anthropic"), "Точно удалить?").click();
    expect(lastAction()).toEqual({ kind: "gateway.remove", id: "gw-anthropic" });
  });

  it("the_form_offers_three_protocols_and_posts_a_save", () => {
    show(view1);
    openForm();
    expect(optionLabels("protocol")).toEqual(["Anthropic", "OpenAI Responses", "OpenAI Chat Completions"]);
    fill({ name: "Мой", protocol: "openai-completions", baseUrl: "https://x", key: "k" });
    submit();
    expect(lastAction()).toEqual({ kind: "gateway.save", draft: { name: "Мой", protocol: "openai-completions", baseUrl: "https://x", key: "k" } });
  });

  it("the_form_closes_after_a_save_went_through_and_stays_after_a_refusal", () => {
    show(view1);
    openForm();
    fill({ name: "Мой", baseUrl: "https://x", key: "k" });
    submit();
    view.settingsResult({ type: "settingsResult", id: lastId(), ok: false, error: "Шлюз «Мой» не принял ключ (401)" });
    expect(role("connection-form").hidden).toBe(false);
    submit();
    view.settingsResult({ type: "settingsResult", id: lastId(), ok: true });
    expect(role("connection-form").hidden).toBe(true);
  });

  it("edit_sends_only_what_changed_and_never_prefills_a_redacted_value", () => {
    show({ ...view1, gateways: [{ ...(view1.gateways[0] as ConnectionsView["gateways"][number]), name: "Шлюз ‹redacted›", baseUrl: "‹redacted›" }] });
    buttonIn(card("gw-anthropic"), "Изменить").click();
    expect((field("name") as HTMLInputElement).value).toBe("");
    expect((field("baseUrl") as HTMLInputElement).value).toBe("");
    expect((field("baseUrl") as HTMLInputElement).placeholder).toBe("не меняется");
    submit();
    expect(lastAction()).toEqual({ kind: "gateway.save", draft: { id: "gw-anthropic", name: "", protocol: "anthropic-messages" } });
  });

  it("a_new_address_with_the_stored_key_says_where_the_key_goes", () => {
    show(view1);
    buttonIn(card("gw-anthropic"), "Изменить").click();
    expect(role("connection-form").textContent).not.toContain("Сохранённый ключ будет отправлен на новый адрес");
    set("baseUrl", "https://new.example");
    expect(role("connection-form").textContent).toContain("Сохранённый ключ будет отправлен на новый адрес");
    set("key", "new-key");
    expect(role("connection-form").textContent).not.toContain("Сохранённый ключ будет отправлен на новый адрес");
  });

  it("editing_an_api_key_hides_the_kind_switch", () => {
    show(view1);
    buttonIn(section().querySelector('[data-api-key="anthropic"]') as HTMLElement, "Изменить").click();
    expect(field("kind").closest("[hidden]")).not.toBeNull();
    set("key", "sk-new");
    submit();
    expect(lastAction()).toEqual({ kind: "apiKey.save", provider: "anthropic", key: "sk-new" });
    openForm();
    expect(field("kind").closest("[hidden]")).toBeNull();
  });

  it("edit_keeps_the_id_and_an_empty_key_is_left_out", () => {
    show(view1);
    buttonIn(card("gw-anthropic"), "Изменить").click();
    expect((field("name") as HTMLInputElement).value).toBe("Шлюз (Anthropic API)");
    expect((field("key") as HTMLInputElement).value).toBe("");
    set("baseUrl", "https://new.example");
    submit();
    expect(lastAction()).toEqual({
      kind: "gateway.save",
      draft: { id: "gw-anthropic", name: "Шлюз (Anthropic API)", protocol: "anthropic-messages", baseUrl: "https://new.example" },
    });
  });

  it("an_api_key_goes_through_the_same_form", () => {
    show(view1);
    openForm();
    set("kind", "openai");
    expect(field("baseUrl").closest("[hidden]")).not.toBeNull();
    set("key", "sk-x");
    submit();
    expect(lastAction()).toEqual({ kind: "apiKey.save", provider: "openai", key: "sk-x" });
  });

  it("a_legacy_gateway_is_read_only", () => {
    show({ ...view1, gateways: [{ ...(view1.gateways[0] as ConnectionsView["gateways"][number]), id: "Old_GW", legacy: true }] });
    expect(card("Old_GW").textContent).toContain("models.json");
    expect([...card("Old_GW").querySelectorAll("button")].map((item) => item.textContent)).toEqual([]);
  });

  it("the_claude_card_warns_about_extra_usage", () => {
    show(view1);
    expect(claudeCard().textContent).toContain(
      "Подписка Claude (Pro/Max). Откроется браузер для входа. Трафик стороннего приложения оплачивается как «extra usage».",
    );
  });

  it("nothing_connected_shows_the_first_run_text", () => {
    show({ gateways: [], accounts: [], apiKeys: [], any: false });
    expect(role("first-run").hidden).toBe(false);
    expect(role("first-run").textContent).toBe("Чтобы начать, подключите модель: войдите через аккаунт Claude или ChatGPT, добавьте API-ключ или свой шлюз.");
    show(view1);
    expect(role("first-run").hidden).toBe(true);
  });

  it("without_omo_accounts_say_so_and_the_first_run_text_waits_for_an_answer", () => {
    show({ ...view1, accounts: [], apiKeys: [], omoUnavailable: "нет связи с OmO" });
    expect(section().textContent).toContain("нет связи с OmO");
    show({ gateways: [], accounts: [], apiKeys: [], any: false, omoUnavailable: "нет связи с OmO" });
    expect(role("first-run").hidden).toBe(true);
  });

  it("a_login_select_is_rendered_and_answered", () => {
    show(view1);
    claudeCard().click();
    expect(lastAction()).toEqual({ kind: "account.login", provider: "anthropic-subscription" });
    login({ kind: "ask", requestId: "q1", type: "select", options: ["A", "B"] });
    click("B");
    expect(lastAction()).toEqual({ kind: "account.answer", requestId: "q1", value: "B" });
  });

  it("a_login_input_is_answered_and_the_end_is_shown", () => {
    show(view1);
    section().querySelector<HTMLElement>('[data-add="chatgpt-subscription"]')?.click();
    login({ kind: "url", url: "https://auth.example/device" });
    expect(role("login").textContent).toContain("https://auth.example/device");
    login({ kind: "ask", requestId: "q2", type: "input", title: "Код", placeholder: "XXXX" });
    const input = role("login").querySelector("input") as HTMLInputElement;
    input.value = "1234";
    click("Отправить");
    expect(lastAction()).toEqual({ kind: "account.answer", requestId: "q2", value: "1234" });
    login({ kind: "end", success: true, account: "me" });
    expect(role("login").textContent).toContain("Вход выполнен");
    key(document, "Escape"); // a finished login is not cancelled
    expect(lastAction()).toEqual({ kind: "account.answer", requestId: "q2", value: "1234" });
  });
});

describe("«Подключения» with the host", () => {
  let daemon: FakeDaemon;
  let home: string;
  let host: ConnectionsHost;
  const clients: RpcClient[] = [];

  beforeEach(async () => {
    daemon = await FakeDaemon.start();
    daemon.on("open_session", () => ({ data: { sessionId: "svc-1", state: { sessionFile: "/sessions/svc.jsonl" } } }));
    daemon.on("close_session", () => ({}));
    daemon.on("get_auth_providers", () => ({ data: { providers: [] } }));
    daemon.on("get_provider_accounts", () => ({ data: { accounts: [] } }));
    daemon.on("login_start", () => ({ data: {} }));
    daemon.on("login_cancel", () => ({}));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-conn-ui-"));
    const agentDir = path.join(home, "agent");
    const paths = envPaths({ env: {}, agentDir, omoPath: "/fake/omo", secrets: [] }, home);
    fs.mkdirSync(paths.pluginDir, { recursive: true });
    const service = new SettingsService(ENV, () => undefined);
    host = new ConnectionsHost({
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
          log: () => undefined,
        }),
      addSecret: () => undefined,
      changed: () => undefined,
      login: (event) => view.settingsLogin(event),
      log: () => undefined,
    });
    service.register(host as never);
    // The webview's posts go to the host as ChatPanel sends them.
    view = new ChatView(root, (message) => {
      posted.push(message);
      if (message.type === "settingsAction") void service.perform(message.section, message.action).then((result) => view.settingsResult({ type: "settingsResult", id: message.id, ...result }));
    });
    view.openSettings("connections");
    view.settings({ env: ENV, connections: await host.view() });
  });

  afterEach(async () => {
    await host.dispose();
    for (const client of clients) client.close();
    await daemon.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function eventually(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 300 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  }

  const fake = { received: (type: string) => daemon.requests.filter((request) => request["type"] === type) };

  async function startLogin(): Promise<void> {
    const before = fake.received("login_start").length;
    claudeCard().click();
    await eventually(() => fake.received("login_start").length === before + 1);
  }

  it("closing_modal_mid_login_cancels_and_next_login_starts", async () => {
    await startLogin();
    (modal().querySelector('[data-role="settings-close"]') as HTMLElement).click();
    expect(lastAction()).toEqual({ kind: "account.cancel" });
    await eventually(() => fake.received("login_cancel").length === 1);
    expect(fake.received("login_cancel")).toHaveLength(1);
    view.openSettings("connections");
    await startLogin();
    expect(fake.received("login_start")).toHaveLength(2);
  });
});
