import fs from "node:fs";
import path from "node:path";
import { guardFilesDir, rulesToWrite, servicePaths } from "../../kit/guard/lifecycle.mjs";
import { DECIDER_MODES, GROUP_IDS, isUserAllow, validateRules, WAIT_SECONDS } from "../../kit/guard/rules.mjs";
import { formatIpLines, importClaudeDeny, parseLines } from "../../kit/guard/rulesText.mjs";
import { httpTransport, latestPrivateChat, loadTelegramConfig, resolveTelegramConfig, telegramKeyFile } from "../../kit/guard/telegram.mjs";
import { profilePath } from "../../kit/sandbox/profile.mjs";
import { GuardRulesInvalid, type DeciderMode, type GroupId, type GuardRulesAdmin, type RulesV2, type WaitSeconds } from "../guard/admin";
import { launchAgentPath, serviceLabel } from "../guard/launchAgent";
import type { ProtectionStatus } from "../guard/protection";
import { writeOmoFile } from "./files";
import { writeKeyFile } from "./gateway";
import type { EnvPaths } from "./paths";
import type { FieldError } from "./protocol";
import type { RolesView } from "./roles";
import { FieldErrors, type SettingsSectionHost } from "./service";

export type TextField = "hardDeny" | "askCustom" | "ipWhitelist";

export type SecurityView = {
  state: ProtectionStatus["state"];
  /** Why protection is «broken». */
  reason?: string;
  /** «off» with something worth knowing (an old v1 guard hook is still there). */
  note?: string;
  /**
   * What turning protection on installs, for the consent dialog; `writeDenies`: the dirs it closes to agents (P38),
   * computed as enabling would now (empty while protection is on or when it cannot be computed).
   */
  consent: { plist: string; kitDir: string; hooksJson: string; profile: string; writeDenies: string[] };
  /**
   * The guard copy that actually runs — not the extension's own files: `dir`, when it was installed there, and whether
   * it is older than the one this extension ships (`stale`: today's rules are not the ones deciding). Absent while no
   * protection of ours is installed. `refreshError`: why the automatic refresh at activation last failed.
   */
  installed?: { dir: string; installedAt?: number; stale: boolean };
  refreshError?: string;
  text: Record<TextField, string>;
  groups: RulesV2["groups"];
  decider: RulesV2["decider"];
  human: RulesV2["human"];
  /**
   * Telegram for this environment: the stored token only as `tokenHint` (••••••+last 4), the chat from the rules;
   * `legacy` — no key file, the supervisor's tg.env is used; `ready` — the toggle can be turned on.
   */
  telegram: { tokenHint?: string; chat: string; legacy: boolean; ready: boolean };
  models: RolesView["models"];
  /** The person's own «always allow» entries (the whitelist), newest first: what each allows and when it was added. */
  whitelist: Array<{ id: string; scope: string; addedAt?: string; session?: string }>;
};

/** One whitelist entry as the settings show it, read from a v2 `allow` user entry. */
type WhitelistView = SecurityView["whitelist"][number];

export type SecurityAction =
  | { kind: "protection.set"; on: boolean; confirmed: boolean }
  | { kind: "text.set"; field: TextField; text: string }
  | { kind: "group.set"; group: GroupId; on: boolean }
  | { kind: "decider.set"; mode?: DeciderMode; model?: string }
  | { kind: "human.set"; waitSeconds?: WaitSeconds; card?: boolean; telegram?: boolean }
  | { kind: "importClaude" }
  | { kind: "whitelist.delete"; id: string }
  | { kind: "telegram.token"; token: string }
  | { kind: "telegram.chat"; chat: string }
  | { kind: "telegram.find" }
  | { kind: "telegram.test" };

