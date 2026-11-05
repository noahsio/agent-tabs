import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: one finished tool step, whose header opens and closes it. */
const STUB = `
(function () {
  var blocks = [
    { kind: "tool", id: "t1", name: "bash", summary: "ls -la", input: "ls -la", output: "total 0", truncated: false, state: "ok" },
  ];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

/** The step header's text, which is the part of the row that toggles the step. */
function headerPoint(page: Page): Promise<Point> {
  return page.evaluate<Point>(`(() => {
    const box = document.querySelector("details.tool-details summary").getBoundingClientRect();
    return { x: box.x + 8, y: box.y + Math.min(box.height, 18) / 2 };
  })()`);
}

function isOpen(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`document.querySelector("details.tool-details").open`);
}

describe.skipIf(!hasChrome)("a refocusing click under a real pointer (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector("details.tool-details") !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  // A headless page cannot really be unfocused (there is no window manager to give the focus to), so the blur the
  // webview would get is dispatched by hand; everything after it — hit testing, the pointer and click events, the
  // step's native toggle — is the browser's own.
  it("the_first_click_after_a_blur_does_not_open_the_step", async () => {
    const header = await headerPoint(page);
    const before = await isOpen(page);

    await page.evaluate(`window.dispatchEvent(new Event("blur"))`);
    await page.click(header);
    expect(await isOpen(page)).toBe(before);

    await page.click(header);
    expect(await isOpen(page)).toBe(!before);
  }, 15_000);
});
