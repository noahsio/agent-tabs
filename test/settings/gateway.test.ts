import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OmoEnv } from "../../src/env";
import {
  GatewayError,
  fetchModels,
  modelsUrl,
  normaliseModel,
  pickProbeModel,
  probe,
  readGateways,
  refreshStale,
  removeGateway,
  saveGateway,
  type GatewaySpec,
} from "../../src/settings/gateway";
import { envPaths, type EnvPaths } from "../../src/settings/paths";

const KEY = "test-key-0123456789abcdef";
type Seen = { method: string; path: string; key?: string; authorization?: string; body?: Record<string, unknown> };

let server: http.Server;
let base: string;
let home: string;
let paths: EnvPaths;
let seen: Seen[];
let status: number;
let served: Array<Record<string, unknown> & { id: string }>;
let paged: boolean;

function reply(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeEach(async () => {
  seen = [];
  status = 200;
  paged = false;
  served = [{ id: "claude-a", display_name: "Claude A" }, { id: "claude-b" }];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const entry: Seen = { method: req.method ?? "", path: req.url ?? "" };
      if (typeof req.headers["x-api-key"] === "string") entry.key = req.headers["x-api-key"];
      if (typeof req.headers.authorization === "string") entry.authorization = req.headers.authorization;
      if (raw !== "") entry.body = JSON.parse(raw) as Record<string, unknown>;
      seen.push(entry);
      if (status !== 200) return reply(res, status, { error: "nope" });
      if (req.method === "POST") return reply(res, 200, { ok: true });
      if (req.url === "/v1/models") {
        return reply(res, 200, paged ? { data: served.slice(0, 1), has_more: true, last_id: served[0]?.id } : { data: served, has_more: false });
      }
      if (req.url?.startsWith("/v1/models?after_id=")) return reply(res, 200, { data: served.slice(1), has_more: false });
      if (req.url === "/models") return reply(res, 200, { data: served });
      return reply(res, 404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-gateway-"));
  const agentDir = path.join(home, ".omo/agent");
  const env: OmoEnv = { env: { OMO_CODING_AGENT_DIR: agentDir }, agentDir, omoPath: "/fake/omo", secrets: [] };
  paths = envPaths(env, home);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

const anthropic = (): GatewaySpec => ({ id: "gw-test", name: "Test", protocol: "anthropic-messages", baseUrl: base });
const openai = (protocol: GatewaySpec["protocol"] = "openai-completions"): GatewaySpec => ({ id: "gw-oai", name: "Oai", protocol, baseUrl: base });

const rawModels = (): string => fs.readFileSync(paths.modelsJson, "utf8");
const models = (): { providers: Record<string, Record<string, unknown> & { models: Array<Record<string, unknown>> }> } =>
  JSON.parse(rawModels()) as never;
const cache = (): Record<string, { fetchedAt: string; source: string; models: unknown[]; lastError?: string }> =>
  JSON.parse(fs.readFileSync(paths.modelsCache, "utf8")) as never;
const mode = (file: string): number => fs.statSync(file).mode & 0o777;
const bodyOf = (endpoint: string): Record<string, unknown> | undefined => seen.find((item) => item.path === endpoint)?.body;

describe("fetchModels", () => {
  it("anthropic_models_come_from_v1_models_with_paging", async () => {
    paged = true;
    const result = await fetchModels(anthropic(), KEY, fetch);
    expect(result.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
    expect(result[0]?.name).toBe("Claude A");
    expect(seen.map((item) => ({ path: item.path, key: item.key }))).toEqual([
      { path: "/v1/models", key: KEY },
      { path: "/v1/models?after_id=claude-a", key: KEY },
    ]);
  });

  it("openai_models_come_from_models_with_bearer", async () => {
    await fetchModels(openai(), KEY, fetch);
    expect(seen[0]).toEqual({ method: "GET", path: "/models", authorization: `Bearer ${KEY}` });
  });

  it("modelsUrl_follows_the_protocol", () => {
    expect(modelsUrl({ ...anthropic(), baseUrl: `${base}/` })).toBe(`${base}/v1/models`);
    expect(modelsUrl(openai())).toBe(`${base}/models`);
  });

  it("maps_failures_to_error_kinds_without_the_key", async () => {
    status = 401;
    await expect(fetchModels(anthropic(), KEY, fetch)).rejects.toMatchObject({ kind: "unauthorized" });
    status = 500;
    await expect(fetchModels(anthropic(), KEY, fetch)).rejects.toMatchObject({ kind: "unreachable" });
    status = 200;
    served = [];
    await expect(fetchModels(anthropic(), KEY, fetch)).rejects.toMatchObject({ kind: "empty" });
    const refused = await fetchModels({ ...anthropic(), baseUrl: "http://127.0.0.1:1" }, KEY, fetch).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GatewayError);
    expect((refused as GatewayError).kind).toBe("unreachable");
    expect((refused as GatewayError).message).not.toContain(KEY);
  });

  it("error_text_never_carries_the_key", async () => {
    const leaky = (async () => {
      throw new Error(`connect failed for key ${KEY}`);
    }) as unknown as typeof fetch;
    const error = (await fetchModels(anthropic(), KEY, leaky).catch((caught: unknown) => caught)) as GatewayError;
    expect(error.message).not.toContain(KEY);
  });
});

describe("model capabilities", () => {
  const entry = async (model: Record<string, unknown> & { id: string }): Promise<Record<string, unknown>> => {
    served = [model];
    await saveGateway(paths, anthropic(), KEY, fetch);
    return models().providers["gw-test"]?.models[0] as Record<string, unknown>;
  };

  it("snake_case_capabilities_become_omos_own_names", async () => {
    const written = await entry({
      id: "dsv41-flash-uncensored",
      display_name: "DSV4.1 Flash",
      reasoning: true,
      thinking: true,
      supported_reasoning_efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"],
      input: ["text", "image"],
      context_window: 262_144,
      max_tokens: 64_000,
      cost: { input: 0.6, output: 3, cache_read: 0.1, cache_write: 0.8 },
    });
    expect(written).toEqual({
      id: "dsv41-flash-uncensored",
      name: "DSV4.1 Flash",
      reasoning: true,
      thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 64_000,
      cost: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0.8 },
    });
  });

  it("camelCase_capabilities_land_the_same_way", async () => {
    const written = await entry({
      id: "m-camel",
      displayName: "Camel",
      reasoning: true,
      supportedThinkingLevels: ["off", "low", "high"],
      contextWindow: 200_000,
      maxTokens: 32_000,
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
    });
    expect(written).toMatchObject({ name: "Camel", reasoning: true, contextWindow: 200_000, maxTokens: 32_000, cost: { cacheRead: 0.5, cacheWrite: 1.5 } });
    expect(written["thinkingLevelMap"]).toEqual({ off: "off", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
  });

  it("the_servers_own_spelling_of_off_is_kept", async () => {
    const written = await entry({ id: "m-none", reasoning: true, supported_reasoning_efforts: ["none", "low", "high"] });
    expect((written["thinkingLevelMap"] as Record<string, unknown>)["off"]).toBe("none");
  });

  it("a_levels_list_alone_marks_the_model_as_thinking", async () => {
    const written = await entry({ id: "m-levels", supported_reasoning_efforts: ["none", "medium"] });
    expect(written["reasoning"]).toBe(true);
  });

  it("reasoning_without_a_list_writes_no_level_map", async () => {
    expect(await entry({ id: "m-plain", reasoning: true })).toEqual({ id: "m-plain", name: "m-plain", reasoning: true });
    expect(await entry({ id: "m-thinks", thinking: true })).toEqual({ id: "m-thinks", name: "m-thinks", reasoning: true });
  });

  it("anthropics_nested_capabilities_are_read", async () => {
    const written = await entry({
      id: "claude-haiku-5-5",
      display_name: "Claude Haiku 5.5",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: { thinking: { supported: true }, image_input: { supported: true } },
    });
    expect(written).toEqual({ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 });
  });

  it("openais_input_modalities_say_what_the_model_takes", () => {
    expect(normaliseModel({ id: "gpt-6-astra", input_modalities: ["text", "image"] })?.input).toEqual(["text", "image"]);
    expect(normaliseModel({ id: "gpt-6-astra", inputModalities: ["text", "image"] })?.input).toEqual(["text", "image"]);
    expect(normaliseModel({ id: "gpt-6-luna", input_modalities: ["text"] })?.input).toEqual(["text"]);
    // a modality OmO has no input kind for (audio) does not hide the ones it has
    expect(normaliseModel({ id: "gpt-6-voice", input_modalities: ["text", "image", "audio"] })?.input).toEqual(["text", "image"]);
    expect(normaliseModel({ id: "m-odd", input_modalities: ["audio"] })?.input).toBeUndefined();
  });

  it("anthropics_image_input_flag_is_read_both_ways", () => {
    expect(normaliseModel({ id: "claude-x", capabilities: { image_input: { supported: true } } })?.input).toEqual(["text", "image"]);
    expect(normaliseModel({ id: "claude-x", capabilities: { image_input: { supported: false } } })?.input).toEqual(["text"]);
  });

  it("input_types_the_server_sent_replace_an_old_text_only_entry", async () => {
    // The first hand-written catalogue marked GPT models text-only; a server that now names its types must win over it.
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.writeFileSync(paths.modelsJson, JSON.stringify({ providers: { "gw-test": { models: [{ id: "gpt-6-astra", input: ["text"] }] } } }));
    expect((await entry({ id: "gpt-6-astra", input_modalities: ["text", "image"] }))["input"]).toEqual(["text", "image"]);
  });

  it("a_model_that_says_it_does_not_think_says_so", async () => {
    expect(await entry({ id: "m-flat", reasoning: false })).toEqual({ id: "m-flat", name: "m-flat", reasoning: false });
    expect(await entry({ id: "m-flat", capabilities: { thinking: { supported: false } } })).toEqual({ id: "m-flat", name: "m-flat", reasoning: false });
  });

  /**
   * A bare `/models` list says nothing about reasoning, and OmO reads a missing `reasoning` as «cannot think»: such a
   * model was then offered the single level `off` and could not be asked to think at all. Silence is not a denial.
   */
  it("a_model_with_no_hint_is_left_for_omo_to_judge", async () => {
    expect(await entry({ id: "gpt-6-astra", object: "model", created: 1, owned_by: "x" })).toEqual({ id: "gpt-6-astra", name: "gpt-6-astra", reasoning: true });
  });

  it("an_entry_that_already_denies_thinking_is_not_overruled_by_the_default", async () => {
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.writeFileSync(paths.modelsJson, JSON.stringify({ providers: { "gw-test": { models: [{ id: "m-quiet", reasoning: false }] } } }));
    expect(await entry({ id: "m-quiet" })).toEqual({ id: "m-quiet", name: "m-quiet", reasoning: false }); // a hand-edited «no» survives
  });

  it("junk_types_are_ignored", async () => {
    const written = await entry({
      id: "m-junk",
      display_name: 7,
      reasoning: "yes",
      supported_reasoning_efforts: ["low", 3],
      input: ["text", "audio"],
      context_window: "big",
      max_tokens: -1,
      cost: { input: "free", output: null },
    });
    expect(written).toEqual({ id: "m-junk", name: "m-junk", reasoning: true }); // junk reads as silence, and silence is OmO's call
  });

  it("a_levels_list_naming_nothing_omo_knows_leaves_omos_defaults", async () => {
    const written = await entry({ id: "m-alien", reasoning: true, supported_reasoning_efforts: ["ultra", "turbo"] });
    expect(written).toEqual({ id: "m-alien", name: "m-alien", reasoning: true });
  });

  it("the_sidecar_keeps_the_servers_own_level_list", async () => {
    served = [{ id: "m-cached", reasoning: true, supported_reasoning_efforts: ["none", "high"] }];
    await saveGateway(paths, anthropic(), KEY, fetch);
    expect(cache()["gw-test"]?.models[0]).toMatchObject({ id: "m-cached", reasoning: true, supportedThinkingLevels: ["none", "high"] });
    expect(readGateways(paths)[0]?.models[0]?.reasoning).toBe(true);
  });

  it("the_provider_entry_is_read_back_when_the_sidecar_is_gone", async () => {
    served = [{ id: "m-kept", reasoning: false }];
    await saveGateway(paths, anthropic(), KEY, fetch);
    fs.rmSync(paths.modelsCache);
    expect(readGateways(paths)[0]?.models).toEqual([{ id: "m-kept", name: "m-kept", reasoning: false }]);
  });
});

describe("probe", () => {
  it("probe_picks_the_cheapest_by_name", () => {
    expect(pickProbeModel(["x-opus", "x-haiku"])).toBe("x-haiku");
    expect(pickProbeModel(["g-6", "g-6-mini"])).toBe("g-6-mini");
    expect(pickProbeModel(["a", "B-Flash"])).toBe("B-Flash");
    expect(pickProbeModel(["a", "b"])).toBe("a");
  });

  it("probe_uses_the_protocol_endpoint", async () => {
    await probe(anthropic(), KEY, "m1", fetch);
    await probe(openai("openai-completions"), KEY, "m2", fetch);
    await probe(openai("openai-responses"), KEY, "m3", fetch);
    const posts = seen.filter((item) => item.method === "POST");
    expect(posts.map((item) => item.path)).toEqual(["/v1/messages", "/chat/completions", "/responses"]);
    expect(bodyOf("/v1/messages")).toMatchObject({ model: "m1", max_tokens: 1 });
    expect(bodyOf("/chat/completions")).toMatchObject({ model: "m2", max_tokens: 1 });
    expect(bodyOf("/responses")).toMatchObject({ model: "m3", max_output_tokens: 16 });
    expect(posts[0]?.key).toBe(KEY);
    expect(posts[1]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it("a_rejected_probe_throws", async () => {
    status = 403;
    await expect(probe(anthropic(), KEY, "m", fetch)).rejects.toMatchObject({ kind: "unauthorized" });
  });
});

describe("saveGateway", () => {
  it("save_writes_key_file_reference_and_cache_sidecar", async () => {
    const result = await saveGateway(paths, anthropic(), KEY, fetch);
    expect(result.models.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
    expect(models().providers["gw-test"]?.apiKey).toBe(`!cat '${paths.keysDir}/gw-test.key'`);
    expect(models().providers["gw-test"]?.api).toBe("anthropic-messages");
    expect(fs.readFileSync(`${paths.keysDir}/gw-test.key`, "utf8")).toBe(KEY);
    expect(mode(`${paths.keysDir}/gw-test.key`)).toBe(0o600);
    expect(mode(paths.keysDir)).toBe(0o700);
    expect(rawModels()).not.toContain(KEY);
    expect(cache()["gw-test"]).toMatchObject({ fetchedAt: expect.any(String), source: `${base}/v1/models` });
    expect(rawModels()).not.toContain("fetchedAt");
    expect(seen.some((item) => item.path === "/v1/messages")).toBe(true);
    expect(fs.readdirSync(paths.keysDir)).toEqual(["gw-test.key"]); // no backup copies of a secret
  });

  it("a_rewritten_key_leaves_no_backup_and_openai_sets_auth_header", async () => {
    await saveGateway(paths, openai(), KEY, fetch);
    await saveGateway(paths, openai(), `${KEY}-2`, fetch);
    expect(fs.readdirSync(paths.keysDir)).toEqual(["gw-oai.key"]);
    expect(fs.readFileSync(`${paths.keysDir}/gw-oai.key`, "utf8")).toBe(`${KEY}-2`);
    expect(models().providers["gw-oai"]?.authHeader).toBe(true);
  });

  it("a_failing_probe_saves_nothing", async () => {
    const failingProbe = (async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST" ? new Response("{}", { status: 400 }) : fetch(url, init)) as typeof fetch;
    await expect(saveGateway(paths, anthropic(), KEY, failingProbe)).rejects.toBeInstanceOf(GatewayError);
    expect(fs.existsSync(paths.modelsJson)).toBe(false);
    expect(fs.existsSync(`${paths.keysDir}/gw-test.key`)).toBe(false);
  });

  it("previous_per_model_fields_survive_a_refresh", async () => {
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.writeFileSync(
      paths.modelsJson,
      JSON.stringify({
        other: 1,
        providers: {
          "gw-test": { baseUrl: "http://old", api: "anthropic-messages", note: "keep", models: [{ id: "claude-a", name: "Old", compat: { forceAdaptiveThinking: true } }, { id: "gone" }] },
          "unrelated": { baseUrl: "x", models: [] },
        },
      }),
    );
    served = [{ id: "claude-a", display_name: "Claude A", reasoning: true }, { id: "claude-b" }];
    await saveGateway(paths, anthropic(), KEY, fetch);
    const provider = models().providers["gw-test"];
    expect(provider?.models[0]?.compat).toEqual({ forceAdaptiveThinking: true });
    expect(provider?.models[0]?.reasoning).toBe(true); // the server's word on a capability wins
    expect(provider?.models[0]?.name).toBe("Claude A");
    expect(provider?.models.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
    expect(provider?.models[1]).toEqual({ id: "claude-b", name: "claude-b", reasoning: true });
    expect(provider?.note).toBe("keep");
    expect(provider?.baseUrl).toBe(base);
    expect(models().providers["unrelated"]).toEqual({ baseUrl: "x", models: [] });
    expect((models() as unknown as { other: number }).other).toBe(1);
  });

  it("a_capability_the_server_stops_mentioning_is_kept", async () => {
    served = [{ id: "claude-a", reasoning: true, max_tokens: 64_000 }];
    await saveGateway(paths, anthropic(), KEY, fetch);
    served = [{ id: "claude-a" }];
    await saveGateway(paths, anthropic(), KEY, fetch);
    expect(models().providers["gw-test"]?.models[0]).toEqual({ id: "claude-a", name: "claude-a", reasoning: true, maxTokens: 64_000 });
  });

  it("an_undefined_key_keeps_the_stored_file", async () => {
    await saveGateway(paths, anthropic(), KEY, fetch);
    seen = [];
    await saveGateway(paths, { ...anthropic(), name: "Renamed" }, undefined, fetch);
    expect(seen[0]?.key).toBe(KEY);
    expect(fs.readFileSync(`${paths.keysDir}/gw-test.key`, "utf8")).toBe(KEY);
    expect(readGateways(paths)[0]?.name).toBe("Renamed");
  });
});

describe("shell safety of the key reference", () => {
  const viaShell = (apiKey: string): string => execFileSync("sh", ["-c", apiKey.slice("!".length)], { encoding: "utf8" });

  it("a_space_or_quote_in_the_agent_dir_still_resolves_through_sh", async () => {
    for (const dirName of ["with space", "it's; touch pwned"]) {
      const agentDir = path.join(home, dirName);
      const spaced = { ...paths, agentDir, modelsJson: path.join(agentDir, "models.json"), keysDir: path.join(agentDir, "keys"), modelsCache: path.join(agentDir, "c.json") };
      await saveGateway(spaced, anthropic(), KEY, fetch);
      const apiKey = JSON.parse(fs.readFileSync(spaced.modelsJson, "utf8")).providers["gw-test"].apiKey as string;
      expect(viaShell(apiKey)).toBe(KEY);
      expect(readGateways(spaced)[0]?.id).toBe("gw-test"); // the stored form is parsed back
      expect(fs.existsSync(path.join(process.cwd(), "pwned"))).toBe(false);
    }
  });

  it("the_legacy_unquoted_form_is_still_recognised", async () => {
    await saveGateway(paths, anthropic(), KEY, fetch);
    const file = models();
    (file.providers["gw-test"] as Record<string, unknown>).apiKey = `!cat ${paths.keysDir}/gw-test.key`;
    fs.writeFileSync(paths.modelsJson, JSON.stringify(file));
    expect(readGateways(paths).map((gateway) => gateway.id)).toEqual(["gw-test"]);
  });

  it("an_id_that_could_leave_the_keys_dir_is_rejected_and_nothing_is_written", async () => {
    for (const id of ["../x", "a;b", "A", ""]) {
      await expect(saveGateway(paths, { ...anthropic(), id }, KEY, fetch)).rejects.toBeInstanceOf(GatewayError);
      expect(() => removeGateway(paths, id)).toThrow(GatewayError);
    }
    expect(fs.existsSync(paths.keysDir)).toBe(false);
    expect(fs.existsSync(paths.modelsJson)).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("corrupt files", () => {
  it("a_corrupt_models_json_is_named_but_not_quoted", async () => {
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.writeFileSync(paths.modelsJson, `{"apiKey": "${KEY}" oops`);
    const error = (await saveGateway(paths, anthropic(), KEY, fetch).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toContain(paths.modelsJson);
    expect(error.message).not.toContain(KEY);
    expect(fs.readFileSync(paths.modelsJson, "utf8")).toContain("oops");
  });
});

describe("refreshStale", () => {
  const HOUR = 3_600_000;

  it("refresh_is_daily", async () => {
    await saveGateway(paths, anthropic(), KEY, fetch);
    const fetchedAt = new Date(cache()["gw-test"]?.fetchedAt as string).getTime();
    seen = [];
    await refreshStale(paths, new Date(fetchedAt + HOUR), fetch);
    expect(seen).toHaveLength(0);
    served = [{ id: "claude-a" }, { id: "claude-b" }, { id: "claude-c" }];
    await refreshStale(paths, new Date(fetchedAt + 25 * HOUR), fetch);
    expect(seen.map((item) => item.path)).toEqual(["/v1/models"]);
    expect(models().providers["gw-test"]?.models.map((model) => model.id)).toEqual(["claude-a", "claude-b", "claude-c"]);
    expect(cache()["gw-test"]?.fetchedAt).toBe(new Date(fetchedAt + 25 * HOUR).toISOString());
  });

  it("refresh_failure_keeps_last_list", async () => {
    await saveGateway(paths, anthropic(), KEY, fetch);
    const before = rawModels();
    const later = new Date(Date.now() + 48 * HOUR);
    status = 500;
    await refreshStale(paths, later, fetch);
    expect(rawModels()).toBe(before);
    expect(cache()["gw-test"]?.models).toHaveLength(2);
    expect(cache()["gw-test"]?.lastError).toBeTruthy();
    expect(cache()["gw-test"]?.lastError).not.toContain(KEY);
  });
});

describe("removeGateway and readGateways", () => {
  it("remove_deletes_entry_cache_and_key_file", async () => {
    await saveGateway(paths, anthropic(), KEY, fetch);
    await saveGateway(paths, openai(), KEY, fetch);
    removeGateway(paths, "gw-test");
    expect(models().providers["gw-test"]).toBeUndefined();
    expect(models().providers["gw-oai"]).toBeDefined();
    expect(cache()["gw-test"]).toBeUndefined();
    expect(fs.existsSync(`${paths.keysDir}/gw-test.key`)).toBe(false);
    expect(fs.existsSync(`${paths.keysDir}/gw-oai.key`)).toBe(true);
  });

  it("a_short_key_shows_no_tail", async () => {
    await saveGateway(paths, anthropic(), "short7!", fetch);
    expect(readGateways(paths)[0]?.keyHint).toBe("••••••");
  });

  it("read_lists_gateways_with_a_hint_that_is_not_the_key", async () => {
    await saveGateway(paths, anthropic(), KEY, fetch);
    const [gateway] = readGateways(paths);
    expect(gateway).toMatchObject({ id: "gw-test", name: "Test", protocol: "anthropic-messages", baseUrl: base });
    expect(gateway?.models.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
    expect(gateway?.keyHint).toBe(`••••••${KEY.slice(-4)}`);
    expect(readGateways({ ...paths, modelsJson: path.join(home, "none.json") })).toEqual([]);
  });
});
