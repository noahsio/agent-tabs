#!/usr/bin/env node
// Live (token-spending, haiku only) check of an environment on a scratch copy of its config:
//   1. SessionStart hook auto-inits CodeGraph in a fresh scratch git repo,
//   2. the UserPromptSubmit hook injects <codegraph_context> into the prompt,
//   3. one codegraph MCP call in an already indexed repo returns a real path.
// Usage: node kit/verify-omo-live.mjs --env system|second --indexed-repo <dir with .codegraph>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEnv } from "./lib/envs.mjs";
import { checkAgentDirSpelling, exitCode, readEnvSetting, readGatewayKey, withScratchHost } from "./verify-omo.mjs";

const SETTINGS = {
  system: "Library/Application Support/Code/User/settings.json",
  second: `${process.env.AGENT_TABS_SECOND_VSCODE ?? ".vscode-portable"}/code-portable-data/user-data/User/settings.json`,
};
const MODEL = { provider: "gw-anthropic", modelId: "claude-haiku-5-5" };

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const envName = option("--env");
const indexedRepo = option("--indexed-repo");
if (!SETTINGS[envName] || !indexedRepo || !fs.existsSync(path.join(indexedRepo, ".codegraph"))) {
  console.error("usage: verify-omo-live.mjs --env system|second --indexed-repo <dir with .codegraph>");
  process.exit(2);
}
const home = os.homedir();
const envInfo = resolveEnv(envName, home);
const settingsFile = path.resolve(home, SETTINGS[envName]);
const gatewayKey = readGatewayKey(settingsFile);
const omoBinary = path.join(home, ".local/bin/omo");
const spelling = checkAgentDirSpelling(readEnvSetting(settingsFile, "OMO_CODING_AGENT_DIR"), envInfo.agentDir);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPrompt(client, cwd, message) {
  const opened = await client.request({ type: "open_session", cwd });
  const sessionId = opened.data.sessionId;
  await client.request({ type: "set_model", ...MODEL, sessionId });
  const mark = client.frames.length;
  await client.request({ type: "prompt", message, sessionId }, 60000);
  await client.wait((frame) => frame.type === "agent_end" && frame.sessionId === sessionId, 180000);
  const frames = client.frames.slice(mark);
  const text = JSON.stringify(frames);
  const answers = frames
    .filter((frame) => frame.type === "message_end" && frame.message?.role === "assistant")
    .map((frame) => (frame.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(""));
  return { sessionId, text, answer: answers.at(-1) ?? "" };
}

const results = [spelling];
const record = (name, ok, detail) => results.push({ name, ok, detail });
if (!spelling.ok) {
  // Hooks would be untrusted: do not spend tokens on a run that cannot pass.
  record("run", false, "skipped before any prompt: agent dir spelling mismatch");
} else {
  try {
    await withScratchHost(
      {
        envName,
        envInfo,
        kitMarker: path.join(home, ".omo/kit") + path.sep,
        omoBinary,
        extraEnv: { GW_API_KEY: gatewayKey, ...(envName === "second" ? { CLAUDE_CONFIG_DIR: envInfo.claudeDir } : {}) },
      },
      async ({ scratchRoot, connectClient }) => {
        const repo = path.join(scratchRoot, "repo");
        fs.mkdirSync(repo);
        fs.writeFileSync(path.join(repo, "greeter.py"), "def greet_everyone(names):\n    return [f'hello {n}' for n in names]\n");
        for (const gitArgs of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]]) execFileSync("git", gitArgs, { cwd: repo });
        const client = await connectClient();

        // 1 + 2: fresh repo.
        const opened = await client.request({ type: "open_session", cwd: repo });
        const dbFile = path.join(repo, ".codegraph", "codegraph.db");
        const deadline = Date.now() + 120000;
        while (!fs.existsSync(dbFile) && Date.now() < deadline) await sleep(1000);
        record("SessionStart auto-init", fs.existsSync(dbFile), fs.existsSync(dbFile) ? ".codegraph/codegraph.db created" : "no codegraph.db");
        await client.request({ type: "close_session", sessionId: opened.data.sessionId }).catch(() => undefined);
        const context = await runPrompt(client, repo, "Where is greet_everyone defined? Which CodeGraph context did you receive? Reply in one short line and quote the opening XML tag of that context.");
        record("UserPromptSubmit marker", context.text.includes("codegraph_context"), `answer: ${context.answer.slice(0, 160)}`);

        // 3: MCP call.
        const mcp = await runPrompt(
          client,
          indexedRepo,
          `Call the codegraph_explore tool exactly once with query "ActivationService" and projectPath "${indexedRepo}". Then reply with only one source file path from its result.`,
        );
        const real = /[\w./-]+\.\w+/.exec(mcp.answer)?.[0];
        const exists = real ? fs.existsSync(path.resolve(indexedRepo, real)) : false;
        record("MCP codegraph call", mcp.text.includes("codegraph_explore") && exists, `answer: ${mcp.answer.slice(0, 160)}; path exists in repo: ${exists}`);
      },
    );
  } catch (error) {
    record("run", false, error.message);
  }
}
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}: ${result.detail}`);
process.exit(exitCode(results));
