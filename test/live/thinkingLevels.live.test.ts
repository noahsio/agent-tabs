import { modelsSource } from "./config";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-live-levels"; // its own host; the person's agent dir is never touched
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const FAKE_HOME = join(SCRATCH_ROOT, "home");
/** The person's own catalogue, read once and copied: the scratch host answers about the very same entries. */
const MODELS_SOURCE = modelsSource;
const PROVIDER = "gw-anthropic";
/** `reasoning: true` in the catalogue. */
const THINKER = { provider: PROVIDER, id: "claude-sonnet-5-5" };
/** No capability fields at all — the entry the gateway sync wrote from an OpenAI-style `/models` list. */
const BARE = { provider: PROVIDER, id: "claude-opus-5" };
/** `reasoning: false`: a model the catalogue says cannot think. */
const FLAT = { provider: PROVIDER, id: "claude-haiku-5-5" };
/** The same bare entry as the fixed sync writes it: nobody said anything, so it is marked thinking. */
const FIXED = { provider: PROVIDER, id: "probe-fixed" };

type Answer = { levels: string[]; level?: string; source?: string; availableLevels?: string[] };

describe.skipIf(!LIVE)("what omo answers about a model's thinking levels (live omo, scratch agent dir)", () => {
  let manager: DaemonManager;
  const answers = new Map<string, Answer>();
  const modelEvents: string[] = [];

  beforeAll(async () => {
    await rm(SCRATCH_ROOT, { recursive: true, force: true });
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await mkdir(PROJECT_DIR, { recursive: true });
    await mkdir(join(FAKE_HOME, ".omo"), { recursive: true });
    // The person's catalogue, plus the fixed sync's own output for the bare entry, so one host answers about both.
    const catalogue = JSON.parse(await readFile(MODELS_SOURCE, "utf8")) as { providers: Record<string, { models: unknown[] }> };
    const provider = catalogue.providers[PROVIDER] as { models: unknown[] };
    provider.models = [...provider.models, { id: FIXED.id, name: "Probe Fixed", reasoning: true }];
    await writeFile(join(AGENT_DIR, "models.json"), JSON.stringify(catalogue, null, 2));
    await writeFile(join(FAKE_HOME, ".omo", "omo.jsonc"), JSON.stringify({ telemetry: { enabled: false } }, null, 2));
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

    const controller = await SessionController.create(manager, PROJECT_DIR);
    controller.on("model", () => modelEvents.push(controller.state.model?.id ?? "?"));
    for (const model of [THINKER, BARE, FLAT, FIXED]) {
      await controller.setModel(model);
      await new Promise((resolve) => setTimeout(resolve, 150)); // let the host's own model_changed arrive
      const reported = await controller.modelThinkingLevel(model);
      answers.set(model.id, { levels: await controller.thinkingLevels(), ...reported });
    }
    await controller.release();
    console.log(`LIVE levels: ${JSON.stringify([...answers], null, 2)}`);
    console.log(`LIVE model_changed frames: ${JSON.stringify(modelEvents)}`);
  }, 180_000);

  afterAll(async () => {
    manager.dispose();
    await stopScratchHost(AGENT_DIR);
  }, 30_000);

  it("a_catalogue_entry_without_reasoning_is_answered_exactly_like_one_that_cannot_think", () => {
    expect((answers.get(THINKER.id)?.levels ?? []).length).toBeGreaterThan(1); // reasoning: true — a real ladder
    expect(answers.get(BARE.id)?.levels).toEqual(["off"]); // no capability field at all — one dead step
    expect(answers.get(FLAT.id)?.levels).toEqual(["off"]); // and indistinguishable from a model that truly cannot think
  });

  /**
   * One word in the catalogue is the whole difference, and OmO alone decides how many steps the ladder has: an id it
   * does not know gets five, `claude-sonnet-5-5` seven. It also starts such a model at its own default — `medium`, not
   * `off` — which is the point of the fix: the levels are offered *and* the model thinks.
   */
  it("marking_the_bare_entry_as_thinking_is_all_omo_needs", () => {
    expect(answers.get(FIXED.id)?.levels).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(answers.get(FIXED.id)?.availableLevels).toEqual(answers.get(FIXED.id)?.levels); // the per-model answer agrees
    expect(answers.get(FIXED.id)?.level).toBe("medium"); // OmO's own default for a thinking model
    expect(answers.get(FIXED.id)?.source).toBe("default"); // nobody pinned it; `off` is still step 0 of the ladder
  });

  it("the_list_is_the_sessions_current_models_and_the_host_announces_every_switch", () => {
    expect(answers.get(THINKER.id)?.levels).not.toEqual(answers.get(BARE.id)?.levels); // one session, one list per model
    expect(modelEvents).toEqual([THINKER.id, BARE.id, FLAT.id, FIXED.id]); // so a client can refetch on each
  });

  /** When the catalogue is repaired matters: a host that is already up keeps the capabilities it started with. */
  it("a_running_host_does_not_pick_up_a_repaired_catalogue", async () => {
    const file = join(AGENT_DIR, "models.json");
    const catalogue = JSON.parse(await readFile(file, "utf8")) as { providers: Record<string, { models: Record<string, unknown>[] }> };
    const models = catalogue.providers[PROVIDER]?.models as Record<string, unknown>[];
    (models.find((model) => model["id"] === BARE.id) as Record<string, unknown>)["reasoning"] = true;
    await writeFile(file, JSON.stringify(catalogue, null, 2));
    const controller = await SessionController.create(manager, PROJECT_DIR);
    await controller.setModel(BARE);
    const levels = await controller.thinkingLevels();
    await controller.release();
    console.log(`LIVE after a live catalogue repair, same host: ${JSON.stringify(levels)}`);
    expect(levels).toEqual(["off"]); // the repair lands on the next host start, not on the next session
  }, 120_000);
});
