import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** A sent message carries a timestamp row; it must read as a thin line, not a tall gap above the bubble. */
const STUB = `
(function () {
  var now = Date.now();
  var reply = function (tag) { return Array.from({ length: 30 }, function (_, i) { return tag + " шаг " + (i + 1); }).join("\\n\\n"); };
  var blocks = [
    { kind: "user", id: "u1", text: "Первое сообщение", timestamp: now - 600000 },
    { kind: "tool", id: "t1", name: "bash", summary: "ls", args: {}, input: "ls", output: "file1", truncated: false, state: "ok", timestamp: now - 590000 },
    { kind: "assistant", id: "a1", text: reply("A"), thinking: "", streaming: false, timestamp: now - 580000 },
  ];
  window.acquireVsCodeApi = function () {
    return { getState:function(){return undefined;}, setState:function(){}, postMessage:function(m){
      if (m.type === "ready") setTimeout(function(){ window.postMessage(JSON.stringify({ type:"state", reconnectable:true, tab:{modelMode:"auto",durableId:"id-1"}, state:{blocks:blocks,dialogs:[],agents:[],running:false} }), "*"); }, 5);
    } };
  };
})();`;

function settle(page: Page): Promise<unknown> {
  return page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}

describe.skipIf(!hasChrome)("a sent bubble sits close under what came before (headless Chrome)", () => {
  let page: Page;
  const SHOTS = "/tmp/agent-tabs-shots/feed-polish";

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="a1"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("the_timestamp_above_a_sent_bubble_is_a_thin_line_not_a_tall_gap", async () => {
    const ts = await page.evaluate<number>(`document.querySelector('[data-block="u1"] > .ts').getBoundingClientRect().height`);
    expect(ts).toBeGreaterThan(0); // the time is shown
    expect(ts).toBeLessThanOrEqual(20); // but as a thin line (was ~32–42px), so the bubble sits close under it
  });

  it("a_stuck_sent_bubble_sits_snug_at_the_feed_top", async () => {
    await page.evaluate(`(() => { const f=document.querySelector("main.feed"); const r=document.querySelector('[data-block="u1"]').getBoundingClientRect(); f.scrollTop=(r.top-f.getBoundingClientRect().top)+150; })()`);
    await settle(page);
    const gap = await page.evaluate<{ entry: number; bubble: number; stuck: boolean }>(`(() => {
      const f = document.querySelector("main.feed").getBoundingClientRect();
      const e = document.querySelector('[data-block="u1"]');
      return { entry: e.getBoundingClientRect().top - f.top, bubble: e.querySelector('.user-bubble').getBoundingClientRect().top - f.top, stuck: e.classList.contains("is-stuck") };
    })()`);
    expect(gap.stuck).toBe(true); // it is pinned to the top
    expect(gap.entry).toBeLessThanOrEqual(10); // the entry (its thin timestamp included) hugs the feed top
    expect(gap.bubble).toBeLessThanOrEqual(28); // and the bubble follows right under the thin time, no big gap
    await page.screenshot(`${SHOTS}/stuck-snug.png`);
  });

  it("a_stuck_head_has_a_soft_edged_full_width_backing_that_reaches_the_top", async () => {
    await page.evaluate(`(() => { const f=document.querySelector("main.feed"); const r=document.querySelector('[data-block="u1"]').getBoundingClientRect(); f.scrollTop=(r.top-f.getBoundingClientRect().top)+320; })()`);
    await settle(page);
    const band = await page.evaluate<{ stuck: boolean; aboveFade: boolean; content: string; bg: string; left: number; right: number; top: number }>(`(() => {
      const e = document.querySelector('[data-block="u1"]');
      const cs = getComputedStyle(e);
      const bf = getComputedStyle(e, "::before"); // the backing is a pseudo, not a solid entry fill
      return {
        stuck: e.classList.contains("is-stuck"),
        aboveFade: Number(cs.zIndex) > 3, // over the top fade, so the time stays crisp
        content: bf.content,
        bg: bf.backgroundImage,
        left: parseFloat(bf.left), right: parseFloat(bf.right), top: parseFloat(bf.top),
      };
    })()`);
    expect(band.stuck).toBe(true);
    expect(band.aboveFade).toBe(true); // the head sits over the fade, so the timestamp is fully visible
    expect(band.content).not.toBe("none"); // the backing pseudo is present
    expect(band.bg).toMatch(/linear-gradient/); // a soft-edged fill, not a hard-edged solid box
    expect(band.bg).toMatch(/,\s*0\)/); // it dissolves to transparent at an edge (no rectangle line)
    expect(band.left).toBeLessThan(0); // stretches into the side gutters: the full feed width, no bleed beside the bubble
    expect(band.right).toBeLessThan(0);
    expect(band.top).toBeLessThan(0); // reaches up past the feed's top edge (clipped under the header): no strip above
    await page.screenshot(`/tmp/agent-tabs-shots/stuck-blend/stuck.png`); // rows scrolling behind: no rectangle, no gap, no bleed
  });

  it("an_in_flow_sent_bubble_has_no_backing_at_all", async () => {
    await page.evaluate(`document.querySelector("main.feed").scrollTop = 0`); // u1 back in its place, not stuck
    await settle(page);
    await page.screenshot(`/tmp/agent-tabs-shots/stuck-blend/inflow.png`); // unchanged: thin time, snug bubble, no backing
    const inflow = await page.evaluate<{ stuck: boolean; bg: string }>(`(() => {
      const e = document.querySelector('[data-block="u1"]');
      return { stuck: e.classList.contains("is-stuck"), bg: getComputedStyle(e, "::before").backgroundImage };
    })()`);
    expect(inflow.stuck).toBe(false);
    expect(inflow.bg).toBe("none"); // in flow there is no backing pseudo — the opaque fill is the stuck state only
  });
});
