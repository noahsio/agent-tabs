import type { DeciderMode, WaitSeconds } from "../../src/guard/admin";
import type { SandboxLayer } from "../../kit/sandbox/profile.mjs";
import type { FieldError, SettingsView } from "../../src/settings/protocol";
import type { SecurityView, TextField } from "../../src/settings/security";
import { breakable, button, el } from "../dom";
import type { SectionContext, SectionView } from "./sections";

const MODES: ReadonlyArray<[DeciderMode, string]> = [
  ["decider-then-me", "Модель-решатель, при сомнении — я"],
  ["ask-me", "Сразу спрашивать меня"],
  ["deny", "Сразу запрещать"],
];
const WAITS: ReadonlyArray<[WaitSeconds, string]> = [
  [60, "1 мин"],
  [180, "3 мин"],
  [300, "5 мин"],
];
const LAYERS: ReadonlyArray<[SandboxLayer, string, string]> = [
  ["launch", "Запуск вне песочницы", "папки из PATH, файлы оболочки, конфиг и хуки git, приложения и их расширения"],
  ["agentCode", "Инструкции и код агентов", "навыки, плагины, пакеты, .omo / .claude / .mcp.json в проектах"],
  ["localServices", "Выход через локальные службы", "ssh на этот Mac, сокеты редактора и OmO, открытие приложений"],
];
const SWIFT_FLAGS = "swift build --disable-sandbox (и test, run); xcodebuild -IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePackageSandbox=YES";
const SANDBOX_HINT = `Под песочницей вложенная песочница запрещена ядром: Swift и Xcode собирают с флагами — ${SWIFT_FLAGS}.`;
// P44: не выбранная модель — пробел в настройке, а не свидетельство о команде: служба разрешает и пишет строку в лог.
const NO_MODEL_NOTE = "Решатель: модель не выбрана — спорное пройдёт с записью в лог, а не спросит вас. Выберите модель, чтобы спорное разбирал он.";
const MISSING = "нет в подключениях";
const BACKGROUND_NOTICE = "macOS покажет уведомление «Node.js Foundation может работать в фоне» — это служба защиты; не выключайте её в «Объектах входа».";
const FIX_BEFORE_IMPORT = "исправьте поле перед импортом — иначе следующее сохранение затрёт импортированные строки";
const KIT_STALE = "она старее установленного расширения: решают её правила, а не нынешние. Перезагрузите окно — копия обновится";
const KIT_NOT_REFRESHED = "Копию защиты не удалось обновить до нынешней";

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const ones = count % 10;
  const word = ones === 1 && tens !== 11 ? one : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? few : many;
  return `${count} ${word}`;
}

const nonEmpty = (text: string): number => text.split("\n").filter((line) => line.trim() !== "").length;
const COUNTERS: Record<TextField, (text: string) => string> = {
  hardDeny: (text) => plural(nonEmpty(text), "правило", "правила", "правил"),
  askCustom: (text) => plural(nonEmpty(text), "правило", "правила", "правил"),
  ipWhitelist: (text) => plural(nonEmpty(text), "запись", "записи", "записей"),
};

function toggle(id: string, label: string, on: boolean, onFlip: (next: boolean) => void): HTMLButtonElement {
  return button("", { class: "st-switch", role: "switch", "aria-checked": String(on), "aria-label": label, "data-toggle": id }, () => onFlip(!on));
}

function segmented<T>(id: string, label: string, options: ReadonlyArray<readonly [T, string]>, current: T, pick: (value: T) => void): HTMLElement {
  const group = el("div", { class: "st-seg", role: "group", "aria-label": label, "data-seg": id });
  for (const [value, text] of options) {
    const on = value === current;
    group.append(button(text, { class: on ? "on" : "", "aria-pressed": String(on) }, () => on || pick(value)));
  }
  return group;
}

/**
 * One rule field: a line-numbered textarea (one line — one rule) whose refused lines are marked in the gutter and
 * listed below. A change posts when the field is left; refused text stays for fixing until an accepted change.
 */
class RuleField {
  readonly element: HTMLElement;
  readonly counter: HTMLElement;
  private readonly area: HTMLTextAreaElement;
  private readonly gutter: HTMLElement;
  private readonly errorList: HTMLElement;
  private shown = "";
  /** The person's text while the host has not accepted it. */
  private draft: string | undefined;
  private marks: FieldError[] = [];
  private posted: string | undefined;
  /** A message of the section's own about this field (not the host's). */
  private own: string | undefined;

