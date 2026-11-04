import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnvVar } from "../../src/env";
import { RpcClient } from "../../src/rpc/client";
import { AccountsService } from "../../src/settings/accounts";
import { EnvironmentHost, RESTART_HINT, type EnvironmentAction } from "../../src/settings/environment";
import { envPaths, type EnvPaths } from "../../src/settings/paths";
import { FieldErrors } from "../../src/settings/service";
import { FakeDaemon } from "../helpers/fakeDaemon";

let home: string;
let paths: EnvPaths;
let daemon: FakeDaemon;
let clients: RpcClient[];
let accounts: AccountsService;
/** The VS Code setting `agentTabs.environmentVariables` as a fresh getConfiguration would read it. */
let variables: EnvVar[];
let updates: EnvVar[][];
let restarts: number;
let changes: number;
let host: EnvironmentHost;

function makeHost(): EnvironmentHost {
  return new EnvironmentHost({
    paths,
    readVariables: () => variables,
    writeVariables: async (next) => {
      updates.push(next);
      variables = next;
    },
    restartHost: () => void (restarts += 1),
    omoVersion: () => accounts.omoVersion(),
    changed: () => void (changes += 1),
    log: () => undefined,
  });
}

function parsed(raw: Record<string, unknown>): EnvironmentAction {
  const action = host.parse(raw);
  if (action === undefined) throw new Error(`refused: ${JSON.stringify(raw)}`);
  return action;
}

async function settle(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 400 && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-env-"));
  const agentDir = path.join(home, "agent");
  variables = [
    { name: "OMO_CODING_AGENT_DIR", value: agentDir },
    { name: "OMO_MEMORY_HOME", value: "~/memory" },
    { name: "OTHER", value: "keep" },
  ];
  paths = envPaths({ env: Object.fromEntries(variables.map((item) => [item.name, item.value])), agentDir, omoPath: "/fake/omo", secrets: [] }, home);
  fs.mkdirSync(paths.pluginDir, { recursive: true });
  daemon = await FakeDaemon.start();
  clients = [];
  updates = [];
  restarts = 0;
  changes = 0;
  daemon.on("open_session", () => ({ data: { sessionId: "svc-1", state: { sessionFile: "/sessions/svc.jsonl" } } }));
  daemon.on("close_session", () => ({}));
  daemon.on("get_protocol_info", () => ({ data: { protocolVersion: 1, serverVersion: "5.1.59", engineVersion: "5.1.59" } }));
  accounts = new AccountsService({
    connect: async () => {
      const client = await RpcClient.connect(daemon.socketPath, daemon.agentDir);
      clients.push(client);
      return client;
    },
    pluginDir: paths.pluginDir,
    openExternal: () => undefined,
    log: () => undefined,
  });
  host = makeHost();
});

afterEach(async () => {
  await accounts.dispose();
  for (const client of clients) client.close();
  await daemon.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("EnvironmentHost", () => {
  it("the_view_shows_the_folders_and_the_omo_version_and_needs_no_restart", async () => {
    const view = await host.view();
    expect(view).toEqual({
      folders: { agentDir: paths.agentDir, memoryHome: "~/memory", claudeDir: path.join(home, ".claude") },
      omoVersion: "5.1.59",
      restartNeeded: false,
      restartHint: RESTART_HINT,
    });
    expect(RESTART_HINT).toBe("Перезапустить OmO — нужно после смены папок");
  });

  it("folder_change_updates_the_vscode_setting_and_asks_for_restart", async () => {
    await host.perform(parsed({ kind: "folder.set", which: "claudeDir", path: " ~/.cache/claude " }));
    expect(updates).toEqual([
      [
        { name: "OMO_CODING_AGENT_DIR", value: paths.agentDir },
        { name: "OMO_MEMORY_HOME", value: "~/memory" },
        { name: "OTHER", value: "keep" },
        { name: "CLAUDE_CONFIG_DIR", value: "~/.cache/claude" },
      ],
    ]);
    const view = await host.view();
    expect(view.restartNeeded).toBe(true);
    expect(view.folders.claudeDir).toBe("~/.cache/claude");

    await host.perform(parsed({ kind: "folder.set", which: "memoryHome", path: "/data/memory" }));
    expect(updates.at(-1)?.find((item) => item.name === "OMO_MEMORY_HOME")?.value).toBe("/data/memory");
    // set back to what the running OmO uses: no restart needed for that folder
    await host.perform(parsed({ kind: "folder.set", which: "claudeDir", path: path.join(home, ".claude") }));
    await host.perform(parsed({ kind: "folder.set", which: "memoryHome", path: "~/memory" }));
    expect((await host.view()).restartNeeded).toBe(false);
  });

  it("a_relative_or_empty_folder_is_refused", async () => {
    expect(host.parse({ kind: "folder.set", which: "agentDir", path: "" })).toBeUndefined();
    expect(host.parse({ kind: "folder.set", which: "nope", path: "/x" })).toBeUndefined();
    await expect(host.perform({ kind: "folder.set", which: "agentDir", path: "relative/dir" })).rejects.toThrow(FieldErrors);
    expect(updates).toEqual([]);
  });

  it("restart_uses_the_windows_restart_command", async () => {
    await host.perform(parsed({ kind: "restart" }));
    expect(restarts).toBe(1);
  });

  it("an_unreachable_omo_never_blocks_the_view_and_a_late_version_reposts_it", async () => {
    let answer: (() => void) | undefined;
    daemon.on("get_protocol_info", () => new Promise((resolve) => (answer = () => resolve({ data: { serverVersion: "5.1.60" } }))));
    const started = Date.now();
    const view = await host.view();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(view.omoVersion).toBeUndefined();
    expect(view.omoUnavailable).toBe("нет связи с OmO");
    await settle(() => answer !== undefined);
    answer?.();
    await settle(() => changes === 1);
    expect((await host.view()).omoVersion).toBe("5.1.60");
  });
});
