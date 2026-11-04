import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcClient } from "../../src/rpc/client";
import { AccountsService } from "../../src/settings/accounts";
import { catReference, writeKeyFile } from "../../src/settings/gateway";
import { envPaths, type EnvPaths } from "../../src/settings/paths";
import { ROLE_ROWS, RolesHost, type RolesAction, type RolesView } from "../../src/settings/roles";
import { SettingsService } from "../../src/settings/service";
import { FakeDaemon } from "../helpers/fakeDaemon";

const OMO_JSONC = `// Agent Tabs roles
{
  "telemetry": { "enabled": false },
  "model_profile": "gw-x/m1:xhigh",
  "agents": {
    "explore": { "model": "gw-x/m1", "reasoning": "medium" },
    "librarian": { "model": "gw-x/m1", "reasoning": "medium" },
    "plan-consultant": { "model": "gw-x/m2", "reasoning": "high" },
    "plan-reviewer": { "model": "gw-x/m2", "reasoning": "xhigh" }
  },
  "categories": {
    "quick": { "model": "gw-x/m2", "reasoning": "low" },
    "unspecified-low": { "model": "gw-x/m2", "reasoning": "low" },
    "writing": { "model": "gone/model", "reasoning": "medium" }
  },
  "memory": { "reflection": { "category": "quick" } }
}
`;

let home: string;
let paths: EnvPaths;
let daemon: FakeDaemon;
let clients: RpcClient[];
let host: RolesHost;
let changes: number;
let logged: string[];

function makeHost(): RolesHost {
  return new RolesHost({
    paths,
    accounts: () =>
      new AccountsService({
        connect: async () => {
          const client = await RpcClient.connect(daemon.socketPath, daemon.agentDir);
          clients.push(client);
          return client;
        },
        pluginDir: paths.pluginDir,
        openExternal: () => undefined,
        log: (text) => logged.push(text),
      }),
    changed: () => void (changes += 1),
    log: (text) => logged.push(text),
  });
}

/** A gateway as Task 3 leaves it: provider in models.json, key file, cache entry. */
function seedGateway(id: string, name: string, models: string[]): void {
  const keyFile = path.join(paths.keysDir, `${id}.key`);
  writeKeyFile(keyFile, "gw-key-0123456789b7f3");
  const file = fs.existsSync(paths.modelsJson) ? (JSON.parse(fs.readFileSync(paths.modelsJson, "utf8")) as { providers: Record<string, unknown> }) : { providers: {} };
  file.providers[id] = { baseUrl: "http://127.0.0.1:1", api: "anthropic-messages", apiKey: catReference(keyFile), models: models.map((model) => ({ id: model, name: model })) };
  fs.mkdirSync(path.dirname(paths.modelsJson), { recursive: true });
  fs.writeFileSync(paths.modelsJson, JSON.stringify(file));
  const cache = fs.existsSync(paths.modelsCache) ? (JSON.parse(fs.readFileSync(paths.modelsCache, "utf8")) as Record<string, unknown>) : {};
  cache[id] = { name, models: models.map((model) => ({ id: model })), fetchedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(paths.modelsCache), { recursive: true });
  fs.writeFileSync(paths.modelsCache, JSON.stringify(cache));
}

/** What the gateway's sidecar says its models are (the shape `fetchModels` leaves). */
function setGatewayModels(id: string, models: Array<Record<string, unknown>>): void {
  const cache = JSON.parse(fs.readFileSync(paths.modelsCache, "utf8")) as Record<string, Record<string, unknown>>;
  (cache[id] as Record<string, unknown>)["models"] = models;
  fs.writeFileSync(paths.modelsCache, JSON.stringify(cache));
}

