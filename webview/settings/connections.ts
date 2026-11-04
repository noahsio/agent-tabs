import type { KeyProvider, LoginEvent, SubscriptionProvider } from "../../src/settings/accounts";
import type { AccountView, ApiKeyView, ConnectionsView, GatewayView } from "../../src/settings/connections";
import type { GatewayProtocol } from "../../src/settings/gateway";
import type { SettingsView } from "../../src/settings/protocol";
import { REDACTED } from "../../src/redacted";
import { breakable, button, el } from "../dom";
import type { SectionContext, SectionView } from "./sections";

type FormKind = "gateway" | KeyProvider;

const FIRST_RUN = "Чтобы начать, подключите модель: войдите через аккаунт Claude или ChatGPT, добавьте API-ключ или свой шлюз.";
const PROTOCOLS: ReadonlyArray<[GatewayProtocol, string]> = [
  ["anthropic-messages", "Anthropic"],
  ["openai-responses", "OpenAI Responses"],
  ["openai-completions", "OpenAI Chat Completions"],
];
const FORM_KINDS: ReadonlyArray<[FormKind, string]> = [
  ["gateway", "Свой шлюз"],
  ["anthropic", "API-ключ Anthropic"],
  ["openai", "API-ключ OpenAI"],
];
const SUBSCRIPTIONS: ReadonlyArray<{ provider: SubscriptionProvider; title: string; note: string }> = [
  {
    provider: "anthropic-subscription",
    title: "Claude — войти через аккаунт",
    note: "Подписка Claude (Pro/Max). Откроется браузер для входа. Трафик стороннего приложения оплачивается как «extra usage».",
  },
  { provider: "chatgpt-subscription", title: "ChatGPT — войти через аккаунт", note: "Подписка ChatGPT (Plus/Pro). Откроется браузер для входа." },
];
const PROVIDER_NAMES: Record<SubscriptionProvider | KeyProvider, string> = {
  "anthropic-subscription": "Claude",
  "chatgpt-subscription": "ChatGPT",
  anthropic: "API-ключ Anthropic",
  openai: "API-ключ OpenAI",
};
const SAVE = "Проверить и сохранить";
const UNCHANGED = "не меняется";
const HINTS = {
  gateway: "Получит список моделей и сделает пробный запрос",
  key: "OmO проверит ключ у провайдера и сохранит его",
  storedKeyMoves: "Сохранённый ключ будет отправлен на новый адрес",
};
const SAVING = "Проверяю…";
const SIGNED_IN = "вход выполнен";

function pluralModels(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  const word = ones === 1 && tens !== 11 ? "модель" : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? "модели" : "моделей";
  return `${count} ${word}`;
}

