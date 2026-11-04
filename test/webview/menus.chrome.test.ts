import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: a session with a few commands, nothing else answered. */
const STUB = `
(function () {
  var commands = [
    { name: "reflect", source: "extension", syntax: "slash" },
    { name: "resume", source: "extension", syntax: "slash" },
    { name: "review-work", source: "extension", syntax: "slash" }
  ];
  function reply(message) { setTimeout(function () { window.postMessage(JSON.stringify(message), "*"); }, 5); }
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type === "ready") reply({ type: "state", reconnectable: true, commands: commands, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: false } });
      },
    };
  };
})();`;

/** The model picker's selection colour, resolved the way the browser paints it. */
const SELECTION = `(() => { const probe = document.createElement("div"); probe.style.background = "var(--sel)"; document.body.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color; })()`;

function centre(page: Page, selector: string): Promise<Point> {
  return page.evaluate<Point>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}

const background = (page: Page, selector: string): Promise<string> => page.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`);

describe.skipIf(!hasChrome)("the «/» menus in a real browser (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-role="slash"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("the_button_menu_paints_the_hovered_row_in_the_selection_blue_and_draws_a_line_over_settings", async () => {
    const selection = await page.evaluate<string>(SELECTION);
    expect(selection).not.toBe("rgba(0, 0, 0, 0)");
    await page.click(await centre(page, '[data-role="slash"]'));
    await waitFor(page, `!document.querySelector('[data-popover="actions"]').hidden`);
    const rows = '[data-popover="actions"] [data-row]';
    await page.move(await centre(page, `${rows}:nth-of-type(2)`));
    await waitFor(page, `document.activeElement === document.querySelectorAll('${rows}')[1]`);
    expect(await background(page, `${rows}:nth-of-type(2)`)).toBe(selection);
    expect(await background(page, `${rows}:nth-of-type(1)`)).not.toBe(selection); // one active row
    const settings = '[data-role="action-settings"]';
    expect(await page.evaluate<string>(`document.querySelector('${settings}').textContent`)).toBe("Настройки");
    const line = await page.evaluate<{ height: number; above: boolean; color: string }>(`(() => {
      const sep = document.querySelector('[data-popover="actions"] [role="separator"]');
      const s = sep.getBoundingClientRect();
      const r = document.querySelector('${settings}').getBoundingClientRect();
      return { height: s.height, above: s.bottom <= r.top + 0.5, color: getComputedStyle(sep).backgroundColor };
    })()`);
    expect(line).toMatchObject({ height: 1, above: true });
    expect(line.color).not.toBe("rgba(0, 0, 0, 0)");
    await page.move(await centre(page, settings));
    await waitFor(page, `document.activeElement === document.querySelector('${settings}')`);
    expect(await background(page, settings)).toBe(selection);
    expect(await page.evaluate<boolean>(`document.querySelector('[data-role="settings"]') === null`)).toBe(true); // no gear in the header
    await page.key("Escape");
    await waitFor(page, `document.querySelector('[data-popover="actions"]').hidden`);
  }, 15_000);

  it("the_typed_menu_paints_the_hovered_row_in_the_same_blue", async () => {
    const selection = await page.evaluate<string>(SELECTION);
    await page.evaluate(`(() => { const input = document.querySelector("textarea"); input.focus(); input.value = "/re"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await waitFor(page, `!document.querySelector('[data-popover="slash"]').hidden`);
    const rows = '[data-popover="slash"] [data-row]';
    await page.move(await centre(page, `${rows}:nth-child(3)`));
    await waitFor(page, `document.querySelectorAll('${rows}')[2].classList.contains("sel")`);
    expect(await background(page, `${rows}:nth-child(3)`)).toBe(selection);
    expect(await background(page, `${rows}:nth-child(1)`)).not.toBe(selection);
    await page.key("Escape");
  }, 15_000);
});