export interface SecurityDeps {
  paths: EnvPaths;
  /** The kit's guard dir this extension ships: the default rules, and the name of the copy enabling installs. */
  guardSource: string;
  /** Turning protection on and off (src/guard/protection.ts with the real machine; fakes in tests). */
  protection: {
    status(): Promise<ProtectionStatus>;
    enable(): Promise<void>;
    disable(): Promise<void>;
    writeDenies(): Promise<string[]>;
    /** The guard copy running now and the last failure of the activation refresh (`installedKit`, held by the window). */
    installed(): { installed?: SecurityView["installed"]; refreshError?: string };
  };
  /** The running service's admin socket; rejects when it does not answer. */
  admin: () => Promise<GuardRulesAdmin>;
  /** True while a service may own rules.json (a socket answers or its lock is fresh): the file is not ours then. */
  serviceMayRun: () => Promise<boolean>;
  /** «Модели и роли»'s model options (every connection). */
  models: () => Promise<RolesView["models"]>;
  log: (text: string) => void;
  /** A typed bot token becomes a known secret before anything can log or post it (P12). */
  addSecret: (value: string) => void;
  /** The supervisor's tg.env: still used while this environment has no key file. */
  tgEnvPath: string;
  /** Telegram's Bot API, from the extension host (outside the sandbox). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const TEXT_FIELDS: readonly TextField[] = ["hardDeny", "askCustom", "ipWhitelist"];
const MODEL = /^[^/\s]+\/\S+$/;
const NEEDS_CONSENT = "Сначала подтвердите, что будет установлено";
// OmO's automatic memory reflection creates a git worktree under the repo's .git, which the sandbox denies for a
// verified reason (a planted .git config/hooks runs when git runs outside the sandbox). It cannot complete under
// protection, so the host runs it with SENPI_MEMORY_REFLECTION off (daemon.ts hostCommand) rather than let it fail and
// spam the feed — this note tells the person why automatic memory is off while protection is on.
const REFLECTION_UNDER_PROTECTION =
  "Под защитой автоматическая память OmO (рефлексия) отключена: ей нужно записать служебные файлы git-worktree, которые песочница запрещает. Когда защита выключена, память снова работает — это ожидаемо, а не сбой.";
const IN_PROGRESS = "Защита уже включается или выключается — дождитесь конца";
const SERVICE_SILENT = "Служба защиты не отвечает — изменение не сохранено. Нажмите «Починить» или выключите защиту";
const SERVICE_STARTING = "Служба защиты запускается или не ответила — изменение не сохранено. Попробуйте ещё раз через несколько секунд";
const NOT_SAVED = "Правила не сохранены — исправьте отмеченные строки";
const HINT_DOTS = "••••••";
const BOT_TOKEN = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;
const NOT_A_TOKEN = "Это не токен бота — скопируйте его из @BotFather целиком (цифры, двоеточие, буквы)";
const TELEGRAM_NOT_READY = "Сначала укажите токен бота и чат";
const NO_TOKEN = "Сначала сохраните токен бота";
const NO_CHAT = "Сначала укажите токен бота и чат — или нажмите «Найти чат»";
const NO_MESSAGES = "Боту никто не писал. Напишите своему боту /start и нажмите «Найти чат»";
const TEST_TEXT = "Agent Tabs: проверка связи";
const TELEGRAM_TIMEOUT_MS = 10_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const optional = (raw: Record<string, unknown>, key: string, check: (value: unknown) => boolean): boolean => raw[key] === undefined || check(raw[key]);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/**
 * «Безопасность» on the host: protection on and off (only with the person's consent), and the rules. The rules have
 * one writer at a time: while the service runs it owns rules.json and every change goes through its admin socket;
 * while protection is off the extension validates and writes the file itself. Validation is the kit's (P3):
 * `parseLines` for a field's text, `validateRules` for the whole.
 */
export class SecurityHost implements SettingsSectionHost<SecurityAction> {
  readonly section = "security" as const;
  private switching = false;
  /** Rule edits one after another: each reads what the previous one wrote. */
  private edits: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SecurityDeps) {}

