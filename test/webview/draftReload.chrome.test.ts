import { afterEach, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

const INPUT = '.input[contenteditable="true"]';

/**
 * VS Code's webview API as a window reload sees it: `getState` gives back what the last page passed to `setState`.
 * `saved` is that state; every `setState` lands in `window.__state`, and every post in `window.__posted`.
 */
const stub = (saved: unknown): string => `
(function () {
  window.__state = ${JSON.stringify(saved ?? null)};
  window.__posted = [];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return window.__state === null ? undefined : window.__state; },
      setState: function (state) { window.__state = state; },
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type === "ready") setTimeout(function () {
          window.postMessage(JSON.stringify({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "d1", sessionPath: "/s/a.jsonl" }, state: { blocks: [], dialogs: [], agents: [], running: false } }), "*");
        }, 5);
      },
    };
  };
})();`;

async function tab(saved?: unknown): Promise<Page> {
  const page = await openPage(await webviewPage(stub(saved)));
  await waitFor(page, `document.querySelector('${INPUT}') !== null && window.__posted.some((m) => m.type === "ready")`);
  return page;
}

describe.skipIf(!hasChrome)("the unsent message across a window reload (headless Chrome)", () => {
  const pages: Page[] = [];
  afterEach(async () => {
    for (const page of pages.splice(0)) await page.close();
  });

  it("text_typed_and_not_sent_is_back_in_the_input_after_the_reload", async () => {
    const before = await tab();
    pages.push(before);
    await waitFor(before, "window.__state !== null"); // the tab's own state came in
    await before.evaluate(`document.querySelector('${INPUT}').focus()`);
    await before.type("not sent yet");
    await waitFor(before, `window.__state?.draft === "not sent yet"`);
    const saved = await before.evaluate<unknown>("window.__state");
    expect(saved).toMatchObject({ tab: { sessionPath: "/s/a.jsonl" }, draft: "not sent yet" });

    const after = await tab(saved);
    pages.push(after);
    expect(await after.evaluate<string>(`document.querySelector('${INPUT}').textContent`)).toBe("not sent yet");
    expect(await after.evaluate<boolean>(`document.querySelector('${INPUT}').hasAttribute("data-empty")`)).toBe(false);
  }, 30_000);

  it("a_sent_message_is_not_kept", async () => {
    const page = await tab();
    pages.push(page);
    await waitFor(page, "window.__state !== null");
    await page.evaluate(`document.querySelector('${INPUT}').focus()`);
    await page.type("go");
    await waitFor(page, `window.__state?.draft === "go"`);
    await page.key("Enter");
    await waitFor(page, `window.__posted.some((m) => m.type === "send" && m.text === "go")`);
    await waitFor(page, `window.__state !== null && !("draft" in window.__state)`);
  }, 30_000);
});
