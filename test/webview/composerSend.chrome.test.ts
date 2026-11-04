import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** An empty session; `window.__show(running)` paints the state again with the turn on or off. */
const STUB = `
(function () {
  window.__posted = [];
  window.__show = function (running) {
    var message = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "d1" }, state: { blocks: [], dialogs: [], agents: [], running: running } };
    window.postMessage(JSON.stringify(message), "*");
  };
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type === "ready") setTimeout(function () { window.__show(false); }, 5);
      },
    };
  };
})();`;

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

function rect(page: Page, selector: string): Promise<Box> {
  return page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`);
}

const SEND = '[data-role="send"]';

async function centre(page: Page): Promise<{ x: number; y: number }> {
  const box = await rect(page, SEND);
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

function sends(page: Page): Promise<number> {
  return page.evaluate<number>(`window.__posted.filter((message) => message.type === "send").length`);
}

describe.skipIf(!hasChrome)("the send button in the composer's bar (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('${SEND}') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("sits_at_the_right_end_of_the_bar_past_every_other_control", async () => {
    await page.evaluate(`window.__show(false)`);
    const bar = await rect(page, ".bar");
    const send = await rect(page, SEND);
    const model = await rect(page, '[data-role="model-pill"]');
    expect(send.left).toBeGreaterThan(model.right); // after the pills, across the spacer
    expect(bar.right - send.right).toBeLessThanOrEqual(12); // the bar's own padding, nothing else
    expect(Math.abs((send.top + send.bottom) / 2 - (bar.top + bar.bottom) / 2)).toBeLessThanOrEqual(1); // centred in the bar
    const last = await page.evaluate<string>(
      `(() => { const bar = document.querySelector(".bar"); const shown = [...bar.children].filter((node) => !node.hidden && node.getBoundingClientRect().width > 0); return shown[shown.length - 1].dataset.role ?? ""; })()`,
    );
    expect(last).toBe("send");
  });

  it("is_muted_while_the_composer_is_empty_and_a_real_click_on_it_sends_nothing", async () => {
    expect(await page.evaluate<boolean>(`document.querySelector('${SEND}').disabled`)).toBe(true);
    const before = await sends(page);
    await page.click(await centre(page));
    expect(await sends(page)).toBe(before);
  });

  it("a_typed_message_lights_it_up_and_a_real_click_sends_that_message", async () => {
    await page.evaluate(`(() => { const input = document.querySelector("textarea.input"); input.value = "поехали"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    expect(await page.evaluate<boolean>(`document.querySelector('${SEND}').disabled`)).toBe(false);

    await page.click(await centre(page));
    await waitFor(page, `window.__posted.some((message) => message.type === "send")`);
    expect(await page.evaluate<string>(`window.__posted.find((message) => message.type === "send").text`)).toBe("поехали");
    expect(await page.evaluate<string>(`document.querySelector("textarea.input").value`)).toBe("");
    expect(await page.evaluate<boolean>(`document.querySelector('${SEND}').disabled`)).toBe(true);
  });

  it("stop_takes_the_last_place_while_a_turn_runs_and_send_keeps_its_own", async () => {
    await page.evaluate(`window.__show(true)`);
    await waitFor(page, `document.querySelector('[data-role="stop"]').hidden === false`);
    const send = await rect(page, SEND);
    const stop = await rect(page, '[data-role="stop"]');
    expect(send.width).toBeGreaterThan(0);
    expect(stop.left).toBeGreaterThanOrEqual(send.right); // stop stays last
    expect(await page.evaluate<string>(`document.querySelector('${SEND}').title`)).toBe("В очередь после текущего хода");
  });
});
