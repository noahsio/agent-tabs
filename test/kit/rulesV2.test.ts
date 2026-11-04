import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { loadDefaultRules, loadRules, migrateRules, validateRules } from "../../kit/guard/rules.mjs";

const defaults = loadDefaultRules();
const v1Default = JSON.parse(readFileSync(new URL("./fixtures/rules-v1.json", import.meta.url), "utf8"));

function writeRules(rules: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "guard-rules-")), "rules.json");
  writeFileSync(file, JSON.stringify(rules));
  return file;
}

describe("rules v2 defaults", () => {
  it("no_decider_model_is_chosen_by_default_and_that_is_valid", () => {
    expect(defaults.decider.model).toBe("");
    expect(validateRules(defaults)).toEqual([]);
    expect(validateRules({ ...defaults, decider: { ...defaults.decider, model: "no-slash" } })).toEqual([expect.objectContaining({ field: "decider.model" })]);
  });
});

describe("rules v2 migration", () => {
  it("v1_rules_migrate_to_groups", () => {
    expect(migrateRules(v1Default).groups).toEqual({ "git-push": true, history: true, secrets: true, "external-ip": true, "global-install": true });
  });

  it("a_group_is_off_when_none_of_its_v1_rules_remain", () => {
    const withoutPush = { ...v1Default, escalate: v1Default.escalate.filter((entry: { id: string }) => entry.id !== "git-push") };
    expect(migrateRules(withoutPush).groups["git-push"]).toBe(false);
    const withoutHistory = { ...v1Default, escalate: v1Default.escalate.filter((entry: { id: string }) => !entry.id.startsWith("git-")) };
    expect(migrateRules(withoutHistory).groups.history).toBe(false);
  });

  it("v1_sudo_chmod_curl_become_builtin_escalations_and_the_rest_carries_over", () => {
    const migrated = migrateRules({ ...v1Default, ipWhitelist: ["10.20.0.0/16"], decider: { enabled: false, model: "claude-haiku-5-5", timeoutMs: 9000 }, human: { waitSeconds: 90, telegram: true } });
    expect(migrated.version).toBe(2);
    expect(migrated.builtinEscalate.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining(["sudo", "chmod-777", "curl-write"]));
    expect(migrated.hardDeny).toEqual(v1Default.hardDeny);
    expect(migrated.askCustom).toEqual([]);
    expect(migrated.ipWhitelist).toEqual([{ cidr: "10.20.0.0/16" }]);
    expect(migrated.decider).toEqual({ mode: "ask-me", model: "gw-anthropic/claude-haiku-5-5", timeoutMs: 9000 });
    expect(migrated.human).toEqual({ waitSeconds: 180, card: true, telegram: true });
    expect(migrateRules(v1Default).decider.mode).toBe("decider-then-me");
    expect(validateRules(migrated)).toEqual([]);
  });

  it("a_custom_v1_escalation_is_kept", () => {
    const custom = { id: "my-rule", label: "mine", patterns: ["\\bterraform\\s+destroy\\b"] };
    expect(migrateRules({ ...v1Default, escalate: [...v1Default.escalate, custom] }).builtinEscalate).toContainEqual(custom);
  });

  it("load_rules_accepts_v1_and_v2_files", () => {
    expect(loadRules(writeRules(v1Default)).version).toBe(2);
    expect(loadRules(writeRules(defaults))).toEqual(defaults);
    expect(() => loadRules(writeRules({ version: 3 }))).toThrow(/version/);
  });
});

describe("rules v2 validation", () => {
  it("the_telegram_chat_and_user_are_optional_numeric_ids", () => {
    const defaults = loadDefaultRules();
    const human = (patch: Record<string, unknown>) => validateRules({ ...defaults, human: { ...defaults.human, ...patch } });
    expect(human({ telegramChat: "123456", telegramUser: "123456" })).toEqual([]);
    expect(human({ telegramChat: "-1001234567890" })).toEqual([]);
    expect(human({ telegramChat: "@channel" })).toEqual([expect.objectContaining({ field: "human.telegramChat" })]);
    expect(human({ telegramChat: 42 })).toEqual([expect.objectContaining({ field: "human.telegramChat" })]);
    expect(human({ telegramUser: "-5" })).toEqual([expect.objectContaining({ field: "human.telegramUser" })]);
  });

  it("the_defaults_are_valid_and_the_whitelist_is_empty", () => {
    expect(validateRules(defaults)).toEqual([]);
    expect(defaults.ipWhitelist).toEqual([]);
  });

  it("every_problem_is_reported_as_a_field_error", () => {
    const errors = validateRules({
      ...defaults,
      askCustom: ["ok*", "git push", "fine", "c["],
      hardDeny: [""],
      ipWhitelist: [{ cidr: "999.1.1.1" }],
      groups: { ...defaults.groups, history: "yes" },
      decider: { mode: "maybe", timeoutMs: 0 },
      human: { waitSeconds: 5, card: true, telegram: false },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        { field: "askCustom", line: 4, message: expect.stringContaining("скобк") },
        expect.objectContaining({ field: "hardDeny", line: 1 }),
        expect.objectContaining({ field: "ipWhitelist", line: 1 }),
        expect.objectContaining({ field: "groups" }),
        expect.objectContaining({ field: "decider.mode" }),
        expect.objectContaining({ field: "decider.timeoutMs" }),
        expect.objectContaining({ field: "human.waitSeconds" }),
      ]),
    );
  });

  it("bad_regexes_in_hidden_rules_are_reported", () => {
    expect(validateRules({ ...defaults, builtinEscalate: [{ id: "x", label: "x", patterns: ["(unclosed"] }] })).toEqual([
      expect.objectContaining({ field: "builtinEscalate", message: expect.stringContaining("regex") }),
    ]);
    expect(validateRules({ ...defaults, allow: [{ id: "x", label: "x", pattern: "a" }] })).toEqual([expect.objectContaining({ field: "allow" })]);
  });

  it("a_non_object_is_one_error", () => {
    expect(validateRules(null)).toEqual([{ field: "rules", message: expect.any(String) }]);
    expect(validateRules({ ...defaults, version: 1 })).toEqual([expect.objectContaining({ field: "version" })]);
  });
});