  parse(raw: Record<string, unknown>): SecurityAction | undefined {
    switch (raw["kind"]) {
      case "protection.set":
        return isBoolean(raw["on"]) && isBoolean(raw["confirmed"]) ? { kind: "protection.set", on: raw["on"], confirmed: raw["confirmed"] } : undefined;
      case "text.set":
        return TEXT_FIELDS.includes(raw["field"] as TextField) && typeof raw["text"] === "string"
          ? { kind: "text.set", field: raw["field"] as TextField, text: raw["text"] }
          : undefined;
      case "group.set":
        return GROUP_IDS.includes(raw["group"] as string) && isBoolean(raw["on"]) ? { kind: "group.set", group: raw["group"] as GroupId, on: raw["on"] } : undefined;
      case "decider.set": {
        const { mode, model } = raw;
        if (mode === undefined && model === undefined) return undefined;
        if (!optional(raw, "mode", (value) => DECIDER_MODES.includes(value as string))) return undefined;
        if (!optional(raw, "model", (value) => value === "" || (typeof value === "string" && MODEL.test(value)))) return undefined;
        return { kind: "decider.set", ...(mode !== undefined ? { mode: mode as DeciderMode } : {}), ...(model !== undefined ? { model: model as string } : {}) };
      }
      case "human.set": {
        const { waitSeconds, card, telegram } = raw;
        if (waitSeconds === undefined && card === undefined && telegram === undefined) return undefined;
        if (!optional(raw, "waitSeconds", (value) => WAIT_SECONDS.includes(value as number))) return undefined;
        if (!optional(raw, "card", isBoolean) || !optional(raw, "telegram", isBoolean)) return undefined;
        return {
          kind: "human.set",
          ...(waitSeconds !== undefined ? { waitSeconds: waitSeconds as WaitSeconds } : {}),
          ...(card !== undefined ? { card: card as boolean } : {}),
          ...(telegram !== undefined ? { telegram: telegram as boolean } : {}),
        };
      }
      case "importClaude":
        return { kind: "importClaude" };
      case "whitelist.delete":
        return typeof raw["id"] === "string" ? { kind: "whitelist.delete", id: raw["id"] } : undefined;
      case "telegram.token":
        return typeof raw["token"] === "string" ? { kind: "telegram.token", token: raw["token"] } : undefined;
      case "telegram.chat":
        return typeof raw["chat"] === "string" ? { kind: "telegram.chat", chat: raw["chat"] } : undefined;
      case "telegram.find":
      case "telegram.test":
        return { kind: raw["kind"] };
      default:
        return undefined;
    }
  }

  async view(): Promise<SecurityView> {
    const { paths } = this.deps;
    const status = await this.deps.protection.status();
    const { rules, invalid } = await this.readRules(status);
    return {
      ...(invalid !== undefined ? { state: "broken" as const, reason: invalid } : { state: status.state }),
      ...(invalid === undefined && status.state === "broken" ? { reason: status.reason } : {}),
      ...(status.state === "off" && status.note !== undefined ? { note: status.note } : {}),
      ...this.deps.protection.installed(),
      consent: {
        plist: launchAgentPath(paths.home, serviceLabel(paths.agentDir)),
        kitDir: guardFilesDir(paths.home, this.deps.guardSource),
        hooksJson: paths.hooksJson,
        profile: profilePath(paths.agentDir),
        writeDenies: status.state === "on" ? [] : await this.writeDenies(),
      },
      text: { hardDeny: rules.hardDeny.join("\n"), askCustom: rules.askCustom.join("\n"), ipWhitelist: formatIpLines(rules.ipWhitelist) },
      groups: rules.groups,
      decider: rules.decider,
      human: rules.human,
      telegram: this.telegramView(rules.human),
      models: await this.deps.models(),
      whitelist: this.whitelistView(rules),
    };
  }

  /** The person's own «always allow» entries, newest first (by addedAt when present). */
  private whitelistView(rules: RulesV2): WhitelistView[] {
    return (rules.allow as unknown[])
      .filter((entry): entry is Record<string, unknown> => isUserAllow(entry))
      .map((entry) => ({
        id: String(entry["id"]),
        scope: typeof entry["scope"] === "string" ? (entry["scope"] as string) : String(entry["label"] ?? entry["id"]),
        ...(typeof entry["addedAt"] === "string" ? { addedAt: entry["addedAt"] as string } : {}),
        ...(typeof entry["session"] === "string" ? { session: entry["session"] as string } : {}),
      }))
      .sort((left, right) => (right.addedAt ?? "").localeCompare(left.addedAt ?? ""));
  }