const raw = (): string => fs.readFileSync(paths.omoJsonc, "utf8");
/** omo.jsonc without comments, read the way OmO reads it. */
function jsonc(): Record<string, any> {
  return JSON.parse(
    raw()
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  ) as Record<string, any>;
}
function setRaw(dotted: string, value: unknown): void {
  const parsed = jsonc();
  const keys = dotted.split(".");
  let node = parsed;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, any>;
  node[keys.at(-1) as string] = value;
  fs.writeFileSync(paths.omoJsonc, JSON.stringify(parsed));
}
async function set(id: string, model?: string, reasoning?: "low" | "medium" | "high" | "xhigh"): Promise<void> {
  const action: RolesAction = { kind: "role.set", id, ...(model !== undefined ? { model } : {}), ...(reasoning !== undefined ? { reasoning } : {}) };
  await host.perform(action);
}
async function row(id: string): Promise<RolesView["rows"][number]> {
  const found = (await host.view()).rows.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-roles-"));
  const agentDir = path.join(home, "agent");
  paths = envPaths({ env: {}, agentDir, omoPath: "/fake/omo", secrets: [] }, home);
  fs.mkdirSync(paths.pluginDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.omoJsonc), { recursive: true });
  fs.writeFileSync(paths.omoJsonc, OMO_JSONC);
  seedGateway("gw-x", "Шлюз (Anthropic API)", ["m1", "m2"]);
  daemon = await FakeDaemon.start();
  clients = [];
  changes = 0;
  logged = [];
  daemon.on("open_session", () => ({ data: { sessionId: "svc-1", state: { sessionFile: "/sessions/svc.jsonl" } } }));
  daemon.on("close_session", () => ({}));
  daemon.on("get_auth_providers", () => ({ data: { providers: [{ id: "chatgpt-sub", name: "ChatGPT", authType: "oauth", status: { configured: true } }] } }));
  daemon.on("get_available_models", () => ({
    data: { models: [{ provider: "chatgpt-sub", id: "c1", name: "C One", reasoning: false }, { provider: "gw-x", id: "m1" }, { provider: "gw-x", id: "m3", reasoning: true }] },
  }));
  host = makeHost();
});

