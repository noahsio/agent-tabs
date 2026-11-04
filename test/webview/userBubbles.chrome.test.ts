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
    expect(Math.round(collapsed.textHeight / collapsed.lineHeight)).toBe(8);
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