  constructor(
    private readonly field: TextField,
    label: string,
    rows: number,
    private readonly post: (text: string) => string,
  ) {
    this.area = el("textarea", { class: "st-mono st-rule-text", "data-field": field, rows: String(rows), wrap: "off", spellcheck: "false", "aria-label": label });
    this.gutter = el("div", { class: "st-gutter st-mono", "data-lines": field, "aria-hidden": "true" });
    this.counter = el("span", { "data-counter": field });
    this.errorList = el("div", { class: "st-rule-errors", "data-errors": field, role: "status" });
    this.area.addEventListener("input", () => this.paint());
    this.area.addEventListener("scroll", () => (this.gutter.scrollTop = this.area.scrollTop));
    this.area.addEventListener("change", () => this.commit());
    this.element = el("div", { class: "st-rules" }, this.gutter, this.area);
  }

  get errors(): HTMLElement {
    return this.errorList;
  }

  /** The host refused the text the field holds: it is not saved and must be fixed first. */
  get invalid(): boolean {
    return this.marks.length > 0;
  }

  say(message: string): void {
    this.own = message;
    this.paint();
  }

  /** A change not yet posted (the field never lost focus) is posted now; returns the id of the save in flight, if any. */
  flush(): string | undefined {
    if (this.area.value !== (this.draft ?? this.shown)) this.commit();
    return this.posted;
  }

  show(text: string): void {
    this.shown = text;
    if (this.draft === undefined && document.activeElement !== this.area) this.area.value = text;
    this.paint();
  }

  result(id: string, ok: boolean, errors: readonly FieldError[]): void {
    if (id !== this.posted) return;
    this.posted = undefined;
    if (ok) {
      this.draft = undefined;
      this.marks = [];
    } else this.marks = errors.filter((error) => error.field === this.field);
    this.paint();
  }

  private commit(): void {
    this.own = undefined;
    const text = this.area.value;
    if (text === this.shown && this.draft === undefined) return;
    this.draft = text;
    this.posted = this.post(text);
  }

  private paint(): void {
    const marked = new Set(this.marks.map((error) => error.line));
    const lines = Math.max(this.area.value.split("\n").length, Number(this.area.getAttribute("rows")));
    this.gutter.replaceChildren(
      ...Array.from({ length: lines }, (_, index) => el("span", { "data-line": String(index + 1), class: marked.has(index + 1) ? "err" : "" }, String(index + 1))),
    );
    this.counter.textContent = COUNTERS[this.field](this.area.value);
    this.errorList.replaceChildren(
      ...this.marks.map((error) => el("div", {}, error.line !== undefined ? `строка ${error.line}: ${error.message}` : error.message)),
      ...(this.own !== undefined ? [el("div", {}, this.own)] : []),
    );
    this.area.classList.toggle("st-invalid", this.marks.length > 0);
  }
}

const TELEGRAM_HELP = "Создайте бота у @BotFather (/newbot) и вставьте токен.";
const TELEGRAM_FIND_HINT = "Напишите своему боту /start и нажмите «Найти чат»";
const TELEGRAM_NOT_READY = "Сначала укажите токен бота и чат";
const TELEGRAM_LEGACY = "Сейчас работает бот из tg.env супервизора. Сохраните токен — у этой среды будет свой бот.";

/**
 * Telegram's setup under «Спрашивать меня»: the bot token (a password field — the stored one shows only as ••••••+last 4,
 * an empty submit keeps it), the chat, «Найти чат» and «Проверить» with their answer inline. Built once: a state that
 * arrives while the person types keeps what they typed.
 */
class TelegramSetup {
  readonly element: HTMLElement;
  private readonly token: HTMLInputElement;
  private readonly chat: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly reason: HTMLElement;
  private readonly legacy: HTMLElement;
  /** Opened by a toggle that could not turn on yet. */
  private opened = false;
  private ready = false;
  private enabled = false;
  /** This setup's saves and checks in flight: their answer shows here. */
  private readonly posted = new Map<string, "token" | "chat" | "find" | "test">();

