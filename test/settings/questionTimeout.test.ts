import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envPaths, type EnvPaths } from "../../src/settings/paths";
import { ensureQuestionTimeout, QUESTION_TIMEOUT_DEFAULT, readQuestionTimeout, writeQuestionTimeout } from "../../src/settings/questionTimeout";

let root: string;
let paths: EnvPaths;
const settingsFile = (): string => path.join(paths.agentDir, "settings.json");
const settings = (): Record<string, unknown> => JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "question-timeout-")));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  paths = envPaths({ env: {}, agentDir, omoPath: "/x/omo", secrets: [] }, root);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("how long a question waits before the agent goes on", () => {
  it("a_fresh_environment_gets_five_minutes_once", () => {
    expect(readQuestionTimeout(paths)).toBeUndefined();
    expect(ensureQuestionTimeout(paths)).toBe("written");
    expect(settings()).toEqual({ askUser: { timeoutMinutes: QUESTION_TIMEOUT_DEFAULT } });
    expect(QUESTION_TIMEOUT_DEFAULT).toBe(5);
    expect(ensureQuestionTimeout(paths)).toBe("kept");
  });

  it("a_value_the_person_chose_is_never_overwritten_and_other_settings_stay", () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ permissionPreset: "full-access", askUser: { bell: false, timeoutMinutes: 45 } }, null, 2));
    expect(ensureQuestionTimeout(paths)).toBe("kept");
    expect(readQuestionTimeout(paths)).toBe(45);
    writeQuestionTimeout(paths, 10);
    expect(settings()).toEqual({ permissionPreset: "full-access", askUser: { bell: false, timeoutMinutes: 10 } });
  });

  it("only_whole_minutes_omo_accepts_are_written", () => {
    for (const bad of [0, 121, 2.5, -1, Number.NaN]) expect(() => writeQuestionTimeout(paths, bad)).toThrow(/от 1 до 120/);
    expect(fs.existsSync(settingsFile())).toBe(false);
    writeQuestionTimeout(paths, 120);
    expect(readQuestionTimeout(paths)).toBe(120);
  });

  it("an_unreadable_settings_file_is_left_alone", () => {
    fs.writeFileSync(settingsFile(), "{ not json");
    expect(readQuestionTimeout(paths)).toBeUndefined();
    expect(ensureQuestionTimeout(paths)).toBe("kept");
    expect(() => writeQuestionTimeout(paths, 5)).toThrow();
    expect(fs.readFileSync(settingsFile(), "utf8")).toBe("{ not json");
  });
});
