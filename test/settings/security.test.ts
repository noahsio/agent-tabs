import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profilePath } from "../../kit/sandbox/profile.mjs";
import { GuardRulesInvalid, type GuardRulesAdmin, type RulesV2 } from "../../src/guard/admin";
import { launchAgentPath, serviceLabel } from "../../src/guard/launchAgent";
import type { ProtectionStatus } from "../../src/guard/protection";
import { envPaths, type EnvPaths } from "../../src/settings/paths";
import type { SettingsResult } from "../../src/settings/protocol";
import type { RolesView } from "../../src/settings/roles";
import { SecurityHost, type SecurityView } from "../../src/settings/security";
import { SettingsService } from "../../src/settings/service";
import { KIT } from "../kit/helpers";

const MODELS: RolesView["models"] = [
  { connection: "Шлюз (Anthropic API)", items: [{ value: "gw-anthropic/claude-haiku-5-5", label: "Claude Haiku 5.5" }] },
  { connection: "ChatGPT", items: [{ value: "openai-codex/gpt-6-sol", label: "GPT 6 Sol" }] },
];
const TOKEN = "123:AAH-fixture-token-abcdefgh-3456";
const existing = ["rm -rf /", "sudo rm*", "mkfs*", "dd if=*", "diskutil erase*", "curl * | sh"];

let home: string;
let paths: EnvPaths;
let service: SettingsService;
let status: ProtectionStatus;
let enableCalls: number;
let disableCalls: number;
/** What the window knows about the guard copy that runs: «Безопасность» passes it on, it does not compute it. */
let installed: { installed?: SecurityView["installed"]; refreshError?: string };
let enableError: Error | undefined;
let adminRules: RulesV2;
let adminSets: RulesV2[];
let adminUp: boolean;
let adminConnects: number;
let serviceMayRun: boolean;
let adminInvalid: boolean;
let enableGate: Promise<void> | undefined;
let logged: string[];
let secrets: string[];
let telegramCalls: Array<{ url: string; body: Record<string, unknown>; signal: unknown }>;
let telegramReply: (method: string) => unknown;
let tgEnv: string;

const rulesFile = (): string => path.join(paths.guardDir, "rules.json");
const fileRules = (): RulesV2 => JSON.parse(fs.readFileSync(rulesFile(), "utf8")) as RulesV2;
const defaults = (): RulesV2 => JSON.parse(fs.readFileSync(path.join(KIT, "guard", "default-rules.json"), "utf8")) as RulesV2;
const perform = (action: Record<string, unknown>): Promise<SettingsResult> => service.perform("security", action);
const view = async (): Promise<SecurityView> => {
  const state = await service.state();
  if ("unavailable" in state) throw new Error(state.unavailable);
  if (state.security === undefined) throw new Error(`no security view: ${JSON.stringify(state.failed)}`);
  return state.security as SecurityView;
};
const set = (field: string, text: string): Promise<SettingsResult> => perform({ kind: "text.set", field, text });

