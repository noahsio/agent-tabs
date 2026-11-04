#!/usr/bin/env node
// UserPromptSubmit hook: wrap `codegraph prompt-hook` (plain text) into OmO JSON additionalContext.
// Always exits 0 with JSON on stdout.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const binary = process.env.OMO_CODEGRAPH_BIN || "codegraph";
const result = spawnSync(binary, ["prompt-hook"], {
  input: readStdin(),
  encoding: "utf8",
  timeout: 15_000,
  stdio: ["pipe", "pipe", "ignore"],
});
const context = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
process.stdout.write(
  context
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })
    : "{}",
);
process.stdout.write("\n");
