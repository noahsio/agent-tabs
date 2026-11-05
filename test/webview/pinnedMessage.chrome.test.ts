import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: one long sent message, then more output than the tab can show at once. */
const STUB = `
(function () {
  var ask = Array.from({ length: 14 }, function (_, i) { return "Строка запроса " + (i + 1); }).join("\\n");
  var reply = Array.from({ length: 60 }, function (_, i) { return "Шаг ответа " + (i + 1); }).join("\\n\\n");
  var blocks = [
    { kind: "user", id: "u1", text: ask },
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

type Shape = {
  shown: boolean;
  /** The copy's own box and the feed's, to see that it is docked to the feed's top edge and spans its width. */
  pin: { top: number; left: number; right: number; height: number };
  feed: { top: number; left: number; right: number };
  textHeight: number;
  fullHeight: number;
  lineHeight: number;
  label: string | null;
  scrollTop: number;
};

function shape(page: Page): Promise<Shape> {
  return page.evaluate<Shape>(`(() => {
    const feed = document.querySelector("main.feed");
    const slot = feed.querySelector(".pin-slot");
    const pin = slot.querySelector('[data-role="pin"]');
    const text = pin.querySelector(".user-text");
    const toggle = pin.querySelector('[data-role="pin-toggle"]');
    const box = (element) => { const r = element.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, height: r.height }; };
    return {
      shown: !slot.hidden,
      pin: box(pin),
      feed: box(feed),
      textHeight: text.clientHeight,
      fullHeight: text.scrollHeight,
      lineHeight: parseFloat(getComputedStyle(text).lineHeight),
      label: toggle.hidden ? null : toggle.textContent,
      scrollTop: feed.scrollTop,
    };
  })()`);
}

describe.skipIf(!hasChrome)("the last message pinned over the feed (headless Chrome)", () => {
  let page: Page;
  /** A point inside the feed, under the pinned copy, for the wheel to scroll. */
  const middle: Point = { x: 450, y: 450 };

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="a1"]') !== null`);
    await waitFor(page, `document.querySelector(".pin-slot")?.hidden === false`);
  }, 30_000);

  afterAll(() => page?.close());

  it("the_copy_is_docked_to_the_feeds_top_edge_at_three_lines_while_the_message_is_out_of_view", async () => {
    const pinned = await shape(page);
    expect(pinned.shown).toBe(true);
    expect(Math.round(pinned.textHeight / pinned.lineHeight)).toBe(3);
    expect(pinned.fullHeight).toBeGreaterThan(pinned.textHeight * 3); // the message is much longer than that
    expect(pinned.label).toBe("Показать полностью");
    expect(pinned.pin.top).toBeCloseTo(pinned.feed.top, 0); // against the top edge, not floating below it
    expect(pinned.pin.left).toBeCloseTo(pinned.feed.left, 0); // and the whole width of the feed
    expect(pinned.pin.right).toBeCloseTo(pinned.feed.right, 0);
    expect(pinned.pin.height).toBeLessThan(0.2 * 700); // a fifth of the tab at most

    // The timeline runs under the copy: it takes none of the feed's height.
    const timelineTop = await page.evaluate<number>(`document.querySelector(".timeline").getBoundingClientRect().top`);
    expect(timelineTop).toBeLessThan(pinned.pin.top + pinned.pin.height);
  }, 15_000);

  /** The copy's control, wherever it sits now: it moves down as the copy opens. */
  const toggle = (): Promise<Point> =>
    page.evaluate<Point>(`(() => { const r = document.querySelector('[data-role="pin-toggle"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

  it("opening_the_copy_reaches_the_whole_message_without_moving_the_feed", async () => {
    const before = await shape(page);
    await page.click(await toggle());
    await waitFor(page, `document.querySelector('[data-role="pin-toggle"]').textContent === "Свернуть"`);
    const open = await shape(page);
    expect(open.scrollTop).toBe(before.scrollTop); // the view did not move to the message
    expect(open.textHeight).toBeGreaterThan(before.textHeight);
    expect(open.textHeight).toBeLessThanOrEqual(Math.ceil(700 / 3)); // a third of the tab at most
    expect(open.pin.height).toBeLessThan(0.4 * 700); // never the whole tab
    // What a third cannot hold is reachable in the copy itself, and still without moving the feed.
    const inside = await page.evaluate<{ reached: number; feed: number }>(`(() => {
      const text = document.querySelector('[data-role="pin"] .user-text');
      text.scrollTop = 9_999;
      return { reached: text.scrollTop, feed: document.querySelector("main.feed").scrollTop };
    })()`);
    expect(inside.reached).toBe(open.fullHeight - open.textHeight);
    expect(inside.feed).toBe(before.scrollTop);

    await page.click(await toggle());
    await waitFor(page, `document.querySelector('[data-role="pin-toggle"]').textContent === "Показать полностью"`);
    expect((await shape(page)).textHeight).toBe(before.textHeight);
  }, 15_000);

  it("the_copy_goes_when_the_message_itself_is_back_on_screen", async () => {
    await page.wheel(middle, -4_000);
    await waitFor(page, `document.querySelector(".pin-slot").hidden === true`);
    const top = await page.evaluate<number>(`document.querySelector('[data-block="u1"]').getBoundingClientRect().top`);
    const feedTop = await page.evaluate<number>(`document.querySelector("main.feed").getBoundingClientRect().top`);
    expect(top).toBeGreaterThanOrEqual(feedTop - 1); // the message is where the person can see it

    await page.wheel(middle, 4_000);
    await waitFor(page, `document.querySelector(".pin-slot").hidden === false`);
  }, 15_000);
});
