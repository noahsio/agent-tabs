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

  it("the_copy_floats_as_a_bubble_inset_from_the_edges_at_three_lines_while_the_message_is_out_of_view", async () => {
    const pinned = await shape(page);
    expect(pinned.shown).toBe(true);
    expect(Math.round(pinned.textHeight / pinned.lineHeight)).toBe(3);
    expect(pinned.fullHeight).toBeGreaterThan(pinned.textHeight * 3); // the message is much longer than that
    expect(pinned.label).toBe("Показать полностью");
    expect(pinned.pin.top).toBeGreaterThan(pinned.feed.top); // floating below the top edge, not welded to it
    expect(pinned.pin.left).toBeGreaterThan(pinned.feed.left); // inset from the sides like a real message bubble
    expect(pinned.pin.right).toBeLessThan(pinned.feed.right);
    expect(pinned.pin.height).toBeLessThan(0.2 * 700); // a fifth of the tab at most
    const radius = await page.evaluate<number>(`parseFloat(getComputedStyle(document.querySelector('[data-role="pin"]')).borderTopLeftRadius)`);
    expect(radius).toBeGreaterThan(0); // rounded corners, not a square strip

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

  it("the_jump_control_scrolls_the_feed_to_the_message_the_copy_mirrors", async () => {
    await waitFor(page, `document.querySelector(".pin-slot").hidden === false`);
    const before = await page.evaluate<number>(`document.querySelector("main.feed").scrollTop`);
    const jump = await page.evaluate<Point>(
      `(() => { const r = document.querySelector('[data-role="pin-jump"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await page.click(jump);
    // The smooth scroll settles with the message back in view (and so the copy gone); waiting on its position, not just
    // on the copy, lets the animation finish — the copy now leaves the moment the message's bottom clears the top edge.
    await waitFor(
      page,
      `(() => { const r = document.querySelector('[data-block="u1"]').getBoundingClientRect(); const f = document.querySelector("main.feed").getBoundingClientRect(); return r.top >= f.top && r.top <= f.bottom; })()`,
    );
    expect(await page.evaluate<boolean>(`document.querySelector(".pin-slot").hidden`)).toBe(true); // the message is in view, so the copy went
    const after = await page.evaluate<number>(`document.querySelector("main.feed").scrollTop`);
    expect(after).toBeLessThan(before); // the feed moved up toward the message at the top

    const where = await page.evaluate<{ top: number; feedTop: number; feedBottom: number }>(`(() => {
      const row = document.querySelector('[data-block="u1"]').getBoundingClientRect();
      const feed = document.querySelector("main.feed").getBoundingClientRect();
      return { top: row.top, feedTop: feed.top, feedBottom: feed.bottom };
    })()`);
    expect(where.top).toBeGreaterThanOrEqual(where.feedTop - 1); // the message is where the person can see it
    expect(where.top).toBeLessThanOrEqual(where.feedBottom);
  }, 15_000);
});

/** Only the agent spoke: there is no sent message for the copy to mirror. */
const NO_SENT_STUB = `
(function () {
  var reply = Array.from({ length: 60 }, function (_, i) { return "Шаг ответа " + (i + 1); }).join("\\n\\n");
  var blocks = [{ kind: "assistant", id: "a1", text: reply, thinking: "", streaming: false }];
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

describe.skipIf(!hasChrome)("the pinned copy's jump control with no sent message (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(NO_SENT_STUB));
    await waitFor(page, `document.querySelector('[data-block="a1"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("the_copy_stays_hidden_and_its_control_does_nothing", async () => {
    const result = await page.evaluate<{ hidden: boolean; before: number; after: number; threw: boolean }>(`(() => {
      const feed = document.querySelector("main.feed");
      const slot = feed.querySelector(".pin-slot");
      const jump = slot.querySelector('[data-role="pin-jump"]');
      const before = feed.scrollTop;
      let threw = false;
      try { jump.click(); } catch (e) { threw = true; }
      return { hidden: slot.hidden, before, after: feed.scrollTop, threw };
    })()`);
    expect(result.hidden).toBe(true); // no message, no copy
    expect(result.threw).toBe(false); // the control is harmless
    expect(result.after).toBe(result.before); // and it moved nothing
  }, 15_000);
});
