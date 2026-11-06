import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "../env";
import { acceptsImageInput, type ModelInfo } from "../panel/protocol";
import type { RpcClient } from "../rpc/client";

export type SubscriptionProvider = "anthropic-subscription" | "chatgpt-subscription";
export type KeyProvider = "anthropic" | "openai";
export type LoginAsk =
  | { requestId: string; type: "select"; title?: string; options: string[] }
  | { requestId: string; type: "input"; title?: string; placeholder?: string };
export type AuthProviderRow = { id: string; name: string; authType: string; configured: boolean; keyHint?: string };
export type AccountRow = { name: string; displayName?: string; blocked?: boolean; pinned?: boolean };
export type LoginEvent =
  | { kind: "url"; url: string }
  | { kind: "progress"; text: string }
  | ({ kind: "ask" } & LoginAsk)
  | { kind: "end"; success: boolean; error?: string; account?: string };
export type SaveKeyResult = { ok: true } | { ok: false; reason: "rejected" | "unreachable" | "unsupported" | "unknown-provider" };

export interface AccountsDeps {
  /** A connection of the service's own: `dispose()` closes it. */
  connect: () => Promise<RpcClient>;
  /** `<agentDir>/agent-tabs`: the service session lives in `<pluginDir>/service`, its path is remembered beside it. */
  pluginDir: string;
  openExternal: (url: string) => void;
  log: (text: string) => void;
}

type Frame = Record<string, unknown>;
type Connection = { client: RpcClient; sessionId: string };
type KeyRejection = "rejected" | "unreachable" | "unsupported" | "unknown-provider";
type ActiveLogin = { provider: SubscriptionProvider; onEvent: (event: LoginEvent) => void };

const MEMORY_FILE = "service-session.json";
const KEY_REJECTIONS: readonly string[] = ["rejected", "unreachable", "unsupported", "unknown-provider"];

function isKeyRejection(value: string): value is KeyRejection {
  return KEY_REJECTIONS.includes(value);
}
const LOGIN_RUNNING = "Вход уже идёт";

