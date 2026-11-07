import fs from "node:fs";
import path from "node:path";
import { redact } from "../env";
import { writeOmoFile } from "./files";
import type { EnvPaths } from "./paths";
import { KNOWN_LEVELS } from "./protocol";

/** OmO's `api` values. */
export type GatewayProtocol = "anthropic-messages" | "openai-responses" | "openai-completions";
export type GatewaySpec = { id: string; name: string; protocol: GatewayProtocol; baseUrl: string };

/** Per-million-token rates, as OmO's catalog names them. */
export type ModelCost = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/**
 * One model the gateway serves, in the names OmO's catalog uses (`models.json`). Everything past `id` is what the
 * server said about it; a field the server did not mention is absent, never guessed.
 */
export type ServedModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  /** The server's own level names, verbatim: OmO derives its own list, this is what the server told us. */
  supportedThinkingLevels?: string[];
  /** OmO's levels mapped to the server's own spelling (`null`: a level the server does not serve). */
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
};
export type GatewayStatus = { fetchedAt?: string; source?: string; models: ServedModel[]; lastError?: string };
export type GatewayErrorKind = "unauthorized" | "unreachable" | "bad-response" | "empty";

/** A gateway call that failed; the message never carries the key. */
export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
const STALE_AFTER_MS = 24 * 3_600_000;
const MAX_PAGES = 50;
const ANTHROPIC_VERSION = "2023-06-01";
const PROBE_PROMPT = "hi";
const CAT_PREFIX = "!cat ";
const PROBE_HINTS: readonly string[] = ["haiku", "mini", "flash"];
const MIN_SECRET_LENGTH = 4;

type FetchFn = typeof fetch;
type Provider = Record<string, unknown> & { models?: unknown };
type ModelsFile = Record<string, unknown> & { providers?: Record<string, Provider> };
type CacheEntry = { name?: string; fetchedAt?: string; source?: string; models?: ServedModel[]; lastError?: string };

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function modelsUrl(spec: GatewaySpec): string {
  return `${trimBase(spec.baseUrl)}${spec.protocol === "anthropic-messages" ? "/v1/models" : "/models"}`;
}

function headers(spec: GatewaySpec, key: string, json = false): Record<string, string> {
  const base: Record<string, string> =
    spec.protocol === "anthropic-messages" ? { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } : { authorization: `Bearer ${key}` };
  return json ? { ...base, "content-type": "application/json" } : base;
}

