// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import type { FieldError } from "../../src/settings/protocol";
import type { SecurityView } from "../../src/settings/security";
import { ChatView } from "../../webview/render";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

const ENV = { name: "second", agentDir: "/a" };

const security: SecurityView = {
  state: "off",
  consent: {
    plist: "/h/Library/LaunchAgents/local.agent-tabs.guard.1234abcd.plist",
    kitDir: "/h/.omo/kit/0123456789ab/guard",
    hooksJson: "/a/hooks.json",
    profile: "/a/guard/sandbox.sb",
    writeDenies: ["/opt/homebrew", "/h/.codegraph", "/h/dev/repo/bin/tool"],
  },
  text: {
    hardDeny: "rm -rf /\nsudo rm *\nmkfs*\ndd if=*\ndiskutil erase*\ncurl * | sh",
    askCustom: "docker volume prune*\nkubectl delete *\nDROP TABLE",
    ipWhitelist: "203.0.113.10 # дев-сервер\n203.0.113.20\n10.20.0.0/16 # офис",
  },
  groups: { "git-push": true, history: true, secrets: true, "external-ip": true, "global-install": false },
  decider: { mode: "decider-then-me", model: "gw-anthropic/claude-haiku-5-5", timeoutMs: 20000 },
  human: { waitSeconds: 300, card: true, telegram: false },
  telegram: { chat: "", legacy: false, ready: false },
  models: [
    { connection: "Шлюз (Anthropic API)", items: [{ value: "gw-anthropic/claude-haiku-5-5", label: "Claude Haiku 5.5" }] },
    { connection: "ChatGPT", items: [{ value: "openai-codex/gpt-6-sol", label: "GPT 6 Sol" }] },
  ],
};

function body(): HTMLElement {
  return root.querySelector('[data-section-body="security"]') as HTMLElement;
}
function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = body().querySelector<T>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
}
function actions(): Array<Record<string, unknown>> {
  return posted.flatMap((message) => (message.type === "settingsAction" ? [{ ...message.action }] : []));
}
function lastId(): string {
  const last = posted.filter((message) => message.type === "settingsAction").at(-1);
  if (last === undefined || last.type !== "settingsAction") throw new Error("nothing posted");
  return last.id;
}
function show(part: Partial<SecurityView> = {}): void {
  view.settings({ env: ENV, security: { ...security, ...part } });
}
const radioLabels = (seg: string): string[] => [...body().querySelectorAll(`[data-seg="${seg}"] button`)].map((node) => node.textContent ?? "");
const counter = (field: string): string => q(`[data-counter="${field}"]`).textContent ?? "";
const markedLines = (field: string): number[] =>
  [...body().querySelectorAll<HTMLElement>(`[data-lines="${field}"] [data-line].err`)].map((node) => Number(node.dataset["line"]));
const area = (field: string): HTMLTextAreaElement => q<HTMLTextAreaElement>(`textarea[data-field="${field}"]`);
function edit(field: string, text: string): void {
  const control = area(field);
  control.value = text;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}
function result(answer: { ok: boolean; error?: string; errors?: FieldError[]; notice?: string }): void {
  view.settingsResult({ type: "settingsResult", id: lastId(), ...answer });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  view.update({ type: "state", state: initialState(), tab: { modelMode: "auto", sessionPath: "/s/a.jsonl", durableId: "d1" }, reconnectable: true });
  view.openSettings("security");
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
});

