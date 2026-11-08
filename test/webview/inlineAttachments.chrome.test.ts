import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** Set to a directory to keep screenshots of the states checked here. */
const SHOTS = process.env["AGENT_TABS_SHOTS"];

/** One sent message with its pictures in the text (frame D), and an empty composer to type into (frame A). */
const STUB = `
(function () {
  var dot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  var blocks = [
    { kind: "user", id: "u1", timestamp: Date.now(), text: "вот тут ошибка [картинка 1] а на втором экране [картинка 2] всё нормально\\n\\nпочини по порядку:\\n1. проверь, что каталог не отдаёт пустой список\\n2. вот как он выглядит пустым [картинка 3]", images: [
      { id: "u1:0", mimeType: "image/png", name: "screen1.png" },
      { id: "u1:1", mimeType: "image/png", name: "screen2.png" },
      { id: "u1:2", mimeType: "image/png", name: "empty-list.png" },
    ] },
    { kind: "assistant", id: "a1", text: "Смотрю по порядку.", thinking: "", streaming: false },
  ];
  window.__posted = [];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type === "getImage") {
          window.postMessage(JSON.stringify({ type: "image", id: message.id, dataUrl: "data:image/png;base64," + dot }), "*");
          return;
        }
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number };

function rect(page: Page, selector: string): Promise<Box> {
  return page.evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; })()`,
  );
}

