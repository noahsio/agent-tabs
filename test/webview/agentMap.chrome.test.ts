import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

const STUB = `
(function () {
  var agents = [];
  for (var n = 0; n < 20; n++) agents.push({ id: "a" + n, label: "Агент " + n, status: n === 0 ? "running" : "done", startedAt: 1000 - n, endedAt: 2000, tokens: 1500 });
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type === "ready") setTimeout(function () {
          window.postMessage(JSON.stringify({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: agents, running: true, activity: "thinking", title: "Главная", contextTokens: 1000 } }), "*");
        }, 5);
      },
    };
  };
})();`;

type Box = { top: number; bottom: number; height: number };

describe.skipIf(!hasChrome)("agent map with many agents (headless Chrome, 700 px high)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-role="agents-pill"]') !== null`);
    await page.evaluate(`document.querySelector('[data-role="agents-pill"]').click()`);
    await waitFor(page, `document.querySelectorAll('.am-cards [data-row]').length === 20`);
  }, 30_000);

  afterAll(() => page?.close());

  const box = (selector: string): Promise<Box> =>
    page.evaluate<Box>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; })()`);

  it("fits the window, keeps the header, and scrolls the body", async () => {
    const panel = await box(".agent-map");
    expect(panel.top).toBeGreaterThanOrEqual(0);
    expect(panel.bottom).toBeLessThanOrEqual(700);
    const head = await box(".am-head");
    expect(head.top).toBeGreaterThanOrEqual(panel.top);
    const scrolls = await page.evaluate<boolean>(`(() => { const b = document.querySelector('.am-body'); return b.scrollHeight > b.clientHeight && getComputedStyle(b).overflowY === 'auto'; })()`);
    expect(scrolls).toBe(true);
    await page.evaluate(`document.querySelector('.am-body').scrollTop = 99999`);
    expect((await box(".am-head")).top).toBe(head.top); // the header did not move
  });

  it("puts the session card level with the first agent card", async () => {
    await page.evaluate(`document.querySelector('.am-body').scrollTop = 0`);
    const root = await box(".am-root");
    const first = await box(".am-cards [data-row]");
    expect(Math.abs(root.top - first.top)).toBeLessThanOrEqual(2);
  });
});
