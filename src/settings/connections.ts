import fs from "node:fs";
import type { AccountsService, KeyProvider, LoginEvent, SaveKeyResult, SubscriptionProvider } from "./accounts";
import {
  GatewayError,
  isGatewayId,
  readGateways,
  readModelsFile,
  refreshGateway,
  refreshStale,
  removeGateway,
  saveGateway,
  type GatewayProtocol,
} from "./gateway";
import type { EnvPaths } from "./paths";
import type { FieldError } from "./protocol";
import { FieldErrors, type SettingsSectionHost } from "./service";

export type GatewayView = {
  id: string;
  name: string;
  protocol: GatewayProtocol;
  baseUrl: string;
  keyHint: string;
  modelCount: number;
  fetchedAt?: string;
  status: "ok" | "error" | "unknown";
  error?: string;
  /** An id the plugin cannot write (made by hand before it): shown, never edited. */
  legacy?: true;
};
export type AccountView = { provider: SubscriptionProvider; name: string; displayName?: string; status: string };
export type ApiKeyView = { provider: KeyProvider; keyHint: string };

export type ConnectionsView = {
  gateways: GatewayView[];
  accounts: AccountView[];
  apiKeys: ApiKeyView[];
  /** Something is connected; false drives the first run. */
  any: boolean;
  /** Why accounts and keys are unknown (OmO did not answer in time). */
  omoUnavailable?: string;
};

/** An edit (`id` set) keeps the stored address when `baseUrl` is absent, the stored name when `name` is empty and the key when `key` is absent. */
export type GatewayDraft = { id?: string; name: string; protocol: GatewayProtocol; baseUrl?: string; key?: string };
export type ConnectionsAction =
  | { kind: "gateway.save"; draft: GatewayDraft }
  | { kind: "gateway.check" | "gateway.refresh" | "gateway.remove"; id: string }
  | { kind: "account.login"; provider: SubscriptionProvider }
  | { kind: "account.answer"; requestId: string; value?: string }
  | { kind: "account.cancel" }
  | { kind: "account.logout"; provider: SubscriptionProvider | KeyProvider }
  | { kind: "account.remove"; provider: SubscriptionProvider; name: string }
  | { kind: "apiKey.save"; provider: KeyProvider; key: string };

export interface ConnectionsDeps {
  paths: EnvPaths;
  /** Makes the window's accounts service; called once, on the first use of accounts. */
  accounts: () => AccountsService;
  /** Joins the live redaction set: every key typed in the modal goes here before anything can log or post it. */
  addSecret: (value: string) => void;
  /** The section changed outside an action (a background refresh, a login's end): every open modal re-reads it. */
  changed: () => void;
  /** A login's progress, to every open modal. */
  login: (event: LoginEvent) => void;
  log: (text: string) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}

type OmoPart = { accounts: AccountView[]; apiKeys: ApiKeyView[]; configured: boolean };

