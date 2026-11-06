import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** Paints an arbitrary session state; the host side decides queued-vs-error, this only shows what it was handed. */
const STUB = `
(function () {
  window.__post = function (state) {
    window.postMessage(JSON.stringify({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "d1" }, state: state }), "*");
  };
  window.acquireVsCodeApi = function () {
    return { getState: function () { return undefined; }, setState: function () {}, postMessage: function () {} };
  };
})();`;

const BANNER = '[data-role="banner"]';

describe.skipIf(!hasChrome)("a message queued while a compaction runs (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('${BANNER}') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("shows_the_message_as_queued_and_raises_no_error_banner", async () => {
    await page.evaluate(
      `window.__post({ compacting: true, running: false, dialogs: [], agents: [], blocks: [{ kind: "user", id: "m1", text: "во время компакта", delivery: { state: "queued", queuedId: "q1" } }] })`,
    );
    await waitFor(page, `document.querySelector(".queued-label") !== null`);
    expect(await page.evaluate<string>(`document.querySelector(".queued-label").textContent`)).toBe("в очереди — ждёт агента");
    expect(await page.evaluate<boolean>(`document.querySelector('${BANNER}').hidden`)).toBe(true);
  });

  it("still_raises_the_banner_for_a_must_act_error", async () => {
    await page.evaluate(`window.__post({ compacting: false, running: false, dialogs: [], agents: [], blocks: [], error: "Модель профиля ещё неизвестна" })`);
    await waitFor(page, `document.querySelector('${BANNER}').hidden === false`);
    expect(await page.evaluate<string>(`document.querySelector(".banner-text").textContent`)).toContain("Модель профиля");
  });
});
