import { modelsSource, readLiveKey, liveModel } from "./config";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv, type OmoEnv } from "../../src/env";
import { MAX_IMAGE_CHARS, MAX_MESSAGE_IMAGE_CHARS, parseWebviewMessage } from "../../src/panel/protocol";
import { SessionController, type OutgoingImage } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-live-image";
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const MEMORY_DIR = join(SCRATCH_ROOT, "memory");
const CLAUDE_DIR = join(SCRATCH_ROOT, "claude");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const OMO_PATH = join(homedir(), ".local/bin/omo");
const HAIKU = liveModel();

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])));
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, crc]);
}

/** A small solid-red RGB PNG, base64. */
function redPng(size: number): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bit, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(Buffer.from([255, 0, 0]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return png.toString("base64");
}

/** An RGB PNG of random pixels: noise does not compress, so its size is about side² × 3 bytes. */
function noisePng(side: number): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.concat(Array.from({ length: side }, () => Buffer.concat([Buffer.from([0]), randomBytes(side * 3)])));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return png.toString("base64");
}


async function waitFor(controller: SessionController, done: (state: ChatState) => boolean, timeoutMs: number): Promise<ChatState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(controller.state)) return controller.state;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out; last blocks: ${controller.state.blocks.map((block) => block.kind).join(",")} error=${controller.state.error ?? "-"}`);
}

function assistantText(state: ChatState): string {
  return state.blocks.map((block) => (block.kind === "assistant" ? block.text : "")).join("\n");
}

describe.skipIf(!LIVE)("image-only prompt (live omo, scratch agent dir)", () => {
  let manager: DaemonManager;
  let env: OmoEnv;

  beforeAll(async () => {
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await mkdir(MEMORY_DIR, { recursive: true });
    await mkdir(CLAUDE_DIR, { recursive: true });
    await mkdir(PROJECT_DIR, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(modelsSource, join(AGENT_DIR, "models.json"));
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "OMO_MEMORY_HOME", value: MEMORY_DIR },
        { name: "CLAUDE_CONFIG_DIR", value: CLAUDE_DIR },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      OMO_PATH,
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    env = built.value;
    manager = new DaemonManager(env);
  }, 60_000);

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(AGENT_DIR); // only the host this test's scratch dir recorded; never any other omo
  }, 30_000);

  it("accepts_a_message_with_no_text_and_one_image_and_answers", async () => {
    const controller = await SessionController.create(manager, PROJECT_DIR);
    await controller.setModel(HAIKU);
    expect(await controller.send("", "auto", [{ mimeType: "image/png", data: redPng(32), name: "red.png" }])).toBe(true);
    const answered = await waitFor(controller, (state) => assistantText(state).trim() !== "" && !state.running, 120_000);
    expect(answered.error).toBeUndefined();
    expect(answered.blocks.filter((block) => block.kind === "user")).toHaveLength(1);
    await controller.release();
  }, 180_000);

  it("three_images_of_about_11m_chars_are_accepted_and_the_session_reopens_with_them", async () => {
    const images: OutgoingImage[] = [1, 2, 3].map((index) => ({ mimeType: "image/png", data: noisePng(957), name: `noise-${index}.png` }));
    const total = images.reduce((sum, image) => sum + image.data.length, 0);
    console.log(`images: ${images.map((image) => image.data.length).join(" + ")} = ${total} base64 chars`);
    expect(total).toBeGreaterThan(10_500_000);
    expect(total).toBeLessThanOrEqual(MAX_MESSAGE_IMAGE_CHARS);
    for (const image of images) expect(image.data.length).toBeLessThanOrEqual(MAX_IMAGE_CHARS);
    // The same boundary check the panel applies to a webview "send".
    expect(parseWebviewMessage({ type: "send", id: "1", text: "Сколько картинок? Ответь одной цифрой.", mode: "auto", images })).toBeDefined();

    const controller = await SessionController.create(manager, PROJECT_DIR);
    await controller.setModel(HAIKU);
    expect(await controller.send("Сколько картинок? Ответь одной цифрой.", "auto", images)).toBe(true);
    const answered = await waitFor(controller, (state) => assistantText(state).trim() !== "" && !state.running, 180_000);
    expect(answered.error).toBeUndefined();
    console.log(`answer: ${assistantText(answered).trim().slice(0, 80)}`);
    const sessionPath = controller.tabState.sessionPath as string;
    await controller.release();

    // A fresh connection and a fresh controller read the whole journal back, images included.
    const fresh = new DaemonManager(env);
    try {
      const reopened = await SessionController.attach(fresh, sessionPath);
      const user = reopened.state.blocks.find((block) => block.kind === "user");
      expect(user?.kind === "user" ? user.images?.length : 0).toBe(3);
      const refs = user?.kind === "user" ? (user.images ?? []) : [];
      const loaded = await Promise.all(refs.map((ref) => reopened.image(ref.id)));
      expect(loaded.map((image) => image?.data.length)).toEqual(images.map((image) => image.data.length));
      console.log(`reopened: ${reopened.state.blocks.length} blocks, ${refs.length} images restored, error=${reopened.state.error ?? "-"}`);
      await reopened.release();
    } finally {
      fresh.dispose();
    }
  }, 300_000);
});
