// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebviewMessage } from "../../src/panel/protocol";
import { Header } from "../../webview/header";

let root: HTMLElement;
let posted: WebviewMessage[];
let sessionsOpened: number;
let header: Header;

function title(): HTMLElement {
  return root.querySelector('[data-role="title"]') as HTMLElement;
}

function field(): HTMLInputElement {
  return root.querySelector('[data-role="title-input"]') as HTMLInputElement;
}

function press(key: string): void {
  field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function icon(role: string): HTMLButtonElement {
  return root.querySelector(`[data-role="${role}"]`) as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = '<header id="h"></header>';
  root = document.getElementById("h") as HTMLElement;
  posted = [];
  sessionsOpened = 0;
  header = new Header(root, (message) => posted.push(message), {
    onOpenSessions: () => sessionsOpened++,
  });
  header.update("Кэш каталога", "d1");
});

describe("Header", () => {
  it("title_click_renames_on_enter_and_cancels_on_escape", () => {
    expect(title().textContent).toBe("Кэш каталога");
    title().click();
    expect(field().closest(".title-edit")?.hasAttribute("hidden")).toBe(false);
    expect(field().value).toBe("Кэш каталога");
    field().value = "Другое имя";
    press("Escape");
    expect(document.activeElement).toBe(title());
    expect(posted).toEqual([]);
    expect(title().textContent).toBe("Кэш каталога");
    expect(title().hidden).toBe(false);

    title().click();
    field().value = "  Кэш: TTL  ";
    press("Enter");
    expect(posted).toEqual([{ type: "rename", name: "Кэш: TTL" }]);
    expect(document.activeElement).toBe(title());
    expect(title().textContent).toBe("Кэш: TTL"); // shown at once, before the host answers
    header.update("Кэш каталога", "d1"); // a state from before the rename landed
    expect(title().textContent).toBe("Кэш: TTL");
    header.renamed(false, "Имя не сохранено");
    expect(title().textContent).toBe("Кэш каталога");
    expect(title().getAttribute("title")).toBe("Имя не сохранено");
  });

  it("a_confirmed_rename_keeps_the_new_title_until_the_next_state", () => {
    title().click();
    field().value = "Новое";
    press("Enter");
    header.renamed(true);
    expect(title().textContent).toBe("Новое");
  });

  it("enter_with_blank_or_same_name_posts_nothing", () => {
    title().click();
    field().value = "   ";
    press("Enter");
    title().click();
    press("Enter");
    expect(posted).toEqual([]);
  });

  it("pin_comes_from_the_tab_and_a_click_shows_at_once_until_the_host_confirms", () => {
    const pressed = (): string | null => icon("pin").getAttribute("aria-pressed");
    expect(pressed()).toBe("false");
    icon("pin").click();
    expect(posted).toEqual([{ type: "pin", durableId: "d1", pinned: true }]);
    expect(pressed()).toBe("true");
    header.update("Кэш каталога", "d1", false); // a state from before the host stored the pin
    expect(pressed()).toBe("true");
    header.update("Кэш каталога", "d1", true); // confirmed
    expect(pressed()).toBe("true");
    header.update("Кэш каталога", "d1", false); // from then on the tab has the word
    expect(pressed()).toBe("false");
    header.update("Другая", "d0", true);
    expect(pressed()).toBe("true");
    header.update("Новая сессия", undefined);
    expect(icon("pin").disabled).toBe(true);
  });

  it("an_unconfirmed_pin_falls_back_to_the_tab", () => {
    vi.useFakeTimers();
    try {
      icon("pin").click();
      expect(icon("pin").getAttribute("aria-pressed")).toBe("true");
      vi.advanceTimersByTime(2_000); // the host never confirmed (storing the pin failed)
      expect(icon("pin").getAttribute("aria-pressed")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no_fork_icon_in_the_header", () => {
    expect(icon("fork")).toBeNull(); // the fork lives in the «/» menu
  });

  it("sessions_and_new_icons_and_no_settings_gear", () => {
    expect(icon("settings")).toBeNull(); // the settings live in the «/» menu
    icon("sessions").click();
    expect(sessionsOpened).toBe(1);
    icon("new").click();
    expect(posted).toEqual([{ type: "newSession" }]);
  });
});
