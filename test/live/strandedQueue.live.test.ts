import { modelsSource, readLiveKey } from "./config";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-stranded-live";
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const MEMORY_DIR = join(SCRATCH_ROOT, "memory");
const CLAUDE_DIR = join(SCRATCH_ROOT, "claude");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const HAIKU = { provider: "gw-anthropic", id: "claude-haiku-5-5" };
const STRANDED = "Reply with exactly: STRANDED-DELIVERED";

async function until(done: () => boolean, ticks = 400): Promise<boolean> {
  for (let tick = 0; tick < ticks && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 100));
  return done();
}

function userBlock(state: ChatState, text: string): Extract<ChatState["blocks"][number], { kind: "user" }> | undefined {
  const block = state.blocks.find((candidate) => candidate.kind === "user" && candidate.text === text);
  return block?.kind === "user" ? block : undefined;
}

/** The tab's own RPC path, for doing what an older tab (or another client) did: a steer with no `whenIdle`. */
type Raw = { request<T>(type: string, fields?: Record<string, unknown>): Promise<T> };

/**
 * Measured live (omo 5.1.64, scratch agent dir, haiku only). A steer sent with no `whenIdle` to a session whose turn
 * has ended is queued, and nothing ever drains it: `isStreaming` is false while the lifecycle says `running` (queued
 * input counts as work) or `waiting_human` (the reply asked something). A tab opened on that session must deliver the
 * message instead of showing «Работаю…» forever.
 */
describe.skipIf(!LIVE)("a message stranded in OmO's queue (live omo, scratch agent dir)", () => {
  let manager: DaemonManager;
  const tabs: SessionController[] = [];

  beforeAll(async () => {
    await rm(SCRATCH_ROOT, { recursive: true, force: true });
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    for (const dir of [MEMORY_DIR, CLAUDE_DIR, PROJECT_DIR]) await mkdir(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(modelsSource, join(AGENT_DIR, "models.json"));
    await writeFile(
      join(AGENT_DIR, "settings.json"),
      JSON.stringify({ defaultProvider: HAIKU.provider, defaultModel: HAIKU.id, permissionPreset: "full-access" }, null, 2),
    );
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "OMO_MEMORY_HOME", value: MEMORY_DIR },
        { name: "CLAUDE_CONFIG_DIR", value: CLAUDE_DIR },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      join(homedir(), ".local/bin/omo"),
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
  }, 60_000);

  afterAll(async () => {
    for (const tab of tabs) await tab.release();
    manager?.dispose();
    await stopScratchHost(AGENT_DIR);
  }, 30_000);

  it("a_tab_opened_on_it_delivers_the_message_exactly_once", async () => {
    const first = await SessionController.create(manager, PROJECT_DIR);
    tabs.push(first);
    await first.setModel(HAIKU);
    expect(await first.send("Reply with exactly: ok", "auto")).toBe(true);
    expect(await until(() => first.state.blocks.some((block) => block.kind === "assistant") && first.state.running === false, 1200)).toBe(true);

    // What the tab did before 0.4.78 when it misread an ended turn as running: a plain steer.
    const raw = first as unknown as Raw;
    await raw.request("steer", { message: STRANDED, clientMessageId: randomUUID() });
    expect(await until(() => userBlock(first.state, STRANDED)?.delivery?.state === "queued", 150)).toBe(true);
    const stuck = await raw.request<Record<string, any>>("get_state");
    // eslint-disable-next-line no-console
    console.log("[stranded] after a plain steer on an idle session:", JSON.stringify({ lifecycle: stuck["lifecycle"]?.state, isStreaming: stuck["isStreaming"], queued: stuck["ordered"]?.length }));
    expect(stuck["isStreaming"]).toBe(false);
    expect(["running", "waiting_human"]).toContain(stuck["lifecycle"]?.state);
    expect(stuck["ordered"]).toHaveLength(1);

    // The window reloads: a new tab opens the same session.
    const sessionPath = first.tabState.sessionPath as string;
    await first.release();
    tabs.splice(0);
    const second = await SessionController.attach(manager, sessionPath);
    tabs.push(second);
    expect(await until(() => second.state.blocks.some((block) => block.kind === "assistant" && /STRANDED-DELIVERED/.test(block.text)), 1200)).toBe(true);
    expect(await until(() => second.state.running === false, 600)).toBe(true);
    expect(second.state.blocks.some((block) => block.kind === "user" && block.delivery?.state === "queued")).toBe(false);

    const rows = (await readFile(sessionPath, "utf8")).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, any>);
    const delivered = rows.filter((row) => row["type"] === "message" && row["message"]?.role === "user" && JSON.stringify(row["message"]?.content ?? "").includes("STRANDED-DELIVERED"));
    expect(delivered).toHaveLength(1);
  }, 600_000);
});
