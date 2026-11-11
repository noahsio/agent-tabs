import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

const STUB = `
(function () {
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type === "ready") setTimeout(function () {
          window.postMessage(JSON.stringify({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "d1" }, state: { blocks: [], dialogs: [], agents: [], running: false } }), "*");
        }, 5);
      },
    };
  };
})();`;

const INPUT = '.input[contenteditable="true"]';

describe.skipIf(!hasChrome)("the composer's placeholder (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('${INPUT}') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("comes_back_once_typed_text_is_erased", async () => {
    expect(await page.evaluate<boolean>(`document.querySelector('${INPUT}').hasAttribute("data-empty")`)).toBe(true);
    await page.evaluate(`document.querySelector('${INPUT}').focus(); document.execCommand("insertText", false, "abc")`);
    expect(await page.evaluate<boolean>(`document.querySelector('${INPUT}').hasAttribute("data-empty")`)).toBe(false);
    for (let press = 0; press < 3; press++) await page.key("Backspace");
    expect(await page.evaluate<string>(`document.querySelector('${INPUT}').textContent`)).toBe("");
    expect(await page.evaluate<boolean>(`document.querySelector('${INPUT}').hasAttribute("data-empty")`)).toBe(true);
  }, 20_000);
});