/** One request; every failure becomes a GatewayError whose text has the key removed. */
async function request(spec: GatewaySpec, key: string, url: string, init: RequestInit, fetchFn: FetchFn): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GatewayError("unreachable", redact(`Шлюз «${spec.name}» недоступен: ${reason}`, [key]));
  }
  if (response.status === 401 || response.status === 403) throw new GatewayError("unauthorized", `Шлюз «${spec.name}» не принял ключ (${response.status})`);
  if (response.status >= 500) throw new GatewayError("unreachable", `Шлюз «${spec.name}» ответил ${response.status}`);
  if (!response.ok) throw new GatewayError("bad-response", `Шлюз «${spec.name}» ответил ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new GatewayError("bad-response", `Шлюз «${spec.name}» вернул не JSON`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The first value that is there; junk reads as absent, so a bad field never shadows a good one. */
function first<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A non-empty array of non-empty strings, or nothing: a list with one bad item is not half-trusted. */
function names(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((item) => text(item) !== undefined) ? (value as string[]) : undefined;
}

const INPUT_KINDS: readonly string[] = ["text", "image", "video"];
/** What a server may call OmO's `off`; the proxy's own spelling is what OmO sends back to it. */
const OFF_NAMES: readonly string[] = ["off", "none", "disabled"];

function levelName(served: string): string {
  const lower = served.toLowerCase();
  return OFF_NAMES.includes(lower) ? "off" : lower;
}

/**
 * OmO's levels against the server's own spelling (`null`: not served). Nothing when the server named no level OmO
 * knows besides `off` — OmO's own defaults beat a map that would leave the model with nothing but `off`.
 */
function levelMap(levels: readonly string[]): Record<string, string | null> | undefined {
  const map: Record<string, string | null> = {};
  for (const level of KNOWN_LEVELS) map[level] = levels.find((served) => levelName(served) === level) ?? null;
  return KNOWN_LEVELS.some((level) => level !== "off" && map[level] !== null) ? map : undefined;
}

function costOf(value: unknown): ModelCost | undefined {
  const entry = asRecord(value);
  if (entry === undefined) return undefined;
  const cost: ModelCost = {};
  const input = rate(entry["input"]);
  const output = rate(entry["output"]);
  const cacheRead = first([rate(entry["cacheRead"]), rate(entry["cache_read"])]);
  const cacheWrite = first([rate(entry["cacheWrite"]), rate(entry["cache_write"])]);
  if (input !== undefined) cost.input = input;
  if (output !== undefined) cost.output = output;
  if (cacheRead !== undefined) cost.cacheRead = cacheRead;
  if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
  return Object.keys(cost).length === 0 ? undefined : cost;
}

/** Anthropic's `/v1/models` says what a model can do in a nested `capabilities` object. */
function capability(entry: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(entry["capabilities"])?.[name]);
}

/** True when anything the server said marks the model as thinking; false only when it said so; otherwise nothing. */
function reasoningOf(entry: Record<string, unknown>, levels: string[] | undefined): boolean | undefined {
  const flags = [flag(entry["reasoning"]), flag(entry["thinking"]), flag(capability(entry, "thinking")?.["supported"])];
  if (flags.includes(true) || levels !== undefined) return true;
  return flags.includes(false) ? false : undefined;
}

/**
 * What the model takes, from OmO's own `input`, OpenAI's `input_modalities` or Anthropic's `image_input` flag. Any of
 * them is the server's word and replaces whatever the catalogue held (an old hand-written `["text"]` included); none of
 * them is silence, left to OmO. OpenAI may list a modality OmO has no input kind for (audio): it is dropped, not fatal.
 */
function inputOf(entry: Record<string, unknown>): string[] | undefined {
  const listed = names(entry["input"]);
  if (listed !== undefined) return listed.every((kind) => INPUT_KINDS.includes(kind)) ? listed : undefined;
  const modalities = first([names(entry["input_modalities"]), names(entry["inputModalities"])]);
  if (modalities !== undefined) {
    const known = modalities.filter((kind) => INPUT_KINDS.includes(kind));
    return known.includes("text") ? known : undefined;
  }
  const image = flag(capability(entry, "image_input")?.["supported"]);
  return image === undefined ? undefined : image ? ["text", "image"] : ["text"];
}

/** One listed model in OmO's own names. Both spellings are read (snake_case and camelCase); junk reads as absent. */
export function normaliseModel(item: unknown): ServedModel | undefined {
  const entry = asRecord(item);
  const id = text(entry?.["id"]);
  if (entry === undefined || id === undefined) return undefined;
  const model: ServedModel = { id };
  const name = first([text(entry["display_name"]), text(entry["displayName"]), text(entry["name"])]);
  const levels = first([names(entry["supportedThinkingLevels"]), names(entry["supported_reasoning_efforts"]), names(entry["reasoning_efforts"])]);
  const reasoning = reasoningOf(entry, levels);
  const input = inputOf(entry);
  const contextWindow = first([count(entry["contextWindow"]), count(entry["context_window"]), count(entry["maxInputTokens"]), count(entry["max_input_tokens"])]);
  const maxTokens = first([count(entry["maxTokens"]), count(entry["max_tokens"])]);
  const cost = costOf(entry["cost"]);
  if (name !== undefined) model.name = name;
  if (reasoning !== undefined) model.reasoning = reasoning;
  if (levels !== undefined) {
    model.supportedThinkingLevels = levels;
    const map = levelMap(levels);
    if (map !== undefined) model.thinkingLevelMap = map;
  }
  if (input !== undefined) model.input = input;
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  if (cost !== undefined) model.cost = cost;
  return model;
}

function servedModels(page: Record<string, unknown> | undefined, spec: GatewaySpec): ServedModel[] {
  if (page === undefined || !Array.isArray(page["data"])) throw new GatewayError("bad-response", `Шлюз «${spec.name}» вернул список моделей в неизвестной форме`);
  return page["data"].flatMap((item) => {
    const model = normaliseModel(item);
    return model === undefined ? [] : [model];
  });
}

/** The server's own model list (Anthropic: paged by `after_id`). An empty list is an error. */
export async function fetchModels(spec: GatewaySpec, key: string, fetchFn: FetchFn = fetch): Promise<ServedModel[]> {
  const url = modelsUrl(spec);
  const models: ServedModel[] = [];
  let afterId: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const target = afterId === undefined ? url : `${url}?after_id=${encodeURIComponent(afterId)}`;
    const page = asRecord(await request(spec, key, target, { method: "GET", headers: headers(spec, key) }, fetchFn));
    models.push(...servedModels(page, spec));
    const lastId = page?.["last_id"];
    if (spec.protocol !== "anthropic-messages" || page?.["has_more"] !== true || typeof lastId !== "string" || lastId === afterId) break;
    afterId = lastId;
  }
  if (models.length === 0) throw new GatewayError("empty", `Шлюз «${spec.name}» не отдал ни одной модели`);
  return models;
}

/** The cheapest by name: haiku, else mini, else flash, else the first. */
export function pickProbeModel(ids: readonly string[]): string {
  for (const hint of PROBE_HINTS) {
    const found = ids.find((id) => id.toLowerCase().includes(hint));
    if (found !== undefined) return found;
  }
  return ids[0] as string;
}

/** One minimal request to the protocol's own endpoint; throws when the gateway refuses it. */
export async function probe(spec: GatewaySpec, key: string, model: string, fetchFn: FetchFn = fetch): Promise<void> {
  const messages = [{ role: "user", content: PROBE_PROMPT }];
  const [endpoint, body]: [string, Record<string, unknown>] =
    spec.protocol === "anthropic-messages"
      ? ["/v1/messages", { model, max_tokens: 1, messages }]
      : spec.protocol === "openai-responses"
        ? ["/responses", { model, max_output_tokens: 16, input: PROBE_PROMPT }] // 16 is the API's minimum
        : ["/chat/completions", { model, max_tokens: 1, messages }];
  await request(spec, key, `${trimBase(spec.baseUrl)}${endpoint}`, { method: "POST", headers: headers(spec, key, true), body: JSON.stringify(body) }, fetchFn);
}

/** `!cat <path>` runs through a shell: the path is single-quoted so a space or metacharacter stays data. */
export function catReference(file: string): string {
  return `${CAT_PREFIX}'${file.replace(/'/g, "'\\''")}'`;
}