  /** The consent's list; a failure (no node, the login shell silent) is logged and enabling reports it itself. */
  private async writeDenies(): Promise<string[]> {
    try {
      return await this.deps.protection.writeDenies();
    } catch (error) {
      this.deps.log(`Список папок, закрываемых защитой, не получен: ${errorText(error)}`);
      return [];
    }
  }

  private telegramView(human: RulesV2["human"]): SecurityView["telegram"] {
    const token = this.storedToken();
    return {
      ...(token !== undefined ? { tokenHint: `${HINT_DOTS}${token.slice(-4)}` } : {}),
      chat: human.telegramChat ?? "",
      legacy: token === undefined && loadTelegramConfig(this.deps.tgEnvPath) !== null,
      ready: this.telegramConfig(human) !== null,
    };
  }

  private storedToken(): string | undefined {
    try {
      return fs.readFileSync(telegramKeyFile(this.deps.paths.agentDir), "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** What the service would use with these rules (kit/guard/telegram.mjs decides, the one place). */
  private telegramConfig(human: RulesV2["human"]): { token: string; chatId: string } | null {
    return resolveTelegramConfig({ keyFile: telegramKeyFile(this.deps.paths.agentDir), tgEnvPath: this.deps.tgEnvPath, human });
  }

  async perform(action: SecurityAction): Promise<void | string> {
    if (action.kind === "telegram.token") this.deps.addSecret(action.token.trim()); // before any log, answer or post
    if (action.kind === "protection.set") return this.setProtection(action.on, action.confirmed);
    if (this.switching) throw new FieldErrors(IN_PROGRESS, []);
    const run = this.edits.then(() => this.editRules(action));
    this.edits = run.catch(() => undefined);
    return run;
  }

  /** Never while protection is being switched: the writer (file or service) is changing hands. */
  private async editRules(action: Exclude<SecurityAction, { kind: "protection.set" }>): Promise<void | string> {
    if (this.switching) throw new FieldErrors(IN_PROGRESS, []);
    const status = await this.deps.protection.status();
    const { rules, invalid } = await this.readRules(status);
    if (invalid !== undefined) throw new FieldErrors(`${invalid}. Исправьте ${servicePaths(this.deps.paths.agentDir).rules} вручную или удалите его — вернутся правила по умолчанию`, []);
    if (action.kind === "importClaude") {
      const { lines, skipped } = this.claudeDeny();
      const added = [...new Set(lines.filter((line) => !rules.hardDeny.includes(line)))];
      await this.writeRules(status, { ...rules, hardDeny: [...rules.hardDeny, ...added] });
      return `импортировано ${added.length}, пропущено ${skipped} (не Bash)`;
    }
    if (action.kind === "telegram.token") return this.saveToken(action.token.trim());
    if (action.kind === "telegram.find") {
      const found = await this.findChat();
      await this.writeRules(status, { ...rules, human: { ...rules.human, telegramChat: found.chatId, telegramUser: found.userId } });
      return `Найден чат ${found.chatId}`;
    }
    if (action.kind === "telegram.test") return this.sendTest(rules.human);
    if (action.kind === "human.set" && action.telegram === true && this.telegramConfig(rules.human) === null) {
      throw new FieldErrors(TELEGRAM_NOT_READY, [{ field: "telegram", message: TELEGRAM_NOT_READY }]);
    }
    await this.writeRules(status, this.edited(rules, action));
  }

  private async setProtection(on: boolean, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new FieldErrors(NEEDS_CONSENT, [{ field: "protection", message: NEEDS_CONSENT }]);
    if (this.switching) throw new FieldErrors(IN_PROGRESS, []);
    this.switching = true;
    try {
      await this.edits; // a rule edit already under way ends with the writer it started with
      await (on ? this.deps.protection.enable() : this.deps.protection.disable());
      if (on) this.deps.log(REFLECTION_UNDER_PROTECTION);
    } catch (error) {
      this.deps.log(`Защита не ${on ? "включена" : "выключена"}: ${errorText(error)}`);
      throw new FieldErrors(`Защита не ${on ? "включена" : "выключена"}: ${errorText(error)}`, []);
    } finally {
      this.switching = false;
    }
  }

  /** An empty submit keeps the stored token; the key file is 0600 in the keys dir, which agents cannot write. */
  private saveToken(token: string): void {
    if (token === "") return;
    if (!BOT_TOKEN.test(token)) throw new FieldErrors(NOT_A_TOKEN, [{ field: "telegramToken", message: NOT_A_TOKEN }]);
    writeKeyFile(telegramKeyFile(this.deps.paths.agentDir), token);
  }

  /** The bot's own updates (no offset: nothing is confirmed, the service's presses stay): the latest private chat. */
  private async findChat(): Promise<{ chatId: string; userId: string }> {
    const token = this.storedToken() ?? loadTelegramConfig(this.deps.tgEnvPath)?.token;
    if (token === undefined) throw new FieldErrors(NO_TOKEN, [{ field: "telegram", message: NO_TOKEN }]);
    const reply = await this.telegram(token, "getUpdates", { timeout: 0, allowed_updates: ["message"] });
    const found = latestPrivateChat(reply["result"]);
    if (found === undefined) throw new FieldErrors(NO_MESSAGES, [{ field: "telegram", message: NO_MESSAGES }]);
    return found;
  }

  private async sendTest(human: RulesV2["human"]): Promise<string> {
    const config = this.telegramConfig(human);
    if (config === null) throw new FieldErrors(NO_CHAT, [{ field: "telegram", message: NO_CHAT }]);
    await this.telegram(config.token, "sendMessage", { chat_id: config.chatId, text: TEST_TEXT });
    return "Сообщение отправлено — проверьте Telegram";
  }

  /** One Bot API call (≤ 10 s); a refusal or no answer is the person's to see, never with the token in it. */
  private async telegram(token: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = (await httpTransport(token, this.deps.fetch)(method, params, TELEGRAM_TIMEOUT_MS)) ?? {};
    if (reply["ok"] === true) return reply;
    const error = reply["error"];
    const text =
      error === "TimeoutError" || error === "AbortError"
        ? "Telegram не ответил за 10 с"
        : typeof reply["description"] === "string"
          ? `Telegram отказал: ${reply["description"]}`
          : `Нет связи с Telegram (${typeof error === "string" ? error : "ошибка"})`;
    const message = text.split(token).join("‹redacted›");
    throw new FieldErrors(message, [{ field: "telegram", message }]);
  }

  /** The rules after `action`; a field's bad lines are reported with their line in the text, nothing else changes. */
  private edited(rules: RulesV2, action: Exclude<SecurityAction, { kind: "protection.set" | "importClaude" | `telegram.${"token" | "find" | "test"}` }>): RulesV2 {
    switch (action.kind) {
      case "text.set": {
        if (action.field === "ipWhitelist") return { ...rules, ipWhitelist: this.lines(action.field, parseLines(action.text, "ip")) };
        return { ...rules, [action.field]: this.lines(action.field, parseLines(action.text, "glob")) };
      }
      case "group.set":
        return { ...rules, groups: { ...rules.groups, [action.group]: action.on } };
      case "whitelist.delete":
        // Revoking takes effect as soon as the rules are written: the next matching command asks again.
        return { ...rules, allow: (rules.allow as unknown[]).filter((entry) => !(isUserAllow(entry) && (entry as { id?: unknown }).id === action.id)) };
      case "decider.set": {
        const { model: _old, ...decider } = rules.decider;
        const model = action.model ?? rules.decider.model;
        return { ...rules, decider: { ...decider, mode: action.mode ?? rules.decider.mode, ...(model !== undefined && model !== "" ? { model } : {}) } };
      }
      case "human.set": {
        const { kind: _kind, ...changes } = action;
        return { ...rules, human: { ...rules.human, ...changes } };
      }
      case "telegram.chat": {
        // A chat typed by hand drops the user «Найти чат» found for another one; no chat, no Telegram.
        const { telegramChat: _chat, telegramUser, ...human } = rules.human;
        const chat = action.chat.trim();
        if (chat === "") return { ...rules, human: { ...human, telegram: false } };
        return { ...rules, human: { ...human, telegramChat: chat, ...(chat === rules.human.telegramChat && telegramUser !== undefined ? { telegramUser } : {}) } };
      }
    }
  }

  private lines<T>(field: TextField, parsed: { values: T[]; errors: Array<{ line: number; message: string }> }): T[] {
    if (parsed.errors.length > 0) throw new FieldErrors(NOT_SAVED, parsed.errors.map((error) => ({ field, line: error.line, message: error.message })));
    return parsed.values;
  }

  private claudeDeny(): { lines: string[]; skipped: number } {
    const file = path.join(this.deps.paths.claudeDir, "settings.json");
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new FieldErrors(code === "ENOENT" ? `Нет файла ${file} — импортировать нечего` : `Файл ${file} не разобрать`, []);
    }
    return importClaudeDeny(raw);
  }

  /**
   * The service's rules while it may run; the file (or, without one, the defaults) while it is off or silent. Rules the
   * service reports invalid come back as `invalid` (the reason) with the defaults to show.
   */
  private async readRules(status: ProtectionStatus): Promise<{ rules: RulesV2; invalid?: string }> {
    if (status.state !== "off") {
      const admin = await this.deps.admin().catch(() => undefined);
      if (admin !== undefined) {
        try {
          return { rules: await admin.rulesGet() };
        } catch (error) {
          if (error instanceof GuardRulesInvalid) return { rules: this.defaultRules(), invalid: error.message };
          this.deps.log(`Правила от службы защиты не получены: ${errorText(error)}`);
        } finally {
          admin.close();
        }
      }
    }
    return { rules: this.fileRules() };
  }

  private defaultRules(): RulesV2 {
    return JSON.parse(fs.readFileSync(path.join(this.deps.guardSource, "default-rules.json"), "utf8")) as RulesV2;
  }

  private fileRules(): RulesV2 {
    const file = servicePaths(this.deps.paths.agentDir).rules;
    let text = rulesToWrite(file, this.deps.guardSource); // none yet: the defaults; v1: its migration
    if (text === undefined) text = fs.readFileSync(file, "utf8");
    let rules: unknown;
    try {
      rules = JSON.parse(text);
    } catch {
      throw new FieldErrors(`Файл ${file} не разобрать — исправьте или удалите его`, []);
    }
    const errors = validateRules(rules);
    if (errors.length > 0) throw new FieldErrors(`Файл ${file} не прошёл проверку: ${errors.map((error) => error.message).join("; ")}`, []);
    return rules as RulesV2;
  }

  /**
   * Off: the extension writes the file. On: only through the service. Broken: the service when it answers; the file only
   * when no service may run — no socket answers and no fresh lock (a starting or slow service still owns it).
   */
  private async writeRules(status: ProtectionStatus, rules: RulesV2): Promise<void> {
    const errors: FieldError[] = validateRules(rules);
    if (errors.length > 0) throw new FieldErrors(NOT_SAVED, errors);
    if (status.state !== "off") {
      const admin = await this.deps.admin().catch((error: unknown) => {
        this.deps.log(`Служба защиты не отвечает: ${errorText(error)}`);
        return undefined;
      });
      if (admin !== undefined) {
        try {
          const result = await admin.rulesSet(rules);
          if (!result.ok) throw new FieldErrors(NOT_SAVED, result.errors);
          return;
        } finally {
          admin.close();
        }
      }
      if (status.state === "on") throw new FieldErrors(SERVICE_SILENT, []);
      if (await this.deps.serviceMayRun()) throw new FieldErrors(SERVICE_STARTING, []);
    }
    const file = servicePaths(this.deps.paths.agentDir).rules;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeOmoFile(file, JSON.stringify(rules, null, 2) + "\n", { backup: "rolling", mode: 0o600 });
  }
}
