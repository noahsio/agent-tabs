import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

const TEXT = "Скопируй эту строку целиком";

/**
 * The tab, plus what VS Code 1.143's webview wrapper does with ⌘C (its pre/index.html): the key is taken from the page
 * on the window, and a `copy` comes back a moment later — after the wrapper focuses the field last focused whenever the
 * document's own focus is on the body.
 */
const STUB = `
(function () {
  var answer = { kind: "assistant", id: "a1", text: ${JSON.stringify(TEXT)}, thinking: "", streaming: false, timestamp: 1000 };
  var lastFocused;
  window.addEventListener("focusin", function () {
    var focused = document.activeElement;
    if (focused && focused !== document.body && focused !== document.documentElement) lastFocused = focused;
  });
  window.addEventListener("keydown", function (event) {
    if (!(event.metaKey || event.ctrlKey) || event.keyCode !== 67) return;
    event.preventDefault();
    window.__forwarded = (window.__forwarded || 0) + 1;
    setTimeout(function () {
      if (document.activeElement === document.body && lastFocused && lastFocused.isConnected) lastFocused.focus({ preventScroll: true });
      document.execCommand("copy");
    }, 20);
  });
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type === "ready") setTimeout(function () {
          window.postMessage(JSON.stringify({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [answer], dialogs: [], agents: [], running: false } }), "*");
        }, 5);
      },
    };
  };
})();`;

describe.skipIf(!hasChrome)("⌘C over the feed inside VS Code's webview wrapper (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="a1"]')?.textContent.includes(${JSON.stringify(TEXT)}) === true`);
    await page.clipboard(); // the page may use the clipboard from here on
  }, 30_000);

  afterAll(() => page?.close());

  it("copies_the_selection_and_keeps_it_after_the_person_typed_in_the_composer", async () => {
    await page.evaluate(`document.querySelector('[contenteditable="true"]').focus()`); // typed in the composer before
    await page.evaluate(`navigator.clipboard.writeText("было раньше")`, { userGesture: true });
    const line = await page.evaluate<{ from: Point; to: Point }>(`(() => {
      const walker = document.createTreeWalker(document.querySelector('[data-block="a1"]'), NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      return { from: { x: r.x + 1, y: r.y + r.height / 2 }, to: { x: r.right - 1, y: r.y + r.height / 2 } };
    })()`);
    await page.drag(line.from, line.to);
    const selected = await page.evaluate<string>("getSelection().toString()");
    expect(selected.length).toBeGreaterThan(0);
    expect(await page.evaluate<boolean>("document.activeElement === document.body")).toBe(true);

    await page.key("c", { meta: true });
    expect(await page.evaluate<number>("window.__forwarded || 0")).toBe(0); // so no delayed copy and no refocus can follow
    expect(await page.clipboard()).toBe(selected);
    expect(await page.evaluate<string>("getSelection().toString()")).toBe(selected);
  }, 20_000);
});