const GATEWAY_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Ids the plugin can write: they become a key file's name and a shell argument. */
export function isGatewayId(id: string): boolean {
  return GATEWAY_ID.test(id);
}

function checkId(id: string): void {
  if (!isGatewayId(id)) throw new GatewayError("bad-response", "Недопустимый идентификатор шлюза: только a-z, 0-9 и «-»");
}

function keyPath(paths: EnvPaths, id: string): string {
  return path.join(paths.keysDir, `${id}.key`);
}

/** Atomic, mode 0600 in a 0700 dir, and never a backup: a backup would be a second copy of a secret. */
export function writeKeyFile(file: string, key: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, key, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}

function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // never the parser's message (it quotes the input) and never overwritten
    throw new Error(`Файл ${file} не разобрать как JSON; он не изменён`);
  }
}

/** Re-read from disk on every use: nobody keeps a copy that could go stale. */
export function readModelsFile(paths: EnvPaths): ModelsFile {
  return (asRecord(readJsonFile(paths.modelsJson)) ?? {}) as ModelsFile;
}

export function writeModelsFile(paths: EnvPaths, file: ModelsFile): void {
  writeOmoFile(paths.modelsJson, `${JSON.stringify(file, null, 2)}\n`, { backup: "rolling" });
}

function readCache(paths: EnvPaths): Record<string, CacheEntry> {
  return (asRecord(readJsonFile(paths.modelsCache)) ?? {}) as Record<string, CacheEntry>;
}

