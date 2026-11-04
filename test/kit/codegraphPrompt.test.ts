import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, makeFakeCodegraph, makeTmp } from "./helpers";

function runHook(bin: string | undefined) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (bin) env.OMO_CODEGRAPH_BIN = bin;
  return spawnSync("node", [path.join(KIT, "hooks/codegraph-prompt.mjs")], {
    input: JSON.stringify({ prompt: "hi", cwd: "/tmp" }),
    encoding: "utf8",
    env,
  });
}

describe("codegraph-prompt hook", () => {
  it("codegraph_prompt_wraps_output_as_json", () => {
    const dir = makeFakeCodegraph(makeTmp(), "<codegraph_context>hello</codegraph_context>");
    const result = runHook(path.join(dir, "codegraph"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "<codegraph_context>hello</codegraph_context>" },
    });
  });

  it("emits {} for empty output", () => {
    const dir = makeFakeCodegraph(makeTmp(), "");
    const result = runHook(path.join(dir, "codegraph"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it("emits {} when the binary is missing", () => {
    const result = runHook("/nonexistent/codegraph");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });
});