const SUBSCRIPTIONS: readonly SubscriptionProvider[] = ["anthropic-subscription", "chatgpt-subscription"];
const KEY_PROVIDERS: readonly KeyProvider[] = ["anthropic", "openai"];
const PROTOCOLS: readonly GatewayProtocol[] = ["anthropic-messages", "openai-responses", "openai-completions"];
/** How long a view waits for OmO's accounts before showing them as unreachable (the answer still comes later). */
const VIEW_WAIT_MS = 1_000;
/** The first run may wait longer: it may have to start OmO, and a wrong «nothing connected» opens the modal. */
const FIRST_RUN_WAIT_MS = 15_000;
/** Stale gateway lists are re-read at most this often (a failing server is not hammered by every view). */
const REFRESH_INTERVAL_MS = 60_000;
const MAX_SLUG = 40;
const HINT_DOTS = "••••••";
const OMO_UNAVAILABLE = "нет связи с OmO";
const SIGNED_IN = "вход выполнен";
const BLOCKED = "заблокирован";
const LEGACY_REFUSED = "Этот шлюз создан вручную: его идентификатор не поддерживается — измените models.json сам";
const UNKNOWN_GATEWAY = "Шлюз не найден — откройте настройки заново";
const KEY_REASONS: Record<Exclude<SaveKeyResult, { ok: true }>["reason"], string> = {
  rejected: "Ключ не принят провайдером",
  unreachable: "Не удалось проверить ключ: провайдер недоступен",
  unsupported: "Эта версия OmO не умеет проверять ключи",
  "unknown-provider": "OmO не знает этого провайдера",
};
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
const TIMEOUT = Symbol("timeout");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** `gw-<slug of the name>` (Cyrillic transliterated, the rest dropped), `gw-<n>` for a name with no letters; never one in `taken`. */
export function gatewayId(name: string, taken: ReadonlySet<string>): string {
  const slug = [...name.toLowerCase()]
    .map((char) => CYRILLIC[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, "");
  const free = (prefix: string, first: number): string => {
    for (let n = first; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
  };
  if (slug === "") return free("gw-", 1);
  return taken.has(`gw-${slug}`) ? free(`gw-${slug}-`, 2) : `gw-${slug}`;
}

/**
 * «Подключения» on the host: gateways from the plugin's files, accounts and API keys from OmO. A view never waits for
 * the network: stale gateway lists are re-read in the background and OmO gets a short bounded wait; whatever arrives
 * later re-posts the section through `changed`.
 */
export class ConnectionsHost implements SettingsSectionHost<ConnectionsAction> {
  readonly section = "connections" as const;
  private service: AccountsService | undefined;
  private omo: OmoPart | undefined;
  private omoFetch: Promise<OmoPart | undefined> | undefined;
  /** The OmO part the modals last got (JSON), undefined before any view went out: a fresh read that differs re-posts once. */
  private shownOmo: string | undefined;
  private refreshing = false;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private firstRunAsked = false;
  private disposed = false;

  constructor(private readonly deps: ConnectionsDeps) {}

  parse(raw: Record<string, unknown>): ConnectionsAction | undefined {
    const kind = raw["kind"];
    switch (kind) {
      case "gateway.save":
        return this.parseDraft(raw["draft"]);
      case "gateway.check":
      case "gateway.refresh":
      case "gateway.remove":
        return typeof raw["id"] === "string" && raw["id"] !== "" ? { kind, id: raw["id"] } : undefined;
      case "account.login":
        return oneOf(SUBSCRIPTIONS, raw["provider"]) ? { kind, provider: raw["provider"] } : undefined;
      case "account.answer": {
        const { requestId, value } = raw;
        if (typeof requestId !== "string" || (value !== undefined && typeof value !== "string")) return undefined;
        return { kind, requestId, ...(value !== undefined ? { value } : {}) };
      }
      case "account.cancel":
        return { kind };
      case "account.logout": {
        const provider = raw["provider"];
        return oneOf(SUBSCRIPTIONS, provider) || oneOf(KEY_PROVIDERS, provider) ? { kind, provider } : undefined;
      }
      case "account.remove":
        return oneOf(SUBSCRIPTIONS, raw["provider"]) && typeof raw["name"] === "string" && raw["name"] !== ""
          ? { kind, provider: raw["provider"], name: raw["name"] }
          : undefined;
      case "apiKey.save":
        return oneOf(KEY_PROVIDERS, raw["provider"]) && typeof raw["key"] === "string" ? { kind, provider: raw["provider"], key: raw["key"] } : undefined;
      default:
        return undefined;
    }
  }

  async view(): Promise<ConnectionsView> {
    this.refreshInBackground();
    const omo = await this.omoForView();
    const gateways = this.gateways(); // after the wait: a change made meanwhile is in
    return {
      gateways,
      accounts: omo?.accounts ?? [],
      apiKeys: omo?.apiKeys ?? [],
      any: gateways.length > 0 || isConnected(omo),
      ...(omo === undefined ? { omoUnavailable: OMO_UNAVAILABLE } : {}),
    };
  }

  async perform(action: ConnectionsAction): Promise<void> {
    switch (action.kind) {
      case "gateway.save":
        return this.saveGateway(action.draft);
      case "gateway.check":
      case "gateway.refresh":
        return this.refreshOne(action.id, action.kind === "gateway.check");
      case "gateway.remove":
        this.known(action.id);
        return this.asFieldErrors(async () => removeGateway(this.deps.paths, action.id));
      case "account.login":
        return this.accounts().startLogin(action.provider, (event) => {
          this.deps.login(event);
          if (event.kind === "end") void this.reloadOmo().then(() => this.deps.changed());
        });
      case "account.answer":
        this.service?.answer(action.requestId, action.value);
        return;
      case "account.cancel":
        this.service?.cancelLogin(); // no service: no login to cancel, and nothing is opened for it
        return;
      case "account.logout":
        await this.accounts().logout(action.provider);
        return this.reloadOmo();
      case "account.remove":
        await this.accounts().removeAccount(action.provider, action.name);
        return this.reloadOmo();
      case "apiKey.save":
        return this.saveKey(action.provider, action.key);
    }
  }

  /** True once per window, when nothing is connected: the first tab that loads opens «Подключения». */
  async firstRun(): Promise<boolean> {
    if (this.firstRunAsked) return false;
    this.firstRunAsked = true;
    if (this.gateways().length > 0) return false;
    // only a definite «nothing» opens the modal: no answer from OmO says nothing about its accounts
    const omo = this.omo ?? (await within(this.loadOmo(), FIRST_RUN_WAIT_MS));
    return omo !== TIMEOUT && omo !== undefined && !isConnected(omo);
  }

  /** The window's one accounts service (the roles section reads the models through it). */
  accountsService(): AccountsService {
    return this.accounts();
  }

  /** Closes the accounts service's session and connection. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const service = this.service;
    this.service = undefined;
    await service?.dispose();
  }

  private parseDraft(value: unknown): ConnectionsAction | undefined {
    if (!isObject(value)) return undefined;
    const { id, name, protocol, baseUrl, key } = value;
    if (typeof name !== "string" || !oneOf(PROTOCOLS, protocol)) return undefined;
    if ([id, baseUrl, key].some((item) => item !== undefined && typeof item !== "string")) return undefined;
    const draft: GatewayDraft = { name, protocol };
    if (typeof id === "string") draft.id = id;
    if (typeof baseUrl === "string" && baseUrl !== "") draft.baseUrl = baseUrl;
    if (typeof key === "string" && key !== "") draft.key = key;
    return { kind: "gateway.save", draft };
  }

  private accounts(): AccountsService {
    if (this.disposed) throw new Error("Окно закрывается");
    this.service ??= this.deps.accounts();
    return this.service;
  }

  private gateways(): GatewayView[] {
    return readGateways(this.deps.paths).map((gateway) => ({
      id: gateway.id,
      name: gateway.name,
      protocol: gateway.protocol,
      baseUrl: gateway.baseUrl,
      keyHint: gateway.keyHint,
      modelCount: gateway.models.length,
      ...(gateway.fetchedAt !== undefined ? { fetchedAt: gateway.fetchedAt } : {}),
      status: gateway.lastError !== undefined ? "error" : gateway.fetchedAt !== undefined ? "ok" : "unknown",
      ...(gateway.lastError !== undefined ? { error: gateway.lastError } : {}),
      ...(isGatewayId(gateway.id) ? {} : { legacy: true as const }),
    }));
  }

  private known(id: string): GatewayView {
    const gateway = this.gateways().find((item) => item.id === id);
    if (gateway === undefined) throw new FieldErrors(UNKNOWN_GATEWAY, []);
    if (gateway.legacy === true) throw new FieldErrors(LEGACY_REFUSED, []);
    return gateway;
  }

  private async saveGateway(draft: GatewayDraft): Promise<void> {
    const key = draft.key?.trim();
    if (key !== undefined) this.deps.addSecret(key); // before the gateway, a log line or an answer can see it
    const stored = draft.id === undefined ? undefined : this.known(draft.id);
    const name = draft.name.trim() || (stored?.name ?? "");
    const baseUrl = draft.baseUrl?.trim() ?? stored?.baseUrl ?? "";
    const errors: FieldError[] = [];
    if (name === "") errors.push({ field: "name", message: "Укажите название" });
    if (!isWebUrl(baseUrl)) errors.push({ field: "baseUrl", message: "Адрес должен начинаться с http:// или https://" });
    if (draft.id === undefined && (key === undefined || key === "")) errors.push({ field: "key", message: "Укажите ключ" });
    if (errors.length > 0) throw new FieldErrors(errors.map((error) => error.message).join(" · "), errors);
    const id = draft.id ?? gatewayId(name, this.takenIds());
    await this.asFieldErrors(() => saveGateway(this.deps.paths, { id, name, protocol: draft.protocol, baseUrl }, key === "" ? undefined : key, this.deps.fetch));
  }

  /** Provider ids and key file names: a new gateway must not take over either. */
  private takenIds(): Set<string> {
    const taken = new Set(Object.keys(readModelsFile(this.deps.paths).providers ?? {}));
    try {
      for (const name of fs.readdirSync(this.deps.paths.keysDir)) if (name.endsWith(".key")) taken.add(name.slice(0, -".key".length));
    } catch {
      // no keys yet
    }
    return taken;
  }

  /** A failure is kept as the gateway's status (so the card shows it) and also refuses the action. */
  private async refreshOne(id: string, withProbe: boolean): Promise<void> {
    this.known(id);
    const failure = await refreshGateway(this.deps.paths, id, this.now(), { probe: withProbe }, this.deps.fetch);
    if (failure === undefined) return;
    this.deps.changed();
    throw new FieldErrors(failure, []);
  }

  private async saveKey(provider: KeyProvider, raw: string): Promise<void> {
    const key = raw.trim();
    this.deps.addSecret(key);
    if (key === "") throw new FieldErrors("Укажите ключ", [{ field: "key", message: "Укажите ключ" }]);
    const result = await this.accounts().saveKey(provider, key);
    if (!result.ok) throw new FieldErrors(KEY_REASONS[result.reason], [{ field: "key", message: KEY_REASONS[result.reason] }]);
    await this.reloadOmo();
  }

  /** A gateway's own error (key refused, server down) is the person's to fix: it goes to the modal as is (it never holds the key). */
  private async asFieldErrors(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      throw new FieldErrors(error.message, [{ field: error.kind === "unauthorized" ? "key" : "baseUrl", message: error.message }]);
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private refreshInBackground(): void {
    const now = this.now();
    if (this.refreshing || now.getTime() - this.lastRefreshAt < REFRESH_INTERVAL_MS) return;
    this.refreshing = true;
    this.lastRefreshAt = now.getTime();
    void (async () => {
      try {
        const before = JSON.stringify(this.gateways());
        await refreshStale(this.deps.paths, now, this.deps.fetch);
        if (JSON.stringify(this.gateways()) !== before && !this.disposed) this.deps.changed();
      } catch (error) {
        this.deps.log(`Списки моделей шлюзов не обновлены: ${errorText(error)}`);
      } finally {
        this.refreshing = false;
      }
    })();
  }

  /** The last known accounts at once (a fresh read follows), else a short wait; what arrives later re-posts (see `loadOmo`). */
  private async omoForView(): Promise<OmoPart | undefined> {
    const known = this.omo;
    const fetching = this.loadOmo();
    let omo = known;
    if (known === undefined) {
      const result = await within(fetching, VIEW_WAIT_MS);
      omo = result === TIMEOUT ? undefined : result;
    }
    this.shownOmo = JSON.stringify(omo ?? null);
    return omo;
  }

  /**
   * One read at a time. When it differs from what the modals last got, the section is re-posted once — here, not per
   * view, so N tabs re-reading never post N times. `quiet`: the caller posts itself (an action's own answer).
   */
  private loadOmo(quiet = false): Promise<OmoPart | undefined> {
    if (this.omoFetch === undefined) {
      this.omoFetch = this.fetchOmo()
        .catch((error: unknown) => {
          this.deps.log(`Аккаунты OmO недоступны: ${errorText(error)}`);
          return undefined;
        })
        .then((part) => {
          this.omo = part;
          this.omoFetch = undefined;
          const fresh = JSON.stringify(part ?? null);
          if (!quiet && this.shownOmo !== undefined && fresh !== this.shownOmo && !this.disposed) {
            this.shownOmo = fresh;
            this.deps.changed();
          }
          return part;
        });
    }
    return this.omoFetch;
  }

  /** After a change: a read that started before it could miss it. Quiet: the caller posts the section. */
  private async reloadOmo(): Promise<void> {
    await this.omoFetch;
    await this.loadOmo(true);
  }

  private async fetchOmo(): Promise<OmoPart> {
    const service = this.accounts();
    const rows = await service.providers();
    const accounts: AccountView[] = [];
    for (const provider of SUBSCRIPTIONS) {
      const listed = await service.accounts(provider).catch((error: unknown) => {
        this.deps.log(`Аккаунты ${provider} не прочитаны: ${errorText(error)}`);
        return [];
      });
      for (const account of listed) {
        accounts.push({
          provider,
          name: account.name,
          ...(account.displayName !== undefined ? { displayName: account.displayName } : {}),
          status: account.blocked === true ? BLOCKED : SIGNED_IN,
        });
      }
      // signed in, but OmO lists no named account: one row whose button signs out
      if (listed.length === 0 && rows.some((row) => row.id === provider && row.configured)) accounts.push({ provider, name: "", status: SIGNED_IN });
    }
    const apiKeys: ApiKeyView[] = [];
    for (const row of rows) {
      if (!row.configured || !oneOf(KEY_PROVIDERS, row.id)) continue;
      apiKeys.push({ provider: row.id, keyHint: row.keyHint !== undefined ? `${HINT_DOTS}${row.keyHint}` : "" });
    }
    return { accounts, apiKeys, configured: rows.some((row) => row.configured) };
  }
}

function isConnected(omo: OmoPart | undefined): boolean {
  return omo !== undefined && (omo.configured || omo.accounts.length > 0);
}