describe("«Безопасность»", () => {
  it("the_section_renders_modes_waits_and_counts", () => {
    show();
    expect(radioLabels("mode")).toEqual(["Модель-решатель, при сомнении — я", "Сразу спрашивать меня", "Сразу запрещать"]);
    expect(radioLabels("wait")).toEqual(["1 мин", "3 мин", "5 мин"]);
    expect(q('[data-seg="mode"] button.on').textContent).toBe("Модель-решатель, при сомнении — я");
    expect(q('[data-seg="wait"] button.on').textContent).toBe("5 мин");
    expect(counter("hardDeny")).toBe("6 правил");
    expect(counter("askCustom")).toBe("3 правила");
    expect(counter("ipWhitelist")).toBe("3 записи");
    expect(body().textContent).toContain("локальная сеть (192.168.*, 10.*, localhost) разрешена всегда");
    expect(body().textContent).toContain("Модель-решатель: Claude Haiku 5.5");
    expect(q('[data-group="global-install"]').textContent).toContain("Глобальная установка пакетов");
    expect(q('[data-group="global-install"]').textContent).toContain("npm -g, pip install");
    expect(q('[data-toggle="group:global-install"]').getAttribute("aria-checked")).toBe("false");
    // the counter follows what is typed
    area("askCustom").value = "a\n\nb";
    area("askCustom").dispatchEvent(new Event("input", { bubbles: true }));
    expect(counter("askCustom")).toBe("2 правила");
  });

  it("an_error_line_is_marked", () => {
    show();
    edit("askCustom", "a*\nb\n\nc[");
    expect(actions().at(-1)).toEqual({ kind: "text.set", field: "askCustom", text: "a*\nb\n\nc[" });
    result({ ok: false, error: "Правило не принято", errors: [{ field: "askCustom", line: 4, message: "незакрытая скобка" }] });
    expect(markedLines("askCustom")).toEqual([4]);
    expect(area("askCustom").value).toBe("a*\nb\n\nc["); // the text stays for fixing
    expect(q('[data-errors="askCustom"]').textContent).toContain("строка 4: незакрытая скобка");
    show(); // a state arriving meanwhile keeps the person's text
    expect(area("askCustom").value).toBe("a*\nb\n\nc[");

    edit("askCustom", "a*\nb\n\nc");
    result({ ok: true });
    expect(markedLines("askCustom")).toEqual([]);
    expect(q('[data-errors="askCustom"]').textContent).toBe("");
  });

  it("a_field_left_unchanged_posts_nothing", () => {
    show();
    area("hardDeny").dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions()).toEqual([]);
  });

  it("turning_on_shows_the_consent_and_posts_only_after_yes", () => {
    show();
    q<HTMLButtonElement>('[data-toggle="protection"]').click();
    expect(actions()).toEqual([]);
    const consent = q('[data-role="consent"]');
    expect(consent.hidden).toBe(false);
    for (const file of Object.values(security.consent).flat()) expect(consent.textContent).toContain(file);
    // P38: every dir closed to agents is named, each on its own line
    const closed = [...consent.querySelectorAll('[data-role="write-denies"] li')].map((item) => item.textContent);
    expect(closed).toEqual(security.consent.writeDenies);
    expect(consent.textContent).toContain("перезапустится");
    expect(consent.textContent).toContain("прервутся");
    expect(consent.textContent).toContain(".git/config");
    expect(consent.textContent).toContain("~/.gitconfig");
    expect(consent.textContent).toContain("git clone");
    expect(consent.textContent).toContain("/opt/homebrew");
    expect(consent.textContent).toContain("--disable-sandbox");
    expect(consent.textContent).toContain(
      "macOS покажет уведомление «Node.js Foundation может работать в фоне» — это служба защиты; не выключайте её в «Объектах входа».",
    );
    q<HTMLButtonElement>('[data-action="consent.cancel"]').click();
    expect(consent.hidden).toBe(true);
    expect(actions()).toEqual([]);

    q<HTMLButtonElement>('[data-toggle="protection"]').click();
    q<HTMLButtonElement>('[data-action="consent.confirm"]').click();
    expect(actions()).toEqual([{ kind: "protection.set", on: true, confirmed: true }]);
  });

  it("turning_off_is_confirmed_too", () => {
    show({ state: "on" });
    q<HTMLButtonElement>('[data-toggle="protection"]').click();
    expect(actions()).toEqual([]);
    expect(q('[data-role="consent"]').textContent).toContain("прервутся");
    q<HTMLButtonElement>('[data-action="consent.confirm"]').click();
    expect(actions()).toEqual([{ kind: "protection.set", on: false, confirmed: true }]);
  });

  it("broken_shows_the_reason_and_repair_asks_for_consent_first", () => {
    show({ state: "broken", reason: "служба защиты не отвечает на хуковом сокете" });
    expect(q('[data-role="protection-reason"]').textContent).toContain("служба защиты не отвечает на хуковом сокете");
    q<HTMLButtonElement>('[data-action="repair"]').click();
    expect(actions()).toEqual([]);
    const consent = q('[data-role="consent"]');
    expect(consent.hidden).toBe(false);
    for (const file of Object.values(security.consent).flat()) expect(consent.textContent).toContain(file);
    q<HTMLButtonElement>('[data-action="consent.confirm"]').click();
    expect(actions()).toEqual([{ kind: "protection.set", on: true, confirmed: true }]);
  });

  it("the_running_guard_copy_and_a_failed_refresh_are_visible", () => {
    const at = Date.parse("2026-11-05T14:48:00");
    const dir = "/h/.omo/kit/6cdd90b9ec09/guard";
    show({ state: "on" });
    expect(q('[data-role="installed-kit"]').hidden).toBe(true); // nothing known: no line at all

    show({ state: "on", installed: { dir, installedAt: at, stale: false } });
    const line = q('[data-role="installed-kit"]');
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain(dir);
    expect(line.textContent).toContain(new Date(at).toLocaleString("ru-RU"));
    expect(line.textContent).not.toContain("старее");
    expect(line.classList.contains("st-warn")).toBe(false);

    // the copy that decides is an older build's: said out loud, though protection itself reads «on»
    show({ state: "on", installed: { dir, installedAt: at, stale: true } });
    expect(q('[data-role="installed-kit"]').textContent).toContain("старее установленного расширения");
    expect(q('[data-role="installed-kit"]').classList.contains("st-warn")).toBe(true);

    show({ state: "on", installed: { dir, stale: true }, refreshError: "Служба защиты не запустилась за 10 с" });
    expect(q('[data-role="kit-refresh-error"]').textContent).toContain("Служба защиты не запустилась за 10 с");
  });

  it("an_old_v1_guard_is_named", () => {
    show({ note: "найдена старая защита v1 — включите защиту, чтобы заменить её" });
    const note = q('[data-role="protection-note"]');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("найдена старая защита v1 — включите защиту, чтобы заменить её");
    show();
    expect(q('[data-role="protection-note"]').hidden).toBe(true);
  });

  it("closing_the_modal_saves_a_changed_field", () => {
    show();
    area("askCustom").value = "kubectl delete *";
    area("askCustom").dispatchEvent(new Event("input", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(actions()).toEqual([{ kind: "text.set", field: "askCustom", text: "kubectl delete *" }]);
  });

  it("import_waits_until_the_field_is_fixed", () => {
    show();
    edit("hardDeny", "rm -rf /\nc[");
    result({ ok: false, error: "Правила не сохранены", errors: [{ field: "hardDeny", line: 2, message: "незакрытая квадратная скобка «[»" }] });
    q<HTMLButtonElement>('[data-action="importClaude"]').click();
    expect(actions().filter((action) => action["kind"] === "importClaude")).toEqual([]);
    expect(q('[data-errors="hardDeny"]').textContent).toContain("исправьте поле перед импортом");
    expect(area("hardDeny").value).toBe("rm -rf /\nc[");
  });

  it("import_first_saves_the_field_and_imports_only_when_that_was_accepted", () => {
    show();
    area("hardDeny").value = "rm -rf /\ngit push --force";
    area("hardDeny").dispatchEvent(new Event("input", { bubbles: true }));
    q<HTMLButtonElement>('[data-action="importClaude"]').click();
    expect(actions()).toEqual([{ kind: "text.set", field: "hardDeny", text: "rm -rf /\ngit push --force" }]);
    result({ ok: true });
    expect(actions().at(-1)).toEqual({ kind: "importClaude" });

    posted = [];
    area("hardDeny").value = "rm -rf /\nc[";
    area("hardDeny").dispatchEvent(new Event("input", { bubbles: true }));
    q<HTMLButtonElement>('[data-action="importClaude"]').click();
    expect(actions()).toEqual([{ kind: "text.set", field: "hardDeny", text: "rm -rf /\nc[" }]);
    result({ ok: false, error: "Правила не сохранены", errors: [{ field: "hardDeny", line: 2, message: "незакрытая квадратная скобка «[»" }] });
    expect(actions().filter((action) => action["kind"] === "importClaude")).toEqual([]);
    expect(q('[data-errors="hardDeny"]').textContent).toContain("исправьте поле перед импортом");
  });

  it("the_import_says_how_many_lines_it_took", () => {
    show();
    q<HTMLButtonElement>('[data-action="importClaude"]').click();
    result({ ok: true, notice: "импортировано 1, пропущено 1 (не Bash)" });
    expect(q('[data-role="import-notice"]').textContent).toBe("импортировано 1, пропущено 1 (не Bash)");
  });

  it("the_swift_hint_shows_only_under_protection", () => {
    show();
    expect(q('[data-role="sandbox-hint"]').hidden).toBe(true);
    show({ state: "on" });
    const hint = q('[data-role="sandbox-hint"]');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("swift build --disable-sandbox");
    expect(hint.textContent).toContain("-IDEPackageSupportDisableManifestSandbox=YES");
    expect(q('[data-role="protection-reason"]').hidden).toBe(true);
  });

  it("decider_human_groups_and_import_post_their_actions", () => {
    show({ telegram: { tokenHint: "••••••3456", chat: "42", legacy: false, ready: true } });
    [...body().querySelectorAll<HTMLButtonElement>('[data-seg="mode"] button')][1]!.click();
    const model = q<HTMLSelectElement>('select[data-field="decider-model"]');
    expect([...model.options].map((option) => option.textContent)).toEqual(["нет модели", "Claude Haiku 5.5", "GPT 6 Sol"]);
    model.value = "openai-codex/gpt-6-sol";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    [...body().querySelectorAll<HTMLButtonElement>('[data-seg="wait"] button')][0]!.click();
    q<HTMLButtonElement>('[data-toggle="telegram"]').click();
    q<HTMLButtonElement>('[data-toggle="card"]').click();
    q<HTMLButtonElement>('[data-toggle="group:git-push"]').click();
    q<HTMLButtonElement>('[data-action="importClaude"]').click();
    expect(actions()).toEqual([
      { kind: "decider.set", mode: "ask-me" },
      { kind: "decider.set", model: "openai-codex/gpt-6-sol" },
      { kind: "human.set", waitSeconds: 60 },
      { kind: "human.set", telegram: true },
      { kind: "human.set", card: false },
      { kind: "group.set", group: "git-push", on: false },
      { kind: "importClaude" },
    ]);
  });

  it("no_decider_model_says_so_and_no_longer_promises_a_question", () => {
    // P44: with no model chosen the service allows and logs — the note must not promise the person a card.
    show({ decider: { mode: "decider-then-me", timeoutMs: 20000 } });
    expect(q<HTMLSelectElement>('select[data-field="decider-model"]').value).toBe("");
    expect(q('[data-role="decider-note"]').textContent).toContain("модель не выбрана — спорное пройдёт с записью в лог");
    // the shipped default: "" is no model chosen (P38)
    show({ decider: { mode: "decider-then-me", model: "", timeoutMs: 20000 } });
    expect(q<HTMLSelectElement>('select[data-field="decider-model"]').value).toBe("");
    expect(q('[data-role="decider-note"]').textContent).toContain("модель не выбрана — спорное пройдёт с записью в лог");
    // a model no connection offers any more is still shown as the current one
    show({ decider: { mode: "decider-then-me", model: "gone/model", timeoutMs: 20000 } });
    expect(q<HTMLSelectElement>('select[data-field="decider-model"]').value).toBe("gone/model");
  });
});

describe("«Безопасность» · Telegram", () => {
  const panel = (): HTMLElement => q('[data-role="telegram"]');
  const tokenField = (): HTMLInputElement => q<HTMLInputElement>('input[data-field="telegramToken"]');
  const chatField = (): HTMLInputElement => q<HTMLInputElement>('input[data-field="telegramChat"]');
  const change = (field: HTMLInputElement, value: string): void => {
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("the_setup_is_hidden_while_telegram_is_off", () => {
    show();
    expect(panel().hidden).toBe(true);
    show({ human: { ...security.human, telegram: true }, telegram: { tokenHint: "••••••3456", chat: "42", legacy: false, ready: true } });
    expect(panel().hidden).toBe(false);
    expect(chatField().value).toBe("42");
  });

  it("turning_it_on_unset_opens_the_setup_with_the_reason_and_posts_nothing", () => {
    show();
    q<HTMLButtonElement>('[data-toggle="telegram"]').click();
    expect(actions()).toEqual([]);
    expect(panel().hidden).toBe(false);
    expect(panel().textContent).toContain("Сначала укажите токен бота и чат");
    expect(panel().textContent).toContain("Создайте бота у @BotFather (/newbot) и вставьте токен.");
    expect(panel().textContent).toContain("Напишите своему боту /start и нажмите «Найти чат»");
    expect(panel().textContent).toContain("Токен бота");
    expect(panel().textContent).toContain("Кому отправлять");
    show(); // a state arriving meanwhile keeps the setup open
    expect(panel().hidden).toBe(false);
  });

  it("the_token_is_a_password_field_and_an_empty_one_posts_nothing", () => {
    show({ human: { ...security.human, telegram: true }, telegram: { tokenHint: "••••••3456", chat: "42", legacy: false, ready: true } });
    expect(tokenField().type).toBe("password");
    expect(tokenField().value).toBe("");
    expect(tokenField().placeholder).toBe("••••••3456");
    change(tokenField(), "   ");
    expect(actions()).toEqual([]);
    change(tokenField(), "123456789:AAH-secret");
    expect(actions()).toEqual([{ kind: "telegram.token", token: "123456789:AAH-secret" }]);
    result({ ok: true });
    expect(tokenField().value).toBe(""); // the stored token is never shown again
  });

  it("chat_find_and_check_post_and_show_their_answer_inline", () => {
    show();
    q<HTMLButtonElement>('[data-toggle="telegram"]').click();
    change(chatField(), "42");
    expect(actions().at(-1)).toEqual({ kind: "telegram.chat", chat: "42" });
    q<HTMLButtonElement>('[data-action="telegram.find"]').click();
    expect(actions().at(-1)).toEqual({ kind: "telegram.find" });
    result({ ok: true, notice: "Найден чат 200" });
    expect(q('[data-role="telegram-status"]').textContent).toBe("Найден чат 200");
    q<HTMLButtonElement>('[data-action="telegram.test"]').click();
    expect(actions().at(-1)).toEqual({ kind: "telegram.test" });
    result({ ok: false, error: "Telegram отказал: Unauthorized", errors: [{ field: "telegram", message: "Telegram отказал: Unauthorized" }] });
    expect(q('[data-role="telegram-status"]').textContent).toBe("Telegram отказал: Unauthorized");
    expect(q('[data-role="telegram-status"]').classList.contains("err")).toBe(true);
  });

  it("the_supervisor_tg_env_is_named_when_it_is_what_works", () => {
    show({ telegram: { chat: "", legacy: true, ready: true } });
    q<HTMLButtonElement>('[data-toggle="telegram"]').click();
    expect(actions()).toEqual([{ kind: "human.set", telegram: true }]);
    show({ human: { ...security.human, telegram: true }, telegram: { chat: "", legacy: true, ready: true } });
    expect(panel().textContent).toContain("tg.env");
  });
});
