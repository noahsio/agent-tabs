import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: one long sent message and one short one. */
const STUB = `
(function () {
  var long = Array.from({ length: 40 }, function (_, i) { return "строка " + (i + 1); }).join("\\n");
  var blocks = [{ kind: "user", id: "u1", text: long }, { kind: "user", id: "u2", text: "коротко" }];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

type Geometry = { textHeight: number; fullHeight: number; lineHeight: number; toggle: { right: number; bottom: number } | null; bubble: { right: number; bottom: number } };

function geometry(page: Page, id: string): Promise<Geometry> {
  return page.evaluate<Geometry>(`(() => {
    const bubble = document.querySelector('[data-block="${id}"] .user-bubble');
    const text = bubble.querySelector(".user-text");
    const toggle = bubble.querySelector('[data-role="message-toggle"]');
    const box = (element) => { const r = element.getBoundingClientRect(); return { right: r.right, bottom: r.bottom }; };
    return {
      textHeight: text.clientHeight,
      fullHeight: text.scrollHeight,
      lineHeight: parseFloat(getComputedStyle(text).lineHeight),
      toggle: toggle && !toggle.hidden ? box(toggle) : null,
      bubble: box(bubble),
    };
  })()`);
}

describe.skipIf(!hasChrome)("long sent messages in a real layout (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="u2"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("a_long_message_shows_about_eight_lines_and_its_control_sits_in_the_bottom_right_corner", async () => {
    const collapsed = await geometry(page, "u1");
    expect(Math.round(collapsed.textHeight / collapsed.lineHeight)).toBe(4);
    expect(collapsed.fullHeight).toBeGreaterThan(collapsed.textHeight * 4);
    expect(collapsed.toggle).not.toBeNull();
    expect((await geometry(page, "u2")).toggle).toBeNull();

    const point = await page.evaluate<Point>(`(() => { const r = document.querySelector('[data-block="u1"] [data-role="message-toggle"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page.click(point);
    await waitFor(page, `document.querySelector('[data-block="u1"] [data-role="message-toggle"]').textContent === "Свернуть"`);
    const open = await geometry(page, "u1");
    expect(open.textHeight).toBe(open.fullHeight);
    const toggle = open.toggle as { right: number; bottom: number };
    expect(open.bubble.right - toggle.right).toBeLessThan(16); // inside the bubble, against its right edge
    expect(open.bubble.bottom - toggle.bottom).toBeLessThan(16); // and its bottom
  }, 15_000);
});

/** A sent message that is one long unbreakable token (a hex blob): it must wrap, never scroll the bubble sideways. */
const HEX_STUB = `
(function () {
  var hex = "0x" + Array.from({ length: 100 }, function (_, i) { return "0123456789abcdef"[i % 16]; }).join("");
  var blocks = [{ kind: "user", id: "u1", text: hex }];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

describe.skipIf(!hasChrome)("a long unbreakable token wraps instead of scrolling (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(HEX_STUB), { width: 360, height: 700 }); // a narrow tab, so the token must wrap
    await waitFor(page, `document.querySelector('[data-block="u1"] .user-text') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("a_100_char_hex_string_breaks_onto_several_lines_without_a_sideways_scroll", async () => {
    const measured = await page.evaluate<{ textOverflow: number; feedOverflow: number; lines: number }>(`(() => {
      const text = document.querySelector('[data-block="u1"] .user-text');
      const feed = document.querySelector("main.feed");
      return {
        textOverflow: text.scrollWidth - text.clientWidth, // >0 would mean the long token overflows its box sideways
        feedOverflow: feed.scrollWidth - feed.clientWidth, // and the feed must never gain a horizontal scrollbar
        lines: Math.round(text.scrollHeight / (parseFloat(getComputedStyle(text).lineHeight) || 20)),
      };
    })()`);
    expect(measured.textOverflow).toBeLessThanOrEqual(1); // no horizontal overflow: the hex blob wrapped
    expect(measured.feedOverflow).toBeLessThanOrEqual(1); // nothing pushed the feed sideways
    expect(measured.lines).toBeGreaterThan(1); // the 100-char token spread over several lines
  }, 15_000);
});