function isObject(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listOf(data: unknown, field: string): unknown[] {
  if (Array.isArray(data)) return data;
  const list = isObject(data) ? data[field] : undefined;
  return Array.isArray(list) ? list : [];
}

/**
 * Subscription logins and API keys over OmO RPC. OmO answers no auth call without a `sessionId`, so the service opens
 * ONE session of its own, lazily, on a connection of its own, and passes it in every frame. The session lives in
 * `<pluginDir>/service` (never a project of the user's, so no tab or list shows it) and is reopened by its remembered
 * path, so logins do not pile up session files.
 */
export class AccountsService {
  private connection: Promise<Connection> | undefined;
  private active: ActiveLogin | undefined;
  private current: Connection | undefined;
  private starting = false;
  private verifyCapable: boolean | undefined;

  constructor(private readonly deps: AccountsDeps) {}

  async providers(): Promise<AuthProviderRow[]> {
    const data = await this.call("get_auth_providers");
    const rows: AuthProviderRow[] = [];
    for (const item of listOf(data, "providers")) {
      if (!isObject(item) || typeof item["id"] !== "string") continue;
      const status = isObject(item["status"]) ? item["status"] : {};
      const row: AuthProviderRow = {
        id: item["id"],
        name: optionalString(item["name"]) ?? item["id"],
        authType: optionalString(item["authType"]) ?? "",
        configured: status["configured"] === true,
      };
      const keyHint = optionalString(item["keyHint"]);
      if (keyHint !== undefined) row.keyHint = keyHint;
      rows.push(row);
    }
    return rows;
  }

  async accounts(provider: SubscriptionProvider): Promise<AccountRow[]> {
    const data = await this.call("get_provider_accounts", { provider });
    const rows: AccountRow[] = [];
    for (const item of listOf(data, "accounts")) {
      if (!isObject(item) || typeof item["name"] !== "string") continue;
      const row: AccountRow = { name: item["name"] };
      if (typeof item["displayName"] === "string") row.displayName = item["displayName"];
      if (typeof item["blocked"] === "boolean") row.blocked = item["blocked"];
      if (typeof item["pinned"] === "boolean") row.pinned = item["pinned"];
      rows.push(row);
    }
    return rows;
  }

  async availableModels(): Promise<ModelInfo[]> {
    const data = await this.call("get_available_models");
    const models: ModelInfo[] = [];
    for (const item of listOf(data, "models")) {
      if (!isObject(item) || typeof item["provider"] !== "string" || typeof item["id"] !== "string") continue;
      const model: ModelInfo = { provider: item["provider"], id: item["id"] };
      if (typeof item["name"] === "string") model.name = item["name"];
      if (typeof item["reasoning"] === "boolean") model.reasoning = item["reasoning"];
      const accepts = acceptsImageInput(item["input"]);
      if (accepts !== undefined) model.acceptsImages = accepts;
      models.push(model);
    }
    return models;
  }

  /** Resolves when OmO accepted the login; its progress, prompts and end arrive through `onEvent`. */
  async startLogin(provider: SubscriptionProvider, onEvent: (event: LoginEvent) => void): Promise<void> {
    if (this.active !== undefined || this.starting) throw new Error(LOGIN_RUNNING);
    this.starting = true;
    try {
      const { client, sessionId } = await this.connect();
      this.active = { provider, onEvent };
      try {
        await client.request("login_start", { provider, sessionId });
      } catch (error) {
        this.active = undefined;
        throw error;
      }
    } finally {
      this.starting = false;
    }
  }

  /** Answers a prompt of the running login; `undefined` cancels the prompt and the login. */
  answer(requestId: string, value: string | undefined): void {
    const login = this.active;
    const connection = this.current;
    if (login === undefined || connection === undefined) return;
    const { client, sessionId } = connection;
    const fields: Frame = { uiRequestId: requestId, sessionId };
    if (value === undefined) fields["cancelled"] = true;
    else fields["value"] = value;
    if (value === undefined) this.finish(login, "Вход отменён");
    void (async () => {
      try {
        await client.request("extension_ui_response", fields);
      } catch (error) {
        this.deps.log(`answer failed: ${errorText(error)}`);
      }
      if (value === undefined) await this.sendCancel(client, sessionId, login.provider);
    })();
  }

  /** Ends the running login at once (the end event is ours, a late auth_login_end is ignored) and tells OmO. */
  cancelLogin(): void {
    const login = this.active;
    const connection = this.current;
    if (login === undefined || connection === undefined) return;
    this.finish(login, "Вход отменён");
    void this.sendCancel(connection.client, connection.sessionId, login.provider);
  }

  private async sendCancel(client: RpcClient, sessionId: string, provider: SubscriptionProvider): Promise<void> {
    try {
      await client.request("login_cancel", { provider, sessionId });
    } catch (error) {
      this.deps.log(`login_cancel failed: ${errorText(error)}`);
    }
  }

  private finish(login: ActiveLogin, error: string): void {
    if (this.active !== login) return;
    this.active = undefined;
    login.onEvent({ kind: "end", success: false, error });
  }

  /** Verifies the key first and stores it only when OmO accepts it. Neither the log nor an error carries the key. */
  async saveKey(provider: KeyProvider, key: string): Promise<SaveKeyResult> {
    try {
      const { client, sessionId } = await this.connect();
      if (!(await this.canVerifyKeys(client))) return { ok: false, reason: "unsupported" };
      const verdict = await client.request<unknown>("verify_api_key", { provider, key, sessionId }, 60_000);
      const result = isObject(verdict) ? verdict : {};
      if (result["ok"] !== true) {
        const reason = optionalString(result["reason"]);
        return { ok: false, reason: reason !== undefined && isKeyRejection(reason) ? reason : "unreachable" };
      }
      await client.request("login_api_key", { provider, key, sessionId });
      return { ok: true };
    } catch (error) {
      throw new Error(redact(errorText(error), [key]));
    }
  }

  async logout(provider: string): Promise<void> {
    await this.call("logout", { provider });
  }

  async removeAccount(provider: SubscriptionProvider, name: string): Promise<void> {
    await this.call("account_remove", { provider, name });
  }

  /** The running OmO's version (`get_protocol_info`), on the service's own connection. */
  async omoVersion(): Promise<string | undefined> {
    const { client } = await this.connect();
    const info = await client.request<unknown>("get_protocol_info");
    if (!isObject(info)) return undefined;
    return optionalString(info["serverVersion"]) ?? optionalString(info["engineVersion"]);
  }

  /** Closes the service session and its connection. */
  async dispose(): Promise<void> {
    const pending = this.connection;
    this.connection = undefined;
    this.active = undefined;
    this.current = undefined;
    if (pending === undefined) return;
    let connection: Connection;
    try {
      connection = await pending;
    } catch {
      return;
    }
    await connection.client.request("close_session", { sessionId: connection.sessionId }).catch(() => undefined);
    connection.client.close();
  }

  private async call(type: string, fields: Frame = {}): Promise<unknown> {
    const { client, sessionId } = await this.connect();
    return client.request(type, { ...fields, sessionId });
  }

  private async canVerifyKeys(client: RpcClient): Promise<boolean> {
    if (this.verifyCapable === undefined) {
      const info = await client.request<unknown>("get_protocol_info");
      const capabilities = isObject(info) ? info["capabilities"] : undefined;
      this.verifyCapable = Array.isArray(capabilities)
        ? capabilities.includes("auth_key_verify")
        : isObject(capabilities) && capabilities["auth_key_verify"] !== undefined && capabilities["auth_key_verify"] !== false;
    }
    return this.verifyCapable;
  }

  private connect(): Promise<Connection> {
    if (this.connection === undefined) {
      const attempt = this.open();
      this.connection = attempt;
      attempt.catch(() => {
        if (this.connection === attempt) this.connection = undefined;
      });
    }
    return this.connection;
  }

  private async open(): Promise<Connection> {
    const client = await this.deps.connect();
    try {
      const sessionId = await this.openSession(client);
      const connection = { client, sessionId };
      this.current = connection;
      client.on("frame", (frame: Frame) => this.onFrame(frame, sessionId));
      client.on("close", () => {
        if (this.current !== connection) return;
        this.current = undefined;
        this.connection = undefined;
        this.verifyCapable = undefined;
        const login = this.active;
        if (login !== undefined) this.finish(login, "Соединение с OmO потеряно");
      });
      return { client, sessionId };
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private async openSession(client: RpcClient): Promise<string> {
    const memory = path.join(this.deps.pluginDir, MEMORY_FILE);
    let opened: unknown;
    let keepMemory = false;
    const remembered = await this.rememberedPath(memory);
    if (remembered !== undefined) {
      try {
        opened = await client.request<unknown>("open_session", { sessionPath: remembered });
      } catch (error) {
        // In use by another window: open a fresh one and leave the memory alone; any other failure replaces the memory.
        const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "error";
        keepMemory = code === "session_path_in_use";
        this.deps.log(`service session ${remembered} not reopened (${code}): ${errorText(error)}`);
      }
    }
    if (opened === undefined) {
      const dir = path.join(this.deps.pluginDir, "service");
      await mkdir(dir, { recursive: true });
      opened = await client.request<unknown>("open_session", { cwd: await realpath(dir) });
    }
    const data = isObject(opened) ? opened : {};
    const state = isObject(data["state"]) ? data["state"] : {};
    const sessionPath = optionalString(state["sessionFile"]) ?? optionalString(data["sessionPath"]);
    if (!keepMemory && sessionPath !== undefined && sessionPath !== remembered) {
      await writeFile(memory, JSON.stringify({ sessionPath })).catch((error: unknown) => this.deps.log(`service session not remembered: ${errorText(error)}`));
    }
    return String(data["sessionId"]);
  }

  private async rememberedPath(memory: string): Promise<string | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(memory, "utf8"));
      return isObject(parsed) ? optionalString(parsed["sessionPath"]) : undefined;
    } catch {
      return undefined;
    }
  }

  private onFrame(frame: Frame, serviceSessionId: string): void {
    const login = this.active;
    if (login === undefined) return;
    if (typeof frame["sessionId"] === "string" && frame["sessionId"] !== serviceSessionId) return;
    switch (frame["type"]) {
      case "auth_login_url": {
        const url = optionalString(frame["url"]);
        if (url === undefined) return;
        this.deps.openExternal(url);
        login.onEvent({ kind: "url", url });
        return;
      }
      case "auth_login_progress":
        login.onEvent({ kind: "progress", text: optionalString(frame["text"]) ?? "" });
        return;
      case "auth_login_end": {
        this.active = undefined;
        const event: LoginEvent = { kind: "end", success: frame["success"] === true };
        const error = optionalString(frame["error"]);
        const account = optionalString(frame["account"]);
        if (error !== undefined) event.error = error;
        if (account !== undefined) event.account = account;
        login.onEvent(event);
        return;
      }
      case "extension_ui_request":
        this.relayAsk(frame, login);
        return;
    }
  }

  private relayAsk(frame: Frame, login: ActiveLogin): void {
    const requestId = optionalString(frame["id"]);
    if (requestId === undefined) return;
    const title = optionalString(frame["title"]);
    if (frame["method"] === "select") {
      const options = Array.isArray(frame["options"]) ? frame["options"].filter((option): option is string => typeof option === "string") : [];
      login.onEvent({ kind: "ask", requestId, type: "select", ...(title !== undefined ? { title } : {}), options });
    } else if (frame["method"] === "input") {
      const placeholder = optionalString(frame["placeholder"]);
      login.onEvent({ kind: "ask", requestId, type: "input", ...(title !== undefined ? { title } : {}), ...(placeholder !== undefined ? { placeholder } : {}) });
    }
  }
}
