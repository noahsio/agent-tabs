import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** The refusal line from the person's own session, with the provider's sentence folded away under it. */
const PROVIDER_TEXT =
  "This request triggered cyber-related safeguards. To learn about the Cyber Verification Program and apply for access, " +
  "visit our help center: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.";

const STUB = `
(function () {
  var blocks = [
    { kind: "user", id: "u1", text: "что?" },
    { kind: "notice", id: "n1", level: "warn", text: "Модель отказалась отвечать на этот запрос — смените модель для этой сессии", details: ${JSON.stringify(PROVIDER_TEXT)} },
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

describe.skipIf(!hasChrome)("a refusal line in the feed (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="n1"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("the_provider_s_words_are_folded_away_and_never_widen_the_feed", async () => {
    const folded = await page.evaluate<{ shown: string; rowHeight: number; feedScrolls: boolean }>(`(() => {
      const row = document.querySelector('[data-block="n1"] .step.notice');
      const feed = document.querySelector("main.feed");
      return {
        shown: row.innerText.trim(),
        rowHeight: row.getBoundingClientRect().height,
        feedScrolls: feed.scrollWidth > feed.clientWidth + 1,
      };
    })()`);
    expect(folded.shown).toContain("смените модель");
    expect(folded.shown).toContain("Подробнее");
    expect(folded.shown).not.toContain("cyber-related"); // closed: the English sentence is not on screen
    expect(folded.feedScrolls).toBe(false);

    const opened = await page.evaluate<{ shown: string; rowHeight: number; insideRail: boolean; feedScrolls: boolean }>(`(() => {
      const row = document.querySelector('[data-block="n1"] .step.notice');
      row.querySelector("details").open = true;
      const detail = row.querySelector("details > pre").getBoundingClientRect();
      const rail = row.getBoundingClientRect();
      const feed = document.querySelector("main.feed");
      return {
        shown: row.innerText.trim(),
        rowHeight: rail.height,
        insideRail: detail.right <= rail.right + 1,
        feedScrolls: feed.scrollWidth > feed.clientWidth + 1,
      };
    })()`);
    expect(opened.shown).toContain("cyber-related"); // opened by the person: the provider's own words
    expect(opened.rowHeight).toBeGreaterThan(folded.rowHeight);
    expect(opened.insideRail).toBe(true);
    expect(opened.feedScrolls).toBe(false); // a long URL wraps instead of pushing the feed sideways
  });
});
