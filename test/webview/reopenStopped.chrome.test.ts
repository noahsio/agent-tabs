import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** An empty, idle session: the honest "gave up reopening" line is then the only thing on screen. */
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

/** What the controller surfaces once it stops reopening a session OmO keeps parking. */
const STORM = "Сессия раз за разом выгружается и не остаётся открытой — перестал открывать её заново. Нажмите «Переподключить», чтобы попробовать снова.";

function send(page: Page, error: string | undefined): Promise<unknown> {
  const state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: false, ...(error !== undefined ? { error } : {}) } };
  return page.evaluate(`window.postMessage(${JSON.stringify(JSON.stringify(state))}, "*")`);
}

describe.skipIf(!hasChrome)("the honest stopped state after a reopen storm (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `(() => document.querySelector(".composer-box") !== null)()`);
  });

  afterAll(async () => {
    await page.close();
  });

  it("shows_one_honest_line_and_a_manual_button_that_asks_to_reopen", async () => {
    await send(page, STORM);
    await waitFor(page, `(() => { const b = document.querySelector('[data-role="banner"]'); return b !== null && !b.hidden; })()`);
    const shown = await page.evaluate<{ text: string; button: boolean }>(`(() => ({
      text: document.querySelector('.banner-text').textContent,
      button: !document.querySelector('[data-role="reconnect"]').hidden,
    }))()`);
    expect(shown.text).toBe(STORM); // one line, naming what happened
    expect(shown.button).toBe(true); // and a button to press

    // The button asks the host to reopen the session; nothing happens by itself.
    await page.evaluate(`(() => { window.__sent = []; document.querySelector('[data-role="reconnect"]').click(); })()`);
    const sent = await page.evaluate<{ type: string }[]>(`window.__sent`);
    expect(sent.some((message) => message.type === "reconnect")).toBe(true);
  });
});
