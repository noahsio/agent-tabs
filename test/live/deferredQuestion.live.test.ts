import { modelsSource, readLiveKey, sourceEnv } from "./config";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { SessionController } from "../../src/sessions/controller";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const MODELS = [
  { provider: "gw-openai", id: "gpt-6-astra" },
  { provider: "gw-anthropic", id: "claude-opus-5-5" },
];

/** The rule the plugin will hand its host (spec 2026-11-08 §5); here it rides in the prompt to measure the models first. */
const RULE = [
  "Autonomy rule: the person may be away for hours.",
  "When a question to the person times out, or the person defers it, do not stop and do not ask again:",
  "take the recommended option, state the assumption in one line starting with 'Assumption:', and carry on.",
  "A deferred answer may arrive later as a normal message; then check your assumption and redo what it changed.",
  "Never act on an assumption for anything irreversible (deploy, delete, push, payments, messages to people): leave it and do other work.",
].join(" ");

const TASK = [
  RULE,
  "Task: in the current folder create plan.md with a three-line plan for a small todo CLI.",
  "Before choosing the storage, ask me exactly one question with the ask_user_question tool:",
  'header "Хранилище", question "Где хранить задачи?", options "JSON-файл" (recommended) and "SQLite", waitForAnswer: true.',
  "Then write plan.md with the storage you ended up with, and finish with one short line.",
].join(" ");

async function waitFor(controller: SessionController, done: (state: ChatState) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(controller.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out; error=${controller.state.error ?? "-"}`);
}

function lastAssistant(state: ChatState): string {
  const blocks = state.blocks.filter((block): block is Extract<Block, { kind: "assistant" }> => block.kind === "assistant");
  return blocks.at(-1)?.text ?? "";
}

function questionResult(state: ChatState): string {
  const tool = state.blocks.find((block) => block.kind === "tool" && /ask_user_question|request_user_input/.test(block.name));
  return tool?.kind === "tool" ? JSON.stringify(tool).slice(0, 700) : "(no question tool block)";
}

const finished = (state: ChatState): boolean => !state.running && state.dialogs.length === 0 && lastAssistant(state) !== "";

describe.runIf(LIVE)("a question nobody answers does not stop the agent (live omo, scratch agent dir)", () => {
  const root = LIVE ? realpathSync(mkdtempSync("/tmp/agent-tabs-live-defer-")) : "";
  const agentDir = join(root, "agent");
  let manager: DaemonManager;

  beforeAll(() => {
    chmodSync(root, 0o700);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    copyFileSync(modelsSource, join(agentDir, "models.json"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ permissionPreset: "full-access", askUser: { timeoutMinutes: 1 } }));
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
  }, 60_000);

  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(agentDir);
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  async function session(model: { provider: string; id: string }, name: string): Promise<{ controller: SessionController; project: string }> {
    const project = join(root, `${name}-${model.id}`);
    mkdirSync(project, { recursive: true });
    const controller = await SessionController.create(manager, project, undefined, undefined);
    await controller.setModel(model);
    return { controller, project };
  }

  it.concurrent.each(MODELS)("live_timed_out_question_then_a_late_answer: $id", async (model) => {
    const { controller, project } = await session(model, "timeout");
    expect(await controller.send(TASK, "auto")).toBe(true);
    await waitFor(controller, (state) => state.dialogs.length > 0, 240_000);
    const asked = Date.now();
    await waitFor(controller, finished, 300_000); // nobody answers: OmO times it out after a minute
    const plan = existsSync(join(project, "plan.md")) ? readFileSync(join(project, "plan.md"), "utf8") : "(no plan.md)";
    console.log(`LIVE[${model.id}] timeout: went on after ${Math.round((Date.now() - asked) / 1000)} s`);
    console.log(`LIVE[${model.id}] timeout: tool block ${questionResult(controller.state)}`);
    console.log(`LIVE[${model.id}] timeout: plan.md ${JSON.stringify(plan)}`);
    console.log(`LIVE[${model.id}] timeout: last reply ${JSON.stringify(lastAssistant(controller.state).slice(0, 500))}`);

    const late = "Ответ на отложенный вопрос «Где хранить задачи?»: SQLite. Тогда ты продолжил с допущением — проверь его и поправь, если нужно.";
    expect(await controller.send(late, "auto")).toBe(true);
    await waitFor(controller, (state) => finished(state) && state.blocks.at(-1)?.kind !== "user", 300_000);
    const after = existsSync(join(project, "plan.md")) ? readFileSync(join(project, "plan.md"), "utf8") : "(no plan.md)";
    console.log(`LIVE[${model.id}] late answer: plan.md ${JSON.stringify(after)}`);
    console.log(`LIVE[${model.id}] late answer: last reply ${JSON.stringify(lastAssistant(controller.state).slice(0, 500))}`);
    await controller.release();
  }, 900_000);

  it.concurrent.each(MODELS)("live_a_question_the_person_defers: $id", async (model) => {
    const { controller, project } = await session(model, "defer");
    expect(await controller.send(TASK, "auto")).toBe(true);
    await waitFor(controller, (state) => state.dialogs.length > 0, 240_000);
    const dialog = controller.state.dialogs[0] as NonNullable<ChatState["dialogs"][number]>;
    const comment = "Человек отложил вопрос: продолжай с рекомендованным вариантом и запиши допущение; ответ придёт позже сообщением.";
    const request = (controller as unknown as { request(type: string, fields: object): Promise<unknown> }).request.bind(controller);
    await request("extension_ui_response", { uiRequestId: dialog.id, answers: {}, comment });
    await waitFor(controller, finished, 300_000);
    const plan = existsSync(join(project, "plan.md")) ? readFileSync(join(project, "plan.md"), "utf8") : "(no plan.md)";
    console.log(`LIVE[${model.id}] defer: tool block ${questionResult(controller.state)}`);
    console.log(`LIVE[${model.id}] defer: plan.md ${JSON.stringify(plan)}`);
    console.log(`LIVE[${model.id}] defer: last reply ${JSON.stringify(lastAssistant(controller.state).slice(0, 500))}`);
    await controller.release();
  }, 900_000);
});
