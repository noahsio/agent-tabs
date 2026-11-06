import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** A ten-line sent message that must fold to a few lines, a three-line one that must not, and a tall reply so the
 *  long message can be scrolled into its stuck state. */
const STUB = `
(function () {
  var ten = Array.from({ length: 10 }, function (_, i) { return "Строка запроса " + (i + 1); }).join("\\n");
  var reply = Array.from({ length: 30 }, function (_, i) { return "шаг " + (i + 1); }).join("\\n\\n");
  var blocks = [
    { kind: "user", id: "u1", text: ten },
    { kind: "assistant", id: "a1", text: reply, thinking: "", streaming: false },
    { kind: "user", id: "u2", text: "Коротко\\nв три\\nстроки" },
    { kind: "assistant", id: "a2", text: reply, thinking: "", streaming: false },
  ];
  window.acquireVsCodeApi = function () {
    return { getState:function(){return undefined;}, setState:function(){}, postMessage:function(m){
      if (m.type === "ready") setTimeout(function(){ window.postMessage(JSON.stringify({type:"state",reconnectable:true,tab:{modelMode:"auto",durableId:"id-1"},state:{blocks:blocks,dialogs:[],agents:[],running:false}}),"*"); }, 5);
    } };
  };
})();`;

function settle(page: Page): Promise<unknown> {
  return page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}

type Fold = { collapsed: boolean; shownLines: number; fullLines: number; toggle: string | null };

function fold(page: Page, id: string): Promise<Fold> {
  return page.evaluate<Fold>(`(() => {
    const bubble = document.querySelector('[data-block="${id}"] .user-bubble');
    const text = bubble.querySelector(".user-text");
    const lh = parseFloat(getComputedStyle(text).lineHeight) || 20;
    const t = bubble.querySelector('[data-role="message-toggle"]');
    return {
      collapsed: bubble.classList.contains("collapsed"),
      shownLines: Math.round(text.clientHeight / lh),
      fullLines: Math.round(text.scrollHeight / lh),
      toggle: t && !t.hidden ? t.textContent : null,
    };
  })()`);
}

const click = (page: Page, sel: string): Promise<unknown> => page.evaluate(`document.querySelector('${sel}').click()`);

describe.skipIf(!hasChrome)("a long sent message folds to a few lines (headless Chrome)", () => {
  let page: Page;
  const SHOTS = "/tmp/agent-tabs-shots/collapse";

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="a2"]') !== null`);
    await settle(page);
  }, 30_000);

  afterAll(() => page?.close());

  it("a_ten_line_message_is_folded_to_a_few_lines_with_the_toggle", async () => {
    await page.evaluate(`document.querySelector("main.feed").scrollTop = 0`);
    await settle(page);
    const u1 = await fold(page, "u1");
    expect(u1.fullLines).toBe(10); // the whole message is ten lines
    expect(u1.collapsed).toBe(true); // over the trigger, so it folds
    expect(u1.shownLines).toBeLessThanOrEqual(5); // down to a few lines, not eight
    expect(u1.shownLines).toBeGreaterThanOrEqual(3);
    expect(u1.toggle).toBe("Показать полностью");
    await page.screenshot(`${SHOTS}/collapsed.png`);
  });

  it("a_three_line_message_is_not_folded", async () => {
    const u2 = await fold(page, "u2");
    expect(u2.fullLines).toBe(3);
    expect(u2.collapsed).toBe(false); // under the trigger
    expect(u2.toggle).toBeNull(); // and no control
  });

  it("opening_it_shows_the_whole_message_without_scrolling_the_feed", async () => {
    const before = await page.evaluate<number>(`document.querySelector("main.feed").scrollTop`);
    await click(page, '[data-block="u1"] [data-role="message-toggle"]');
    await waitFor(page, `document.querySelector('[data-block="u1"] [data-role="message-toggle"]').textContent === "Свернуть"`);
    const open = await fold(page, "u1");
    expect(open.collapsed).toBe(false);
    expect(open.shownLines).toBe(open.fullLines); // every line is shown now
    expect(await page.evaluate<number>(`document.querySelector("main.feed").scrollTop`)).toBe(before); // the feed did not move
    await page.screenshot(`${SHOTS}/expanded.png`);

    await click(page, '[data-block="u1"] [data-role="message-toggle"]'); // «Свернуть» folds it back
    await waitFor(page, `document.querySelector('[data-block="u1"] [data-role="message-toggle"]').textContent === "Показать полностью"`);
    expect((await fold(page, "u1")).collapsed).toBe(true);
  });

  it("a_stuck_long_message_shows_the_same_few_line_fold", async () => {
    await page.evaluate(`(() => { const f=document.querySelector("main.feed"); const r=document.querySelector('[data-block="u1"]').getBoundingClientRect(); f.scrollTop=(r.top-f.getBoundingClientRect().top)+150; })()`);
    await settle(page);
    const stuck = await page.evaluate<boolean>(`document.querySelector('[data-block="u1"]').classList.contains("is-stuck")`);
    expect(stuck).toBe(true);
    const u1 = await fold(page, "u1");
    expect(u1.collapsed).toBe(true); // pinned, it is still just a few lines
    expect(u1.shownLines).toBeLessThanOrEqual(5);
  });
});