  constructor(private readonly act: (action: Record<string, unknown>) => string) {
    this.token = el("input", { type: "password", "data-field": "telegramToken", autocomplete: "off", spellcheck: "false", class: "st-mono", "aria-label": "Токен бота" });
    this.token.addEventListener("change", () => {
      const token = this.token.value.trim();
      if (token !== "") this.post("token", { kind: "telegram.token", token });
    });
    this.chat = el("input", { type: "text", "data-field": "telegramChat", inputmode: "numeric", placeholder: "id чата", class: "st-mono", "aria-label": "Кому отправлять" });
    this.chat.addEventListener("change", () => this.post("chat", { kind: "telegram.chat", chat: this.chat.value.trim() }));
    this.status = el("span", { class: "st-s st-tg-status", "data-role": "telegram-status", role: "status" });
    this.reason = el("p", { class: "st-err-line", "data-role": "telegram-reason" }, TELEGRAM_NOT_READY);
    this.legacy = el("p", { class: "st-s st-hint", "data-role": "telegram-legacy" }, TELEGRAM_LEGACY);
    const field = (label: string, control: HTMLElement): HTMLElement => el("div", { class: "st-field" }, el("label", {}, label), control);
    this.element = el(
      "div",
      { class: "st-card st-telegram", "data-role": "telegram", role: "group", "aria-label": "Telegram" },
      el("div", { class: "st-t" }, "Telegram"),
      el("p", { class: "st-s" }, TELEGRAM_HELP),
      this.legacy,
      el(
        "div",
        { class: "st-fields" },
        field("Токен бота", this.token),
        field(
          "Кому отправлять",
          el("div", { class: "st-row" }, this.chat, button("Найти чат", { class: "secondary st-sm", "data-action": "telegram.find" }, () => this.post("find", { kind: "telegram.find" }))),
        ),
      ),
      el("p", { class: "st-s st-hint" }, TELEGRAM_FIND_HINT),
      el("div", { class: "st-row st-tg-check" }, button("Проверить", { class: "secondary st-sm", "data-action": "telegram.test" }, () => this.post("test", { kind: "telegram.test" })), this.status),
      this.reason,
    );
  }

  /** The toggle was flipped on before the setup was complete: the setup shows, with why. */
  open(): void {
    this.opened = true;
    this.paint();
    this.token.focus();
  }

  show(view: SecurityView): void {
    this.ready = view.telegram.ready;
    this.enabled = view.human.telegram;
    this.token.placeholder = view.telegram.tokenHint ?? "123456789:AA…";
    if (document.activeElement !== this.chat && ![...this.posted.values()].includes("chat")) this.chat.value = view.telegram.chat;
    this.legacy.hidden = !view.telegram.legacy;
    this.paint();
  }

  result(id: string, ok: boolean, errors: readonly FieldError[], notice?: string): void {
    const what = this.posted.get(id);
    if (what === undefined) return;
    this.posted.delete(id);
    if (ok && what === "token") this.token.value = ""; // saved: from now on only its last four show
    this.status.textContent = ok ? (notice ?? "") : (errors[0]?.message ?? "");
    this.status.classList.toggle("err", !ok);
  }

  private post(what: "token" | "chat" | "find" | "test", action: Record<string, unknown>): void {
    this.status.textContent = what === "find" ? "ищу…" : what === "test" ? "отправляю…" : "";
    this.status.classList.remove("err");
    this.posted.set(this.act(action), what);
  }

  private paint(): void {
    this.element.hidden = !(this.enabled || this.opened);
    this.reason.hidden = this.enabled || this.ready;
  }
}

/**
 * «Безопасность» after the mockup: protection on/off (each way only after the person confirms what changes),
 * «broken» with its reason and «Починить», who decides disputed commands, the rule fields, sandbox layers and the IP list.
 */
