import { modelsSource, readLiveKey } from "./config";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv, type OmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { instantDeadTurn, systemAbortStall } from "../../src/sessions/liveness";
import { stopScratchHost } from "./scratchHost";

/**
 * The turn OmO itself kills, against a real host.
 *
 * `fixtures/killFirstRequest.ts` is loaded as a scratch-host extension and calls the in-process extension API's
 * `abort("system")` from `before_provider_request` — one of the three callers in the binary that pass that provenance,
 * and the only one a test can reach. It kills the scratch agent dir's **first** provider request and nothing after it.
 *
 * What that produces on OmO 5.1.59, measured: an assistant message with `stopReason: "aborted"`, one empty text part
 * and `endedAt − requestedAt` of 16 ms, plus the entry `turn-end-liveness` with verdict
 * `{kind: "stalled", reason: "aborted", abortSource: "system"}` — the shape of all four rows in the person's journal.
 * The tab then has to recognise it, say so, and put the message back in. Run with `AGENT_TABS_LIVE=1`.
 */
const LIVE = process.env["AGENT_TABS_LIVE"] === "1";

const SCRATCH_ROOT = "/tmp/agent-tabs-liveness-live";
const AGENT_DIR = join(SCRATCH_ROOT, "agent");
const MEMORY_DIR = join(SCRATCH_ROOT, "memory");
const CLAUDE_DIR = join(SCRATCH_ROOT, "claude");
const PROJECT_DIR = join(SCRATCH_ROOT, "proj");
const MODELS_SOURCE = modelsSource;
const OMO_PATH = join(homedir(), ".local/bin/omo");
const DUMP = join(SCRATCH_ROOT, "shape.json");
const KILLER = join(import.meta.dirname, "fixtures/killFirstRequest.ts");
const MARKER = join(SCRATCH_ROOT, "killed");

/** OmO's own line when the session is unloaded and opened again — one per restart, so they can be counted. */
const REOPENED = "Сессия выгружена — открываю заново";

async function sessionFile(): Promise<string> {
  const root = join(AGENT_DIR, "sessions");
  const found: string[] = [];
  for (const dir of await readdir(root)) {
    const files = (await readdir(join(root, dir)).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
    for (const file of files) found.push(join(root, dir, file));
  }
  const newest = found.sort().at(-1);
  if (newest === undefined) throw new Error("no scratch session file");
  return newest;
}

async function entries(): Promise<Record<string, any>[]> {
  const text = await readFile(await sessionFile(), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
}

/** Every notice line the feed holds. */
function notices(controller: SessionController): string[] {
  return controller.state.blocks.flatMap((block) => (block.kind === "notice" ? [block.text] : []));
}

/** Whether the conversation holds an assistant answer with words in it. */
function answered(controller: SessionController): boolean {
  return controller.state.blocks.some((block) => block.kind === "assistant" && block.text.trim() !== "");
}

async function until(done: () => boolean, ticks = 600): Promise<void> {
  for (let tick = 0; tick < ticks && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(done()).toBe(true);
}

describe.skipIf(!LIVE)("a turn OmO killed by itself (live omo, scratch agent dir)", () => {
  let omoEnv: OmoEnv;
  let manager: DaemonManager;
  let controller: SessionController | undefined;

  beforeAll(async () => {
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    for (const dir of [MEMORY_DIR, CLAUDE_DIR, PROJECT_DIR]) await mkdir(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: PROJECT_DIR, stdio: "ignore" });
    await copyFile(MODELS_SOURCE, join(AGENT_DIR, "models.json"));
    await writeFile(join(AGENT_DIR, "settings.json"), JSON.stringify({ extensions: [KILLER] }, null, 2));
    await rm(MARKER, { force: true });
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "OMO_MEMORY_HOME", value: MEMORY_DIR },
        { name: "CLAUDE_CONFIG_DIR", value: CLAUDE_DIR },
        { name: "OMO_TEST_KILL_MARKER", value: MARKER },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      OMO_PATH,
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    omoEnv = built.value;
    manager = new DaemonManager(omoEnv);
  }, 60_000);

  afterAll(async () => {
    await controller?.release();
    manager?.dispose();
    await stopScratchHost(AGENT_DIR);
  }, 30_000);

  it("is_recognised_on_the_real_records_and_the_message_goes_back_in", async () => {
    controller = await SessionController.create(manager, PROJECT_DIR);
    const tab = controller;
    // The tab must never be left claiming it works: this is its own state at the moment it says the turn was killed.
    let runningWhenTold: boolean | undefined;
    tab.on("change", (state: { running: boolean; blocks: { kind: string; text?: string }[] }) => {
      if (runningWhenTold !== undefined) return;
      if (state.blocks.some((block) => block.kind === "notice" && block.text?.startsWith("OmO оборвал ход сам") === true)) runningWhenTold = state.running;
    });
    await tab.send("Ответь одним словом: привет.", "auto");
    await until(() => notices(tab).some((text) => text.startsWith("OmO оборвал ход сам")));
    await until(() => answered(tab)); // the recovery's own resend, answered

    const rows = await entries();
    const aborted = rows.flatMap((entry) =>
      entry["type"] === "message" && entry["message"]?.role === "assistant" && entry["message"].stopReason === "aborted" ? [entry["message"] as Record<string, any>] : [],
    );
    const stalls = rows.flatMap((entry) => (entry["customType"] === "turn-end-liveness" ? [entry["data"]] : []));
    const admitted = [...new Set(rows.flatMap((entry) => (entry["customType"] === "rpc_client_message_admission" ? [String(entry["data"]?.clientMessageId)] : [])))];
    const read = rows.flatMap((entry) => {
      const work = systemAbortStall(entry);
      return work === undefined ? [] : [work];
    });

    await writeFile(
      DUMP,
      JSON.stringify(
        {
          aborted,
          durations: aborted.map((message) => (message["timing"]?.endedAt ?? 0) - (message["timing"]?.requestedAt ?? 0)),
          stalls,
          lastTurnEnd: rows.flatMap((entry) => (entry["data"]?.lastTurnEnd !== undefined ? [entry["data"].lastTurnEnd] : [])),
          admitted,
          runningWhenTold,
          running: tab.state.running,
          notices: notices(tab),
        },
        null,
        2,
      ),
    );

    // 1. OmO wrote both records of the shape, and they are the ones the person's journal holds
    expect(stalls).toMatchObject([{ verdict: { kind: "stalled", reason: "aborted", abortSource: "system" } }]);
    expect(aborted).toHaveLength(1);

    // 2. our two readers fire on those very records, off the typed fields alone
    expect(read).toEqual([{ kind: "none" }]);
    expect(aborted.filter((message) => instantDeadTurn(message))).toHaveLength(1);

    // 3. and the tab did what it says: one restart, the message admitted again under a new id, an answer, no «Работаю…»
    expect(notices(tab).filter((text) => text === REOPENED)).toHaveLength(1);
    expect(admitted).toHaveLength(2);
    expect(notices(tab)).toContain("Перезапустил сессию и отправил сообщение заново");
    expect(runningWhenTold).toBe(false);
  }, 180_000);
});
