import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: three sent messages, each under its own reply that is taller than the tab can show at once. */
const STUB = `
(function () {
  var reply = function (tag) { return Array.from({ length: 30 }, function (_, i) { return tag + " шаг " + (i + 1); }).join("\\n\\n"); };
  var long = Array.from({ length: 20 }, function (_, i) { return "Строка " + (i + 1); }).join("\\n");
  var blocks = [
    { kind: "user", id: "u1", text: "Сообщение один" },
    { kind: "assistant", id: "a1", text: reply("A"), thinking: "", streaming: false },
    { kind: "user", id: "u2", text: long },
    { kind: "assistant", id: "a2", text: reply("B"), thinking: "", streaming: false },
    { kind: "user", id: "u3", text: "Сообщение три" },
    { kind: "assistant", id: "a3", text: reply("C"), thinking: "", streaming: false },
  ];
  var send = function (bl) {
    window.postMessage(JSON.stringify({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: bl, dialogs: [], agents: [], running: false } }), "*");
  };
  window.__blocks = blocks;
  window.__send = send;
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) { if (message.type === "ready") setTimeout(function () { send(blocks); }, 5); },
    };
  };
})();`;

/** A box, in feed-relative coordinates: a bubble's `top` is how far below the feed's own top edge it sits. */
type Box = { top: number; bottom: number; height: number };

function bubble(page: Page, id: string): Promise<Box | null> {
  return page.evaluate<Box | null>(`(() => {
    const row = document.querySelector('[data-block="${id}"] .user-bubble');
    if (row === null) return null;
    const r = row.getBoundingClientRect();
    const f = document.querySelector("main.feed").getBoundingClientRect();
    return { top: r.top - f.top, bottom: r.bottom - f.top, height: r.height };
  })()`);
}

function feedHeight(page: Page): Promise<number> {
  return page.evaluate<number>(`document.querySelector("main.feed").getBoundingClientRect().height`);
}

/** The feed's top inset (`--feed-top`), the line a stuck bubble rests against. */
function inset(page: Page): Promise<number> {
  return page.evaluate<number>(`parseFloat(getComputedStyle(document.querySelector("main.feed")).getPropertyValue("--feed-top")) || 8`);
}

function settle(page: Page): Promise<unknown> {
  return page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}

/**
 * Scrolls so `id`'s *natural* top lands `viewportTop` px below the feed's top edge. The natural top is read at
 * `scrollTop = 0`, where nothing is stuck, so a sticky bubble's clamped rect never throws the maths off.
 */
async function scrollSo(page: Page, id: string, viewportTop: number): Promise<void> {
  await page.evaluate(`document.querySelector("main.feed").scrollTop = 0`);
  await settle(page);
  await page.evaluate(`(() => {
    const feed = document.querySelector("main.feed");
    const r = document.querySelector('[data-block="${id}"]').getBoundingClientRect();
    feed.scrollTop = (r.top - feed.getBoundingClientRect().top) - ${viewportTop};
  })()`);
  await settle(page);
}

