import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Set to a directory to keep screenshots of the states checked here. */
const SHOTS = process.env["AGENT_TABS_SHOTS"];

/** Tool steps of every shape, then enough replies that the feed scrolls; posts are kept in `window.__posted`. */
const STUB = `
(function () {
  var long = "x".repeat(400);
  var blocks = [
    { kind: "tool", id: "b1", name: "bash", summary: "list everything", input: "ls -la " + long + "\\npwd\\nwhoami\\nuname -a\\ndate", output: "out 1\\nout 2\\nout 3\\nout 4\\nout 5", truncated: false, state: "ok" },
    { kind: "tool", id: "e1", name: "eval", summary: "count lines", input: "const n = 1;\\nconsole.log(n)", inputLang: "js", output: "Error: boom", truncated: false, state: "error" },
    { kind: "tool", id: "r1", name: "read", summary: "/repo/src/feed.ts", file: "/repo/src/feed.ts", fromLine: 10, toLine: 49, output: "...", truncated: false, state: "ok" },
    { kind: "tool", id: "d1", name: "edit", summary: "/repo/src/a.ts", file: "/repo/src/a.ts", input: " keep\\n-old line\\n+new line\\n+another " + long + "\\n tail\\n@@\\n-x\\n+y", added: 3, removed: 2, output: "ok", truncated: false, state: "ok" },
    { kind: "tool", id: "k1", name: "task", summary: "", role: "explore", model: "gw/m1", description: "Find usages of the feed", input: "Find every place that renders the feed and list them", output: "Found 3 places", truncated: false, state: "ok", durationMs: 4000 },
  ];
  for (var i = 0; i < 30; i++) blocks.push({ kind: "assistant", id: "a" + i, text: "Reply number " + i + ". " + "Some words to fill a line. ".repeat(4), thinking: "", streaming: false });
  blocks.push({ kind: "tool", id: "last", name: "bash", summary: "the last step", input: "echo last\\n2\\n3\\n4\\n5", output: "last", truncated: false, state: "ok" });
  window.__posted = [];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

function rect(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number }> {
  return page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot(join(SHOTS, `${name}.png`));
}

describe.skipIf(!hasChrome)("tool boxes and the floating composer (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="last"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("a_box_clamps_to_three_lines_cuts_long_lines_and_never_widens_the_feed", async () => {
    await page.evaluate(`document.querySelector("main.feed").scrollTop = 0`);
    await shot(page, "1-tool-steps-collapsed");
    const fit = await page.evaluate<{ lines: number; cut: boolean; feedScrolls: boolean; boxInside: boolean; fades: boolean }>(`(() => {
      const text = document.querySelector('[data-block="b1"] [data-io="in"] .io-text');
      const feed = document.querySelector("main.feed");
      const box = document.querySelector('[data-block="b1"] [data-role="tool-io"]').getBoundingClientRect();
      return {
        lines: Math.round(text.clientHeight / 18),
        cut: text.scrollWidth > text.clientWidth,
        feedScrolls: feed.scrollWidth > feed.clientWidth,
        boxInside: box.right <= feed.getBoundingClientRect().right,
        fades: getComputedStyle(text).maskImage !== "none",
      };
    })()`);
    expect(fit).toEqual({ lines: 3, cut: true, feedScrolls: false, boxInside: true, fades: true });
  });

  it("a_click_on_the_box_expands_it_and_another_collapses_it", async () => {
    const box = await rect(page, '[data-block="b1"] [data-io="out"]');
    const at: Point = { x: box.left + 80, y: box.top + 10 };
    await page.click(at);
    expect(await page.evaluate<number>(`document.querySelector('[data-block="b1"] [data-io="out"] .io-text').clientHeight`)).toBe(5 * 18);
    await shot(page, "2-tool-box-expanded");
    await page.click(at);
    expect(await page.evaluate<number>(`document.querySelector('[data-block="b1"] [data-io="out"] .io-text').clientHeight`)).toBe(3 * 18);
  });

  it("an_error_output_is_in_the_error_colour", async () => {
    const colours = await page.evaluate<{ out: string; in: string }>(`(() => ({
      out: getComputedStyle(document.querySelector('[data-block="e1"] [data-io="out"] .io-text')).color,
      in: getComputedStyle(document.querySelector('[data-block="e1"] [data-io="in"] .io-text')).color,
    }))()`);
    expect(colours.out).not.toBe(colours.in);
  });

  it("a_diff_tints_added_and_removed_lines", async () => {
    const tints = await page.evaluate<{ add: string; del: string; ctx: string }>(`(() => {
      const bg = (kind) => getComputedStyle(document.querySelector('[data-block="d1"] .dl.' + kind)).backgroundColor;
      return { add: bg("add"), del: bg("del"), ctx: bg("ctx") };
    })()`);
    expect(tints.add).not.toBe(tints.ctx);
    expect(tints.del).not.toBe(tints.ctx);
    expect(tints.add).not.toBe(tints.del);
  });

  it("a_file_link_opens_the_file_and_does_not_toggle_its_step", async () => {
    const link = await rect(page, '[data-block="r1"] [data-open-file]');
    await page.click({ x: link.left + 4, y: link.top + link.height / 2 });
    const result = await page.evaluate<{ posted: unknown; open: boolean }>(`({
      posted: window.__posted.filter((message) => message.type === "openFile"),
      open: document.querySelector('[data-block="r1"] details').open,
    })`);
    expect(result).toEqual({ posted: [{ type: "openFile", path: "/repo/src/feed.ts", line: 10 }], open: false });
  });

  it("the_last_message_scrolls_fully_above_the_composer", async () => {
    await page.evaluate(`(() => { const feed = document.querySelector("main.feed"); feed.scrollTop = feed.scrollHeight; })()`);
    await shot(page, "3-bottom-under-composer");
    const last = await rect(page, '[data-block="last"]');
    const box = await rect(page, ".composer-box");
    const feed = await rect(page, "main.feed");
    const composer = await rect(page, "footer.composer");
    expect(last.bottom).toBeLessThanOrEqual(box.top);
    expect(feed.bottom).toBeGreaterThanOrEqual(composer.bottom - 0.5); // the feed runs under the composer to the panel's bottom
  });

  it("the_feed_keeps_room_for_a_growing_composer_and_stays_at_the_bottom", async () => {
    await page.evaluate(`(() => {
      const input = document.querySelector(".input");
      input.textContent = "one\\ntwo\\nthree\\nfour\\nfive\\nsix";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor(page, `parseFloat(document.querySelector("main.feed").style.paddingBottom) === document.querySelector("footer.composer").offsetHeight`);
    const last = await rect(page, '[data-block="last"]');
    const box = await rect(page, ".composer-box");
    expect(last.bottom).toBeLessThanOrEqual(box.top);
    await shot(page, "4-grown-composer");
    await page.evaluate(`(() => { const input = document.querySelector(".input"); input.textContent = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await waitFor(page, `parseFloat(document.querySelector("main.feed").style.paddingBottom) === document.querySelector("footer.composer").offsetHeight`);
  });

  it("a_click_and_the_wheel_under_the_gradient_reach_the_feed", async () => {
    // Scroll so the last step's box sits in the gradient above the composer box, then click it there.
    const composer = await rect(page, "footer.composer");
    const box = await rect(page, ".composer-box");
    expect(box.top - composer.top).toBeGreaterThan(20); // a fade band above the box
    await page.evaluate(`(() => {
      const feed = document.querySelector("main.feed");
      const target = document.querySelector('[data-block="last"] [data-role="tool-io"]');
      const band = ${composer.top} + 10; // inside the gradient
      feed.scrollTop += target.getBoundingClientRect().top + 8 - band;
    })()`);
    const target = await rect(page, '[data-block="last"] [data-role="tool-io"]');
    const at: Point = { x: target.left + 60, y: target.top + 8 };
    expect(at.y).toBeGreaterThan(composer.top);
    expect(at.y).toBeLessThan(box.top);
    expect(await page.evaluate<boolean>(`document.elementFromPoint(${at.x}, ${at.y}).closest("footer.composer") === null`)).toBe(true);
    await page.click(at);
    expect(await page.evaluate<boolean>(`document.querySelector('[data-block="last"] [data-role="tool-io"]').classList.contains("open")`)).toBe(true);

    const before = await page.evaluate<number>(`document.querySelector("main.feed").scrollTop`);
    await page.wheel({ x: box.left + 10, y: composer.top + 8 }, -200);
    await waitFor(page, `document.querySelector("main.feed").scrollTop < ${before}`);
    await shot(page, "5-gradient-click-through");
  }, 15_000);
});
