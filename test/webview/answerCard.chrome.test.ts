import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

const SHOTS = "/tmp/agent-tabs-shots/answers";

/**
 * Stands in for VS Code: a question answered by picking an option (with descriptions), one answered in the person's
 * own words, and one whose words are long enough that the card must collapse as a long sent message does.
 */
const STUB = `
(function () {
  var cache = {
    header: "Кэш",
    text: "Как хранить кэш каталога после смены ноды?",
    options: [
      { label: "TTL и запасной кэш", description: "Отдавать сохранённый список до 10 минут; пустой ответ ноды его не перезаписывает", chosen: false },
      { label: "Только на диске", description: "Список живёт до перезапуска; проще, но после смены ноды может устареть", chosen: true },
      { label: "Без кэша", description: "Каждый раз спрашивать ноду; пустой список будет виден сразу", chosen: false }
    ]
  };
  var checks = {
    header: "Проверки",
    text: "Какие проверки добавить?",
    options: [
      { label: "Юнит-тесты", description: "CatalogService: пустой ответ не затирает кэш", chosen: true },
      { label: "Интеграционные", description: "Смена ноды на живом стенде, около 4 минут", chosen: false },
      { label: "Линтер", description: "swiftlint по изменённым файлам", chosen: true }
    ]
  };
  var key = { header: "age ключ", text: "Каким ключом шифровать резервную копию?", options: [{ label: "age", description: "Современное шифрование файлов age", chosen: false }, { label: "gpg", description: "Шифрование и подпись через GnuPG", chosen: false }], words: "не понимаю что это" };
  var long = { header: "Ключ", text: "Чем шифровать?", words: Array.from({ length: 40 }, function (_, i) { return "строка ответа " + (i + 1); }).join("\\n") };
  var blocks = [
    { kind: "user", id: "c1", text: "каталог иногда отдаёт пустой список после смены ноды — разберись и почини" },
    { kind: "user", id: "u-opts", text: "[Answer to question toolu_1]", answer: { questionId: "toolu_1", forkFrom: "c1", questions: [cache, checks] } },
    { kind: "user", id: "u-long", text: "[Answer to question toolu_3]", answer: { questionId: "toolu_3", forkFrom: "c1", questions: [long] } },
    { kind: "user", id: "u-words", text: "[Answer to question toolu_2]", answer: { questionId: "toolu_2", forkFrom: "c1", questions: [key] } }
  ];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type === "messageActions") {
          var menu = { type: "messageActions", blockId: message.blockId, fork: { ok: true }, rewind: { ok: false, reason: "Откат кода работает только в git-проекте" } };
          setTimeout(function () { window.postMessage(JSON.stringify(menu), "*"); }, 5);
          return;
        }
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

/**
 * The centre of an element the feed may have scrolled away: brought into view as a person would, then read twice
 * unchanged. The feed keeps itself at the bottom whenever the floating composer resizes, which under load lands well
 * after the first paint — a point measured before that jump would click whatever slid into its place.
 */
async function pointOf(page: Page, selector: string): Promise<Point> {
  const look = (scroll: boolean): Promise<Point & { hit: boolean; scroll: number }> =>
    page.evaluate<Point & { hit: boolean; scroll: number }>(`(() => {
      const element = document.querySelector('${selector}');
      ${scroll ? 'element.scrollIntoView({ block: "center" });' : ""}
      const r = element.getBoundingClientRect();
      const at = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      const under = document.elementFromPoint(at.x, at.y);
      return { ...at, hit: under === element || element.contains(under), scroll: document.querySelector("main").scrollTop };
    })()`);
  let last = await look(true);
  for (let tries = 0; tries < 40; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const now = await look(false);
    if (now.hit && now.x === last.x && now.y === last.y && now.scroll === last.scroll) return { x: now.x, y: now.y };
    last = now.hit ? now : await look(true);
  }
  throw new Error(`${selector} never settled under its own centre`);
}

type Geometry = { textHeight: number; fullHeight: number; lineHeight: number; toggle: string | null };

function geometry(page: Page, id: string): Promise<Geometry> {
  return page.evaluate<Geometry>(`(() => {
    const bubble = document.querySelector('[data-block="${id}"] .user-bubble');
    const text = bubble.querySelector(".user-text");
    const toggle = bubble.querySelector('[data-role="message-toggle"]');
    return {
      textHeight: text.clientHeight,
      fullHeight: text.scrollHeight,
      lineHeight: parseFloat(getComputedStyle(text).lineHeight),
      toggle: toggle && !toggle.hidden ? toggle.textContent : null,
    };
  })()`);
}

describe.skipIf(!hasChrome)("the answered-question card in a real layout (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="u-long"] .answer') !== null`);
    // The feed keeps room for the floating composer and sticks to the bottom when it does; under load that lands well
    // after the first paint, and every point measured before it would be stale. Wait for the inset, then for quiet.
    await waitFor(page, `document.querySelector("main").style.paddingBottom !== ""`);
    await waitFor(page, `(() => { const feed = document.querySelector("main"); const was = feed.dataset.wasAt; feed.dataset.wasAt = String(feed.scrollTop); return was === String(feed.scrollTop); })()`);
  }, 30_000);

  afterAll(() => page?.close());

  it("a_long_answer_collapses_like_a_long_sent_message_and_opens_on_its_toggle", async () => {
    const collapsed = await geometry(page, "u-long");
    expect(Math.round(collapsed.textHeight / collapsed.lineHeight)).toBe(4);
    expect(collapsed.fullHeight).toBeGreaterThan(collapsed.textHeight * 3);
    expect(collapsed.toggle).toBe("Показать полностью");
    expect((await geometry(page, "u-words")).toggle).toBeNull(); // a short card keeps no control

    await page.click(await pointOf(page, '[data-block="u-long"] [data-role="message-toggle"]'));
    await waitFor(page, `document.querySelector('[data-block="u-long"] [data-role="message-toggle"]').textContent === "Свернуть"`);
    const open = await geometry(page, "u-long");
    expect(open.textHeight).toBe(open.fullHeight);
    await page.click(await pointOf(page, '[data-block="u-long"] [data-role="message-toggle"]')); // collapsed again
    await waitFor(page, `document.querySelector('[data-block="u-long"] [data-role="message-toggle"]').textContent === "Показать полностью"`);
  }, 20_000);

  it("the_card_and_its_fork_button_are_painted_where_the_mockups_family_puts_them", async () => {
    // the whole set open, as the person would read it back; the ↺ shows on hover, as a sent message's does
    await page.click(await pointOf(page, '[data-block="u-opts"] [data-role="message-toggle"]'));
    await waitFor(page, `document.querySelector('[data-block="u-opts"] [data-role="message-toggle"]').textContent === "Свернуть"`);
    await page.move(await pointOf(page, '[data-block="u-opts"] .answer-head'));
    const shown = await page.evaluate<boolean>(
      `getComputedStyle(document.querySelector('[data-block="u-opts"] [data-role="message-actions"]')).opacity === "1"`,
    );
    expect(shown).toBe(true);
    await page.screenshot(`${SHOTS}/card-options-with-descriptions.png`);

    await page.move(await pointOf(page, '[data-block="u-words"] .answer-head'));
    await page.screenshot(`${SHOTS}/card-free-text-answer.png`);
  }, 20_000);

  it("the_cards_own_button_opens_the_usual_fork_menu", async () => {
    await page.click(await pointOf(page, '[data-block="u-words"] [data-role="message-actions"]'));
    await waitFor(page, `document.querySelector('[data-popover="message-actions"] [data-role="fork"]:not([disabled])') !== null`);
    const labels = await page.evaluate<string[]>(
      `[...document.querySelectorAll('[data-popover="message-actions"] .mrow .name')].map((name) => name.textContent)`,
    );
    expect(labels).toEqual(["Ответвить разговор отсюда", "Откатить код сюда", "Ответвить и откатить код"]);
    await page.screenshot(`${SHOTS}/card-fork-menu.png`);
  }, 20_000);
});
