import { sourceEnv, modelsSource, readLiveKey, liveModel } from "./config";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { MessageActions } from "../../src/panel/messageActions";
import { Checkpointer } from "../../src/rewind/checkpointer";
import type { ForkDraft } from "../../src/rewind/fork";
import { CheckpointStore } from "../../src/rewind/store";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const HAIKU = liveModel();
const ROLES = ["explore", "librarian", "plan-consultant", "plan-reviewer", "sisyphus-junior", "oracle", "metis", "momus"];
const CATEGORIES = ["deep-low", "deep-high", "quick", "ultrabrain", "unspecified-low", "unspecified-high", "artistry", "architect", "visual-engineering", "writing"];

async function waitFor(controller: SessionController, done: (state: ChatState) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(controller.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out; error=${controller.state.error ?? "-"}`);
}

describe.runIf(LIVE)("fork and rewind (live omo, scratch agent dir, haiku only)", () => {
  // Under /tmp, not $TMPDIR: macOS's long $TMPDIR makes the host socket path exceed the unix-socket limit.
  const root = LIVE ? realpathSync(mkdtempSync("/tmp/agent-tabs-live-fork-")) : "";
  const agentDir = join(root, "agent");
  const project = join(root, "proj");
  let manager: DaemonManager;
  let store: CheckpointStore;
  let checkpointer: Checkpointer;

  beforeAll(() => {
    chmodSync(root, 0o700);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    copyFileSync(modelsSource, join(agentDir, "models.json"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: HAIKU.provider, defaultModel: HAIKU.id, permissionPreset: "full-access" }));
    mkdirSync(join(project, ".omo"), { recursive: true });
    const pin = { model: `${HAIKU.provider}/${HAIKU.id}`, reasoning: "low" };
    writeFileSync(
      join(project, ".omo", "omo.jsonc"),
      JSON.stringify({
        model_profile: pin.model,
        telemetry: { enabled: false },
        agents: Object.fromEntries(ROLES.map((name) => [name, pin])),
        categories: Object.fromEntries(CATEGORIES.map((name) => [name, pin])),
      }),
    );
    writeFileSync(join(project, ".gitignore"), ".omo/\n");
    writeFileSync(join(project, "README.md"), "scratch\n");
    const git = (...args: string[]): void => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@l", "-c", "commit.gpgsign=false", ...args], { cwd: project });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: agentDir },
        { name: "CLAUDE_CONFIG_DIR", value: sourceEnv.claudeDir },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
    store = new CheckpointStore(agentDir);
    checkpointer = new Checkpointer({ store, agentDir });
  }, 60_000);

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(agentDir); // only this scratch dir's own host
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("live_prompt_snapshot_rewind_and_fork", async () => {
    const source = await SessionController.create(manager, project, undefined, checkpointer);
    await source.setModel(HAIKU);
    expect(source.state.model).toEqual(HAIKU); // never prompt anything but haiku
    let replaced = 0;
    (await manager.client()).on("frame", (frame: Record<string, unknown>) => {
      if (frame["type"] === "session_replaced") replaced++;
    });
    expect(await source.send("Use the write tool to create note.txt with content: one. Reply done.", "auto")).toBe(true);
    await waitFor(source, (state) => state.running, 60_000);
    await waitFor(source, (state) => !state.running, 180_000);
    expect(existsSync(join(project, "note.txt"))).toBe(true);
    const user = source.state.blocks.find((block) => block.kind === "user");
    const blockId = user?.id as string;
    expect((await store.read(source.sessionUuid as string)).points.get(blockId)).toBeDefined();

    const opened: [string, ForkDraft | undefined][] = [];
    const actions = new MessageActions({ controller: source, checkpointer, runningCwds: async () => [], openFork: (path, draft) => opened.push([path, draft]) });
    const preview = await actions.preview(blockId, false);
    expect(preview).toMatchObject({ ok: true, items: [{ path: "note.txt", action: "delete", changed: "no" }] });
    expect((await actions.rewind(blockId, false, preview.ok ? preview.fingerprint : "")).rewound).toMatchObject({ ok: true, count: 1 });
    expect(existsSync(join(project, "note.txt"))).toBe(false);

    expect(await actions.fork(blockId)).toEqual({ ok: true });
    const [[forkPath, draft]] = opened as [[string, ForkDraft]];
    expect(draft.text).toContain("note.txt");
    const fork = await SessionController.attach(manager, forkPath, undefined, undefined, checkpointer);
    expect(fork.state.blocks.some((block) => block.kind === "user")).toBe(false);
    expect(replaced).toBe(0);
    await fork.release();
    await source.release();
  }, 600_000);
});
