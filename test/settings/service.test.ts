import { beforeEach, describe, expect, it } from "vitest";
import { FieldErrors, SettingsService, type SettingsSectionHost } from "../../src/settings/service";

type Toggle = { kind: "toggle"; on: boolean; key?: string };
const KEY = "fixture-modal-key-4321";

/** A section that keeps one flag; "fail" makes its next action throw. */
class FlagSection implements SettingsSectionHost<Toggle> {
  readonly section = "tools" as const;
  on = false;
  fail: Error | undefined;
  failView: Error | undefined;
  failParse: Error | undefined;

  parse(raw: Record<string, unknown>): Toggle | undefined {
    if (this.failParse !== undefined) throw this.failParse;
    return raw["kind"] === "toggle" && typeof raw["on"] === "boolean" ? { kind: "toggle", on: raw["on"] } : undefined;
  }

  async view(): Promise<unknown> {
    if (this.failView !== undefined) throw this.failView;
    return { on: this.on };
  }

  async perform(action: Toggle): Promise<void> {
    if (this.fail !== undefined) throw this.fail;
    this.on = action.on;
  }
}

let service: SettingsService;
let flags: FlagSection;
let changes: number;
let logged: string[];

/** A second section that always shows itself, to prove one failing view does not hide the others. */
const environment: SettingsSectionHost<unknown> = {
  section: "environment",
  parse: () => undefined,
  view: async () => ({ omo: "5.1.59" }),
  perform: async () => undefined,
};

beforeEach(() => {
  logged = [];
  service = new SettingsService({ name: "second", agentDir: "/home/u/.omo/agent" }, (text) => logged.push(text));
  flags = new FlagSection();
  service.register(flags as SettingsSectionHost<unknown>);
  service.register(environment);
  changes = 0;
  service.on("changed", () => changes++);
});

describe("SettingsService", () => {
  it("state_carries_the_environment_and_every_registered_section_view", async () => {
    expect(await service.state()).toEqual({ env: { name: "second", agentDir: "/home/u/.omo/agent" }, tools: { on: false }, environment: { omo: "5.1.59" } });
  });

  it("a_failing_section_view_is_marked_and_the_others_still_arrive", async () => {
    flags.failView = new Error("models.json: Unexpected token");
    expect(await service.state()).toEqual({
      env: { name: "second", agentDir: "/home/u/.omo/agent" },
      failed: { tools: expect.any(String) },
      environment: { omo: "5.1.59" },
    });
    expect(logged.join("\n")).toContain("models.json: Unexpected token");
  });

  it("an_action_for_an_unknown_section_or_shape_is_refused", async () => {
    expect(await service.perform("models", { nonsense: 1 })).toEqual({ ok: false, error: expect.any(String) });
    expect(await service.perform("tools", { nonsense: 1 })).toEqual({ ok: false, error: expect.any(String) });
    expect(await service.perform("tools", "toggle")).toEqual({ ok: false, error: expect.any(String) });
    expect(flags.on).toBe(false);
    expect(changes).toBe(0);
  });

  it("a_valid_action_is_performed_and_announced", async () => {
    expect(await service.perform("tools", { kind: "toggle", on: true })).toEqual({ ok: true });
    expect(flags.on).toBe(true);
    expect(changes).toBe(1);
    expect(await service.state()).toMatchObject({ tools: { on: true } });
  });

  it("a_throwing_parse_is_a_failed_action_not_a_throw", async () => {
    flags.failParse = new Error(`bad shape near ${KEY}`);
    expect(await service.perform("tools", { kind: "toggle", on: true, key: KEY })).toEqual({ ok: false, error: expect.any(String) });
    expect(changes).toBe(0);
    expect(logged.join("\n")).not.toContain(KEY);
  });

  it("an_unexpected_error_quoting_a_typed_key_reaches_neither_the_answer_nor_the_log", async () => {
    flags.fail = new Error(`gateway said 401 for key ${KEY}`);
    const result = await service.perform("tools", { kind: "toggle", on: true, key: KEY });
    expect(result).toEqual({ ok: false, error: "Не удалось применить изменение — подробности в канале «Agent Tabs»" });
    expect(logged).toEqual(["Настройки, раздел «tools»: gateway said 401 for key ‹redacted›"]);
  });

  it("a_failed_action_reports_field_errors_without_a_change", async () => {
    flags.fail = new FieldErrors("Правила не сохранены", [{ field: "rules", line: 3, message: "Пустой шаблон" }]);
    expect(await service.perform("tools", { kind: "toggle", on: true })).toEqual({
      ok: false,
      error: "Правила не сохранены",
      errors: [{ field: "rules", line: 3, message: "Пустой шаблон" }],
    });
    expect(changes).toBe(0);
  });
});
