// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { Lightbox } from "../../webview/lightbox";

const HINT = "←/→ листать · Esc закрыть · ⌘C копировать";

let lightbox: Lightbox;
let copied: string[];
let field: HTMLTextAreaElement;

function key(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function caption(): string | null | undefined {
  return document.querySelector('[data-role="lightbox-caption"]')?.textContent;
}

function shown(): string | null | undefined {
  return document.querySelector(".lightbox img")?.getAttribute("src");
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><textarea></textarea></div>';
  field = document.querySelector("textarea") as HTMLTextAreaElement;
  copied = [];
  lightbox = new Lightbox({ copyImage: async (dataUrl) => void copied.push(dataUrl) });
  document.getElementById("app")?.append(lightbox.element);
});

describe("Lightbox", () => {
  it("lightbox_keyboard_navigation", () => {
    field.focus();
    expect(lightbox.element.hidden).toBe(true);
    lightbox.open([{ id: "a", dataUrl: "data:image/png;base64,AAAA" }, { id: "b" }, { id: "c", dataUrl: "data:image/png;base64,CCCC" }], 0);
    expect(lightbox.element.hidden).toBe(false);
    expect(caption()).toBe(`1 / 3 · ${HINT}`);
    expect(shown()).toBe("data:image/png;base64,AAAA");

    expect(key("ArrowRight").defaultPrevented).toBe(true);
    expect(caption()).toBe(`2 / 3 · ${HINT}`);
    expect(shown()).toBeUndefined();
    expect(document.querySelector(".lightbox")?.textContent).toContain("Нет превью");
    lightbox.image("b", "data:image/png;base64,BBBB"); // bytes that arrive while it is open
    expect(shown()).toBe("data:image/png;base64,BBBB");

    key("ArrowRight");
    key("ArrowRight"); // stays on the last one
    expect(caption()).toBe(`3 / 3 · ${HINT}`);
    key("c", { metaKey: true });
    expect(copied).toEqual(["data:image/png;base64,CCCC"]);
    key("ArrowLeft");
    expect(caption()).toBe(`2 / 3 · ${HINT}`);

    key("Escape");
    expect(lightbox.element.hidden).toBe(true);
    expect(document.activeElement).toBe(field);
    key("ArrowLeft"); // closed: keys belong to the page again
    lightbox.open([{ id: "z", dataUrl: "data:image/png;base64,ZZZZ" }], 0);
    expect(caption()).toBe(`1 / 1 · ${HINT}`);
  });

  it("buttons_and_backdrop", () => {
    lightbox.open([{ id: "a", dataUrl: "data:image/png;base64,AAAA" }, { id: "b", dataUrl: "data:image/png;base64,BBBB" }], 1);
    const prev = document.querySelector('[data-role="lightbox-prev"]') as HTMLButtonElement;
    const next = document.querySelector('[data-role="lightbox-next"]') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    prev.click();
    expect(caption()).toBe(`1 / 2 · ${HINT}`);
    expect(prev.disabled).toBe(true);
    (document.querySelector(".lightbox img") as HTMLElement).click(); // the picture itself does not close
    expect(lightbox.element.hidden).toBe(false);
    lightbox.element.click();
    expect(lightbox.element.hidden).toBe(true);
    lightbox.open([{ id: "a", dataUrl: "data:image/png;base64,AAAA" }], 0);
    (document.querySelector('[data-role="lightbox-close"]') as HTMLButtonElement).click();
    expect(lightbox.element.hidden).toBe(true);
  });

  it("copy_failure_is_silent", async () => {
    lightbox = new Lightbox({ copyImage: async () => Promise.reject(new Error("denied")) });
    document.body.append(lightbox.element);
    lightbox.open([{ id: "a", dataUrl: "data:image/png;base64,AAAA" }], 0);
    expect(key("c", { ctrlKey: true }).defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0)); // an unhandled rejection would fail the run
    expect(lightbox.element.hidden).toBe(false);
  });
});