export class SecuritySection implements SectionView {
  readonly element: HTMLElement;
  private readonly protection: HTMLElement;
  private readonly reason: HTMLElement;
  private readonly note: HTMLElement;
  /** Which guard copy is actually running and since when — the one thing a stale installation never said out loud. */
  private readonly installed: HTMLElement;
  private readonly importNotice: HTMLElement;
  private readonly consent: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly decider: HTMLElement;
  private readonly layers: HTMLElement;
  private readonly asks: HTMLElement;
  private readonly layerRestart: HTMLElement;
  private changingLayer: string | undefined;
  /** The person's «always allow» list: each entry with what it allows and a «Забыть» button. */
  private readonly whitelist: HTMLElement;
  private readonly fields: Record<TextField, RuleField>;
  private readonly telegram: TelegramSetup;
  private last: SecurityView | undefined;
  /** The protection change in flight: the switch says so until the host answers. */
  private switching: string | undefined;
  private importing: string | undefined;
  /** «Импорт» waits for this save of «Всегда запрещено»: it imports only when the save was accepted. */
  private importAfter: string | undefined;

  constructor(private readonly context: SectionContext) {
    const field = (name: TextField, label: string, rows: number): RuleField =>
      new RuleField(name, label, rows, (text) => this.context.act({ kind: "text.set", field: name, text }));
    this.fields = {
      hardDeny: field("hardDeny", "Всегда запрещено", 6),
      askCustom: field("askCustom", "Свои правила «спросить»", 4),
      ipWhitelist: field("ipWhitelist", "Белый список адресов", 4),
    };
    this.protection = el("div", { class: "st-row" });
    this.reason = el("div", { class: "st-row st-broken", "data-role": "protection-reason" });
    this.note = el("p", { class: "st-s st-warn st-hint", "data-role": "protection-note" });
    this.installed = el("div", { class: "st-s st-hint", "data-role": "installed-kit" });
    this.importNotice = el("span", { class: "st-import-notice", "data-role": "import-notice", role: "status" });
    this.consent = el("div", { class: "st-consent", "data-role": "consent", role: "group", "aria-label": "Подтверждение" });
    this.consent.hidden = true;
    this.hint = el("p", { class: "st-s st-hint", "data-role": "sandbox-hint" }, SANDBOX_HINT);
    this.decider = el("div", { class: "st-card" });
    this.telegram = new TelegramSetup((action) => this.context.act(action));
    this.layers = el("div", { class: "st-groups", role: "group", "aria-label": "Что закрыто песочницей" });
    this.asks = el("ul", { class: "st-consent-list", "data-role": "guard-asks" });
    this.layerRestart = el("p", { class: "st-s st-hint", "data-role": "layer-restart" });
    this.whitelist = el("div", { class: "st-whitelist", role: "list", "aria-label": "Всегда разрешать" });
    const { hardDeny, askCustom, ipWhitelist } = this.fields;
    const rulesHint = el("span", { class: "st-h3-note" }, "· одна строка — одно правило, можно вставить сразу много");
    this.element = el(
      "div",
      { class: "st-security" },
      el("div", { class: "st-card st-protection" }, this.protection, this.reason, this.note, this.installed, this.consent, this.hint),
      el("h3", { class: "st-h3" }, "Кто решает спорные команды"),
      this.decider,
      this.telegram.element,
      el("h3", { class: "st-h3" }, "Всегда запрещено ", rulesHint),
      el(
        "div",
        { class: "st-card" },
        hardDeny.element,
        hardDeny.errors,
        el(
          "div",
          { class: "st-row st-s st-rule-foot" },
          el("span", {}, hardDeny.counter, " · шаблоны с *"),
          el("span", { class: "st-grow" }),
          this.importNotice,
          button("Импорт из Claude (permissions.deny)", { class: "secondary st-sm", "data-action": "importClaude" }, () => this.importClaude()),
        ),
      ),
      el("h3", { class: "st-h3" }, "Всегда разрешать · ваши правила «разрешать такое впредь» с карточек"),
      el("div", { class: "st-card" }, this.whitelist),
      el("h3", { class: "st-h3" }, "Что закрыто песочницей"),
      el("p", { class: "st-s", "data-role": "sandbox-core" }, "Ядро защиты — правила, ключи, хуки, кит: всегда, пока включена защита"),
      this.layers,
      this.layerRestart,
      el("h3", { class: "st-h3" }, "О чём спрашивает защита"),
      this.asks,
      el(
        "div",
        { class: "st-card st-ask-custom" },
        el("div", { class: "st-t" }, "Свои правила «спросить» · одна строка — одно правило"),
        askCustom.element,
        askCustom.errors,
        el("div", { class: "st-s st-rule-foot" }, askCustom.counter),
      ),
      el("h3", { class: "st-h3" }, "Белый список адресов · одна строка — один адрес или подсеть, после # — подпись"),
      el(
        "div",
        { class: "st-card" },
        ipWhitelist.element,
        ipWhitelist.errors,
        el("div", { class: "st-s st-rule-foot" }, ipWhitelist.counter, " · локальная сеть (192.168.*, 10.*, localhost) разрешена всегда"),
      ),
    );
  }

