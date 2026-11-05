import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** An empty session, so the composer stands on its own. */
const STUB = `
(function () {
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

function height(page: Page, selector: string): Promise<number> {
  return page.evaluate(`(() => document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().height)()`);
}

describe.skipIf(!hasChrome)("the composer box with nothing typed in it (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `(() => document.querySelector(".input") !== null)()`);
  });

  afterAll(async () => {
    await page.close();
  });

  /**
   * The field marks "nothing typed" with an attribute of its own. A class named `empty` would be the feed's hint
   * (`.empty { margin: 24px 0 }`), which padded the empty composer with 48 px of nothing — what the person saw.
   */
  it("stands one_line_tall_and_the_bar_sits_right_under_it", async () => {
    const outer = await height(page, ".composer-box");
    const input = await height(page, ".input");
    const bar = await height(page, ".bar");

    expect(input).toBeLessThan(50); // one line plus its padding, never a second line of margin
    expect(outer - (input + bar)).toBeLessThanOrEqual(2); // the box's own two borders, and nothing else between them
  });

  it("grows_by_one_line_when_a_line_is_typed_and_shrinks_back", async () => {
    const empty = await height(page, ".input");
    await page.evaluate(
      `(() => { const i = document.querySelector(".input"); i.replaceChildren(document.createTextNode("привет"), document.createElement("br"), document.createTextNode("ещё")); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    const two = await height(page, ".input");
    expect(two).toBeGreaterThan(empty);

    await page.evaluate(`(() => { const i = document.querySelector(".input"); i.replaceChildren(); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    expect(await height(page, ".input")).toBe(empty);
  });
});