function writeCache(paths: EnvPaths, cache: Record<string, CacheEntry>): void {
  writeOmoFile(paths.modelsCache, `${JSON.stringify(cache, null, 2)}\n`, { backup: "rolling" });
}

/** The file a provider's `apiKey` points at, when it is one of ours (`!cat <keysDir>/…`). */
function referencedKeyFile(paths: EnvPaths, provider: Provider | undefined): string | undefined {
  const apiKey = provider?.["apiKey"];
  if (typeof apiKey !== "string" || !apiKey.startsWith(CAT_PREFIX)) return undefined;
  const argument = apiKey.slice(CAT_PREFIX.length);
  const file = argument.startsWith("'") && argument.endsWith("'") && argument.length >= 2 ? argument.slice(1, -1).replace(/'\\''/g, "'") : argument;
  return path.dirname(file) === paths.keysDir ? file : undefined;
}

function isProtocol(value: unknown): value is GatewayProtocol {
  return value === "anthropic-messages" || value === "openai-responses" || value === "openai-completions";
}

function readKey(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    return key === "" ? undefined : key;
  } catch {
    return undefined;
  }
}

function providerModels(provider: Provider): Array<Record<string, unknown>> {
  return Array.isArray(provider.models) ? provider.models.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined) : [];
}

/**
 * The fields of a model entry the server owns: `models.json`'s own names, and only the ones OmO's catalog reads
 * (`supportedThinkingLevels` is not among them — OmO derives its list from `reasoning` and `thinkingLevelMap`).
 */
const CATALOG_FIELDS = ["name", "reasoning", "thinkingLevelMap", "input", "contextWindow", "maxTokens", "cost"] as const;

/**
 * Keeps a still-served model's own fields (e.g. `compat`, or a capability the server stopped mentioning) and takes
 * from the server every field it did send; a new model is the whole normalised set.
 *
 * A model nobody has said anything about is written as thinking. OmO reads a missing `reasoning` as «cannot think» and
 * then answers `get_available_thinking_levels` with `["off"]` — a denial the gateway never made: an OpenAI-style
 * `/models` list is bare ids and describes no capability either way. Writing that silence into the catalogue as a
 * denial took the levels away from every such model (live proof in `test/live/thinkingLevels.live.test.ts`: a bare
 * entry answered `["off"]`, exactly like a model marked `reasoning: false`). So absence of information now
 * means «let OmO decide»: it owns the ladder, how many steps it has and where a model starts on it. An explicit
 * `reasoning: false` — from the server, or edited into the entry by hand — still wins and survives every refresh.
 */
function mergeModels(previous: Provider | undefined, served: readonly ServedModel[]): Array<Record<string, unknown>> {
  const before = new Map(providerModels(previous ?? {}).map((model) => [model["id"], model]));
  return served.map((model) => {
    const entry: Record<string, unknown> = { ...before.get(model.id), id: model.id };
    for (const field of CATALOG_FIELDS) if (model[field] !== undefined) entry[field] = model[field];
    entry["name"] ??= model.id;
    entry["reasoning"] ??= true;
    return entry;
  });
}

