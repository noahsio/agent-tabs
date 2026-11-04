import fs from "node:fs";
import { parseJsonc, setJsoncPath } from "../../kit/lib/jsonc.mjs";
import type { AccountsService } from "./accounts";
import { readGateways } from "./gateway";
import { writeOmoFile } from "./files";
import type { EnvPaths } from "./paths";
import { KNOWN_LEVELS, REASONING_LEVELS, type Reasoning } from "./protocol";
import { FieldErrors, type SettingsSectionHost } from "./service";

/**
 * One line of the grid. `keys` are the jsonc paths of the objects holding `model` and `reasoning` (all written
 * together); `reasoningKeys` overrides where the power lives when it is not the same object. `kind` marks the two rows
 * that are not a plain `<key>.model` / `<key>.reasoning` pair.
 */
export type RoleRow = {
  id: string;
  title: string;
  detail: string;
  keys: string[][];
  reasoningKeys?: string[][];
  kind?: "profile" | "memory";
};

export const ROLE_ROWS: readonly RoleRow[] = [
  { id: "main", title: "Главный агент", detail: "ведёт сессию, планирует, раздаёт задачи", keys: [["model_profile"]], kind: "profile" },
  { id: "plan-review", title: "Ревью плана", detail: "проверяет план до начала работы", keys: [["agents", "plan-reviewer"]] },
  { id: "consultant", title: "Консультант", detail: "второе мнение по сложным вопросам", keys: [["agents", "plan-consultant"]] },
  { id: "explore", title: "Разведка кода", detail: "быстро находит, где что лежит", keys: [["agents", "explore"], ["agents", "librarian"]] },
  {
    id: "deep",
    title: "Глубокая работа",
    detail: "пишет и правит код в больших задачах",
    keys: [["categories", "deep-high"], ["categories", "deep-low"], ["categories", "unspecified-high"]],
  },
  { id: "quick", title: "Быстрые задачи", detail: "мелкие правки, тесты, проверки", keys: [["categories", "quick"], ["categories", "unspecified-low"]] },
  { id: "hard", title: "Сложные задачи", detail: "алгоритмы, архитектура", keys: [["categories", "ultrabrain"], ["categories", "architect"]] },
  { id: "interfaces", title: "Интерфейсы", detail: "вёрстка, визуальная часть", keys: [["categories", "visual-engineering"], ["categories", "artistry"]] },
  { id: "writing", title: "Тексты", detail: "документация, описания", keys: [["categories", "writing"]] },
  { id: "memory", title: "Память", detail: "разбирает прошлые ошибки в фоне; берёт модель выбранной категории", keys: [["memory", "reflection"]], kind: "memory" },
];

export type RoleRowView = {
  id: string;
  title: string;
  detail: string;
  /** The technical names, for the tooltip. */
  hint: string;
  /** "provider/id", "mixed" when the keys of the row disagree; for «Память» the chosen category. */
  model?: string;
  reasoning?: string;
  /** «Главный агент» names a profile (`model_profiles.<id>`) rather than a model. */
  profile?: string;
  /** «Память»: the categories to pick from. */
  categories?: Array<{ value: string; label: string }>;
  /** The chosen model is known not to think: there is no power to pick. */
  noReasoning?: true;
};

export type ModelOption = { value: string; label: string; reasoning?: boolean };

export type RolesView = {
  rows: RoleRowView[];
  models: Array<{ connection: string; items: ModelOption[] }>;
  /** Why the accounts' models are missing (OmO did not answer in time). */
  omoUnavailable?: string;
};

export type RolesAction = { kind: "role.set"; id: string; model?: string; reasoning?: Reasoning };

export interface RolesDeps {
  paths: EnvPaths;
  /** The window's one accounts service (shared with «Подключения»). */
  accounts: () => AccountsService;
  /** The section changed outside an action (OmO's models arrived late): every open modal re-reads it. */
  changed: () => void;
  log: (text: string) => void;
}

