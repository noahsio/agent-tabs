import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, makeTmp } from "./helpers";

function runInit(cwd: string, bin: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("sh", [path.join(KIT, "hooks/codegraph-init.sh")], {
    input: JSON.stringify({ cwd }),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", OMO_CODEGRAPH_BIN: bin, ...extraEnv },
  });
}

function repoWithFakeCodegraph() {
  const root = makeTmp();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const marker = path.join(root, "init-called");
  const bin = path.join(root, "codegraph");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${marker}"\n`, { mode: 0o755 });
  return { repo, bin, marker };
}

const waitFor = async (file: string) => {
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 100));
};

describe("codegraph-init hook", () => {
  it("inits any git repo, excludes .codegraph and prints JSON", async () => {
    const { repo, bin, marker } = repoWithFakeCodegraph();
    const result = runInit(repo, bin);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    await waitFor(marker);
    expect(fs.readFileSync(marker, "utf8")).toContain("init --yes");
    expect(fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8")).toContain(".codegraph/");
  });

  it("honours OMO_CODEGRAPH_AUTOINIT=0", async () => {
    const { repo, bin, marker } = repoWithFakeCodegraph();
    const result = runInit(repo, bin, { OMO_CODEGRAPH_AUTOINIT: "0" });
    expect(JSON.parse(result.stdout)).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(marker)).toBe(false);
  });
});
