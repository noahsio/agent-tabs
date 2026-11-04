// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

function role(name: string, scope: ParentNode = root): HTMLElement {
  return scope.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

function modal(): HTMLElement {
  return root.querySelector('[data-popover="settings"]') as HTMLElement;
}

function navItems(): HTMLElement[] {
  return [...modal().querySelectorAll<HTMLElement>("[data-section]")];
}

function navLabels(): string[] {
  return navItems().map((item) => item.textContent ?? "");
}

function nav(label: string): HTMLElement {
  const item = navItems().find((candidate) => candidate.textContent === label);
  if (item === undefined) throw new Error(`no section «${label}»`);
  return item;
}

function activeSection(): string {
  const active = navItems().filter((item) => item.getAttribute("aria-current") === "page");
  expect(active).toHaveLength(1);
  expect(role("settings-title").textContent).toBe(active[0]?.textContent);
  return active[0]?.textContent ?? "";
}

function action(label: string): HTMLElement {
  const row = [...root.querySelectorAll<HTMLElement>('[data-popover="actions"] [data-row]')].find((candidate) => !candidate.hidden && candidate.textContent === label);
  if (row === undefined) throw new Error(`no action «${label}»`);
  return row;
}

function openActions(): void {
  role("slash").click();
}

/** The modal's only opener in the tab: «Настройки» in the «/» menu. */
function openSettings(): void {
  openActions();
  action("Настройки").click();
}

function key(target: EventTarget, name: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  view.update({ type: "state", state: initialState(), tab: { modelMode: "auto", sessionPath: "/s/a.jsonl", durableId: "d1" }, reconnectable: true });
});

afterEach(() => {
  key(document, "Escape");
});

describe("Settings modal", () => {
  it("the_gear_opens_the_modal_with_five_sections_in_order", () => {
    expect(modal().hidden).toBe(true);
    openSettings();
    expect(modal().hidden).toBe(false);
    expect(navLabels()).toEqual(["Подключения", "Модели и роли", "Безопасность", "Инструменты", "Среда"]);
    expect(activeSection()).toBe("Подключения");
    expect(role("settings-footer").textContent).toBe("Изменения сохраняются сразу · файлы OmO, а не настройки VS Code");
    expect(posted).toContainEqual({ type: "settingsGet" });
  });

  it("switching_sections_posts_nothing", () => {
    openSettings();
    nav("Безопасность").click();
    expect(activeSection()).toBe("Безопасность");
    nav("Среда").click();
    expect(activeSection()).toBe("Среда");
    expect(posted).toEqual([{ type: "settingsGet" }]);
  });

  it("the_actions_menu_row_is_visible_and_opens_connections", () => {
    openSettings();
    nav("Инструменты").click();
    key(document, "Escape");
    openActions();
    action("Настройки").click();
    expect(modal().hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-popover="actions"]')?.hidden).toBe(true);
    expect(activeSection()).toBe("Подключения");
  });

  it("escape_and_the_close_button_close_the_modal", () => {
    openSettings();
    key(document, "Escape");
    expect(modal().hidden).toBe(true);
    expect(document.activeElement).toBe(root.querySelector("textarea"));

    openSettings();
    expect(modal().hidden).toBe(false);
    role("settings-close").click();
    expect(modal().hidden).toBe(true);
  });

  it("the_host_state_shows_the_environment_and_a_failed_action_its_reason", () => {
    openSettings();
    view.settings({ env: { name: "second", agentDir: "/Users/u/.omo-second/agent" } });
    expect(role("settings-env").textContent).toBe("Среда этого окна:second · /Users/u/.omo-second/agent");
    expect(role("settings-error").hidden).toBe(true);

    view.settingsResult({ type: "settingsResult", id: "a1", ok: false, error: "Файл занят" });
    expect(role("settings-error").hidden).toBe(false);
    expect(role("settings-error").textContent).toBe("Файл занят");
    view.settingsResult({ type: "settingsResult", id: "a2", ok: true });
    expect(role("settings-error").hidden).toBe(true);
  });

  it("without_an_environment_the_modal_says_why_and_shows_no_section", () => {
    openSettings();
    view.settings({ unavailable: "Настройки недоступны: среда OmO не задана" });
    expect(role("settings-notice").hidden).toBe(false);
    expect(role("settings-notice").textContent).toBe("Настройки недоступны: среда OmO не задана");
    expect(role("settings-env").hidden).toBe(true);
    expect(modal().querySelectorAll("[data-section-body]:not([hidden])")).toHaveLength(0);
  });

  it("a_section_that_failed_to_load_is_marked_and_the_others_show", () => {
    openSettings();
    view.settings({ env: { name: "second", agentDir: "/a" }, failed: { security: "Не удалось прочитать раздел" } });
    expect(role("settings-notice").hidden).toBe(true);
    expect(modal().querySelector('[data-section-body="connections"]')?.hasAttribute("hidden")).toBe(false);
    nav("Безопасность").click();
    expect(role("settings-notice").textContent).toBe("Не удалось прочитать раздел");
    expect(modal().querySelector('[data-section-body="security"]')?.hasAttribute("hidden")).toBe(true);
    nav("Среда").click();
    expect(role("settings-notice").hidden).toBe(true);
  });

  it("the_host_can_open_a_section_for_the_first_run", () => {
    view.openSettings("environment");
    expect(modal().hidden).toBe(false);
    expect(activeSection()).toBe("Среда");
    expect(modal().dataset["firstRun"]).toBeUndefined();
    key(document, "Escape");

    view.openSettings("connections", true);
    expect(activeSection()).toBe("Подключения");
    expect(modal().dataset["firstRun"]).toBe("true");
    expect(posted.filter((message) => message.type === "settingsGet")).toHaveLength(2);
  });
});
