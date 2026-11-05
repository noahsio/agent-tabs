import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/**
 * A session as long as the person's own biggest one (~600 blocks after the journal replay): the first state the host
 * posts carries the whole conversation, and the tab must show all of it — no empty-state hint left over, and the paint
 * cost measured where it is real (jsdom neither lays out nor paints). The time is printed, never asserted: this guards
 * the render, not the machine it runs on.
 */
const BLOCKS = 600;

const STUB = `
(function () {
  var blocks = [];
  for (var i = 0; i < ${BLOCKS}; i++) {
    if (i % 5 === 0) blocks.push({ kind: "user", id: "u" + i, text: "Запрос номер " + i + ". " + "Ещё слова, чтобы строка была длиннее. ".repeat(3) });
    else if (i % 5 === 1) blocks.push({ kind: "tool", id: "t" + i, name: "bash", summary: "step " + i, input: "echo " + i + "\\nls -la\\npwd", output: "line 1\\nline 2\\nline 3", truncated: false, state: "ok" });
    else if (i % 5 === 2) blocks.push({ kind: "tool", id: "d" + i, name: "edit", summary: "/repo/a" + i + ".ts", file: "/repo/a" + i + ".ts", input: " keep\\n-old\\n+new\\n tail", added: 1, removed: 1, output: "ok", truncated: false, state: "ok" });
    else blocks.push({ kind: "assistant", id: "a" + i, text: "Ответ " + i + ".\\n\\n- пункт один\\n- пункт два\\n\\n\`code " + i + "\`", thinking: "", streaming: false });
  }
  window.__blocks = blocks.length;
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1", sessionPath: "/tmp/agent/sessions/--p--/s.jsonl" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        window.__postedAt = performance.now();
        window.postMessage(JSON.stringify(state), "*");
      },
    };
  };
})();`;

describe.skipIf(!hasChrome)("a long session's first state (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
  }, 120_000);

  afterAll(async () => {
    await page?.close();
  });

  it("shows_every_block_of_the_first_state", async () => {
    await waitFor(page, `document.querySelectorAll('main .timeline > [data-block]').length >= ${BLOCKS}`);
    const painted = await page.evaluate<number>("Math.round(performance.now() - window.__postedAt)");
    console.log(`first paint of ${BLOCKS} blocks: ${painted} ms`);
    expect(await page.evaluate<number>("document.querySelectorAll('main .timeline > [data-block]').length")).toBe(BLOCKS);
    expect(await page.evaluate<boolean>("document.querySelector('main .empty').hidden")).toBe(true); // no new-chat hint over a conversation
  });
});
