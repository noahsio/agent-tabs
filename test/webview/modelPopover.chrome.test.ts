import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: a session with 30 models and three power levels. */
const STUB = `
(function () {
  var models = [];
  for (var i = 0; i < 30; i++) models.push({ provider: "gw-openai", id: "m" + i, name: "Model " + i });
  function reply(message) { setTimeout(function () { window.postMessage(JSON.stringify(message), "*"); }, 5); }
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type === "ready") reply({ type: "state", reconnectable: true, commands: [], models: models, thinkingLevels: ["low", "medium", "high"], tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: false, thinkingLevel: "medium" } });
      },
    };
  };
})();`;

type Geometry = { popHeight: number; footTop: number; footBottom: number; popTop: number; popBottom: number; listScrollTop: number; listOverflows: boolean };

const GEOMETRY = `(() => {
  const pop = document.querySelector('[data-popover="model"]');
  const list = pop.querySelector('[data-role="model-list"]');
  const foot = pop.querySelector('[data-role="model-foot"]');
  const p = pop.getBoundingClientRect();
  const f = foot.getBoundingClientRect();
  return { popHeight: p.height, popTop: p.top, popBottom: p.bottom, footTop: f.top, footBottom: f.bottom, listScrollTop: list.scrollTop, listOverflows: list.scrollHeight > list.clientHeight };
})()`;

describe.skipIf(!hasChrome)("the model picker in a real browser (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB), { width: 900, height: 700 });
    await waitFor(page, `document.querySelector('[data-role="model-pill"]') !== null`);
    await page.evaluate(`document.querySelector('[data-role="model-pill"]').click()`);
    await waitFor(page, `!document.querySelector('[data-popover="model"]').hidden`);
  }, 30_000);

  afterAll(() => page?.close());

  it("is_at_most_half_the_viewport_with_a_scrolling_list_and_a_pinned_footer", async () => {
    const before = await page.evaluate<Geometry>(GEOMETRY);
    expect(before.popHeight).toBeLessThanOrEqual(350);
    expect(before.listOverflows).toBe(true);
    expect(before.footTop).toBeGreaterThanOrEqual(before.popTop);
    expect(before.footBottom).toBeLessThanOrEqual(before.popBottom + 0.5);
    const centre = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-role="model-list"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page.wheel(centre, 400);
    await waitFor(page, `document.querySelector('[data-role="model-list"]').scrollTop > 0`);
    const after = await page.evaluate<Geometry>(GEOMETRY);
    expect(after.listScrollTop).toBeGreaterThan(0);
    expect(after.footTop).toBe(before.footTop);
    expect(after.footBottom).toBe(before.footBottom);
    expect(after.popHeight).toBe(before.popHeight);
  }, 15_000);

  it("keeps_the_arrow_focused_row_inside_the_list", async () => {
    await page.evaluate(`document.querySelector('[data-role="model-auto"]').focus()`);
    for (let step = 0; step < 20; step++) await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))`);
    const visible = await page.evaluate<boolean>(`(() => {
      const row = document.activeElement.getBoundingClientRect();
      const list = document.querySelector('[data-role="model-list"]').getBoundingClientRect();
      return document.activeElement.dataset.model === "gw-openai/m19" && row.top >= list.top - 0.5 && row.bottom <= list.bottom + 0.5;
    })()`);
    expect(visible).toBe(true);
  }, 15_000);
});
