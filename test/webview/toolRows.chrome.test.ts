import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: a finished thinking step, a short tool step and one with a very long summary. */
const STUB = `
(function () {
  var blocks = [
    { kind: "assistant", id: "a1", text: "", thinking: "сначала посмотрю файлы", streaming: false, thinkingMs: 4000 },
    { kind: "tool", id: "t1", name: "bash", summary: "ls -la", input: "ls -la", output: "total 0", truncated: false, state: "ok" },
    { kind: "tool", id: "t2", name: "bash", summary: "grep -rn " + "very-long-pattern ".repeat(40), input: "grep", output: "x", truncated: false, state: "ok" },
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

const ROWS = { tool: "details.tool-details", thinking: "details.thinking" } as const;

/** The centre of the row's text, and a point on the same line near the row's right edge (empty space). */
function points(page: Page, selector: string): Promise<{ text: Point; empty: Point }> {
  return page.evaluate<{ text: Point; empty: Point }>(`(() => {
    const details = document.querySelector(${JSON.stringify(selector)});
    const text = details.querySelector("summary").getBoundingClientRect();
    const row = details.closest(".step").getBoundingClientRect();
    const y = text.y + Math.min(text.height, 18) / 2;
    return { text: { x: text.x + 8, y }, empty: { x: row.right - 12, y } };
  })()`);
}

function isOpen(page: Page, selector: string): Promise<boolean> {
  return page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}).open`);
}

describe.skipIf(!hasChrome)("feed step rows under a real pointer (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector("details.tool-details") !== null && document.querySelector("details.thinking") !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("a_long_summary_still_ends_in_an_ellipsis_inside_the_row", async () => {
    const fit = await page.evaluate<{ inside: boolean; clipped: boolean }>(`(() => {
      const details = document.querySelectorAll("details.tool-details")[1];
      const summary = details.querySelector("summary").getBoundingClientRect();
      const row = details.closest(".step").getBoundingClientRect();
      const mono = details.querySelector(".mono");
      return { inside: summary.right <= row.right + 0.5, clipped: mono.scrollWidth > mono.clientWidth };
    })()`);
    expect(fit).toEqual({ inside: true, clipped: true });
  });

  for (const [name, selector] of Object.entries(ROWS)) {
    it(`a_${name}_row_toggles_from_its_text_only`, async () => {
      const { text, empty } = await points(page, selector);
      expect(empty.x - text.x).toBeGreaterThan(200); // the row is wide; the text is not
      const initially = await isOpen(page, selector); // a tool step starts open on its box, thinking closed
      expect(initially).toBe(name === "tool");
      await page.click(empty);
      expect(await isOpen(page, selector)).toBe(initially);
      await page.click(text);
      expect(await isOpen(page, selector)).toBe(!initially);
      await page.click(empty);
      expect(await isOpen(page, selector)).toBe(!initially);
      await page.click(text);
      expect(await isOpen(page, selector)).toBe(initially);
    }, 15_000);
  }
});
