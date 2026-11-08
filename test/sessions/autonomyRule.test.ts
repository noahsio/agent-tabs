import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTONOMY_RULE, writeAutonomyRule } from "../../src/sessions/autonomyRule";
import { envPaths, type EnvPaths } from "../../src/settings/paths";

let root: string;
let paths: EnvPaths;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-rule-")));
  paths = envPaths({ env: {}, agentDir: path.join(root, "agent"), omoPath: "/x/omo", secrets: [] }, root);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("the rule the plugin's host appends to the system prompt", () => {
  it("is_written_once_into_the_plugins_own_folder_and_its_path_returned", () => {
    const file = writeAutonomyRule(paths);
    expect(file).toBe(path.join(paths.pluginDir, "autonomy-rule.md"));
    expect(fs.readFileSync(file, "utf8")).toBe(`${AUTONOMY_RULE}\n`);
    const written = fs.statSync(file).mtimeMs;
    expect(writeAutonomyRule(paths)).toBe(file);
    expect(fs.statSync(file).mtimeMs).toBe(written); // unchanged content is not rewritten
  });

  it("says_what_the_spec_asks_of_the_model", () => {
    for (const part of ["Assumption:", "irreversible", "later as a normal message", "work around"]) expect(AUTONOMY_RULE).toContain(part);
  });
});
