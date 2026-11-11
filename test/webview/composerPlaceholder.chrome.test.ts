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

describe.skipIf(!hasChrome)("the composer's placeholder and undo (headless Chrome)", () => {
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

  /**
   * VS Code pastes into a webview with `execCommand("paste")`, so the tab's paste handler runs inside another editing
   * command. Here an outer `insertText` stands in for it and fires the paste from its own `input` event.
   */
  it("a_paste_made_inside_vs_codes_paste_command_is_undone_by_cmd_z", async () => {
    await page.evaluate(`(() => {
      const input = document.querySelector('${INPUT}');
      input.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");
      document.execCommand("insertText", false, "abc");
      input.addEventListener("input", () => {
        const data = new DataTransfer();
        data.setData("text/plain", "PASTED");
        input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      }, { once: true });
      document.execCommand("insertText", false, "x");
    })()`);
    expect(await page.evaluate<string>(`document.querySelector('${INPUT}').textContent`)).toBe("abcxPASTED");
    await page.evaluate(`document.execCommand("undo")`);
    expect(await page.evaluate<string>(`document.querySelector('${INPUT}').textContent`)).toBe("abcx");
  }, 20_000);
});
