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
});
