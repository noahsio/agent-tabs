import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/**
 * A provider rejection as the person sees it: the quiet Russian line with the provider's own sentence folded away,
 * and — the whole point of this branch — no red banner at the top of the tab. Verbatim from the journal,
 * `tg_channels_manager` 2026-11-04T18:51:29Z line 608.
 */
const PROVIDER_TEXT =
  "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. " +
  "If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access " +
  "via https://platform.openai.com/settings/organization/status-and-access before retrying.";

const SHOTS = "/tmp/agent-tabs-shots/rejection";

const STUB = `
(function () {
  var blocks = [
    { kind: "user", id: "u1", text: "собери статистику каналов" },
    { kind: "assistant", id: "a1", text: "", thinking: "Смотрю, что просят…", streaming: false },
    { kind: "notice", id: "n1", level: "warn", text: "Провайдер отклонил запрос — смените модель для этой сессии", details: ${JSON.stringify(PROVIDER_TEXT)} },
    { kind: "notice", id: "n2", level: "info", text: "Провайдер отклонил запрос — перешёл на Opus 5 и повторил" },
    { kind: "user", id: "u2", text: "собери статистику каналов" },
  ];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type !== "ready") return;
        // state.error absent: a rejection must never put the provider's English sentence in the banner
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

describe.skipIf(!hasChrome)("a provider rejection in the feed (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="n1"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("no_banner_carries_the_providers_english_anywhere_on_screen", async () => {
    const banner = await page.evaluate<{ visible: boolean; pageText: boolean }>(`(() => {
      const node = document.querySelector('[data-role="banner"], .banner');
      return {
        visible: node !== null && !node.hidden && node.getClientRects().length > 0,
        pageText: document.body.innerText.includes("cybersecurity risk"),
      };
    })()`);
    expect(banner).toEqual({ visible: false, pageText: false });
  });

  it("the_line_reads_in_russian_and_opens_onto_the_providers_words", async () => {
    const folded = await page.evaluate<string>(`document.querySelector('[data-block="n1"] .step.notice').innerText.trim()`);
    expect(folded).toContain("Провайдер отклонил запрос");
    expect(folded).toContain("Подробнее");
    expect(folded).not.toContain("cybersecurity risk");

    const opened = await page.evaluate<{ shown: string; feedScrolls: boolean }>(`(() => {
      const row = document.querySelector('[data-block="n1"] .step.notice');
      row.querySelector("details").open = true;
      const feed = document.querySelector("main.feed");
      return { shown: row.innerText.trim(), feedScrolls: feed.scrollWidth > feed.clientWidth + 1 };
    })()`);
    expect(opened.shown).toContain("cybersecurity risk");
    expect(opened.feedScrolls).toBe(false); // a long URL must not widen the feed
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot(join(SHOTS, "feed-rejection.png"));
  });

  it("the_step_the_ladder_took_reads_as_its_own_quiet_line", async () => {
    const step = await page.evaluate<string>(`document.querySelector('[data-block="n2"] .step.notice').innerText.trim()`);
    expect(step).toBe("Провайдер отклонил запрос — перешёл на Opus 5 и повторил");
  });
});