  update(state: SettingsView): void {
    const view = state.security as SecurityView | undefined;
    if (view === undefined) return;
    this.last = view;
    this.render(view);
  }

  result(id: string, ok: boolean, errors: readonly FieldError[], notice?: string): void {
    if (id === this.changingLayer) {
      this.changingLayer = undefined;
      if (this.last !== undefined) this.render(this.last);
    }
    for (const field of Object.values(this.fields)) field.result(id, ok, errors);
    this.telegram.result(id, ok, errors, notice);
    if (id === this.importAfter) {
      this.importAfter = undefined;
      if (ok) this.postImport();
      else this.fields.hardDeny.say(FIX_BEFORE_IMPORT);
    }
    if (id === this.importing) {
      this.importing = undefined;
      this.importNotice.textContent = ok ? (notice ?? "") : "";
    }
    if (id === this.switching) {
      this.switching = undefined;
      if (this.last !== undefined) this.render(this.last);
    } else if (!ok && this.last !== undefined) this.render(this.last); // the rules did not change: show what they say
  }

  closed(): void {
    for (const field of Object.values(this.fields)) field.flush();
  }

  /**
   * Imported lines join the saved field: its own change is saved first and the import follows only when that save was
   * accepted; never while it holds text the host refused (its next save would drop the imported lines).
   */
  private importClaude(): void {
    const field = this.fields.hardDeny;
    const saving = field.flush();
    if (saving !== undefined) {
      this.importAfter = saving;
      return;
    }
    if (field.invalid) {
      field.say(FIX_BEFORE_IMPORT);
      return;
    }
    this.postImport();
  }

  private postImport(): void {
    this.importNotice.textContent = "";
    this.importing = this.context.act({ kind: "importClaude" });
  }

  private render(view: SecurityView): void {
    this.renderProtection(view);
    this.renderDecider(view);
    this.telegram.show(view);
    this.layers.replaceChildren(
      ...LAYERS.map(([id, title, example]) => {
        const control = toggle(`layer:${id}`, title, view.layers[id], (on) => {
          this.changingLayer = this.context.act({ kind: "layer.set", layer: id, on });
          this.render(view);
        });
        control.disabled = this.changingLayer !== undefined || this.switching !== undefined;
        return el(
          "div",
          { class: "st-group", "data-layer": id },
          el("div", {}, el("b", { class: "st-t" }, title), el("span", { class: "st-s" }, example)),
          control,
        );
      }),
    );
    this.layerRestart.textContent = this.changingLayer !== undefined
      ? "Применяется…"
      : view.state === "off"
        ? "Выбор сохранится и применится при включении защиты."
        : "При изменении слоя OmO этой среды перезапустится — идущие ходы агентов во всех окнах прервутся.";
    this.asks.replaceChildren(...view.asks.map((label) => el("li", {}, label)));
    this.renderWhitelist(view);
    for (const [name, field] of Object.entries(this.fields) as Array<[TextField, RuleField]>) field.show(view.text[name]);
  }

  /** The «always allow» list: each entry spells out what it allows, when it was added, and a «Забыть» button. */
  private renderWhitelist(view: SecurityView): void {
    const entries = view.whitelist ?? [];
    if (entries.length === 0) {
      this.whitelist.replaceChildren(
        el("p", { class: "st-s st-hint" }, "Пока пусто. На карточке «Разрешить команду?» выберите «Разрешать такое впредь» — правило появится здесь."),
      );
      return;
    }
    this.whitelist.replaceChildren(
      ...entries.map((entry) => {
        const when = entry.addedAt !== undefined ? `добавлено ${new Date(entry.addedAt).toLocaleString("ru-RU")}` : "";
        const from = entry.session !== undefined ? ` · из сессии ${entry.session.split("-")[0]}` : "";
        return el(
          "div",
          { class: "st-wl-row", role: "listitem", "data-whitelist": entry.id },
          el("div", { class: "st-grow" }, el("code", { class: "st-mono" }, entry.scope), el("div", { class: "st-s st-hint" }, `${when}${from}`)),
          button("Забыть", { class: "secondary st-sm", "data-action": "whitelist.delete" }, () => this.context.act({ kind: "whitelist.delete", id: entry.id })),
        );
      }),
    );
  }