function writeRulesFile(rules: RulesV2): void {
  fs.mkdirSync(paths.guardDir, { recursive: true });
  fs.writeFileSync(rulesFile(), JSON.stringify(rules, null, 2) + "\n");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-security-"));
  paths = envPaths({ env: { CLAUDE_CONFIG_DIR: path.join(home, "claude") }, agentDir: path.join(home, "agent"), omoPath: "/fake/omo", secrets: [] }, home);
  fs.mkdirSync(paths.agentDir, { recursive: true });
  status = { state: "off" };
  enableCalls = 0;
  disableCalls = 0;
  installed = {};
  enableError = undefined;
  adminRules = { ...defaults(), hardDeny: [...existing] };
  adminSets = [];
  adminUp = true;
  adminConnects = 0;
  serviceMayRun = false;
  adminInvalid = false;
  enableGate = undefined;
  logged = [];
  secrets = [];
  telegramCalls = [];
  telegramReply = () => ({ ok: true, result: {} });
  tgEnv = path.join(home, "tg.env");
  writeRulesFile({ ...defaults(), hardDeny: [...existing] });
  const admin = async (): Promise<GuardRulesAdmin> => {
    adminConnects += 1;
    if (!adminUp) throw new Error("connect ENOENT admin.sock");
    return {
      rulesGet: async () => {
        if (adminInvalid) throw new GuardRulesInvalid([{ field: "hardDeny", line: 1, message: "незакрытая квадратная скобка «[»" }]);
        await Promise.resolve();
        return structuredClone(adminRules);
      },
      rulesSet: async (rules) => {
        await Promise.resolve();
        adminSets.push(rules);
        adminRules = structuredClone(rules);
        return { ok: true };
      },
      close: () => undefined,
    };
  };
  service = new SettingsService({ name: "second", agentDir: paths.agentDir }, (text) => logged.push(text));
  service.register(
    new SecurityHost({
      paths,
      guardSource: path.join(KIT, "guard"),
      protection: {
        status: async () => status,
        enable: async () => {
          enableCalls += 1;
          await enableGate;
          if (enableError !== undefined) throw enableError;
          status = { state: "on" };
        },
        disable: async () => {
          disableCalls += 1;
          status = { state: "off" };
        },
        writeDenies: async () => ["/opt/homebrew", "/Users/me/.codegraph"],
        installed: () => installed,
      },
      admin,
      serviceMayRun: async () => serviceMayRun,
      models: async () => MODELS,
      log: (text) => logged.push(text),
      addSecret: (value) => secrets.push(value),
      tgEnvPath: tgEnv,
      fetch: async (url, init) => {
        const method = String(url).split("/").pop() as string;
        telegramCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, signal: init?.signal });
        const reply = telegramReply(method);
        if (reply instanceof Error) throw reply;
        return new Response(JSON.stringify(reply));
      },
    }),
  );
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("SecurityHost · protection", () => {
  it("turning_on_asks_for_consent_first", async () => {
    expect(await perform({ kind: "protection.set", on: true, confirmed: false })).toMatchObject({ ok: false });
    expect(enableCalls).toBe(0);
    expect(await perform({ kind: "protection.set", on: true, confirmed: true })).toEqual({ ok: true });
    expect(enableCalls).toBe(1);
    expect((await view()).state).toBe("on");
  });

  it("turning_off_needs_the_confirmation_too", async () => {
    status = { state: "on" };
    expect(await perform({ kind: "protection.set", on: false, confirmed: false })).toMatchObject({ ok: false });
    expect(disableCalls).toBe(0);
    expect(await perform({ kind: "protection.set", on: false, confirmed: true })).toEqual({ ok: true });
    expect(disableCalls).toBe(1);
  });

  it("a_failed_enable_says_why", async () => {
    enableError = new Error("Служба защиты не запустилась за 10 с — журнал: /x/service.log");
    const result = await perform({ kind: "protection.set", on: true, confirmed: true });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Служба защиты не запустилась за 10 с") });
    expect((await view()).state).toBe("off");
  });

  it("the_view_says_which_guard_copy_runs_and_why_it_was_not_refreshed", async () => {
    status = { state: "on" };
    const empty = await view();
    expect(empty.installed).toBeUndefined();
    expect(empty.refreshError).toBeUndefined();
    installed = { installed: { dir: `${home}/.omo/kit/6cdd90b9ec09/guard`, installedAt: 1_762_349_280_000, stale: true }, refreshError: "Служба защиты не запустилась за 10 с" };
    const shown = await view();
    expect(shown.installed).toEqual({ dir: `${home}/.omo/kit/6cdd90b9ec09/guard`, installedAt: 1_762_349_280_000, stale: true });
    expect(shown.refreshError).toBe("Служба защиты не запустилась за 10 с");
  });

  it("the_view_names_what_consent_installs_and_why_it_is_broken", async () => {
    status = { state: "broken", reason: "служба защиты не отвечает на хуковом сокете" };
    const shown = await view();
    expect(shown.state).toBe("broken");
    expect(shown.reason).toBe("служба защиты не отвечает на хуковом сокете");
    expect(shown.consent.plist).toBe(launchAgentPath(home, serviceLabel(paths.agentDir)));
    expect(shown.consent.hooksJson).toBe(paths.hooksJson);
    expect(shown.consent.profile).toBe(profilePath(paths.agentDir));
    expect(shown.consent.kitDir).toMatch(new RegExp(`^${home}/\\.omo/kit/[0-9a-f]{12}/guard$`));
    expect(fs.existsSync(shown.consent.kitDir)).toBe(false); // naming it installs nothing
    expect(shown.consent.writeDenies).toEqual(["/opt/homebrew", "/Users/me/.codegraph"]); // P38: seen before agreeing
    expect(shown.models).toEqual(MODELS);
  });
});

