import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

const SHOTS = "/tmp/agent-tabs-shots/levels";

/**
 * A session on a gateway model the catalogue said nothing about, with the ladder OmO answers once the entry is marked
 * as thinking (live proof in `test/live/thinkingLevels.live.test.ts`). The stub records what the picker posts back.
 */
const STUB = `
(function () {
  var models = [
    { provider: "gw-anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
    { provider: "gw-anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  ];
  window.__posted = [];
  function state(id, levels, level) {
    return {
      type: "state",
      reconnectable: true,
      commands: [],
      models: models,
      thinkingLevels: levels,
      tab: { modelMode: "manual", durableId: "id-1" },
      state: { blocks: [], dialogs: [], agents: [], running: false, model: { provider: "gw-anthropic", id: id }, thinkingLevel: level },
    };
  }
  window.__show = function (id, levels, level) { window.postMessage(JSON.stringify(state(id, levels, level)), "*"); };
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type === "ready") {
          setTimeout(function () { window.__show("claude-opus-5", ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "medium"); }, 5);
        }
      },
    };
  };
})();`;

type Track = { notches: number; width: number; knobAt: number; label: string };

const TRACK = `(() => {
  const pop = document.querySelector('[data-popover="model"]');
  const slider = pop.querySelector('[role="slider"]');
  const knob = slider.querySelector(".notch.cur").getBoundingClientRect();
  const box = slider.getBoundingClientRect();
  return {
    notches: slider.querySelectorAll(".notch").length,
    width: box.width,
    knobAt: (knob.left + knob.width / 2 - box.left) / box.width,
    label: pop.querySelector('[data-role="effort-label"]').textContent,
  };
})()`;

describe.skipIf(!hasChrome)("the power ladder in a real browser (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    page = await openPage(await webviewPage(STUB), { width: 900, height: 700 });
    await waitFor(page, `document.querySelector('[data-role="model-pill"]') !== null`);
    await page.evaluate(`document.querySelector('[data-role="model-pill"]').click()`);
    await waitFor(page, `!document.querySelector('[data-popover="model"]').hidden`);
  }, 60_000);

  afterAll(async () => {
    await page.close();
  });

  it("a_gateway_model_shows_every_step_omo_reports_and_a_click_lands_on_the_one_under_the_pointer", async () => {
    await waitFor(page, `document.querySelector('[data-popover="model"] [role="slider"]') !== null`);
    const track = await page.evaluate<Track>(TRACK);
    expect(track.notches).toBe(7); // the whole ladder, not one dead step
    expect(track.width).toBeGreaterThan(100);
    expect(track.knobAt).toBeGreaterThan(0.4); // «medium» of seven sits in the middle of the track
    expect(track.knobAt).toBeLessThan(0.6);
    expect(track.label).toBe("Мощность (medium)");
    await page.screenshot(join(SHOTS, "opus-5-ladder.png"));

    // real hit testing: the browser picks the notch, not the test
    const at = await page.evaluate<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('[data-level="xhigh"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    await page.click(at);
    await waitFor(page, `window.__posted.some((m) => m.type === "setThinking" && m.level === "xhigh")`);
    expect(await page.evaluate<string>(`document.querySelector('[data-role="effort-label"]').textContent`)).toBe("Мощность (xhigh)");
    await page.screenshot(join(SHOTS, "opus-5-xhigh.png"));
  }, 30_000);

  it("a_model_that_reports_one_level_paints_a_plain_row_with_no_track_at_all", async () => {
    await page.evaluate(`window.__show("claude-haiku-5-5", ["off"], "off")`);
    await waitFor(page, `document.querySelector('[data-popover="model"] [data-role="effort-only"]') !== null`);
    const row = await page.evaluate<{ slider: boolean; text: string; height: number }>(`(() => {
      const pop = document.querySelector('[data-popover="model"]');
      const only = pop.querySelector('[data-role="effort-only"]');
      return { slider: pop.querySelector('[role="slider"]') !== null, text: only.textContent, height: only.getBoundingClientRect().height };
    })()`);
    expect(row.slider).toBe(false); // nothing to slide, so nothing that looks like it
    expect(row.text).toBe("эта модель не размышляет");
    expect(row.height).toBeGreaterThan(0); // and the words are actually painted
    await page.screenshot(join(SHOTS, "haiku-no-thinking.png"));
  }, 30_000);
});