  private renderProtection(view: SecurityView): void {
    const on = view.state !== "off";
    const badge =
      this.switching !== undefined
        ? el("span", { class: "st-badge warn" }, "применяется…")
        : view.state === "on"
          ? el("span", { class: "st-badge ok" }, "● включена")
          : view.state === "broken"
            ? el("span", { class: "st-badge err" }, "● не в порядке")
            : el("span", { class: "st-badge" }, "выключена");
    const control = toggle("protection", "Защита команд", on, (next) => this.ask(next));
    control.disabled = this.switching !== undefined || this.changingLayer !== undefined;
    this.protection.replaceChildren(
      el(
        "div",
        { class: "st-grow" },
        el("div", { class: "st-headline" }, el("span", { class: "st-t" }, "Защита команд"), badge),
        el("div", { class: "st-s" }, "Опасные команды останавливаются; служебные файлы закрыты песочницей macOS"),
      ),
      control,
    );
    this.reason.replaceChildren(
      el("span", { class: "st-grow" }, `Защита не в порядке: ${view.reason ?? "причина неизвестна"}`),
      button("Починить", { class: "st-sm", "data-action": "repair" }, () => this.ask(true)),
    );
    this.reason.hidden = view.state !== "broken";
    this.note.textContent = view.note ?? "";
    this.note.hidden = view.note === undefined;
    this.renderInstalled(view);
    this.hint.hidden = view.state !== "on";
  }

  /**
   * The guard copy the hook and the service really run: the extension installs a copy and that copy decides, so an
   * extension update that nothing carried forward has to be readable here instead of looking like today's rules.
   */
  private renderInstalled(view: SecurityView): void {
    const { installed, refreshError } = view;
    const when = installed?.installedAt !== undefined ? `, установлена ${new Date(installed.installedAt).toLocaleString("ru-RU")}` : "";
    this.installed.replaceChildren(
      ...(installed !== undefined
        ? [
            el(
              "div",
              {},
              "Работает копия защиты ",
              el("span", { class: "st-mono st-url" }, ...breakable(installed.dir)),
              `${when}${installed.stale ? ` · ${KIT_STALE}` : ""}`,
            ),
          ]
        : []),
      ...(refreshError !== undefined ? [el("div", { "data-role": "kit-refresh-error" }, `${KIT_NOT_REFRESHED}: ${refreshError}`)] : []),
    );
    this.installed.hidden = installed === undefined && refreshError === undefined;
    this.installed.classList.toggle("st-warn", installed?.stale === true || refreshError !== undefined);
  }