afterEach(async () => {
  for (const client of clients) client.close();
  await daemon.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("RolesHost write", () => {
  it("setting_plan_review_writes_its_agent", async () => {
    await set("plan-review", "gw-x/m1", "high");
    expect(jsonc()["agents"]["plan-reviewer"]).toEqual({ model: "gw-x/m1", reasoning: "high" });
  });

  it("a_multi_key_role_writes_every_key_and_reads_mixed", async () => {
    await set("explore", "gw-x/m2");
    expect(jsonc()["agents"]["explore"]["model"]).toBe(jsonc()["agents"]["librarian"]["model"]);
    expect(jsonc()["agents"]["explore"]["reasoning"]).toBe("medium"); // power untouched by a model pick
    setRaw("agents.librarian.model", "other/m");
    expect((await row("explore")).model).toBe("mixed");
  });

  it("missing_omo_jsonc_is_created_and_commented_one_preserved", async () => {
    fs.rmSync(paths.omoJsonc);
    await set("quick", "gw-x/m1");
    expect(jsonc()["categories"]["quick"]["model"]).toBe("gw-x/m1");
    expect(jsonc()["categories"]["unspecified-low"]["model"]).toBe("gw-x/m1");
    fs.writeFileSync(paths.omoJsonc, '// mine\n{ "telemetry": {"enabled": false}, }\n');
    await set("quick", "gw-x/m2");
    expect(raw()).toContain("// mine");
    expect(jsonc()["telemetry"]).toEqual({ enabled: false });
  });

  it("a_corrupt_file_is_never_overwritten_and_the_view_says_so", async () => {
    fs.writeFileSync(paths.omoJsonc, '{ "agents": ');
    await expect(set("quick", "gw-x/m1")).rejects.toThrow(/omo\.jsonc/);
    await expect(host.view()).rejects.toThrow(/omo\.jsonc/);
    expect(raw()).toBe('{ "agents": ');
  });

  it("five_grid_actions_leave_one_rolling_backup_and_no_timestamped_ones", async () => {
    for (const model of ["gw-x/m1", "gw-x/m2", "gw-x/m1", "gw-x/m2", "gw-x/m1"]) await set("quick", model);
    const names = fs.readdirSync(path.dirname(paths.omoJsonc));
    expect(names.filter((name) => name.startsWith("omo.jsonc.bak-"))).toEqual(["omo.jsonc.bak-agent-tabs"]);
  });

  it("an_action_for_an_unknown_role_or_power_is_refused_by_parse", () => {
    expect(host.parse({ kind: "role.set", id: "nope", model: "a/b" })).toBeUndefined();
    expect(host.parse({ kind: "role.set", id: "quick", reasoning: "max" })).toBeUndefined();
    expect(host.parse({ kind: "role.set", id: "quick" })).toBeUndefined();
    expect(host.parse({ kind: "role.set", id: "quick", model: "gw-x/m1", reasoning: "low" })).toEqual({ kind: "role.set", id: "quick", model: "gw-x/m1", reasoning: "low" });
  });

  it("the_main_agent_writes_a_model_profile_pin_with_its_power_as_the_suffix", async () => {
    await set("main", "gw-x/m2");
    expect(jsonc()["model_profile"]).toBe("gw-x/m2:xhigh"); // the power stays
    await set("main", undefined, "low");
    expect(jsonc()["model_profile"]).toBe("gw-x/m2:low");
    await set("main", "chatgpt-sub/c1", "high");
    expect(jsonc()["model_profile"]).toBe("chatgpt-sub/c1:high");
  });

  it("a_profile_id_is_shown_and_a_model_pick_replaces_it_with_a_pin", async () => {
    setRaw("model_profile", "work");
    const main = await row("main");
    expect(main.profile).toBe("work");
    expect(main.model).toBeUndefined();
    await expect(set("main", undefined, "low")).rejects.toThrow(/модель/);
    expect(jsonc()["model_profile"]).toBe("work");
    await set("main", "gw-x/m1");
    expect(jsonc()["model_profile"]).toBe("gw-x/m1");
    expect((await row("main")).profile).toBeUndefined();
  });

  it("memory_picks_a_category_and_has_no_power", async () => {
    const memory = await row("memory");
    expect(memory.model).toBe("quick");
    expect(memory.categories?.find((item) => item.value === "quick")?.label).toBe("Быстрые задачи — m2 (quick)");
    await set("memory", "writing");
    expect(jsonc()["memory"]["reflection"]["category"]).toBe("writing");
    await expect(set("memory", "not-a-category")).rejects.toThrow();
    expect(host.parse({ kind: "role.set", id: "memory", reasoning: "low" })).toBeUndefined();
  });

  it("a_category_set_by_hand_is_still_the_current_value", async () => {
    setRaw("memory.reflection.category", "my-own");
    const memory = await row("memory");
    expect(memory.model).toBe("my-own");
    expect(memory.categories?.[0]).toEqual({ value: "my-own", label: "my-own" });
  });

  it("an_unset_model_profile_says_to_pick_a_model_first", async () => {
    fs.writeFileSync(paths.omoJsonc, "{}\n");
    await expect(set("main", undefined, "low")).rejects.toThrow("Сначала выберите модель главного агента");
  });

  it("a_level_outside_the_grids_four_is_part_of_the_suffix_not_the_model_id", async () => {
    setRaw("model_profile", "x/y:minimal");
    expect(await row("main")).toMatchObject({ model: "x/y", reasoning: "minimal" });
    await set("main", "gw-x/m2");
    expect(jsonc()["model_profile"]).toBe("gw-x/m2:minimal"); // the power stays
    setRaw("model_profile", "ollama/llama3:8b");
    expect(await row("main")).toMatchObject({ model: "ollama/llama3:8b" }); // ":8b" is no level
    expect((await row("main")).reasoning).toBeUndefined();
  });

  it("memory_defaults_to_quick_when_unset", async () => {
    fs.writeFileSync(paths.omoJsonc, "{}\n");
    expect((await row("memory")).model).toBe("quick");
  });
});

describe("RolesHost view", () => {
  it("options_are_grouped_by_connection_and_hint_names_technical_keys", async () => {
    const shown = await host.view();
    expect(shown.models.map((group) => group.connection)).toEqual(["Шлюз (Anthropic API)", "ChatGPT"]);
    expect((await row("explore")).hint).toBe("explore, librarian");
    expect((await row("quick")).hint).toBe("quick, unspecified-low");
  });

  it("gateway_models_and_omo_models_are_merged_without_duplicates", async () => {
    const shown = await host.view();
    expect(shown.models[0]?.items).toEqual([
      { value: "gw-x/m1", label: "m1" },
      { value: "gw-x/m2", label: "m2" },
      { value: "gw-x/m3", label: "m3", reasoning: true }, // OmO's own word travels with the option
    ]);
    expect(shown.models[1]?.items).toEqual([{ value: "chatgpt-sub/c1", label: "C One", reasoning: false }]);
  });

  it("a_model_that_does_not_think_leaves_the_row_without_a_power", async () => {
    setGatewayModels("gw-x", [{ id: "m1", reasoning: false }, { id: "m2", reasoning: true }]);
    await set("quick", "gw-x/m1", "high");
    expect((await row("quick")).noReasoning).toBe(true);
    await set("quick", "gw-x/m2");
    expect((await makeHost().view()).rows.find((item) => item.id === "quick")?.noReasoning).toBeUndefined();
    await set("quick", "gw-x/nope");
    expect((await makeHost().view()).rows.find((item) => item.id === "quick")?.noReasoning).toBeUndefined();
  });

  it("omos_own_models_mute_the_power_too", async () => {
    await set("quick", "chatgpt-sub/c1");
    expect((await row("quick")).noReasoning).toBe(true);
  });

  it("the_model_options_are_the_grids_for_other_pickers", async () => {
    const options = await host.modelOptions();
    expect(options.map((group) => group.connection)).toEqual(["Шлюз (Anthropic API)", "ChatGPT"]);
    expect(options).toEqual((await host.view()).models);
  });

  it("a_current_model_outside_the_options_is_still_the_rows_value", async () => {
    expect((await row("writing")).model).toBe("gone/model");
  });

  it("an_unreachable_omo_shows_the_gateways_alone_and_says_so", async () => {
    await daemon.stop();
    host = makeHost();
    const shown = await host.view();
    expect(shown.models.map((group) => group.connection)).toEqual(["Шлюз (Anthropic API)"]);
    expect(shown.omoUnavailable).toBe("нет связи с OmO");
    daemon = await FakeDaemon.start(); // afterEach stops it
  });

  it("every_listed_role_is_in_the_grid_in_the_order_of_the_brief", () => {
    expect(ROLE_ROWS.map((role) => role.title)).toEqual([
      "Главный агент", "Ревью плана", "Консультант", "Разведка кода", "Глубокая работа", "Быстрые задачи", "Сложные задачи", "Интерфейсы", "Тексты", "Память",
    ]);
  });
});

describe("a role change reaches the open tabs", () => {
  it("a_performed_role_or_connection_action_announces_new_models", async () => {
    const service = new SettingsService({ name: "second", agentDir: paths.agentDir }, () => undefined);
    service.register(host as never);
    let announced = 0;
    service.on("models", () => void (announced += 1));
    expect(await service.perform("models", { kind: "role.set", id: "quick", model: "gw-x/m1" })).toEqual({ ok: true });
    expect(announced).toBe(1);
    await service.perform("models", { kind: "role.set", id: "nope", model: "x/y" });
    expect(announced).toBe(1); // a refused action changes nothing
    service.register({ section: "connections", parse: () => ({}), view: async () => ({}), perform: async () => undefined });
    await service.perform("connections", {});
    expect(announced).toBe(2);
    service.register({ section: "security", parse: () => ({}), view: async () => ({}), perform: async () => undefined });
    await service.perform("security", {});
    expect(announced).toBe(2); // only models and connections change the model list
  });
});
