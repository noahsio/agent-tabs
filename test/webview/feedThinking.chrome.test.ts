import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** A turn whose assistant is thinking right now: the step must tick its seconds, and the bottom «Думаю…» must not appear. */
const STUB = `
(function () {
  var now = Date.now();
  var blocks = [
    { kind: "user", id: "u1", text: "Задача", timestamp: now - 10000 },
    { kind: "assistant", id: "a1", text: "", thinking: "Разбираю условие и прикидываю решение…", streaming: true, thinkingStartedAt: now - 5000, timestamp: now - 5000 },
  ];
  window.acquireVsCodeApi = function () {
    return { getState:function(){return undefined;}, setState:function(){}, postMessage:function(m){
      if (m.type === "ready") setTimeout(function(){ window.postMessage(JSON.stringify({ type:"state", reconnectable:true, tab:{modelMode:"auto",durableId:"id-1"}, state:{blocks:blocks,dialogs:[],agents:[],running:true,activity:"thinking"} }), "*"); }, 5);
    } };
  };
})();`;

describe.skipIf(!hasChrome)("a thinking turn shows one ticking line (headless Chrome)", () => {
  let page: Page;
  const SHOTS = "/tmp/agent-tabs-shots/thinking";

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-role="thinking-live"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("the_step_ticks_the_seconds_and_the_bottom_indicator_stays_hidden", async () => {
    const indicatorHidden = await page.evaluate<boolean>(`document.querySelector('[data-role="indicator"]').hidden`);
    expect(indicatorHidden).toBe(true); // only the step carries the thinking line, not the bottom «Думаю…»

    const first = await page.evaluate<string>(`document.querySelector('[data-role="thinking-live"]').textContent`);
    expect(first).toContain("Размышляю");
    await page.screenshot(`${SHOTS}/thinking-ticking.png`);

    // let the interval tick across a couple of seconds, then read the label again
    await waitFor(
      page,
      `(() => { const t = document.querySelector('[data-role="thinking-live"]').textContent.match(/(\\d+)/); return t && Number(t[1]) > ${seconds(first)}; })()`,
      4_000,
    );
    const later = await page.evaluate<string>(`document.querySelector('[data-role="thinking-live"]').textContent`);
    expect(seconds(later)).toBeGreaterThan(seconds(first));
  });

  function seconds(label: string): number {
    return Number(label.match(/(\d+)/)?.[1] ?? "0");
  }
});