function applyProvider(paths: EnvPaths, spec: GatewaySpec, apiKey: string, served: readonly ServedModel[]): void {
  const file = readModelsFile(paths);
  const providers = { ...(file.providers ?? {}) };
  const provider: Provider = { ...(providers[spec.id] ?? {}), baseUrl: spec.baseUrl, api: spec.protocol, apiKey, models: mergeModels(providers[spec.id], served) };
  if (spec.protocol === "anthropic-messages") delete provider["authHeader"];
  else provider["authHeader"] = true;
  providers[spec.id] = provider;
  writeModelsFile(paths, { ...file, providers });
}

/**
 * Checks the key against the server (model list, then a one-token probe), then writes the key file, the provider and
 * the cache entry. Nothing is written when the check fails. `key` undefined keeps the stored key file.
 */
export async function saveGateway(paths: EnvPaths, spec: GatewaySpec, key: string | undefined, fetchFn: FetchFn = fetch): Promise<GatewayStatus> {
  checkId(spec.id);
  const existing = readModelsFile(paths).providers?.[spec.id];
  const file = key === undefined ? (referencedKeyFile(paths, existing) ?? keyPath(paths, spec.id)) : keyPath(paths, spec.id);
  const effective = key ?? readKey(file);
  if (effective === undefined) throw new GatewayError("unauthorized", `Для шлюза «${spec.name}» не задан ключ`);
  const served = await fetchModels(spec, effective, fetchFn);
  await probe(spec, effective, pickProbeModel(served.map((model) => model.id)), fetchFn);
  if (key !== undefined) writeKeyFile(file, key);
  applyProvider(paths, spec, catReference(file), served);
  const status: GatewayStatus = { fetchedAt: new Date().toISOString(), source: modelsUrl(spec), models: served };
  writeCache(paths, { ...readCache(paths), [spec.id]: { name: spec.name, ...status } });
  return status;
}

type Known = { spec: GatewaySpec; provider: Provider; cached: CacheEntry; keyFile: string };

/** Providers whose key lives in one of our key files: those are the gateways the plugin manages. */
function knownGateways(paths: EnvPaths): Known[] {
  const providers = readModelsFile(paths).providers ?? {};
  const cache = readCache(paths);
  const result: Known[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    const keyFile = referencedKeyFile(paths, provider);
    const api = provider["api"];
    const baseUrl = provider["baseUrl"];
    if (keyFile === undefined || !isProtocol(api) || typeof baseUrl !== "string") continue;
    const cached = cache[id] ?? {};
    result.push({ spec: { id, name: cached.name ?? id, protocol: api, baseUrl }, provider, cached, keyFile });
  }
  return result;
}

/** The provider's own entries as served models: the entry already holds OmO's names, so it reads back the same way. */
function servedFromProvider(provider: Provider): ServedModel[] {
  return providerModels(provider).flatMap((model) => {
    const served = normaliseModel(model);
    return served === undefined ? [] : [served];
  });
}

/** Still the gateway the read started from (same spec, key file and key): a remove or edit made meanwhile wins over a late answer. */
function stillSame(paths: EnvPaths, known: Known, key: string | undefined): boolean {
  const current = knownGateways(paths).find((item) => item.spec.id === known.spec.id);
  return current !== undefined && current.keyFile === known.keyFile && JSON.stringify(current.spec) === JSON.stringify(known.spec) && readKey(current.keyFile) === key;
}

/**
 * The last list stays when the server cannot be reached; only the error is noted (and returned). `withProbe` also sends
 * the one-token request. Nothing is written when the gateway changed or went away while the server was asked.
 */
