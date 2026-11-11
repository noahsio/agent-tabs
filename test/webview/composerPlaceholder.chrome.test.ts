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

  describe("smart undo: each ⌘Z takes back one step", () => {
    const text = (): Promise<string> => page.evaluate<string>(`document.querySelector('${INPUT}').textContent`);
    /** VS Code's ⌘Z in a webview: `execCommand("undo")` in the page. */
    const undo = (): Promise<unknown> => page.evaluate(`document.execCommand("undo")`);
    /** An empty field with the caret in it and no step left open, as after sending a message. */
    const fresh = (): Promise<unknown> =>
      page.evaluate(`(() => {
        const input = document.querySelector('${INPUT}');
        input.focus();
        document.execCommand("selectAll");
        document.execCommand("delete");
        const selection = getSelection();
        const range = selection.getRangeAt(0);
        selection.removeAllRanges();
        selection.addRange(range);
      })()`);
    const paste = (pasted: string): Promise<unknown> =>
      page.evaluate(`(() => {
        const data = new DataTransfer();
        data.setData("text/plain", ${JSON.stringify(pasted)});
        document.querySelector('${INPUT}').dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      })()`);

    it("typing_after_a_paste_is_taken_back_before_the_paste", async () => {
      await fresh();
      await paste("PASTED");
      await page.type("zz");
      expect(await text()).toBe("PASTEDzz");
      await undo();
      expect(await text()).toBe("PASTED");
      await undo();
      expect(await text()).toBe("");
    }, 20_000);

    it("each_word_is_its_own_step", async () => {
      await fresh();
      await page.type("one two");
      await undo();
      expect(await text()).toBe("one ");
      await undo();
      expect(await text()).toBe("");
    }, 20_000);

    it("a_pause_ends_a_step", async () => {
      await fresh();
      await page.evaluate(`(() => { const real = Date.now; window.__later = 0; Date.now = () => real() + window.__later; })()`);
      await page.type("ab");
      await page.evaluate("window.__later = 2000"); // two seconds on the page's clock, without waiting them
      await page.type("cd");
      await undo();
      expect(await text()).toBe("ab");
      await undo();
      expect(await text()).toBe("");
    }, 20_000);

    it("deleting_after_typing_is_its_own_step", async () => {
      await fresh();
      await page.type("abc");
      await page.key("Backspace");
      expect(await text()).toBe("ab");
      await undo();
      expect(await text()).toBe("abc");
      await undo();
      expect(await text()).toBe("");
    }, 20_000);
  });
});