function rects(page: Page, selector: string): Promise<Box[]> {
  return page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; })`,
  );
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot(join(SHOTS, `${name}.png`));
}

/** Types words into the composer and attaches a picture at the caret, the way a paste does. */
const WRITE = `(async (before, after, name) => {
  const input = document.querySelector(".input");
  input.focus();
  input.textContent = before + after;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const range = document.createRange();
  range.setStart(input.firstChild, before.length);
  range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [new File([bytes], name, { type: "image/png" })], types: ["Files"], getData: () => "" } });
  input.dispatchEvent(paste);
})`;

describe.skipIf(!hasChrome)("pictures standing in the line of text (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-role="send"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("a_pasted_picture_sits_on_the_line_between_the_words_that_were_around_the_caret", async () => {
    await page.evaluate(`${WRITE}("вот тут ошибка ", " а на втором экране всё нормально", "screen1.png")`);
    await waitFor(page, `document.querySelector('.input .att[data-status="ready"]') !== null`);
    await shot(page, "a-composer-inline-pill");

    const pill = await rect(page, ".input .att");
    const line = await rect(page, ".input");
    expect(pill.height).toBe(20); // the shelf's chip, shrunk to a text line
    expect(pill.left).toBeGreaterThan(line.left);
    expect(pill.right).toBeLessThan(line.right);
    // On the same line as the words on both sides of it, not pushed above or below them.
    const words = await page.evaluate<{ top: number; bottom: number }>(`(() => {
      const input = document.querySelector(".input");
      const range = document.createRange();
      range.setStart(input.firstChild, 0);
      range.setEnd(input.firstChild, 3);
      const r = range.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    })()`);
    expect(pill.top).toBeLessThan(words.bottom);
    expect(pill.bottom).toBeGreaterThan(words.top);
  });

  it("the_cross_keeps_its_room_so_hovering_never_moves_the_line", async () => {
    const before = await rect(page, ".input .att");
    const cross = await rect(page, '.input [data-role="pill-remove"]');
    expect(cross.width).toBeGreaterThan(0); // room reserved, invisible until hovered
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.input [data-role="pill-remove"]')).opacity`)).toBe("0");

    await page.move({ x: Math.round((before.left + before.right) / 2), y: Math.round((before.top + before.bottom) / 2) });
    await waitFor(page, `getComputedStyle(document.querySelector('.input [data-role="pill-remove"]')).opacity === "1"`);
    const after = await rect(page, ".input .att");
    expect(after.width).toBe(before.width); // the ✕ appearing does not re-wrap anything
    expect(after.left).toBe(before.left);
  });

  it("a_pill_wraps_whole_like_a_long_word_in_a_panel_420_px_wide", async () => {
    const narrow = await openPage(await webviewPage(STUB), { width: 420, height: 700 });
    try {
      await waitFor(narrow, `document.querySelector('[data-role="send"]') !== null`);
      await narrow.evaluate(`${WRITE}("вот тут ошибка ", " а на втором экране всё нормально и ещё немного слов", "screen2.png")`);
      await waitFor(narrow, `document.querySelector('.input .att[data-status="ready"]') !== null`);
      await shot(narrow, "n1-composer-420");
      const pill = await rect(narrow, ".input .att");
      const line = await rect(narrow, ".input");
      expect(pill.height).toBe(20); // one piece on one line, never split across two
      expect(pill.left).toBeGreaterThanOrEqual(line.left);
      expect(pill.right).toBeLessThanOrEqual(line.right + 0.5);
      // The words run past it onto the next line, and the chip stays whole on its own.
      expect(await narrow.evaluate<number>(`document.querySelector(".input").getBoundingClientRect().height`)).toBeGreaterThan(50);
      await shot(narrow, "n2-feed-420");
    } finally {
      await narrow.close();
    }
  });

  it("enter_sends_the_message_with_its_label_and_shift_enter_only_breaks_the_line", async () => {
    await page.evaluate(`${WRITE}("вот тут ошибка ", " и всё", "screen1.png")`);
    await waitFor(page, `document.querySelector('.input .att[data-status="ready"]') !== null`);
    await page.key("Enter");
    await waitFor(page, `window.__posted.some((message) => message.type === "send")`);
    expect(await page.evaluate<string>(`window.__posted.filter((message) => message.type === "send").at(-1).text`)).toBe("вот тут ошибка [картинка 1] и всё");
    expect(await page.evaluate<number>(`window.__posted.filter((message) => message.type === "send").at(-1).images.length`)).toBe(1);
    expect(await page.evaluate<string>(`document.querySelector(".input").textContent`)).toBe("");

    await page.evaluate(`(() => { const input = document.querySelector(".input"); input.focus(); input.textContent = "первая"; input.dispatchEvent(new Event("input", { bubbles: true })); const r = document.createRange(); r.selectNodeContents(input); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    const before = await page.evaluate<number>(`window.__posted.filter((message) => message.type === "send").length`);
    await page.key("Enter", { shift: true });
    await page.evaluate(`(() => { document.execCommand("insertText", false, "вторая"); })()`);
    expect(await page.evaluate<number>(`window.__posted.filter((message) => message.type === "send").length`)).toBe(before); // nothing sent
    expect(await page.evaluate<string>(`document.querySelector(".input").innerText.trim()`)).toBe("первая\nвторая");
    await page.evaluate(`(() => { const input = document.querySelector(".input"); input.textContent = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  });

  it("undo_takes_the_pill_and_its_picture_away_and_redo_brings_both_back", async () => {
    await page.evaluate(`${WRITE}("вот тут ошибка ", " и всё", "screen1.png")`);
    await waitFor(page, `document.querySelector('.input .att[data-status="ready"]') !== null`);

    await page.evaluate(`(() => { document.querySelector(".input").focus(); document.execCommand("undo"); })()`);
    await waitFor(page, `document.querySelectorAll(".input .att").length === 0`); // the editor's own undo reaches the pill
    expect(await page.evaluate<boolean>(`document.querySelector('[data-role="send"]').disabled`)).toBe(false);

    await page.evaluate(`(() => { document.querySelector(".input").focus(); document.execCommand("redo"); })()`);
    await waitFor(page, `document.querySelector('.input .att[data-status="ready"]') !== null`); // and the picture comes back with it
    await page.key("Enter");
    await waitFor(page, `window.__posted.some((message) => message.type === "send")`);
    const last = `window.__posted.filter((message) => message.type === "send").at(-1)`;
    expect(await page.evaluate<string>(`${last}.text`)).toBe("вот тут ошибка [картинка 1] и всё");
    expect(await page.evaluate<number>(`${last}.images.length`)).toBe(1);
  });

  it("a_sent_message_shows_the_same_chips_at_the_same_places_and_opens_the_viewer", async () => {
    await waitFor(page, `document.querySelectorAll('[data-block="u1"] .user-text .att').length === 3`);
    await shot(page, "d-sent-in-feed");
    const chips = await rects(page, '[data-block="u1"] .user-text .att');
    expect(chips).toHaveLength(3);
    expect(chips.every((chip) => chip.height === 20)).toBe(true);
    expect(chips[0]?.top).toBe(chips[1]?.top); // the first two stand on the message's first line
    expect(chips[0]?.left).toBeLessThan(chips[1]?.left as number);
    expect(chips[2]?.top).toBeGreaterThan(chips[1]?.top as number); // the third is at the end of its own item
    expect(await page.evaluate<number>(`document.querySelectorAll('[data-block="u1"] .uimgs').length`)).toBe(0); // all three have a place

    await page.click({ x: Math.round(((chips[1] as Box).left + (chips[1] as Box).right) / 2), y: Math.round(((chips[1] as Box).top + (chips[1] as Box).bottom) / 2) });
    await waitFor(page, `document.querySelector(".lightbox") !== null && !document.querySelector(".lightbox").hidden`);
    expect(await page.evaluate<string>(`document.querySelector(".lightbox").textContent`)).toContain("2 / 3"); // in the order of the text
    await page.key("Escape");
  });

  it("recall_reconstructs_the_native_editor_before_any_image_bytes_arrive", async () => {
    await page.evaluate(`(() => {
      const input = document.querySelector(".input");
      input.focus();
      input.replaceChildren();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    })()`);
    const parts = await page.evaluate<string>(`(() => {
      const copy = document.querySelector(".input").cloneNode(true);
      copy.querySelectorAll(".att").forEach((pill) => pill.replaceWith("■"));
      copy.querySelectorAll("br").forEach((br) => br.replaceWith("\\n"));
      return copy.textContent;
    })()`);
    expect(parts).toBe("вот тут ошибка ■ а на втором экране ■ всё нормально\n\nпочини по порядку:\n1. проверь, что каталог не отдаёт пустой список\n2. вот как он выглядит пустым ■");
    await waitFor(page, `document.querySelectorAll('.input .att[data-status="ready"]').length === 3`);
    await shot(page, "recall-inline");
    await page.key("Enter");
    expect(await page.evaluate<string>(`window.__posted.filter((message) => message.type === "send").at(-1).text`)).toBe("вот тут ошибка [картинка 1] а на втором экране [картинка 2] всё нормально\n\nпочини по порядку:\n1. проверь, что каталог не отдаёт пустой список\n2. вот как он выглядит пустым [картинка 3]");
  });
});
