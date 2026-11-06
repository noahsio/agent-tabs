import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** Set to a directory to keep screenshots of the states checked here. */
const SHOTS = process.env["AGENT_TABS_SHOTS"];

/** A session on the text-only GPT 6 Astra, with an image-capable model also in the catalog to switch to. */
const STUB = `
(function () {
  var models = [
    { provider: "gw-openai", id: "gpt-6-astra", name: "GPT 6 Astra", acceptsImages: false },
    { provider: "gw-anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", acceptsImages: true },
  ];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type !== "ready") return;
        var state = {
          type: "state", reconnectable: true, models: models,
          tab: { modelMode: "manual", durableId: "id-1" },
          state: { blocks: [], dialogs: [], agents: [], running: false, model: { provider: "gw-openai", id: "gpt-6-astra" } },
        };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

/** Types a line and pastes a picture at the caret, the way a person does. */
const WRITE = `(async (words, name) => {
  const input = document.querySelector(".input");
  input.focus();
  input.textContent = words;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [new File([bytes], name, { type: "image/png" })], types: ["Files"], getData: () => "" } });
  input.dispatchEvent(paste);
})`;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot(join(SHOTS, `${name}.png`));
}

describe.skipIf(!hasChrome)("the image-capability warning (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-role="image-warn"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("shows_the_warning_and_disables_the_send_when_an_image_is_attached_to_a_text_only_model", async () => {
    await page.evaluate(`${WRITE}("посмотри на это", "shot.png")`);
    await waitFor(page, `document.querySelector('.input .att[data-status="ready"]') !== null`);
    await waitFor(page, `!document.querySelector('[data-role="image-warn"]').hidden`);

    expect(await page.evaluate<string>(`document.querySelector('[data-role="image-warn"]').textContent`)).toContain("GPT 6 Astra");
    expect(await page.evaluate<boolean>(`document.querySelector('[data-role="send"]').disabled`)).toBe(true);
    await shot(page, "text-only-model-drops-image");
  });
});
