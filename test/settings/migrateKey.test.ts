import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvVar, OmoEnv } from "../../src/env";
import { migrateGwApiKey } from "../../src/settings/migrateKey";
import { envPaths, type EnvPaths } from "../../src/settings/paths";

const KEY = "migrated-key-0123456789";
let home: string;
let paths: EnvPaths;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migrate-"));
  const agentDir = path.join(home, ".omo/agent");
  const env: OmoEnv = { env: { OMO_CODING_AGENT_DIR: agentDir }, agentDir, omoPath: "/fake/omo", secrets: [] };
  paths = envPaths(env, home);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    paths.modelsJson,
    JSON.stringify({
      providers: {
        "gw-anthropic": { baseUrl: "http://a", api: "anthropic-messages", apiKey: "$GW_API_KEY", models: [] },
        "gw-openai": { baseUrl: "http://o", api: "openai-completions", apiKey: "GW_API_KEY", models: [] },
        "gw-braces": { baseUrl: "http://b", api: "openai-responses", apiKey: "${GW_API_KEY}", models: [] },
        "gw-env": { baseUrl: "http://e", api: "openai-responses", apiKey: { $env: "GW_API_KEY" }, models: [] },
        other: { baseUrl: "http://x", apiKey: "literal", models: [] },
      },
    }),
  );
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const models = (): { providers: Record<string, { apiKey: unknown }> } => JSON.parse(fs.readFileSync(paths.modelsJson, "utf8")) as never;

describe("migrateGwApiKey", () => {
  it("gw_api_key_moves_to_a_key_file_and_leaves_the_setting", async () => {
    const vars: EnvVar[] = [
      { name: "OMO_CODING_AGENT_DIR", value: paths.agentDir },
      { name: "GW_API_KEY", value: KEY },
    ];
    const update = vi.fn(async (_vars: EnvVar[]) => undefined);
    expect(await migrateGwApiKey(vars, paths, update)).toBe("migrated");
    const keyFile = `${paths.keysDir}/gw.key`;
    expect(fs.readFileSync(keyFile, "utf8")).toBe(KEY);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(models().providers["gw-anthropic"]?.apiKey).toBe(`!cat '${keyFile}'`);
    expect(models().providers["gw-openai"]?.apiKey).toBe(`!cat '${keyFile}'`);
    expect(models().providers["gw-braces"]?.apiKey).toBe(`!cat '${keyFile}'`);
    expect(models().providers["gw-env"]?.apiKey).toBe(`!cat '${keyFile}'`);
    expect(models().providers["other"]?.apiKey).toBe("literal");
    expect(update).toHaveBeenCalledWith(vars.filter((item) => item.name !== "GW_API_KEY"));
    const updatedVars = update.mock.calls[0]?.[0] as EnvVar[];
    expect(await migrateGwApiKey(updatedVars, paths, update)).toBe("none");
    expect(update).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(paths.keysDir)).toEqual(["gw.key"]);
  });

  it("a_crash_before_the_setting_update_is_repaired_by_a_rerun", async () => {
    const vars: EnvVar[] = [{ name: "GW_API_KEY", value: KEY }];
    await expect(migrateGwApiKey(vars, paths, async () => { throw new Error("settings busy"); })).rejects.toThrow("settings busy");
    const update = vi.fn(async (_vars: EnvVar[]) => undefined);
    expect(await migrateGwApiKey(vars, paths, update)).toBe("migrated");
    expect(update).toHaveBeenCalledWith([]);
    expect(models().providers["gw-anthropic"]?.apiKey).toBe(`!cat '${paths.keysDir}/gw.key'`);
  });
});