  /** The person confirms what changes before anything is installed or removed. */
  private ask(on: boolean): void {
    const view = this.last;
    if (view === undefined) return;
    const item = (text: string, file?: string): HTMLElement => el("li", {}, text, ...(file !== undefined ? [el("span", { class: "st-mono st-url" }, ...breakable(file))] : []));
    const content: HTMLElement[] = on
      ? [
          el("div", { class: "st-t" }, "Включить защиту команд?"),
          el("p", { class: "st-s" }, "Будет установлено:"),
          el(
            "ul",
            { class: "st-consent-list" },
            item("служба защиты (LaunchAgent): ", view.consent.plist),
            item("копия хука и службы: ", view.consent.kitDir),
            item("хук защиты в ", view.consent.hooksJson),
            item("профиль песочницы: ", view.consent.profile),
          ),
          el("p", { class: "st-s" }, "Что изменится:"),
          el(
            "ul",
            { class: "st-consent-list" },
            item("OmO этой среды перезапустится — идущие ходы агентов во всех окнах прервутся."),
            ...(view.layers.launch ? [
              item("Агенты не смогут менять .git/config, .git/hooks и ~/.gitconfig: git clone, git init и git remote add выполняешь ты."),
              item("Папки из PATH, в которые ты можешь писать (например, /opt/homebrew), закрыты для агентов: brew install и глобальные установки — тоже ты."),
            ] : []),
            item(`Swift и Xcode собирают с флагами: ${SWIFT_FLAGS}.`),
            item(BACKGROUND_NOTICE),
          ),
          ...(view.consent.writeDenies.length > 0
            ? [
                el("p", { class: "st-s" }, "Закрыты для записи агентами:"),
                el(
                  "ul",
                  { class: "st-consent-list", "data-role": "write-denies" },
                  ...view.consent.writeDenies.map((dir) => el("li", {}, el("span", { class: "st-mono st-url" }, ...breakable(dir)))),
                ),
              ]
            : []),
        ]
      : [
          el("div", { class: "st-t" }, "Выключить защиту команд?"),
          el("p", { class: "st-s" }, "Служба, хук и профиль песочницы будут удалены, правила останутся. OmO этой среды перезапустится без песочницы — идущие ходы агентов во всех окнах прервутся."),
        ];
    this.consent.replaceChildren(
      ...content,
      el(
        "div",
        { class: "st-row st-actions" },
        button("Отмена", { class: "secondary st-sm", "data-action": "consent.cancel" }, () => (this.consent.hidden = true)),
        button(on ? "Включить защиту" : "Выключить защиту", { class: "st-sm", "data-action": "consent.confirm" }, () => this.apply(on)),
      ),
    );
    this.consent.hidden = false;
    this.consent.querySelector<HTMLButtonElement>('[data-action="consent.confirm"]')?.focus();
  }

  private apply(on: boolean): void {
    this.consent.hidden = true;
    this.switching = this.context.act({ kind: "protection.set", on, confirmed: true });
    if (this.last !== undefined) this.renderProtection(this.last);
  }

  private renderDecider(view: SecurityView): void {
    const { decider, human } = view;
    const labels = new Map(view.models.flatMap((group) => group.items.map((item) => [item.value, item.label] as const)));
    const model = el("select", { "data-field": "decider-model", "aria-label": "Модель решателя" });
    model.append(el("option", { value: "" }, "нет модели"));
    if (decider.model !== undefined && decider.model !== "" && !labels.has(decider.model)) model.append(el("option", { value: decider.model }, `${decider.model} — ${MISSING}`));
    for (const group of view.models) {
      const section = el("optgroup", { label: group.connection });
      for (const item of group.items) section.append(el("option", { value: item.value }, item.label));
      model.append(section);
    }
    model.value = decider.model ?? "";
    model.addEventListener("change", () => this.context.act({ kind: "decider.set", model: model.value }));

    const note =
      decider.mode !== "decider-then-me"
        ? "Без решателя каждая спорная команда ждёт твоего ответа или запрещается."
        : decider.model === undefined || decider.model === ""
          ? NO_MODEL_NOTE
          : `Модель-решатель: ${labels.get(decider.model) ?? decider.model} — быстро пропускает безобидное (например, rm -rf папки сборки по пути из переменной). Без решателя каждая спорная команда ждёт твоего ответа или запрещается.`;
    const field = (label: string, control: HTMLElement): HTMLElement => el("div", { class: "st-field" }, el("label", {}, label), control);
    this.decider.replaceChildren(
      segmented("mode", "Кто решает", MODES, decider.mode, (mode) => this.context.act({ kind: "decider.set", mode })),
      el("p", { class: "st-s st-decider-note", "data-role": "decider-note" }, note),
      el(
        "div",
        { class: "st-fields" },
        field("Модель решателя", model),
        field(
          "Спрашивать меня",
          el(
            "div",
            { class: "st-row" },
            el("span", { class: "st-s" }, "карточкой в чате"),
            toggle("card", "Карточкой в чате", human.card, (card) => this.context.act({ kind: "human.set", card })),
            el("span", { class: "st-s" }, "Telegram"),
            toggle("telegram", "Telegram", human.telegram, (telegram) =>
              telegram && !view.telegram.ready ? this.telegram.open() : this.context.act({ kind: "human.set", telegram }),
            ),
          ),
        ),
        field("Ждать ответа", segmented("wait", "Ждать ответа", WAITS, human.waitSeconds, (waitSeconds) => this.context.act({ kind: "human.set", waitSeconds }))),
      ),
    );
  }
}
