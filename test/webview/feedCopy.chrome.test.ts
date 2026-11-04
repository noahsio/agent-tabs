import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

const URL_TEXT = "https://example.com/some/long/path?q=1";
const OUTPUT_LINES = 300;

/**
 * Stands in for VS Code while a turn runs: a finished message with a code block, a running step with a long output,
 * and an assistant message still being streamed — the one the host rewrites every few dozen milliseconds.
 */
const STUB = `
(function () {
  var url = "${URL_TEXT}";
  var output = Array.from({ length: ${OUTPUT_LINES} }, function (_, i) { return "строка " + (i + 1); }).join("\\n");
  var code = { kind: "assistant", id: "a1", text: "Запусти:\\n\\n\\u0060\\u0060\\u0060sh\\nls -la /tmp\\ncd /tmp\\n\\u0060\\u0060\\u0060\\n", thinking: "", streaming: false, timestamp: 1000 };
  var step = { kind: "tool", id: "t1", name: "bash", summary: "ls", output: output, truncated: false, state: "ok", input: "ls -la /tmp", timestamp: 1500 };
  var live = { kind: "assistant", id: "a2", text: "Открой " + url + " и смотри", thinking: "", streaming: true, timestamp: 2000 };
  /** Resolves once the tab has taken the state: the message task runs before a timeout queued after it. */
  var push = function () {
    var blocks = [code, step, live].map(function (block) { return JSON.parse(JSON.stringify(block)); });
    window.postMessage(JSON.stringify({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: true } }), "*");
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  };
  window.__grow = function (extra) {
    live = { kind: "assistant", id: "a2", text: live.text + extra, thinking: "", streaming: true, timestamp: 2000 };
    return push();
  };
  window.__posted = [];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type === "ready") setTimeout(push, 5);
      },
    };
  };
})();`;

/** Selects `text` where it stands inside `selector`, the way a person's drag over it would. */
const selectIn = (selector: string, text: string): string => `(() => {
  const walker = document.createTreeWalker(document.querySelector('${selector}'), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const start = node.textContent.indexOf(${JSON.stringify(text)});
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + ${JSON.stringify(text)}.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return getSelection().toString();
  }
  throw new Error("no node holds the text");
})()`;

function centre(page: Page, selector: string): Promise<Point> {
  return page.evaluate<Point>(`(() => {
    const r = document.querySelector('${selector}').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
}

function opacity(page: Page, selector: string): Promise<string> {
  return page.evaluate<string>(`getComputedStyle(document.querySelector('${selector}')).opacity`);
}

describe.skipIf(!hasChrome)("copying out of the feed (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="a2"] a') !== null`);
    await page.clipboard(); // the page may use navigator.clipboard from here on
  }, 30_000);

  afterAll(() => page?.close());

  it("a_selection_in_the_message_being_streamed_outlives_the_next_update_and_the_clipboard_gets_it", async () => {
    expect(await page.evaluate<string>(selectIn('[data-block="a2"]', URL_TEXT))).toBe(URL_TEXT);

    await page.evaluate("window.__grow(' и ещё')"); // the host's next delta, as they arrive every ~50 ms
    expect(await page.evaluate<string>("getSelection().toString()")).toBe(URL_TEXT);

    // What the editor's menu and ⌘C both end in: a copy of the document's selection.
    expect(await page.evaluate<boolean>(`document.execCommand("copy")`, { userGesture: true })).toBe(true);
    expect(await page.clipboard()).toBe(URL_TEXT);

    // Let go, and the message catches up with everything it missed.
    await page.evaluate("getSelection().removeAllRanges()");
    await waitFor(page, `document.querySelector('[data-block="a2"]').textContent.includes("и ещё")`);
  }, 20_000);

  it("a_real_drag_over_the_text_selects_it_and_the_feed_leaves_it_alone", async () => {
    await page.evaluate("getSelection().removeAllRanges(); window.__posted.length = 0");
    const word = await page.evaluate<{ from: Point; to: Point }>(`(() => {
      const walker = document.createTreeWalker(document.querySelector('[data-block="a2"]'), NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 6); // «Открой», before the link
      const r = range.getBoundingClientRect();
      return { from: { x: r.x + 1, y: r.y + r.height / 2 }, to: { x: r.right - 1, y: r.y + r.height / 2 } };
    })()`);
    await page.drag(word.from, word.to);
    const dragged = await page.evaluate<string>("getSelection().toString()");
    expect(dragged.length).toBeGreaterThan(0);

    await page.evaluate("window.__grow(' снова')");
    expect(await page.evaluate<string>("getSelection().toString()")).toBe(dragged);
    expect(await page.evaluate<unknown[]>("window.__posted.slice()")).toEqual([]); // a drag over text opens nothing
    await page.evaluate("getSelection().removeAllRanges()");
  }, 20_000);

  it("the_copy_control_of_a_code_block_shows_on_hover_and_copies_the_code", async () => {
    const selector = '[data-block="a1"] pre [data-role="copy"]';
    expect(await opacity(page, selector)).toBe("0");
    const point = await centre(page, selector);
    await page.move(point);
    await waitFor(page, `getComputedStyle(document.querySelector('${selector}')).opacity === "1"`);

    await page.click(point);
    await waitFor(page, `document.querySelector('${selector}').classList.contains("copied")`);
    expect(await page.clipboard()).toBe("ls -la /tmp\ncd /tmp\n");
  }, 20_000);

  it("the_copy_control_of_an_output_box_copies_the_whole_text_without_opening_the_box", async () => {
    const selector = '[data-block="t1"] [data-io="out"] [data-role="copy"]';
    const box = '[data-block="t1"] [data-role="tool-io"]';
    expect(await page.evaluate<boolean>(`document.querySelector('${box}').classList.contains("open")`)).toBe(false);

    const point = await centre(page, selector);
    await page.move(point);
    await page.click(point);
    await waitFor(page, `document.querySelector('${selector}').classList.contains("copied")`);
    const copied = await page.clipboard();
    expect(copied.split("\n")).toHaveLength(OUTPUT_LINES);
    expect(copied.endsWith(`строка ${OUTPUT_LINES}`)).toBe(true); // the box shows 200 lines; the clipboard gets them all
    expect(await page.evaluate<boolean>(`document.querySelector('${box}').classList.contains("open")`)).toBe(false);
  }, 20_000);
});
