import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** An empty session, so the composer and the line over it stand on their own. */
const STUB = `
(function () {
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        (window.__sent = window.__sent || []).push(message);
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

const SHOTS = "/tmp/agent-tabs-shots/reconnect";
const SHORT = "Не удалось открыть сессию: omo host exited (code 1, signal null) before it was ready";
/** The kind of message that pushed the layout around when it lived in a banner. */
const LONG = `${SHORT} — ${"подробности хоста ".repeat(40)}`;

function notice(error: string, waitMs: number, attempt: number): string {
  return JSON.stringify({
    type: "reconnecting",
    active: true,
    error,
    attempt,
    waitMs,
    capped: false,
    target: { host: "/Users/me/.omo", session: "/tmp/agent/sessions/--proj--/2026_abc.jsonl" },
  });
}

function send(page: Page, json: string): Promise<unknown> {
  return page.evaluate(`window.postMessage(${JSON.stringify(json)}, "*")`);
}

function box(page: Page, selector: string): Promise<{ height: number; width: number; scrollWidth: number; top: number }> {
  return page.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const rect = node.getBoundingClientRect();
    return { height: rect.height, width: rect.width, scrollWidth: node.scrollWidth, top: rect.top };
  })()`);
}

function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(rect.left + 20), y: Math.round(rect.top + rect.height / 2) };
  })()`);
}

describe.skipIf(!hasChrome)("the reconnect line and its details (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `(() => document.querySelector(".composer-box") !== null)()`);
  });

  afterAll(async () => {
    await page.close();
  });

  it("stays_one_row_however_long_the_message_is_and_never_widens_the_tab", async () => {
    await send(page, notice(SHORT, 12_000, 3));
    await waitFor(page, `(() => { const n = document.querySelector(".reconnect"); return n !== null && !n.hidden; })()`);
    const short = await box(page, ".reconnect");
    const composerAt = (await box(page, ".composer-box")).top;
    expect(short.height).toBeLessThanOrEqual(22); // one row, cap included
    await page.screenshot(join(SHOTS, "line-waiting.png"));

    await send(page, notice(LONG, 12_000, 3));
    await waitFor(page, `(() => document.querySelector('[data-role="reconnect-text"]').textContent.length > ${LONG.length - 1})()`);
    const long = await box(page, ".reconnect");
    expect(long.height).toBe(short.height); // the whole message never pushes the layout around
    expect(long.width).toBe(short.width);
    expect((await box(page, ".composer-box")).top).toBe(composerAt);
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
    // The countdown keeps its room at the end of the row whatever the message does.
    expect(await page.evaluate<string>(`document.querySelector('[data-role="reconnect-progress"]').textContent`)).toContain("Повтор через");
    // Truncated with an ellipsis: the text's own width is past the row it is clipped to.
    const clipped = await page.evaluate<{ natural: number; row: number; ellipsis: string }>(`(() => {
      const node = document.querySelector('[data-role="reconnect-text"]');
      const range = document.createRange();
      range.selectNodeContents(node);
      return { natural: range.getBoundingClientRect().width, row: node.clientWidth, ellipsis: getComputedStyle(node).textOverflow };
    })()`);
    expect(clipped.natural).toBeGreaterThan(clipped.row);
    expect(clipped.ellipsis).toBe("ellipsis");
  });

  it("a_click_on_the_line_opens_the_details_with_the_whole_text", async () => {
    await page.click(await centre(page, '[data-role="reconnect-text"]'));
    await waitFor(page, `(() => { const m = document.querySelector('[data-role="reconnect-details"]'); return m !== null && !m.hidden; })()`);
    const shown = await page.evaluate<string>(`document.querySelector('[data-role="reconnect-error"]').textContent`);
    expect(shown).toBe(LONG);
    await page.screenshot(join(SHOTS, "details-modal.png"));
  });

  /**
   * The person's own case drawn by a real browser: the file is held by another copy of the host, so the line stops
   * counting down, the spinner stands still and «Повторить сейчас» is gone — a click could not free it.
   */
  it("a_line_that_gave_up_stops_spinning_and_drops_the_button", async () => {
    await page.evaluate(`document.querySelector('[data-role="reconnect-close"]').click()`);
    const message = "Файл сессии держит другая копия хоста OmO (pid 46960) — она ещё работает. Повторять бесполезно.";
    await send(page, JSON.stringify({ ...(JSON.parse(notice(message, 0, 6)) as Record<string, unknown>), waitMs: undefined, givenUp: true }));
    await waitFor(page, `(() => document.querySelector(".reconnect")?.dataset.phase === "held")()`);
    const held = await page.evaluate<{ row: number; progress: string; now: boolean; more: boolean; spin: string; banner: boolean }>(`(() => ({
      row: document.querySelector(".reconnect").getBoundingClientRect().height,
      progress: document.querySelector('[data-role="reconnect-progress"]').textContent,
      now: document.querySelector('[data-role="reconnect-now"]').hidden,
      more: document.querySelector('[data-role="reconnect-more"]').hidden,
      spin: getComputedStyle(document.querySelector('[data-role="reconnect-spin"]')).animationName,
      banner: document.querySelector('[data-role="banner"]').hidden,
    }))()`);
    expect(held.row).toBeLessThanOrEqual(22); // still one quiet row over the composer
    expect(held.progress).toBe("Попыток: 6");
    expect(held.now).toBe(true); // nothing to click
    expect(held.more).toBe(false); // the whole story is still one click away
    expect(held.spin).toBe("none"); // nothing is in flight to spin for
    expect(held.banner).toBe(true); // and never the red banner at the top
    await page.screenshot(join(SHOTS, "line-held.png"));
  });

  /**
   * The holder is working, so the extension refused to stop it and the person decides instead. Drawn by a real browser:
   * the stop sits in the same quiet row, the facts ARE the row's text, and a real click (hit tested, not dispatched at
   * a node) reaches the button and asks the host.
   */
  it("a_refused_stop_puts_a_real_button_in_the_row_and_a_click_reaches_it", async () => {
    const facts =
      "Файл сессии держит другая копия хоста OmO (pid 46960): в этой среде ещё идут задачи (1). Сама её не останавливаю — клиентов 0, незакрытых задач 1, журналы молчат 0 мин, CPU 42 %.";
    await send(page, JSON.stringify({ ...(JSON.parse(notice(facts, 0, 6)) as Record<string, unknown>), waitMs: undefined, givenUp: true, offerStop: true }));
    await waitFor(page, `(() => document.querySelector('[data-role="reconnect-stop"]')?.hidden === false)()`);
    const row = await box(page, ".reconnect");
    expect(row.height).toBeLessThanOrEqual(22); // the button does not turn the quiet line into two rows
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
    await page.screenshot(join(SHOTS, "line-offer-stop.png"));

    await page.click(await centre(page, '[data-role="reconnect-stop"]'));
    await waitFor(page, `(() => (window.__sent || []).some(function (one) { return one.type === "stopHolder"; }))()`);
  });
});
