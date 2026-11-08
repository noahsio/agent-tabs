// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import type { CommandRow } from "../../src/sessions/controller";
import type { EnvironmentView } from "../../src/settings/environment";
import { envPaths } from "../../src/settings/paths";
import { MASK, readHiddenCommands, ToolsHost, type ToolsView } from "../../src/settings/tools";
import { ChatView } from "../../webview/render";
import { type } from "../helpers/composer";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

const ENV = { name: "second", agentDir: "/a" };
const CLAUDE_MD = "/c/CLAUDE.md";

const tools: ToolsView = {
  codegraph: { on: true },
  superpowers: {
    mode: "package",
    folder: "/h/.omo/superpowers",
    version: "6.3.1-yasherisa.3",
    sha: "d592fb7",
    pinned: "d592fb7",
    skills: 15,
    claude: [
      { dir: "/h/.claude", label: "~/.claude", plugin: "on" },
      { dir: "/h/.omo-second/claude", label: "~/.omo-second/claude", plugin: "on" },
    ],
  },
  skills: [
    { folder: "/c/skills/prompt-master", name: "prompt-master", on: true },
    { folder: "/c/skills/repo-task-proof-loop", name: "repo-task-proof-loop", on: true },
    { folder: "/c/skills/supervisor", name: "supervisor", on: false },
  ],
  otherSkills: [],
  mcp: [{ name: "gh", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: MASK, REGION: "eu" } }],
  hidden: ["tui", "keybindings", "help"],
  instructions: { on: true, path: CLAUDE_MD, exists: true },
};

const environment: EnvironmentView = {
  folders: { agentDir: "/a", memoryHome: "~/memory", claudeDir: "/c" },
  omoVersion: "5.1.59",
  restartNeeded: false,
  restartHint: "Перезапустить OmO — нужно после смены папок",
  questionTimeoutMinutes: 5,
};

function body(section: "tools" | "environment"): HTMLElement {
  return root.querySelector(`[data-section-body="${section}"]`) as HTMLElement;
}
function q<T extends HTMLElement = HTMLElement>(section: "tools" | "environment", selector: string): T {
  const found = body(section).querySelector<T>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
}
function actions(): Array<Record<string, unknown>> {
  return posted.flatMap((message) => (message.type === "settingsAction" ? [{ ...message.action, section: message.section }] : []));
}
function show(part: Partial<{ tools: ToolsView; environment: EnvironmentView }>): void {
  view.settings({ env: ENV, tools, environment, ...part });
}
function change(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  view.update({ type: "state", state: initialState(), tab: { modelMode: "auto", sessionPath: "/s/a.jsonl", durableId: "d1" }, reconnectable: true });
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
});

