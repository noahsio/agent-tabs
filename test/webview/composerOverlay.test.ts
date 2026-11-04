// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import { ChatView } from "../../webview/render";

/** jsdom has no ResizeObserver: this one records what is observed and lets the test report a resize. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let root: HTMLElement;
let composer: HTMLElement;
let feed: HTMLElement;

function setHeight(element: HTMLElement, height: number): void {
  Object.defineProperty(element, "offsetHeight", { configurable: true, value: height });
}

function resize(height: number): void {
  setHeight(composer, height);
  for (const observer of FakeResizeObserver.instances) if (observer.targets.includes(composer)) observer.fire();
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  new ChatView(root, () => undefined);
  composer = root.querySelector("footer.composer") as HTMLElement;
  feed = root.querySelector("main.feed") as HTMLElement;
});

afterEach(() => vi.unstubAllGlobals());

describe("the composer floats over the feed", () => {
  it("the_feed_keeps_room_under_its_last_message_as_tall_as_the_composer", () => {
    resize(130);
    expect(feed.style.paddingBottom).toBe("130px");
    resize(210); // more text, an attachment
    expect(feed.style.paddingBottom).toBe("210px");
  });

  it("a_feed_at_the_bottom_stays_there_when_the_composer_grows", () => {
    let scrollTop = 800;
    Object.defineProperty(feed, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(feed, "scrollHeight", { configurable: true, get: () => 1000 + parseInt(feed.style.paddingBottom || "0", 10) });
    Object.defineProperty(feed, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => (scrollTop = value) });
    resize(100);
    expect(scrollTop).toBe(1100);
    resize(160);
    expect(scrollTop).toBe(1160);

    scrollTop = 300; // scrolled up to read: left where it is
    resize(200);
    expect(scrollTop).toBe(300);
  });

  it("stick_to_bottom_still_follows_new_messages", () => {
    const view = new ChatView(root, () => undefined);
    const main = root.querySelector("main.feed") as HTMLElement;
    let scrollTop = 800;
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(main, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => (scrollTop = value) });
    const block: Block = { kind: "assistant", id: "a1", text: "hi", thinking: "", streaming: true };
    view.update({ type: "state", state: { ...initialState(), blocks: [block], running: true }, tab: { modelMode: "auto" }, reconnectable: true });
    expect(scrollTop).toBe(1000);
  });

  it("the_gradient_layer_lets_clicks_and_scrolling_through_and_the_box_takes_them", () => {
    const css = readFileSync(join(__dirname, "../../webview/style.css"), "utf8");
    const rule = (selector: string): string => css.match(new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".composer")).toMatch(/pointer-events: none;/);
    expect(rule(".composer")).toMatch(/position: absolute;/);
    expect(rule(".composer")).toMatch(/linear-gradient\(to bottom, transparent/);
    expect(rule(".composer-box")).toMatch(/pointer-events: auto;/);
  });
});
