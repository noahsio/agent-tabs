import { sourceEnv, modelsSource, readLiveKey, liveModel } from "./config";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { Checkpointer } from "../../src/rewind/checkpointer";
import { CheckpointStore } from "../../src/rewind/store";
import type { RpcClient } from "../../src/rpc/client";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
/** Also times send → visible for each way a message leaves (writes /tmp/agent-tabs-latency.json). */
const MEASURE = process.env["AGENT_TABS_MEASURE"] === "1";
/** With the person's own prompt hooks (codegraph), re-trusted for the scratch path as kit/verify-omo.mjs does. */
const WITH_HOOKS = process.env["AGENT_TABS_MEASURE_HOOKS"] === "1";
const HAIKU = liveModel();
const LONG_TURN = "Use the bash tool to run `sleep 15`, then reply with exactly: slept.";

async function waitFor(controller: SessionController, done: (state: ChatState) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(controller.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out; error=${controller.state.error ?? "-"}`);
}

function userBlock(state: ChatState, text: string): Extract<ChatState["blocks"][number], { kind: "user" }> | undefined {
  const block = state.blocks.find((candidate) => candidate.kind === "user" && candidate.text === text);
  return block?.kind === "user" ? block : undefined;
}

/** Times from `send()` to: each request written / answered, the frames naming the message, and its block in ChatState. */
async function measure(client: RpcClient, controller: SessionController, text: string, mode: "auto" | "followUp"): Promise<Record<string, number | string>> {
  const t0 = performance.now();
  const at = (): number => Math.round(performance.now() - t0);
  const marks: Record<string, number | string> = {};
  const original = client.request.bind(client);
  (client as { request: RpcClient["request"] }).request = ((type: string, fields: Record<string, unknown> = {}, timeout?: number) => {
    marks[`req:${type}`] ??= at();
    const answer = original(type, fields, timeout);
    answer.then(
      (data) => {
        marks[`res:${type}`] ??= at();
        const disposition = (data as Record<string, unknown> | undefined)?.["disposition"];
        if (typeof disposition === "string") marks[`disposition:${type}`] = disposition;
      },
      (error: unknown) => (marks[`err:${type}`] ??= `${at()} ${String(error)}`),
    );
    return answer;
  }) as RpcClient["request"];
  const onFrame = (frame: Record<string, any>): void => {
    if (frame["type"] === "queue_update" && JSON.stringify(frame["ordered"] ?? []).includes(text)) marks["frame:queue_update"] ??= at();
    if (frame["type"] === "message_start" && frame["message"]?.role === "user") marks["frame:user_message_start"] ??= at();
  };
  client.on("frame", onFrame);
  const onChange = (state: ChatState): void => {
    const block = userBlock(state, text);
    if (block !== undefined) marks[`state:${block.delivery?.state ?? "in_conversation"}`] ??= at();
  };
  controller.on("change", onChange);
  const sent = controller.send(text, mode);
  marks["sendReturned"] = `${String(await sent)}@${at()}`;
  await waitFor(controller, (state) => userBlock(state, text)?.delivery === undefined, 120_000);
  controller.off("change", onChange);
  client.off("frame", onFrame);
  (client as { request: RpcClient["request"] }).request = original;
  return marks;
}

describe.runIf(LIVE || MEASURE)("sending and the queue (live omo, scratch agent dir, haiku only)", () => {
  // Under /tmp, not $TMPDIR: macOS's long $TMPDIR makes the host socket path exceed the unix-socket limit.
  const root = LIVE || MEASURE ? realpathSync(mkdtempSync("/tmp/agent-tabs-live-queue-")) : "";
  const agentDir = join(root, "agent");
  const gitProject = join(root, "proj");
  const plainProject = join(root, "plain");
  let manager: DaemonManager;
  let checkpointer: Checkpointer;

  beforeAll(async () => {
    chmodSync(root, 0o700);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    copyFileSync(modelsSource, join(agentDir, "models.json"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: HAIKU.provider, defaultModel: HAIKU.id, permissionPreset: "full-access" }));
    if (WITH_HOOKS) {
      const hooksFile = join(agentDir, "hooks.json");
      copyFileSync(join(sourceEnv.agentDir, "hooks.json"), hooksFile);
      const { buildHooksState } = await import("../../kit/lib/trust.mjs" as string);
      const kitMarker = join(homedir(), ".omo/kit") + "/";
      const state = buildHooksState(JSON.parse(readFileSync(hooksFile, "utf8")), hooksFile, {}, undefined, { isOwn: (command: string) => command.includes(kitMarker) });
      writeFileSync(join(agentDir, "hooks-state.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    }
    for (const project of [gitProject, plainProject]) {
      mkdirSync(join(project, ".omo"), { recursive: true });
      writeFileSync(join(project, ".omo", "omo.jsonc"), JSON.stringify({ model_profile: `${HAIKU.provider}/${HAIKU.id}`, telemetry: { enabled: false } }));
      writeFileSync(join(project, "README.md"), "scratch\n");
    }
    writeFileSync(join(gitProject, ".gitignore"), ".omo/\n");
    const git = (...args: string[]): void => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@l", "-c", "commit.gpgsign=false", ...args], { cwd: gitProject });
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
    checkpointer = new Checkpointer({ store: new CheckpointStore(agentDir), agentDir });
  }, 60_000);

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(agentDir); // only this scratch dir's own host
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it.runIf(LIVE)("live_a_queued_message_is_shown_at_once_edited_and_taken_back_before_the_agent_sees_it", async () => {
    const controller = await SessionController.create(manager, gitProject, undefined, checkpointer);
    await controller.setModel(HAIKU);
    expect(controller.state.model).toEqual(HAIKU); // never prompt anything but haiku
    expect(await controller.send(LONG_TURN, "auto")).toBe(true);
    await waitFor(controller, (state) => state.activity === "tool", 120_000);

    const taken = "Then reply with exactly: TAKEN-BACK";
    const sending = controller.send(taken, "followUp");
    expect(userBlock(controller.state, taken)?.delivery).toEqual({ state: "sending" }); // in the feed before any answer
    expect(await sending).toBe(true);
    await waitFor(controller, (state) => userBlock(state, taken)?.delivery?.state === "queued", 10_000);

    const kept = "Then reply with exactly: KEPT";
    expect(await controller.send(kept, "followUp")).toBe(true);
    await waitFor(controller, (state) => userBlock(state, kept)?.delivery?.state === "queued", 10_000);
    const keptId = userBlock(controller.state, kept)?.id as string;
    expect(await controller.editQueued(keptId, "Then reply with exactly: EDITED")).toEqual({ outcome: "edited" });
    expect(userBlock(controller.state, "Then reply with exactly: EDITED")?.delivery?.state).toBe("queued");

    const takenId = userBlock(controller.state, taken)?.id as string;
    expect(await controller.dequeue(takenId)).toEqual({ outcome: "removed", text: taken, images: [] });
    expect(userBlock(controller.state, taken)).toBeUndefined();

    await waitFor(controller, (state) => userBlock(state, "Then reply with exactly: EDITED")?.delivery === undefined, 180_000);
    await waitFor(controller, (state) => !state.running, 180_000);
    const { entries } = await controller.journal();
    const said = JSON.stringify(entries.filter((entry) => entry["type"] === "message")); // OmO's own bookkeeping records the removed input too
    expect(said).not.toContain("TAKEN-BACK"); // the agent never saw it
    expect(said).toContain("EDITED");
    expect(said).not.toContain("exactly: KEPT");
    expect(await controller.dequeue(keptId)).toEqual({ outcome: "delivered" }); // too late now
    await controller.release();
  }, 600_000);

  it.runIf(MEASURE)("measures_send_to_visible", async () => {
    const spawnedAt = performance.now();
    const client = await manager.client();
    const results: Record<string, unknown> = { "host cold start + connect": Math.round(performance.now() - spawnedAt) };
    for (const [name, cwd] of [
      ["git", gitProject],
      ["plain", plainProject],
    ] as const) {
      const createdAt = performance.now();
      const controller = await SessionController.create(manager, cwd, undefined, checkpointer);
      results[`create ${name}`] = Math.round(performance.now() - createdAt);
      await controller.setModel(HAIKU);
      results[`a/b ${name} idle prompt #1`] = await measure(client, controller, `Reply with exactly: one-${name}`, "auto");
      await waitFor(controller, (state) => !state.running, 120_000);
      results[`a/b ${name} idle prompt #2`] = await measure(client, controller, `Reply with exactly: two-${name}`, "auto");
      await waitFor(controller, (state) => !state.running, 120_000);
      if (name === "git") {
        await controller.send(LONG_TURN, "auto");
        await waitFor(controller, (state) => state.activity === "tool", 120_000);
        results["c steer while running"] = await measure(client, controller, "Also add the word STEERED at the end.", "auto");
        await waitFor(controller, (state) => !state.running, 180_000);
        await controller.send(LONG_TURN, "auto");
        await waitFor(controller, (state) => state.activity === "tool", 120_000);
        results["d follow_up while running"] = await measure(client, controller, "Then reply with exactly: FOLLOWED", "followUp");
        await waitFor(controller, (state) => !state.running, 180_000);
      } else {
        // a second message typed right after an idle prompt: it waits for the prompt's answer, then steers its turn
        const first = controller.send("Use the bash tool to run `sleep 5`, then reply with exactly: ok.", "auto");
        await new Promise((resolve) => setTimeout(resolve, 5));
        results["e second message right after a prompt"] = await measure(client, controller, "Also say BACK-TO-BACK.", "auto");
        await first;
        await waitFor(controller, (state) => !state.running, 180_000);
      }
      await controller.release();
    }
    writeFileSync("/tmp/agent-tabs-latency.json", JSON.stringify(results, null, 2));
  }, 900_000);
});