describe("SecurityHost · v1 leftover", () => {
  it("an_old_v1_hook_is_off_with_its_note", async () => {
    status = { state: "off", note: "найдена старая защита v1 — включите защиту, чтобы заменить её" };
    const shown = await view();
    expect(shown.state).toBe("off");
    expect(shown.note).toBe("найдена старая защита v1 — включите защиту, чтобы заменить её");
  });
});

describe("SecurityHost · rules", () => {
  it("an_invalid_line_is_highlighted_and_nothing_is_written", async () => {
    const before = fs.readFileSync(rulesFile(), "utf8");
    const result = await set("askCustom", "a*\nb\n\nc[");
    expect(result).toMatchObject({ ok: false, errors: [{ field: "askCustom", line: 4 }] });
    expect(fs.readFileSync(rulesFile(), "utf8")).toEqual(before);
  });

  it("on_rules_go_through_the_admin_socket_off_rules_go_to_the_file", async () => {
    // off: the extension is the only writer
    expect(await set("askCustom", "kubectl delete *")).toEqual({ ok: true });
    expect(fileRules().askCustom).toEqual(["kubectl delete *"]);
    expect(adminConnects).toBe(0);

    // on: the running service owns the file
    status = { state: "on" };
    const fileBefore = fs.readFileSync(rulesFile(), "utf8");
    expect(await set("askCustom", "DROP TABLE")).toEqual({ ok: true });
    expect(adminSets.map((rules) => rules.askCustom)).toEqual([["DROP TABLE"]]);
    expect(adminSets[0]?.hardDeny).toEqual(existing); // built from the service's rules, not the file's
    expect(fs.readFileSync(rulesFile(), "utf8")).toBe(fileBefore);
    expect((await view()).text.askCustom).toBe("DROP TABLE");
  });

  it("on_with_a_silent_service_writes_nothing", async () => {
    status = { state: "on" };
    adminUp = false;
    const before = fs.readFileSync(rulesFile(), "utf8");
    expect(await set("askCustom", "DROP TABLE")).toMatchObject({ ok: false, error: expect.stringContaining("Служба защиты не отвечает") });
    expect(fs.readFileSync(rulesFile(), "utf8")).toBe(before);
  });

  it("broken_without_a_service_falls_back_to_the_file", async () => {
    status = { state: "broken", reason: "служба защиты не отвечает на хуковом сокете" };
    adminUp = false;
    expect(await set("askCustom", "DROP TABLE")).toEqual({ ok: true });
    expect(fileRules().askCustom).toEqual(["DROP TABLE"]);
  });

  it("broken_with_a_live_but_silent_service_never_writes_the_file", async () => {
    status = { state: "broken", reason: "профиль песочницы устарел или не читается" };
    adminUp = false;
    serviceMayRun = true; // a live socket or a fresh lock: a service owns (or is about to own) the file
    const before = fs.readFileSync(rulesFile(), "utf8");
    expect(await set("askCustom", "DROP TABLE")).toMatchObject({ ok: false, error: expect.stringContaining("запускается или не ответила") });
    expect(fs.readFileSync(rulesFile(), "utf8")).toBe(before);
  });

  it("rule_edits_wait_for_no_switch_and_are_refused_during_one", async () => {
    let open!: () => void;
    enableGate = new Promise<void>((resolve) => (open = resolve));
    const enabling = perform({ kind: "protection.set", on: true, confirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = fs.readFileSync(rulesFile(), "utf8");
    expect(await set("askCustom", "DROP TABLE")).toMatchObject({ ok: false, error: expect.stringContaining("дождитесь") });
    expect(fs.readFileSync(rulesFile(), "utf8")).toBe(before);
    expect(adminSets).toEqual([]);
    open();
    expect(await enabling).toEqual({ ok: true });
  });

  it("concurrent_edits_are_applied_one_after_another", async () => {
    status = { state: "on" };
    const results = await Promise.all([set("askCustom", "DROP TABLE"), perform({ kind: "group.set", group: "secrets", on: false })]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(adminRules.askCustom).toEqual(["DROP TABLE"]);
    expect(adminRules.groups.secrets).toBe(false);
  });

  it("rules_the_service_refuses_make_the_state_broken_and_edits_wait", async () => {
    status = { state: "on" };
    adminInvalid = true;
    const shown = await view();
    expect(shown.state).toBe("broken");
    expect(shown.reason).toContain("незакрытая квадратная скобка");
    expect(shown.text.hardDeny.split("\n")).toEqual(defaults().hardDeny);
    expect(await set("askCustom", "DROP TABLE")).toMatchObject({ ok: false, error: expect.stringContaining("rules.json") });
    expect(adminSets).toEqual([]);
  });

  it("claude_import_appends_unique_lines", async () => {
    fs.mkdirSync(paths.claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.claudeDir, "settings.json"),
      JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)", "Bash(git push --force)", "Read(./.env)", "Bash(mkfs:*)"] } }),
    );
    expect(await perform({ kind: "importClaude" })).toEqual({ ok: true, notice: "импортировано 1, пропущено 1 (не Bash)" });
    expect((await view()).text.hardDeny.split("\n")).toEqual([...existing, "git push --force"]);
  });

  it("claude_import_without_a_settings_file_says_so", async () => {
    expect(await perform({ kind: "importClaude" })).toMatchObject({ ok: false, error: expect.stringContaining("settings.json") });
  });

  it("ip_whitelist_round_trips_notes", async () => {
    expect(await set("ipWhitelist", "203.0.113.10 # дев-сервер")).toEqual({ ok: true });
    expect((await view()).text.ipWhitelist).toBe("203.0.113.10 # дев-сервер");
    expect(fileRules().ipWhitelist).toEqual([{ cidr: "203.0.113.10", note: "дев-сервер" }]);
    expect(await set("ipWhitelist", "203.0.113.10\nnot-an-ip # x")).toMatchObject({ ok: false, errors: [{ field: "ipWhitelist", line: 2 }] });
  });

  it("groups_decider_and_human_are_written", async () => {
    expect(await perform({ kind: "group.set", group: "git-push", on: false })).toEqual({ ok: true });
    expect(await perform({ kind: "decider.set", mode: "ask-me" })).toEqual({ ok: true });
    expect(await perform({ kind: "decider.set", model: "openai-codex/gpt-6-sol" })).toEqual({ ok: true });
    expect(await perform({ kind: "telegram.token", token: TOKEN })).toEqual({ ok: true });
    expect(await perform({ kind: "telegram.chat", chat: "42" })).toEqual({ ok: true });
    expect(await perform({ kind: "human.set", waitSeconds: 60, telegram: true })).toEqual({ ok: true });
    let rules = fileRules();
    expect(rules.groups["git-push"]).toBe(false);
    expect(rules.decider).toMatchObject({ mode: "ask-me", model: "openai-codex/gpt-6-sol" });
    expect(rules.human).toEqual({ waitSeconds: 60, card: true, telegram: true, telegramChat: "42" });

    // «нет модели»: the key goes, the mode stays (the service asks the person)
    expect(await perform({ kind: "decider.set", mode: "decider-then-me", model: "" })).toEqual({ ok: true });
    rules = fileRules();
    expect(rules.decider.mode).toBe("decider-then-me");
    expect("model" in rules.decider).toBe(false);
    expect((await view()).decider).toEqual(rules.decider);
  });

  it("malformed_actions_are_refused", async () => {
    const before = fs.readFileSync(rulesFile(), "utf8");
    for (const action of [
      { kind: "group.set", group: "nope", on: true },
      { kind: "decider.set", mode: "maybe" },
      { kind: "decider.set", model: "no-slash" },
      { kind: "human.set", waitSeconds: 90 },
      { kind: "text.set", field: "allow", text: "x" },
      { kind: "protection.set", on: true },
    ]) {
      expect(await perform(action), JSON.stringify(action)).toMatchObject({ ok: false, error: "Действие не распознано" });
    }
    expect(fs.readFileSync(rulesFile(), "utf8")).toBe(before);
  });

  it("no_rules_file_shows_the_defaults_and_the_first_change_creates_it", async () => {
    fs.rmSync(rulesFile());
    const shown = await view();
    expect(shown.text.hardDeny.split("\n")).toEqual(defaults().hardDeny);
    expect(shown.text.ipWhitelist).toBe("");
    expect(await perform({ kind: "group.set", group: "secrets", on: false })).toEqual({ ok: true });
    expect(fileRules()).toEqual({ ...defaults(), groups: { ...defaults().groups, secrets: false } });
    expect(fs.statSync(rulesFile()).mode & 0o777).toBe(0o600);
  });
});

describe("SecurityHost · Telegram", () => {
  const keyFile = (): string => path.join(paths.agentDir, "keys", "telegram.key");

  it("the_bot_token_goes_to_its_key_file_and_only_its_last_four_are_shown", async () => {
    expect((await view()).telegram).toEqual({ chat: "", legacy: false, ready: false });
    expect(await perform({ kind: "telegram.token", token: `  ${TOKEN}  ` })).toEqual({ ok: true });
    expect(secrets).toContain(TOKEN); // P12: known before anything can log or post it
    expect(fs.readFileSync(keyFile(), "utf8")).toBe(TOKEN);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    const shown = await view();
    expect(shown.telegram).toEqual({ tokenHint: "••••••3456", chat: "", legacy: false, ready: false });
    expect(JSON.stringify(shown)).not.toContain(TOKEN);
    // an empty submit keeps the stored token
    expect(await perform({ kind: "telegram.token", token: "" })).toEqual({ ok: true });
    expect(fs.readFileSync(keyFile(), "utf8")).toBe(TOKEN);
  });

  it("something_that_is_not_a_bot_token_is_refused_and_still_kept_secret", async () => {
    const typed = "not-a-token-but-secret";
    expect(await perform({ kind: "telegram.token", token: typed })).toMatchObject({ ok: false, errors: [{ field: "telegramToken" }] });
    expect(secrets).toContain(typed);
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("the_chat_goes_to_the_rules_through_their_one_writer", async () => {
    expect(await perform({ kind: "telegram.chat", chat: " 42 " })).toEqual({ ok: true });
    expect(fileRules().human.telegramChat).toBe("42");
    expect(await perform({ kind: "telegram.chat", chat: "@me" })).toMatchObject({ ok: false, errors: [{ field: "human.telegramChat" }] });
    status = { state: "on" };
    expect(await perform({ kind: "telegram.chat", chat: "77" })).toEqual({ ok: true });
    expect(adminSets.at(-1)?.human.telegramChat).toBe("77");
    expect(await perform({ kind: "telegram.chat", chat: "" })).toEqual({ ok: true });
    expect("telegramChat" in (adminSets.at(-1)?.human ?? {})).toBe(false);
  });

  it("telegram_cannot_be_turned_on_until_token_and_chat_are_set", async () => {
    expect(await perform({ kind: "human.set", telegram: true })).toMatchObject({ ok: false, errors: [{ field: "telegram" }] });
    expect(fileRules().human.telegram).toBe(false);
    await perform({ kind: "telegram.token", token: TOKEN });
    expect(await perform({ kind: "human.set", telegram: true })).toMatchObject({ ok: false });
    await perform({ kind: "telegram.chat", chat: "42" });
    expect((await view()).telegram.ready).toBe(true);
    expect(await perform({ kind: "human.set", telegram: true })).toEqual({ ok: true });
    expect(await perform({ kind: "human.set", telegram: false })).toEqual({ ok: true }); // off is always allowed
  });

  it("the_supervisor_tg_env_still_counts_without_a_key_file", async () => {
    fs.writeFileSync(tgEnv, "TG_BOT_TOKEN=111:legacy-token-abcdefghijklmnopqrst\nTG_CHAT_ID=5\n");
    expect((await view()).telegram).toEqual({ chat: "", legacy: true, ready: true });
    expect(await perform({ kind: "human.set", telegram: true })).toEqual({ ok: true });
  });

  it("find_chat_takes_the_latest_private_chat_and_fills_chat_and_user", async () => {
    expect(await perform({ kind: "telegram.find" })).toMatchObject({ ok: false, error: expect.stringContaining("токен") });
    await perform({ kind: "telegram.token", token: TOKEN });
    telegramReply = () => ({ ok: true, result: [] });
    expect(await perform({ kind: "telegram.find" })).toMatchObject({ ok: false, errors: [{ field: "telegram", message: expect.stringContaining("/start") }] });
    telegramReply = () => ({
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 100, type: "private" }, from: { id: 100 }, text: "/start" } },
        { update_id: 2, message: { chat: { id: 200, type: "private" }, from: { id: 201 }, text: "/start" } },
      ],
    });
    const found = await perform({ kind: "telegram.find" });
    expect(found).toMatchObject({ ok: true, notice: expect.stringContaining("200") });
    expect(fileRules().human).toMatchObject({ telegramChat: "200", telegramUser: "201" });
    const call = telegramCalls.at(-1);
    expect(call?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(call?.body).toMatchObject({ allowed_updates: ["message"] });
    expect(call?.body["offset"]).toBeUndefined(); // nothing is confirmed: the service's updates stay
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    // a chat typed by hand drops the user found for another one
    await perform({ kind: "telegram.chat", chat: "300" });
    expect(fileRules().human.telegramUser).toBeUndefined();
  });

  it("check_sends_a_test_message_and_says_why_it_failed_without_the_token", async () => {
    await perform({ kind: "telegram.token", token: TOKEN });
    expect(await perform({ kind: "telegram.test" })).toMatchObject({ ok: false, error: expect.stringContaining("чат") });
    await perform({ kind: "telegram.chat", chat: "42" });
    expect(await perform({ kind: "telegram.test" })).toMatchObject({ ok: true, notice: expect.any(String) });
    expect(telegramCalls.at(-1)).toMatchObject({ url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, body: { chat_id: "42", text: "Agent Tabs: проверка связи" } });

    telegramReply = () => ({ ok: false, error_code: 401, description: `Unauthorized for bot${TOKEN}` });
    const refused = await perform({ kind: "telegram.test" });
    expect(refused).toMatchObject({ ok: false, errors: [{ field: "telegram", message: expect.stringContaining("Unauthorized") }] });
    expect(JSON.stringify(refused)).not.toContain(TOKEN);

    telegramReply = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(await perform({ kind: "telegram.test" })).toMatchObject({ ok: false, error: expect.stringContaining("10 с") });
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});
