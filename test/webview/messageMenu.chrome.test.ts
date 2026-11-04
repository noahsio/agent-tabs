import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: two sent messages; the ↺ menu is answered at once (fork possible, rewind not). */
const STUB = `
(function () {
  var blocks = [{ kind: "user", id: "c1", text: "Первое сообщение" }, { kind: "assistant", id: "a1", text: "ответ", thinking: "", streaming: false }, { kind: "user", id: "c2", text: "Второе" }];
  function reply(message) { setTimeout(function () { window.postMessage(JSON.stringify(message), "*"); }, 5); }
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type === "ready") reply({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } });
        if (message.type === "messageActions") reply({ type: "messageActions", blockId: message.blockId, fork: { ok: true }, rewind: { ok: false, reason: "Снимок не сохранился" } });
      },
    };
  };
})();`;

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

function bubbleCentre(page: Page, id: string): Promise<Point> {
  return page.evaluate<Point>(`(() => { const r = document.querySelector('[data-block="${id}"] .user-bubble').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}

function buttonState(page: Page, id: string): Promise<{ opacity: number; centre: Point }> {
  return page.evaluate(`(() => {
    const b = document.querySelector('[data-block="${id}"] [data-role="message-actions"]');
    const r = b.getBoundingClientRect();
    return { opacity: Number(getComputedStyle(b).opacity), centre: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
  })()`);
}

for (const size of [{ width: 900, height: 700 }, { width: 360, height: 700 }]) {
  describe.skipIf(!hasChrome)(`the ↺ menu in a real layout at ${size.width}×${size.height} (headless Chrome)`, () => {
    let page: Page;

    beforeAll(async () => {
      page = await openPage(await webviewPage(STUB), size);
      await waitFor(page, `document.querySelector('[data-block="c2"]') !== null`);
    }, 30_000);

    afterAll(() => page?.close());

    it("actions_button_sits_on_the_bubbles_top_right_corner", async () => {
      const boxes = await page.evaluate<{ bubble: Box; button: Box }>(`(() => {
        const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const entry = document.querySelector('[data-block="c1"]');
        return { bubble: box(entry.querySelector('.user-bubble')), button: box(entry.querySelector('[data-role="message-actions"]')) };
      })()`);
      const centreX = boxes.button.left + boxes.button.width / 2;
      const centreY = boxes.button.top + boxes.button.height / 2;
      expect(Math.abs(centreX - boxes.bubble.right)).toBeLessThanOrEqual(4);
      expect(Math.abs(centreY - boxes.bubble.top)).toBeLessThanOrEqual(4);
    }, 15_000);

    it("actions_button_shows_on_hover_and_the_menu_stays_inside_the_tab", async () => {
      expect((await buttonState(page, "c1")).opacity).toBe(0);
      await page.move(await bubbleCentre(page, "c1"));
      await waitFor(page, `Number(getComputedStyle(document.querySelector('[data-block="c1"] [data-role="message-actions"]')).opacity) === 1`);
      const { centre } = await buttonState(page, "c1");
      await page.move(centre);
      await page.click(centre);
      await waitFor(page, `!document.querySelector('[data-popover="message-actions"]').hidden && !document.querySelector('[data-popover="message-actions"] [data-role="fork"]').disabled`);
      const menu = await page.evaluate<Box>(`(() => { const r = document.querySelector('[data-popover="message-actions"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`);
      expect(menu.width).toBeGreaterThan(0);
      expect(menu.left).toBeGreaterThanOrEqual(16 - 0.5);
      expect(menu.right).toBeLessThanOrEqual(size.width - 16 + 0.5);
      expect(menu.top).toBeGreaterThanOrEqual(0);
      expect(menu.bottom).toBeLessThanOrEqual(size.height);
      const hint = await page.evaluate<string>(`document.querySelector('[data-popover="message-actions"] [data-role="rewind"] .hint').textContent`);
      expect(hint).toBe("Снимок не сохранился");
      await page.key("Escape");
      await waitFor(page, `document.querySelector('[data-popover="message-actions"]').hidden`);
    }, 15_000);
  });
}
