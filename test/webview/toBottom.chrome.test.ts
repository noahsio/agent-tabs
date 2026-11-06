import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: one sent message and a reply far taller than the tab, so the feed can be scrolled up. */
const STUB = `
(function () {
  var reply = Array.from({ length: 60 }, function (_, i) { return "Шаг ответа " + (i + 1); }).join("\\n\\n");
  var blocks = [
    { kind: "user", id: "u1", text: "Запрос" },
    { kind: "assistant", id: "a1", text: reply, thinking: "", streaming: false },
  ];
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

function settle(page: Page): Promise<unknown> {
  return page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}

const hidden = (page: Page): Promise<boolean> => page.evaluate<boolean>(`document.querySelector(".to-bottom-slot").hidden`);
const atBottom = (page: Page): Promise<boolean> =>
  page.evaluate<boolean>(`(() => { const f = document.querySelector("main.feed"); return f.scrollHeight - f.scrollTop - f.clientHeight < 48; })()`);

describe.skipIf(!hasChrome)("the to-bottom control (headless Chrome)", () => {
  let page: Page;
  const SHOTS = "/tmp/agent-tabs-shots/native-sticky";

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="a1"]') !== null`);
    await waitFor(page, `document.querySelector(".to-bottom-slot") !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("is_hidden_at_the_bottom_and_shows_once_the_feed_is_scrolled_up", async () => {
    await page.evaluate(`document.querySelector("main.feed").scrollTop = document.querySelector("main.feed").scrollHeight`);
    await settle(page);
    expect(await atBottom(page)).toBe(true);
    expect(await hidden(page)).toBe(true); // at the end there is nothing to return to

    await page.evaluate(`document.querySelector("main.feed").scrollTop = 0`);
    await settle(page);
    expect(await hidden(page)).toBe(false); // scrolled up: the control offers the way back
    await page.screenshot(`${SHOTS}/to-bottom.png`);
  });

  it("is_centred_over_the_feed_and_clear_of_the_composer", async () => {
    const where = await page.evaluate<{ btnMid: number; feedMid: number; btnBottom: number; composerTop: number }>(`(() => {
      const btn = document.querySelector('[data-role="to-bottom"]').getBoundingClientRect();
      const feed = document.querySelector("main.feed").getBoundingClientRect();
      const composer = document.querySelector("footer.composer .composer-box").getBoundingClientRect();
      return { btnMid: btn.left + btn.width / 2, feedMid: feed.left + feed.width / 2, btnBottom: btn.bottom, composerTop: composer.top };
    })()`);
    expect(Math.abs(where.btnMid - where.feedMid)).toBeLessThan(2); // horizontally centred over the feed
    expect(where.btnBottom).toBeLessThanOrEqual(where.composerTop + 1); // floating above the composer box, not over it
  });

  it("does_not_block_a_click_meant_for_the_composer_input", async () => {
    const input = await page.evaluate<Point>(
      `(() => { const r = document.querySelector("footer.composer textarea, footer.composer [contenteditable]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await page.click(input);
    const focused = await page.evaluate<boolean>(`document.activeElement === document.querySelector("footer.composer textarea, footer.composer [contenteditable]")`);
    expect(focused).toBe(true); // the control's slot lets the composer take the pointer
  });

  it("returns_to_the_latest_message_when_clicked", async () => {
    await page.evaluate(`document.querySelector("main.feed").scrollTop = 0`);
    await settle(page);
    expect(await hidden(page)).toBe(false);
    const button = await page.evaluate<Point>(
      `(() => { const r = document.querySelector('[data-role="to-bottom"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await page.click(button);
    await waitFor(page, `(() => { const f = document.querySelector("main.feed"); return f.scrollHeight - f.scrollTop - f.clientHeight < 48; })()`);
    expect(await atBottom(page)).toBe(true); // the smooth ride settled at the latest message
    await waitFor(page, `document.querySelector(".to-bottom-slot").hidden === true`); // and the control hid itself again
  });
});
