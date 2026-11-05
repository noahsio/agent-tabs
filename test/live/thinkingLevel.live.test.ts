import { modelsSource } from "./config";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { ChatPanel, type PanelHost } from "../../src/panel/ChatPanel";
import { applyDelta } from "../../src/panel/delta";
import type { HostMessage, StateMessage } from "../../src/panel/protocol";
import { PanelRegistry } from "../../src/panel/registry";
import { SessionController } from "../../src/sessions/controller";
import { levelToApply, readRememberedLevels, rememberedLevel } from "../../src/sessions/rememberedLevels";
import { stopScratchHost } from "./scratchHost";

vi.mock("vscode", () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.slice(1).join("/") }), parse: (value: string) => value, file: (path: string) => ({ fsPath: path }) },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  window: { showWarningMessage: vi.fn(), createWebviewPanel: vi.fn(), showTextDocument: vi.fn(), tabGroups: { activeTabGroup: { viewColumn: 1 } } },
  workspace: { openTextDocument: vi.fn() },
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
}));

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-live-level"; // its own host
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const FAKE_HOME = join(SCRATCH_ROOT, "home");
const MODELS_SOURCE = modelsSource;
/** The model the profile pins, as the person's own `omo.jsonc` does; no turn ever runs (the token is not real). */
const MODEL = { provider: "gw-anthropic", id: "claude-opus-5-5" };
const PINNED = "high";
const REMEMBERED = "minimal";

/** Enough of a webview for a real ChatPanel: it records the state the composer would show. */
function fakePanel(): { panel: vscode.WebviewPanel; posted: StateMessage[]; receive(raw: unknown): void } {
  const listeners: ((raw: unknown) => void)[] = [];
  const posted: StateMessage[] = [];
  const panel = {
    title: "",
    iconPath: undefined,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (listener: (raw: unknown) => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
      postMessage: async (json: string) => {
        const message = JSON.parse(json) as HostMessage;
        if (message.type === "state") posted.push(message);
        else if (message.type === "delta") posted.push(applyDelta(posted.at(-1) as StateMessage, message));
        return true;
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    reveal: () => undefined,
    viewColumn: 1,
  };
  return { panel: panel as unknown as vscode.WebviewPanel, posted, receive: (raw) => listeners.forEach((listener) => listener(raw)) };
}

function panelHost(manager: DaemonManager): PanelHost {
  return {
    extensionUri: {} as vscode.Uri,
    registry: new PanelRegistry<ChatPanel>(),
    panels: new Set<ChatPanel>(),
    catalog: {},
    updateCatalog: () => undefined,
    onCatalogChange: () => () => undefined,
    secrets: [],
    log: () => undefined,
    daemon: () => ({ ok: true, value: manager }),
    listSessions: async () => [],
    setPinned: async () => undefined,
    setArchived: async () => undefined,
    openSession: async () => undefined,
    newSession: () => undefined,
    restartHost: () => undefined,
    isProjectSession: async () => false,
    showOutput: async () => undefined,
    isPinned: () => false,
    openFork: () => undefined,
    rememberedLevel: (model) => rememberedLevel(readRememberedLevels(AGENT_DIR), model),
  };
}

async function settle(done: () => boolean, ticks = 600): Promise<void> {
  for (let tick = 0; tick < ticks && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe.skipIf(!LIVE)("a model's thinking level across sessions (live omo, scratch agent dir)", () => {
  let manager: DaemonManager;

  beforeAll(async () => {
    await rm(SCRATCH_ROOT, { recursive: true, force: true });
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await mkdir(PROJECT_DIR, { recursive: true });
    await mkdir(join(FAKE_HOME, ".omo"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(MODELS_SOURCE, join(AGENT_DIR, "models.json"));
    // The person's own configuration: the profile pins a level on the model, and OmO remembers another one for it.
    await writeFile(join(FAKE_HOME, ".omo", "omo.jsonc"), JSON.stringify({ model_profile: `${MODEL.provider}/${MODEL.id}:${PINNED}` }, null, 2));
    await writeFile(join(AGENT_DIR, "state.json"), JSON.stringify({ modelThinkingLevels: { [`${MODEL.provider}/${MODEL.id}`]: REMEMBERED } }, null, 2), { mode: 0o600 });
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: FAKE_HOME, DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "GW_API_KEY", value: "not-a-real-token" }, // no model is ever called
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
  }, 120_000);

  afterAll(async () => {
    manager.dispose();
    await stopScratchHost(AGENT_DIR); // only this scratch dir's own host
  }, 30_000);

  it("omo_itself_starts_a_new_session_at_the_pinned_level_not_at_the_remembered_one", async () => {
    const controller = await SessionController.create(manager, PROJECT_DIR);
    const reported = await controller.modelThinkingLevel(MODEL);
    console.log(`LIVE fresh session: model ${JSON.stringify(controller.state.model)}; get_model_thinking_level ${JSON.stringify(reported)}`);
    expect(controller.state.model).toEqual(MODEL);
    expect(readRememberedLevels(AGENT_DIR)[`${MODEL.provider}/${MODEL.id}`]).toBe(REMEMBERED);
    expect(reported).toMatchObject({ level: PINNED, source: "explicit" }); // the profile's pin, not the remembered level
    expect(levelToApply(reported, REMEMBERED)).toBe(REMEMBERED); // so the remembered level is what the session must take
    await controller.release();
  }, 120_000);

  it("a_new_sessions_tab_starts_at_the_level_the_person_last_chose_for_the_model", async () => {
    const host = panelHost(manager);
    const fake = fakePanel();
    ChatPanel.restore(host, fake.panel, { kind: "new", cwd: PROJECT_DIR });
    // The first message creates the session; its turn fails on the unusable token, which the level does not depend on.
    fake.receive({ type: "send", id: randomUUID(), text: "привет", mode: "auto" });
    await settle(() => fake.posted.at(-1)?.tab.sessionPath !== undefined);
    await settle(() => fake.posted.at(-1)?.state.thinkingLevel === REMEMBERED);
    const shown = fake.posted.at(-1);
    console.log(`LIVE new tab: session ${shown?.tab.sessionPath}, composer shows ${shown?.state.thinkingLevel}`);
    expect(shown?.state.model).toEqual(MODEL);
    expect(shown?.state.thinkingLevel).toBe(REMEMBERED); // not the pinned level
    expect(readRememberedLevels(AGENT_DIR)[`${MODEL.provider}/${MODEL.id}`]).toBe(REMEMBERED); // and OmO still remembers it
  }, 180_000);
});