function ago(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes) || minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} ч назад` : `${Math.floor(hours / 24)} дн назад`;
}

function small(label: string, onClick: () => void): HTMLButtonElement {
  return button(label, { class: "secondary st-sm" }, onClick);
}

/** Removing asks once more on the same button: webviews have no confirm(). */
function removeButton(label: string, onConfirm: () => void): HTMLButtonElement {
  const control = small(label, () => {
    if (control.dataset["confirm"] === "true") {
      onConfirm();
      return;
    }
    control.dataset["confirm"] = "true";
    control.textContent = "Точно удалить?";
    control.classList.add("st-danger");
  });
  return control;
}

function badge(text: string, tone: "ok" | "warn" | "err" | ""): HTMLElement {
  return el("span", { class: `st-badge ${tone}`.trim() }, text);
}

function select(name: string, options: ReadonlyArray<readonly [string, string]>): HTMLSelectElement {
  const control = el("select", { "data-field": name });
  for (const [value, label] of options) control.append(el("option", { value }, label));
  return control;
}

/** A label and its control; hiding the pair hides both cells of the grid. */
function fieldRow(label: string, control: HTMLElement): HTMLElement {
  return el("div", { class: "st-field" }, el("label", {}, label), control);
}

/**
 * «Подключения» after the mockup: what is connected (with check, edit and remove), the three ways to add one, a
 * running login with OmO's own prompts, and the form for an API key or a gateway. The form survives every state
 * update; only the lists are rebuilt.
 */
export class ConnectionsSection implements SectionView {
  readonly element: HTMLElement;
  private readonly firstRun: HTMLElement;
  private readonly connected: HTMLElement;
  private readonly loginCards: HTMLButtonElement[] = [];
  private readonly loginBox: HTMLElement;
  private readonly loginTitle: HTMLElement;
  private readonly loginStatus: HTMLElement;
  private readonly loginAsk: HTMLElement;
  private readonly loginCancel: HTMLButtonElement;
  private readonly form: HTMLElement;
  private readonly formTitle: HTMLElement;
  private readonly kindRow: HTMLElement;
  private readonly gatewayRows: HTMLElement[];
  private readonly kind: HTMLSelectElement;
  private readonly name: HTMLInputElement;
  private readonly protocol: HTMLSelectElement;
  private readonly baseUrl: HTMLInputElement;
  private readonly key: HTMLInputElement;
  private readonly save: HTMLButtonElement;
  private readonly formHint: HTMLElement;
  /** The gateway being edited (its id goes with the save). */
  private editing: string | undefined;
  /** The save in flight, by action id. */
  private saving: string | undefined;
  /** A login this modal shows: `actionId` while its start is unanswered, `done` once it ended. */
  private loginState: { actionId?: string; done: boolean } | undefined;

  constructor(private readonly context: SectionContext) {
    this.firstRun = el("div", { class: "st-firstrun", "data-role": "first-run" }, FIRST_RUN);
    this.firstRun.hidden = true;
    this.connected = el("div", { "data-role": "connected" });

    const addCards = el("div", { class: "st-prov" });
    for (const { provider, title, note } of SUBSCRIPTIONS) {
      const card = button(el("span", { class: "st-t" }, title), { class: "st-card st-add", "data-add": provider }, () => this.startLogin(provider));
      card.append(el("span", { class: "st-s" }, note));
      this.loginCards.push(card);
      addCards.append(card);
    }
    const keyCard = button(el("span", { class: "st-t" }, "API-ключ или свой шлюз"), { class: "st-card st-add", "data-add": "key-or-gateway" }, () => this.openForm("gateway"));
    keyCard.append(el("span", { class: "st-s" }, "Anthropic, OpenAI или совместимый сервер: адрес, ключ, тип протокола. Список моделей берётся у сервера (/models), без зашитых названий."));
    addCards.append(keyCard);

    this.loginTitle = el("div", { class: "st-t" });
    this.loginStatus = el("div", { class: "st-s", "data-role": "login-status" });
    this.loginAsk = el("div", { class: "st-ask" });
    this.loginCancel = small("Отменить", () => this.cancelLogin());
    this.loginBox = el(
      "div",
      { class: "st-card st-login", "data-role": "login" },
      el("div", { class: "st-row" }, el("div", { class: "st-grow" }, this.loginTitle, this.loginStatus), this.loginCancel),
      this.loginAsk,
    );
    this.loginBox.hidden = true;

    this.kind = select("kind", FORM_KINDS);
    this.kind.addEventListener("change", () => this.applyKind());
    this.name = el("input", { "data-field": "name", type: "text", placeholder: "Мой шлюз" });
    this.protocol = select("protocol", PROTOCOLS);
    this.baseUrl = el("input", { "data-field": "baseUrl", type: "text", class: "st-mono", placeholder: "https://…" });
    this.key = el("input", { "data-field": "key", type: "password", autocomplete: "off" });
    this.baseUrl.addEventListener("input", () => this.updateHint());
    this.key.addEventListener("input", () => this.updateHint());
    this.save = button(SAVE, { "data-role": "connection-save" }, () => this.submit());
    this.formHint = el("span", { class: "st-s" });
    this.formTitle = el("div", { class: "st-t" });
    this.kindRow = fieldRow("Вид", this.kind);
    this.gatewayRows = [fieldRow("Название", this.name), fieldRow("Протокол", this.protocol), fieldRow("Адрес", this.baseUrl)];
    this.form = el(
      "div",
      { class: "st-card st-form", "data-role": "connection-form" },
      this.formTitle,
      el(
        "div",
        { class: "st-fields" },
        this.kindRow,
        ...this.gatewayRows,
        fieldRow("Ключ", this.key),
        el("div", { class: "st-field" }, el("span"), el("div", { class: "st-row" }, this.save, small("Отмена", () => this.closeForm()), this.formHint)),
      ),
    );
    this.form.hidden = true;

    this.element = el(
      "div",
      { class: "st-conn" },
      this.firstRun,
      el("h3", { class: "st-h3" }, "Подключённые"),
      this.connected,
      el("h3", { class: "st-h3" }, "Добавить"),
      addCards,
      this.loginBox,
      this.form,
    );
  }

  update(state: SettingsView): void {
    const view = state.connections as ConnectionsView | undefined;
    if (view === undefined) return;
    this.firstRun.hidden = view.any || view.omoUnavailable !== undefined; // «nothing connected» only on OmO's definite answer
    const cards = [...view.gateways.map((gateway) => this.gatewayCard(gateway)), ...view.accounts.map((account) => this.accountCard(account)), ...view.apiKeys.map((key) => this.keyCard(key))];
    const notes: HTMLElement[] = [];
    if (view.omoUnavailable !== undefined) notes.push(el("p", { class: "st-s" }, `Аккаунты и API-ключи: ${view.omoUnavailable}`));
    if (cards.length === 0) notes.push(el("p", { class: "st-s" }, "Пока ничего не подключено."));
    this.connected.replaceChildren(...cards, ...notes);
  }

  result(id: string, ok: boolean): void {
    if (id === this.saving) {
      this.saving = undefined;
      this.save.disabled = false;
      this.save.textContent = SAVE;
      if (ok) this.closeForm();
    }
    const login = this.loginState;
    if (login !== undefined && id === login.actionId) {
      delete login.actionId;
      if (!ok) this.endLogin(); // OmO refused to start it: the modal shows why
    }
  }

  login(event: LoginEvent): void {
    if (event.kind === "end") {
      if (this.loginState === undefined || this.loginState.done) return; // a cancelled login's late end
      this.loginState.done = true;
      this.loginAsk.replaceChildren();
      this.loginCancel.hidden = true;
      this.loginStatus.textContent = event.success ? `Вход выполнен${event.account !== undefined ? ` (${event.account})` : ""}` : (event.error ?? "Вход не удался");
      this.setLoginCards(true);
      return;
    }
    if (this.loginState === undefined || this.loginState.done) this.showLogin("Вход"); // started in another tab of this window
    if (event.kind === "progress") this.loginStatus.textContent = event.text;
    else if (event.kind === "url") {
      this.loginStatus.replaceChildren("Страница входа открыта в браузере. Если нет — откройте её сами:", el("br"), el("span", { class: "st-mono st-url" }, ...breakable(event.url)));
    } else this.renderAsk(event);
  }

  closed(): void {
    if (this.loginState !== undefined && !this.loginState.done) this.context.act({ kind: "account.cancel" });
    this.endLogin();
  }

  // ---------- connected ----------

  private gatewayCard(gateway: GatewayView): HTMLElement {
    const fetched =
      gateway.fetchedAt === undefined && gateway.modelCount === 0
        ? "список моделей ещё не получен"
        : `${pluralModels(gateway.modelCount)}${gateway.fetchedAt !== undefined ? ` · получены от шлюза ${ago(gateway.fetchedAt)}` : ""}`;
    const lines = el("div", { class: "st-s" }, fetched);
    const status =
      gateway.status === "ok" ? badge("● работает", "ok") : gateway.status === "error" ? badge("● ошибка", "err") : badge("не проверен", "");
    const key = `ключ ${gateway.keyHint === "" ? "не прочитан" : gateway.keyHint}`;
    const info = el(
      "div",
      { class: "st-grow st-wide" },
      el("div", { class: "st-headline" }, el("span", { class: "st-t" }, gateway.name), status),
      el("div", { class: "st-s st-mono st-urlkey" }, el("span", { class: "st-ellipsis", title: gateway.baseUrl }, gateway.baseUrl), el("span", { class: "st-nowrap" }, key)),
      lines,
    );
    const buttons = el("div", { class: "st-btns" });
    const row = el("div", { class: "st-row" }, info, buttons);
    if (gateway.legacy === true) {
      info.append(el("div", { class: "st-s" }, `Создан вручную: идентификатор «${gateway.id}» не поддерживается — меняйте его в models.json.`));
    } else {
      lines.append(" · ", button("обновить список", { class: "link" }, () => this.context.act({ kind: "gateway.refresh", id: gateway.id })));
      buttons.append(
        small("Проверить", () => this.context.act({ kind: "gateway.check", id: gateway.id })),
        small("Изменить", () => this.openGateway(gateway)),
        removeButton("Удалить", () => this.context.act({ kind: "gateway.remove", id: gateway.id })),
      );
    }
    const card = el("div", { class: "st-card", "data-gateway": gateway.id }, row);
    if (gateway.error !== undefined) card.append(el("div", { class: "st-s st-err-line" }, gateway.error));
    return card;
  }

  private accountCard(account: AccountView): HTMLElement {
    const label = account.displayName !== undefined ? `${account.displayName} (${account.name})` : account.name;
    const action = account.name === "" ? { kind: "account.logout", provider: account.provider } : { kind: "account.remove", provider: account.provider, name: account.name };
    return el(
      "div",
      { class: "st-card", "data-account": `${account.provider}:${account.name}` },
      el(
        "div",
        { class: "st-row" },
        el(
          "div",
          { class: "st-grow" },
          el(
            "div",
            { class: "st-headline" },
            el("span", { class: "st-t" }, `${PROVIDER_NAMES[account.provider]}${label !== "" ? ` — ${label}` : ""}`),
            badge(account.status === SIGNED_IN ? `● ${account.status}` : account.status, account.status === SIGNED_IN ? "ok" : "warn"),
          ),
          el("div", { class: "st-s" }, "вход через аккаунт"),
        ),
        el("div", { class: "st-btns" }, removeButton(account.name === "" ? "Выйти" : "Удалить", () => this.context.act(action))),
      ),
    );
  }

  private keyCard(key: ApiKeyView): HTMLElement {
    return el(
      "div",
      { class: "st-card", "data-api-key": key.provider },
      el(
        "div",
        { class: "st-row" },
        el("div", { class: "st-grow" }, el("div", { class: "st-t" }, PROVIDER_NAMES[key.provider]), el("div", { class: "st-s st-mono" }, `ключ ${key.keyHint === "" ? "задан" : key.keyHint}`)),
        el("div", { class: "st-btns" }, small("Изменить", () => this.openKey(key.provider)), removeButton("Удалить", () => this.context.act({ kind: "account.logout", provider: key.provider }))),
      ),
    );
  }

  // ---------- login ----------

  private startLogin(provider: SubscriptionProvider): void {
    if (this.loginState !== undefined && !this.loginState.done) return;
    this.showLogin(`Вход: ${PROVIDER_NAMES[provider]}`);
    this.loginStatus.textContent = "Запускаю вход…";
    const actionId = this.context.act({ kind: "account.login", provider });
    if (this.loginState !== undefined) this.loginState.actionId = actionId;
  }

  private showLogin(title: string): void {
    this.loginState = { done: false };
    this.loginTitle.textContent = title;
    this.loginStatus.textContent = "";
    this.loginAsk.replaceChildren();
    this.loginCancel.hidden = false;
    this.loginBox.hidden = false;
    this.setLoginCards(false);
  }

  private cancelLogin(): void {
    this.context.act({ kind: "account.cancel" });
    this.endLogin();
  }

  private endLogin(): void {
    this.loginState = undefined;
    this.loginBox.hidden = true;
    this.loginAsk.replaceChildren();
    this.setLoginCards(true);
  }

  private setLoginCards(enabled: boolean): void {
    for (const card of this.loginCards) card.disabled = !enabled;
  }

  /** OmO's own question (the way to sign in, a code): every option is a button, an input is answered by «Отправить». */
  private renderAsk(ask: Extract<LoginEvent, { kind: "ask" }>): void {
    const answer = (value: string): void => {
      this.context.act({ kind: "account.answer", requestId: ask.requestId, value });
      this.loginAsk.replaceChildren();
      this.loginStatus.textContent = "Жду OmO…";
    };
    const title = ask.title !== undefined ? [el("div", { class: "st-s" }, ask.title)] : [];
    if (ask.type === "select") {
      this.loginAsk.replaceChildren(...title, el("div", { class: "st-options" }, ...ask.options.map((option) => small(option, () => answer(option)))));
      return;
    }
    const input = el("input", { type: "text", placeholder: ask.placeholder ?? "" });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") answer(input.value);
    });
    this.loginAsk.replaceChildren(...title, el("div", { class: "st-row" }, input, small("Отправить", () => answer(input.value))));
    input.focus();
  }

  // ---------- form ----------

  private openForm(kind: FormKind): void {
    this.editing = undefined;
    this.kind.value = kind;
    this.kindRow.hidden = false;
    this.name.value = "";
    this.name.placeholder = "Мой шлюз";
    this.protocol.value = "anthropic-messages";
    this.baseUrl.value = "";
    this.baseUrl.placeholder = "https://…";
    this.key.value = "";
    this.key.placeholder = "";
    this.formTitle.textContent = "Новое подключение: API-ключ / шлюз";
    this.showForm();
  }

  /** A stored key is replaced, never shown: only the key field. */
  private openKey(provider: KeyProvider): void {
    this.openForm(provider);
    this.kindRow.hidden = true;
    this.formTitle.textContent = `Изменить: ${PROVIDER_NAMES[provider]}`;
  }

  /** Empty fields keep the stored values: a posted value may be redacted, and a redacted one must never be saved back. */
  private openGateway(gateway: GatewayView): void {
    this.openForm("gateway");
    this.editing = gateway.id;
    this.kindRow.hidden = true;
    const nameShown = !gateway.name.includes(REDACTED);
    this.name.value = nameShown ? gateway.name : "";
    this.name.placeholder = nameShown ? "" : UNCHANGED;
    this.protocol.value = gateway.protocol;
    this.baseUrl.placeholder = UNCHANGED;
    this.key.placeholder = "оставьте пустым, чтобы не менять";
    this.formTitle.textContent = `Изменить: ${gateway.name}`;
    this.updateHint();
  }

  private showForm(): void {
    this.applyKind();
    this.form.hidden = false;
    (this.kind.value === "gateway" ? this.name : this.key).focus();
  }

  private closeForm(): void {
    this.form.hidden = true;
    this.key.value = "";
    this.editing = undefined;
  }

  private applyKind(): void {
    for (const row of this.gatewayRows) row.hidden = this.kind.value !== "gateway";
    this.updateHint();
  }

  private updateHint(): void {
    const storedKeyMoves = this.editing !== undefined && this.baseUrl.value.trim() !== "" && this.key.value.trim() === "";
    this.formHint.textContent = this.kind.value !== "gateway" ? HINTS.key : storedKeyMoves ? HINTS.storedKeyMoves : HINTS.gateway;
  }

  private submit(): void {
    if (this.saving !== undefined) return;
    const key = this.key.value.trim();
    const baseUrl = this.baseUrl.value.trim();
    const kind = this.kind.value as FormKind;
    const action =
      kind === "gateway"
        ? {
            kind: "gateway.save",
            draft: {
              ...(this.editing !== undefined ? { id: this.editing } : {}),
              name: this.name.value.trim(),
              protocol: this.protocol.value,
              ...(baseUrl !== "" ? { baseUrl } : {}),
              ...(key !== "" ? { key } : {}),
            },
          }
        : { kind: "apiKey.save", provider: kind, key };
    this.saving = this.context.act(action);
    this.save.disabled = true;
    this.save.textContent = SAVING;
  }
}