describe("slash menu hidden list", () => {
  const COMMANDS: CommandRow[] = [
    { name: "tui", source: "extension", syntax: "slash" },
    { name: "help", description: "Show help", source: "extension", syntax: "slash" },
  ];
  const keys = (): string[] => [...root.querySelectorAll<HTMLElement>('[data-popover="slash"] [data-role="slash-key"]')].map((node) => node.textContent ?? "");
  const typeSlash = (): void => {
    type(root.querySelector(".input") as HTMLElement, "/");
  };

  it("hidden_commands_round_trip_and_reach_the_slash_menu", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-hidden-"));
    try {
      const paths = envPaths({ env: {}, agentDir: path.join(home, "agent"), omoPath: "/fake/omo", secrets: [] }, home);
      const host = new ToolsHost({ paths, addSecret: () => undefined, openFile: async () => undefined, hiddenChanged: () => undefined, log: () => undefined });
      // Before any change the built-in list hides both.
      view.update({ type: "state", state: initialState(), tab: { modelMode: "auto" }, reconnectable: true, commands: COMMANDS, hiddenCommands: readHiddenCommands(paths) });
      typeSlash();
      expect(keys()).not.toContain("/help");
      expect(keys()).not.toContain("/tui");

      const action = host.parse({ kind: "hidden.set", commands: ["/tui"] });
      if (action === undefined) throw new Error("refused");
      await host.perform(action);
      // The window's next state carries the list (the settings modal never opened).
      view.update({ type: "state", state: initialState(), tab: { modelMode: "auto" }, reconnectable: true, commands: COMMANDS, hiddenCommands: readHiddenCommands(paths) });
      typeSlash();
      expect(keys()).toContain("/help");
      expect(keys()).not.toContain("/tui");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("«Инструменты»", () => {
  beforeEach(() => view.openSettings("tools"));

  it("codegraph_and_skill_toggles_post_their_switch", () => {
    show({});
    const codegraph = q<HTMLButtonElement>("tools", '[data-toggle="codegraph"]');
    expect(codegraph.getAttribute("aria-checked")).toBe("true");
    codegraph.click();
    q<HTMLButtonElement>("tools", '[data-toggle="skill:/c/skills/supervisor"]').click();
    q<HTMLButtonElement>("tools", '[data-toggle="superpowers"]').click();
    q<HTMLButtonElement>("tools", '[data-action="superpowers.update"]').click();
    expect(actions()).toEqual([
      { kind: "codegraph.set", on: false, section: "tools" },
      { kind: "skills.set", folder: "/c/skills/supervisor", on: true, section: "tools" },
      { kind: "superpowers.set", on: false, section: "tools" },
      { kind: "superpowers.update", section: "tools" },
    ]);
  });

  describe("superpowers row", () => {
    const rows = (): HTMLElement[] => [...body("tools").querySelectorAll<HTMLElement>(".st-skills > .st-skill")];
    const row = (): HTMLElement => q("tools", '[data-role="superpowers"]');
    const claudeLine = (): string => q("tools", '[data-role="superpowers-claude"]').textContent ?? "";
    const withClaude = (...plugin: Array<"on" | "off" | "absent">): ToolsView => ({
      ...tools,
      superpowers: { ...tools.superpowers, claude: tools.superpowers.claude.map((env, index) => ({ ...env, plugin: plugin[index] ?? "absent" })) },
    });

    it("is_the_first_row_of_the_one_skills_list_with_its_plugin_badge_and_the_same_toggle", () => {
      show({});
      expect(rows()[0]).toBe(row());
      expect(rows().slice(1).map((item) => item.textContent)).toEqual(["prompt-master", "repo-task-proof-loop", "supervisor"]);
      expect(rows()[2]?.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
      expect(q("tools", '[data-role="superpowers"] .st-badge').textContent).toBe("плагин · 6.3.1-yasherisa.3 · d592fb7");
      expect(q<HTMLButtonElement>("tools", '[data-toggle="superpowers"]').getAttribute("aria-checked")).toBe("true");
      expect(row().querySelector('[data-action="superpowers.update"]')?.textContent).toBe("обновить");
      expect(claudeLine()).toBe("в Claude: включён в обеих средах");
      expect(body("tools").textContent).not.toContain("Навыки Claude этой среды");
      expect([...body("tools").querySelectorAll("h3")].map((heading) => heading.textContent)).toContain("Навыки");
    });

    it("says_where_claude_has_the_plugin", () => {
      show({ tools: withClaude("on", "absent") });
      expect(claudeLine()).toBe("в Claude: только в ~/.claude");
      show({ tools: withClaude("absent", "absent") });
      expect(claudeLine()).toBe("в Claude: не установлен");
      show({ tools: withClaude("off", "absent") });
      expect(claudeLine()).toBe("в Claude: выключен");
    });

    it("a_clone_off_the_pinned_ref_says_so", () => {
      show({ tools: { ...tools, superpowers: { ...tools.superpowers, sha: "1234567" } } });
      expect(q("tools", '[data-role="superpowers"] .st-badge').textContent).toBe("плагин · 6.3.1-yasherisa.3 · 1234567");
      expect(row().textContent).toContain("закреплена d592fb7");
    });

    it("the_package_mode_is_the_normal_state_without_a_warning", () => {
      show({});
      expect(row().querySelector(".st-warn")).toBeNull();
      expect(q<HTMLButtonElement>("tools", '[data-toggle="superpowers"]').getAttribute("aria-checked")).toBe("true");
    });

    it("the_skills_dir_mode_is_legacy_and_offers_to_migrate_to_a_package", () => {
      show({ tools: { ...tools, superpowers: { ...tools.superpowers, mode: "skills" } } });
      expect(row().textContent).toContain("подключён как папка навыков");
      expect(q<HTMLButtonElement>("tools", '[data-toggle="superpowers"]').getAttribute("aria-checked")).toBe("true");
      q<HTMLButtonElement>("tools", '[data-action="superpowers.migrate"]').click();
      expect(row().textContent).toContain("перевести в пакет");
      expect(actions()).toEqual([{ kind: "superpowers.set", on: true, section: "tools" }]);
    });

    it("without_a_clone_it_cannot_be_switched_and_points_at_setup", () => {
      const { folder: _folder, version: _version, sha: _sha, ...missing } = tools.superpowers;
      show({ tools: { ...tools, superpowers: { ...missing, mode: "off", skills: 0 } } });
      expect(q<HTMLButtonElement>("tools", '[data-toggle="superpowers"]').disabled).toBe(true);
      expect(row().textContent).toContain("не установлен — запустите kit/setup-omo.mjs");
      expect(row().querySelector('[data-action="superpowers.update"]')).toBeNull();
    });
  });

  it("other_skill_paths_are_listed_without_switches", () => {
    show({ tools: { ...tools, otherSkills: [{ path: "/x/my-skills", exists: true }, { path: "/c/skills/gone", exists: false }] } });
    const list = q("tools", '[data-role="other-skills"]');
    expect(list.textContent).toContain("Другие пути навыков");
    expect(list.textContent).toContain("/x/my-skills");
    expect(list.textContent).toContain("/c/skills/gone · нет папки");
    expect(list.querySelector('[role="switch"]')).toBeNull();
    show({});
    expect(body("tools").querySelector('[data-role="other-skills"]')).toBeNull();
  });

  it("an_mcp_server_shows_masked_values_and_its_edit_keeps_them", () => {
    show({});
    expect(q("tools", '[data-mcp="gh"]').textContent).toContain("gh-mcp --stdio");
    q<HTMLButtonElement>("tools", '[data-mcp="gh"] [data-action="mcp.edit"]').click();
    const env = q<HTMLTextAreaElement>("tools", '[data-field="mcp-env"]');
    expect(env.value).toBe(`GITHUB_TOKEN=${MASK}\nREGION=eu`);
    expect(q<HTMLInputElement>("tools", '[data-field="mcp-name"]').readOnly).toBe(true);
    const args = q<HTMLTextAreaElement>("tools", '[data-field="mcp-args"]');
    expect(args.value).toBe("--stdio");
    args.value = "--stdio\n--label=my server\n\n";
    env.value = `GITHUB_TOKEN=${MASK}\nREGION=us`;
    q<HTMLButtonElement>("tools", '[data-action="mcp.save"]').click();
    expect(actions().at(-1)).toEqual({
      kind: "mcp.save",
      name: "gh",
      command: "gh-mcp",
      args: ["--stdio", "--label=my server"], // one argument per line: spaces stay inside it
      env: { GITHUB_TOKEN: MASK, REGION: "us" },
      section: "tools",
    });
  });

  it("an_argument_with_spaces_round_trips_through_the_form", () => {
    show({ tools: { ...tools, mcp: [{ name: "fs", command: "srv", args: ["--root", "/Users/me/My Projects"], env: {} }] } });
    expect(q("tools", '[data-mcp="fs"]').textContent).toContain('srv --root "/Users/me/My Projects"');
    q<HTMLButtonElement>("tools", '[data-mcp="fs"] [data-action="mcp.edit"]').click();
    expect(q<HTMLTextAreaElement>("tools", '[data-field="mcp-args"]').value).toBe("--root\n/Users/me/My Projects");
    q<HTMLButtonElement>("tools", '[data-action="mcp.save"]').click();
    expect(actions().at(-1)).toMatchObject({ kind: "mcp.save", name: "fs", args: ["--root", "/Users/me/My Projects"] });
  });

  it("a_new_mcp_server_and_a_removal_post_their_actions", () => {
    show({});
    q<HTMLButtonElement>("tools", '[data-action="mcp.add"]').click();
    q<HTMLInputElement>("tools", '[data-field="mcp-name"]').value = "local";
    q<HTMLInputElement>("tools", '[data-field="mcp-command"]').value = "/bin/srv";
    q<HTMLButtonElement>("tools", '[data-action="mcp.save"]').click();
    expect(actions().at(-1)).toEqual({ kind: "mcp.save", name: "local", command: "/bin/srv", args: [], env: {}, section: "tools" });
    const remove = q<HTMLButtonElement>("tools", '[data-mcp="gh"] [data-action="mcp.remove"]');
    remove.click();
    expect(actions()).toHaveLength(1); // asks once more first
    remove.click();
    expect(actions().at(-1)).toEqual({ kind: "mcp.remove", name: "gh", section: "tools" });
  });

  it("the_hidden_list_is_edited_one_command_per_line", () => {
    show({});
    expect(q("tools", '[data-role="hidden-summary"]').textContent).toContain("/tui, /keybindings, /help");
    q<HTMLButtonElement>("tools", '[data-action="hidden.edit"]').click();
    const lines = q<HTMLTextAreaElement>("tools", '[data-field="hidden"]');
    expect(lines.value).toBe("/tui\n/keybindings\n/help");
    lines.value = "/tui\n\n/fast";
    q<HTMLButtonElement>("tools", '[data-action="hidden.save"]').click();
    expect(actions().at(-1)).toEqual({ kind: "hidden.set", commands: ["/tui", "/fast"], section: "tools" });
  });

  it("global_instructions_toggle_open_and_the_note_about_the_system_file", () => {
    show({});
    expect(body("tools").textContent).toContain("Использовать CLAUDE.md этой среды");
    expect(body("tools").textContent).toContain(CLAUDE_MD);
    expect(body("tools").textContent).toContain("~/.claude/CLAUDE.md");
    q<HTMLButtonElement>("tools", '[data-toggle="instructions"]').click();
    q<HTMLButtonElement>("tools", '[data-action="instructions.open"]').click();
    expect(actions()).toEqual([
      { kind: "instructions.set", on: false, section: "tools" },
      { kind: "instructions.open", section: "tools" },
    ]);
  });

  it("the_system_claude_md_cannot_be_switched_off", () => {
    show({ tools: { ...tools, instructions: { on: true, path: "/h/.claude/CLAUDE.md", exists: true, always: true } } });
    const toggle = q<HTMLButtonElement>("tools", '[data-toggle="instructions"]');
    expect(toggle.disabled).toBe(true);
    expect(body("tools").textContent).toContain("OmO всегда загружает ~/.claude/CLAUDE.md");
  });
});

describe("«Среда»", () => {
  beforeEach(() => view.openSettings("environment"));

  it("folders_version_and_restart", () => {
    show({});
    expect(q<HTMLInputElement>("environment", '[data-field="claudeDir"]').value).toBe("/c");
    expect(body("environment").textContent).toContain("5.1.59");
    expect(body("environment").textContent).toContain("нужно после смены папок");
    change(q<HTMLInputElement>("environment", '[data-field="memoryHome"]'), "/data/memory");
    q<HTMLButtonElement>("environment", '[data-action="restart"]').click();
    expect(actions()).toEqual([
      { kind: "folder.set", which: "memoryHome", path: "/data/memory", section: "environment" },
      { kind: "restart", section: "environment" },
    ]);
  });

  it("the_question_timeout_shows_and_a_change_is_sent_as_whole_minutes", () => {
    show({});
    const field = q<HTMLInputElement>("environment", '[data-field="questionTimeout"]');
    expect(field.value).toBe("5");
    change(field, "5"); // unchanged: nothing to send
    change(field, "12");
    expect(actions()).toEqual([{ kind: "questionTimeout.set", minutes: 12, section: "environment" }]);
  });

  it("a_changed_folder_highlights_the_restart", () => {
    show({ environment: { ...environment, restartNeeded: true } });
    expect(q("environment", '[data-role="restart-hint"]').classList.contains("st-warn")).toBe(true);
    show({ environment: { ...environment, omoVersion: undefined, omoUnavailable: "нет связи с OmO" } } as never);
    expect(body("environment").textContent).toContain("нет связи с OmO");
  });
});