describe.skipIf(!hasChrome)("sent bubbles that stick natively (headless Chrome)", () => {
  let page: Page;
  const SHOTS = "/tmp/agent-tabs-shots/native-sticky";

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="a3"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("the_latest_sent_bubble_is_stuck_at_the_feed_top_at_the_bottom", async () => {
    await page.evaluate(`document.querySelector("main.feed").scrollTop = document.querySelector("main.feed").scrollHeight`);
    await settle(page);
    const u3 = await bubble(page, "u3");
    const gap = await inset(page);
    expect(u3).not.toBeNull();
    expect((u3 as Box).top).toBeGreaterThanOrEqual(gap - 1); // resting on the top inset, not above it
    expect((u3 as Box).top).toBeLessThan(28); // and not scrolled down the feed: it is stuck at the top line
    // The real bubble is the one at the top — no copy doubling its text anywhere.
    const copies = await page.evaluate<number>(`Array.from(document.querySelectorAll(".user-text")).filter((n) => (n.textContent ?? "").trim() === "Сообщение три").length`);
    expect(copies).toBe(1);
  });

  it("the_next_bubble_pushes_the_stuck_one_up_and_out_and_takes_its_place", async () => {
    await scrollSo(page, "u2", -100); // deep in u2's turn: u2 stuck at the top, u3 far below
    const restU2 = await bubble(page, "u2");
    expect((restU2 as Box).top).toBeGreaterThanOrEqual((await inset(page)) - 1);
    expect((restU2 as Box).top).toBeLessThan(28); // u2 resting on the top line
    await page.screenshot(`${SHOTS}/stuck-midscroll.png`); // one bubble stuck mid-feed, the reply scrolling under it

    await scrollSo(page, "u3", 16); // u3's top has reached the top line, right where u2 rests
    const pushedU2 = await bubble(page, "u2");
    const arrivedU3 = await bubble(page, "u3");
    expect((pushedU2 as Box).top).toBeLessThan((restU2 as Box).top - 10); // u2 shoved up by u3's arrival
    expect((pushedU2 as Box).bottom).toBeLessThanOrEqual((arrivedU3 as Box).top + 1); // u2 rides above u3, not over it
    expect((arrivedU3 as Box).top).toBeLessThan(28); // u3 taking the top
    await page.screenshot(`${SHOTS}/handoff.png`); // the hand-off: u3's top meeting u2 and carrying it off
  });

  it("agent_and_tool_rows_never_stick", async () => {
    const sticky = await page.evaluate<boolean>(`Array.from(document.querySelectorAll(".entry.steps")).some((e) => getComputedStyle(e).position === "sticky")`);
    expect(sticky).toBe(false); // only sent bubbles are sticky
    await scrollSo(page, "a1", -40); // scroll a reply up past the top edge
    const a1 = await page.evaluate<number>(`(() => { const r = document.querySelector('[data-block="a1"]').getBoundingClientRect(); const f = document.querySelector("main.feed").getBoundingClientRect(); return r.top - f.top; })()`);
    expect(a1).toBeLessThan(0); // the reply scrolled away above the edge; it did not pin there
  });

  it("at_the_very_top_the_first_message_leads_with_nothing_stacked_over_it", async () => {
    await page.evaluate(`document.querySelector("main.feed").scrollTop = 0`);
    await settle(page);
    const u1 = await bubble(page, "u1");
    const u2 = await bubble(page, "u2");
    const gap = await inset(page);
    expect((u1 as Box).top).toBeGreaterThanOrEqual(gap - 1); // u1 sits at the top in natural flow
    expect((u2 as Box).top).toBeGreaterThan((u1 as Box).bottom); // u2 is far below, not stacked over u1
  });

  it("a_long_stuck_bubble_does_not_swallow_the_feed", async () => {
    await scrollSo(page, "u2", -100); // u2 (a 20-line message) stuck at the top while its reply shows below
    const u2 = await bubble(page, "u2");
    const height = await feedHeight(page);
    expect((u2 as Box).top).toBeLessThan(28); // it is the stuck one
    expect((u2 as Box).height).toBeLessThan(0.6 * height); // yet capped: content below it stays in view
  });

  it("a_streaming_re_render_keeps_the_stuck_bubble_in_place", async () => {
    await scrollSo(page, "u2", -100); // u2 stuck at the top
    const before = await page.evaluate<{ top: number; scroll: number }>(`(() => {
      const r = document.querySelector('[data-block="u2"] .user-bubble').getBoundingClientRect();
      const f = document.querySelector("main.feed");
      return { top: r.top - f.getBoundingClientRect().top, scroll: f.scrollTop };
    })()`);
    await page.evaluate(`(() => { const b = window.__blocks.map((x) => ({ ...x })); const a2 = b.find((x) => x.id === "a2"); a2.text = a2.text + "\\n\\nновый шаг"; window.__send(b); })()`);
    await settle(page);
    const after = await page.evaluate<{ top: number; scroll: number }>(`(() => {
      const r = document.querySelector('[data-block="u2"] .user-bubble').getBoundingClientRect();
      const f = document.querySelector("main.feed");
      return { top: r.top - f.getBoundingClientRect().top, scroll: f.scrollTop };
    })()`);
    expect(after.scroll).toBe(before.scroll); // the agent streamed on, but the feed did not jump
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1); // and the stuck bubble held its line
  });
});