async function refreshOne(paths: EnvPaths, known: Known, now: Date, fetchFn: FetchFn, withProbe = false): Promise<string | undefined> {
  const key = readKey(known.keyFile);
  let served: ServedModel[] | undefined;
  let failure: string | undefined;
  try {
    if (key === undefined) throw new GatewayError("unauthorized", "Файл ключа пуст или не читается");
    served = await fetchModels(known.spec, key, fetchFn);
    if (withProbe) await probe(known.spec, key, pickProbeModel(served.map((model) => model.id)), fetchFn);
  } catch (error) {
    served = undefined;
    failure = redact(error instanceof Error ? error.message : String(error), key === undefined ? [] : [key]);
  }
  if (!stillSame(paths, known, key)) return failure;
  let entry: CacheEntry;
  if (served !== undefined) {
    applyProvider(paths, known.spec, catReference(known.keyFile), served);
    entry = { name: known.spec.name, fetchedAt: now.toISOString(), source: modelsUrl(known.spec), models: served };
  } else {
    entry = { ...known.cached, name: known.spec.name, models: known.cached.models ?? servedFromProvider(known.provider), lastError: failure };
  }
  writeCache(paths, { ...readCache(paths), [known.spec.id]: entry });
  return failure;
}

/** One gateway's list now, whatever its age (`probe`: plus the one-token request); a failure is noted in the cache and returned. */
export async function refreshGateway(paths: EnvPaths, id: string, now: Date, options: { probe: boolean }, fetchFn: FetchFn = fetch): Promise<string | undefined> {
  const known = knownGateways(paths).find((item) => item.spec.id === id);
  if (known === undefined) throw new Error(`Шлюз «${id}» не найден`);
  return refreshOne(paths, known, now, fetchFn, options.probe);
}

/** Re-reads the list of every gateway whose last successful fetch is over a day old (or that never had one). */
export async function refreshStale(paths: EnvPaths, now: Date, fetchFn: FetchFn = fetch): Promise<void> {
  for (const known of knownGateways(paths)) {
    const fetchedAt = known.cached.fetchedAt === undefined ? Number.NaN : Date.parse(known.cached.fetchedAt);
    if (!Number.isNaN(fetchedAt) && now.getTime() - fetchedAt <= STALE_AFTER_MS) continue;
    await refreshOne(paths, known, now, fetchFn);
  }
}

/** Deletes the provider, its cache entry and its key file (a key file other providers still use stays). */
export function removeGateway(paths: EnvPaths, id: string): void {
  checkId(id);
  const file = readModelsFile(paths);
  const providers = { ...(file.providers ?? {}) };
  const removed = providers[id];
  if (removed === undefined) return;
  const keyFile = referencedKeyFile(paths, removed);
  delete providers[id];
  writeModelsFile(paths, { ...file, providers });
  const cache = readCache(paths);
  if (id in cache) {
    delete cache[id];
    writeCache(paths, cache);
  }
  const stillUsed = Object.values(providers).some((provider) => referencedKeyFile(paths, provider) === keyFile);
  if (keyFile !== undefined && !stillUsed) fs.rmSync(keyFile, { force: true });
}

const KEY_HINT_TAIL = 4;
const MIN_HINT_KEY_LENGTH = 8;

/** Enough to tell keys apart, never the key. */
function keyHint(key: string | undefined): string {
  if (key === undefined) return "";
  return key.length >= MIN_HINT_KEY_LENGTH ? `••••••${key.slice(-KEY_HINT_TAIL)}` : "••••••";
}

export function readGateways(paths: EnvPaths): Array<GatewaySpec & GatewayStatus & { keyHint: string }> {
  return knownGateways(paths).map(({ spec, provider, cached, keyFile }) => ({
    ...spec,
    ...(cached.fetchedAt !== undefined ? { fetchedAt: cached.fetchedAt } : {}),
    ...(cached.source !== undefined ? { source: cached.source } : {}),
    ...(cached.lastError !== undefined ? { lastError: cached.lastError } : {}),
    models: cached.models ?? servedFromProvider(provider),
    keyHint: keyHint(readKey(keyFile)),
  }));
}

/** The contents of every key file (4+ chars): the redaction list must know keys that no setting holds. */
export function keyFileSecrets(paths: EnvPaths): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.keysDir).filter((name) => name.endsWith(".key"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const key = readKey(path.join(paths.keysDir, name));
    return key !== undefined && key.length >= MIN_SECRET_LENGTH ? [key] : [];
  });
}