type ModelGroup = RolesView["models"][number];
type OmoModels = { groups: ModelGroup[]; models: Array<ModelOption & { provider: string }> };

const MEMORY_DEFAULT_CATEGORY = "quick";
const VIEW_WAIT_MS = 1_000;
const OMO_UNAVAILABLE = "нет связи с OmO";
const NOT_PARSEABLE = "Файл ~/.omo/omo.jsonc не разобрать; он не изменён — исправьте его вручную";
const NEEDS_MODEL = "Сначала выберите модель: сейчас главным агентом назван профиль";
const NEEDS_MODEL_UNSET = "Сначала выберите модель главного агента";
const TIMEOUT = Symbol("timeout");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReasoning(value: unknown): value is Reasoning {
  return (REASONING_LEVELS as readonly unknown[]).includes(value);
}

function isKnownLevel(value: unknown): value is string {
  return (KNOWN_LEVELS as readonly unknown[]).includes(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function valueAt(config: Record<string, unknown>, keys: readonly string[]): unknown {
  let node: unknown = config;
  for (const key of keys) node = isObject(node) ? node[key] : undefined;
  return node;
}

function textAt(config: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = valueAt(config, keys);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The one value of a row's keys; "mixed" when they disagree, undefined when none is set. */
function combine(values: Array<string | undefined>): string | undefined {
  if (values.every((value) => value === undefined)) return undefined;
  return values.every((value) => value === values[0]) ? values[0] : "mixed";
}

function hintOf(row: RoleRow): string {
  return row.keys.map((keys) => (keys[0] === "agents" || keys[0] === "categories" ? keys.slice(1).join(".") : keys.join("."))).join(", ");
}

/** `model_profile`: "<provider/id>[:<reasoning>]" is a pin; a string without a slash names a profile. */
function parseProfile(value: string | undefined): { profile?: string; model?: string; reasoning?: string } {
  if (value === undefined) return {};
  if (!value.includes("/")) return { profile: value };
  const cut = value.lastIndexOf(":");
  const tail = cut === -1 ? undefined : value.slice(cut + 1);
  return isKnownLevel(tail) ? { model: value.slice(0, cut), reasoning: tail } : { model: value };
}

const categoryKeys = ROLE_ROWS.flatMap((row) => row.keys.filter((keys) => keys[0] === "categories").map((keys) => keys[1] as string));

/**
 * «Модели и роли» on the host: the grid over `~/.omo/omo.jsonc`. Models come from every connection — gateways from
 * the plugin's files, accounts and built-ins from OmO — and are never listed in the plugin. A view never waits long
 * for OmO: its last answer is shown at once and a different fresh one re-posts the section.
 */
export class RolesHost implements SettingsSectionHost<RolesAction> {
  readonly section = "models" as const;
  private omo: OmoModels | undefined;
  private omoFetch: Promise<OmoModels | undefined> | undefined;
  private shown: string | undefined;

  constructor(private readonly deps: RolesDeps) {}

  parse(raw: Record<string, unknown>): RolesAction | undefined {
    if (raw["kind"] !== "role.set") return undefined;
    const { id, model, reasoning } = raw;
    const row = ROLE_ROWS.find((item) => item.id === id);
    if (row === undefined || (model === undefined && reasoning === undefined)) return undefined;
    if (model !== undefined && (typeof model !== "string" || model === "")) return undefined;
    if (reasoning !== undefined && (!isReasoning(reasoning) || row.kind === "memory")) return undefined;
    return { kind: "role.set", id: row.id, ...(model !== undefined ? { model } : {}), ...(reasoning !== undefined ? { reasoning } : {}) };
  }

  async view(): Promise<RolesView> {
    const config = this.readConfig();
    const omo = await this.omoForView();
    const groups = this.groups(omo);
    const labels = new Map(groups.flatMap((group) => group.items.map((item) => [item.value, item.label] as const)));
    const thinks = new Map(groups.flatMap((group) => group.items.map((item) => [item.value, item.reasoning] as const)));
    const rows = ROLE_ROWS.map((row) => this.rowView(row, config, labels, thinks));
    return { rows, models: groups, ...(omo === undefined ? { omoUnavailable: OMO_UNAVAILABLE } : {}) };
  }

  /** The grid's model options (every connection), for other pickers: «Безопасность»'s decider model. */
  async modelOptions(): Promise<RolesView["models"]> {
    return this.groups(await this.omoForView());
  }

  async perform(action: RolesAction): Promise<void> {
    const row = ROLE_ROWS.find((item) => item.id === action.id);
    if (row === undefined) return;
    const text = this.readText();
    const config = this.parseConfig(text);
    const writes = this.writes(row, action, config);
    let edited = text.trim() === "" ? "{}\n" : text;
    try {
      for (const [keys, value] of writes) edited = setJsoncPath(edited, keys, value);
    } catch {
      throw new FieldErrors("Не удалось записать в ~/.omo/omo.jsonc: у файла неожиданная структура; он не изменён", []);
    }
    writeOmoFile(this.deps.paths.omoJsonc, edited, { backup: "rolling" });
  }

  private writes(row: RoleRow, action: RolesAction, config: Record<string, unknown>): Array<[string[], string]> {
    if (row.kind === "memory") {
      if (action.model === undefined || !categoryKeys.includes(action.model)) throw new FieldErrors("Такой категории нет", []);
      return [[["memory", "reflection", "category"], action.model]];
    }
    if (row.kind === "profile") {
      const current = parseProfile(textAt(config, ["model_profile"]));
      const model = action.model ?? current.model;
      if (model === undefined) throw new FieldErrors(current.profile !== undefined ? NEEDS_MODEL : NEEDS_MODEL_UNSET, []);
      const reasoning = action.reasoning ?? current.reasoning;
      return [[["model_profile"], reasoning === undefined ? model : `${model}:${reasoning}`]];
    }
    const writes: Array<[string[], string]> = [];
    for (const keys of row.keys) {
      if (action.model !== undefined) writes.push([[...keys, "model"], action.model]);
      if (action.reasoning !== undefined) writes.push([[...keys, "reasoning"], action.reasoning]);
    }
    return writes;
  }

  private rowView(
    row: RoleRow,
    config: Record<string, unknown>,
    labels: ReadonlyMap<string, string>,
    thinks: ReadonlyMap<string, boolean | undefined>,
  ): RoleRowView {
    const base = { id: row.id, title: row.title, detail: row.detail, hint: hintOf(row) };
    /** Only a model the catalog knows and marks as not thinking: an unknown one keeps its power. */
    const mute = (model: string | undefined): { noReasoning?: true } => (model !== undefined && thinks.get(model) === false ? { noReasoning: true } : {});
    if (row.kind === "profile") {
      const { profile, model, reasoning } = parseProfile(textAt(config, ["model_profile"]));
      return {
        ...base,
        ...(model !== undefined ? { model } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...mute(model),
      };
    }
    if (row.kind === "memory") {
      const chosen = textAt(config, ["memory", "reflection", "category"]) ?? MEMORY_DEFAULT_CATEGORY;
      const categories = categoryKeys.map((key) => {
        const owner = ROLE_ROWS.find((item) => item.keys.some((keys) => keys[0] === "categories" && keys[1] === key));
        const model = textAt(config, ["categories", key, "model"]);
        return { value: key, label: `${owner?.title ?? key} — ${model === undefined ? "модель не задана" : (labels.get(model) ?? model)} (${key})` };
      });
      if (!categoryKeys.includes(chosen)) categories.unshift({ value: chosen, label: chosen }); // set by hand: still the current value
      return { ...base, model: chosen, categories };
    }
    const model = combine(row.keys.map((keys) => textAt(config, [...keys, "model"])));
    const reasoning = combine((row.reasoningKeys ?? row.keys).map((keys) => textAt(config, [...keys, "reasoning"])));
    return { ...base, ...(model !== undefined ? { model } : {}), ...(reasoning !== undefined ? { reasoning } : {}), ...mute(model) };
  }

  /** Gateways first (their own list plus whatever OmO knows under their id), then the other providers by OmO's name for them. */
  private groups(omo: OmoModels | undefined): ModelGroup[] {
    const groups: ModelGroup[] = [];
    const gatewayIds = new Set<string>();
    for (const gateway of readGateways(this.deps.paths)) {
      gatewayIds.add(gateway.id);
      const items: ModelOption[] = gateway.models.map((model) => ({
        value: `${gateway.id}/${model.id}`,
        label: model.name ?? model.id,
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      }));
      const known = new Set(items.map((item) => item.value));
      for (const model of omo?.models ?? []) {
        if (model.provider === gateway.id && !known.has(model.value)) items.push({ value: model.value, label: model.label, ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}) });
      }
      if (items.length > 0) groups.push({ connection: gateway.name, items });
    }
    for (const group of omo?.groups ?? []) groups.push(group);
    return groups.filter((group) => group.items.length > 0);
  }

  private readText(): string {
    try {
      return fs.readFileSync(this.deps.paths.omoJsonc, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw new FieldErrors(`Файл ~/.omo/omo.jsonc не прочитан: ${(error as NodeJS.ErrnoException).code ?? "ошибка"}`, []);
    }
  }

  private parseConfig(text: string): Record<string, unknown> {
    if (text.trim() === "") return {};
    try {
      const config: unknown = parseJsonc(text);
      if (isObject(config)) return config;
    } catch {
      // never the parser's message: it quotes the file
    }
    throw new FieldErrors(NOT_PARSEABLE, []);
  }

  private readConfig(): Record<string, unknown> {
    return this.parseConfig(this.readText());
  }

  private async omoForView(): Promise<OmoModels | undefined> {
    const known = this.omo;
    const fetching = this.loadOmo();
    let omo = known;
    if (known === undefined) {
      const result = await within(fetching, VIEW_WAIT_MS);
      omo = result === TIMEOUT ? undefined : result;
    }
    this.shown = JSON.stringify(omo ?? null);
    return omo;
  }

  /** One read at a time; a result that differs from what the modals last got re-posts the section once. */
  private loadOmo(): Promise<OmoModels | undefined> {
    if (this.omoFetch === undefined) {
      this.omoFetch = this.fetchOmo()
        .catch((error: unknown) => {
          this.deps.log(`Модели OmO недоступны: ${errorText(error)}`);
          return undefined;
        })
        .then((part) => {
          this.omo = part;
          this.omoFetch = undefined;
          const fresh = JSON.stringify(part ?? null);
          if (this.shown !== undefined && fresh !== this.shown) {
            this.shown = fresh;
            this.deps.changed();
          }
          return part;
        });
    }
    return this.omoFetch;
  }

  private async fetchOmo(): Promise<OmoModels> {
    const service = this.deps.accounts();
    const [models, providers] = await Promise.all([service.availableModels(), service.providers().catch(() => [])]);
    const names = new Map(providers.map((row) => [row.id, row.name]));
    const all = models.map((model) => ({
      provider: model.provider,
      value: `${model.provider}/${model.id}`,
      label: model.name ?? model.id,
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    }));
    const order: string[] = [];
    const byProvider = new Map<string, ModelGroup>();
    const gateways = new Set(readGateways(this.deps.paths).map((gateway) => gateway.id));
    for (const model of all) {
      if (gateways.has(model.provider)) continue;
      let group = byProvider.get(model.provider);
      if (group === undefined) {
        group = { connection: names.get(model.provider) ?? model.provider, items: [] };
        byProvider.set(model.provider, group);
        order.push(model.provider);
      }
      group.items.push({ value: model.value, label: model.label, ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}) });
    }
    return { groups: order.map((provider) => byProvider.get(provider) as ModelGroup), models: all };
  }
}
