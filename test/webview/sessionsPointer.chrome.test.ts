import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

const MINUTE = 60_000;

/** Stands in for VS Code: a fixed state, three sessions, and every message the webview posts in `window.__posted`. */
const STUB = `
(function () {
  var now = Date.now();
  function session(n, title, ago) {
    return { sessionPath: "/s/" + n + ".jsonl", durableId: "id-" + n, title: title, updatedAt: now - ago, running: false, pinned: false, archived: false, current: n === 1 };
  }
  var sessions = [session(1, "Текущая", 0), session(2, "Вторая", 12 * ${MINUTE}), session(3, "Третья", 180 * ${MINUTE})];
  window.__state = function (n) {
    return { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: true, activity: "thinking", title: "Текущая", contextTokens: 1000 + n } };
  };
  window.__posted = [];
  function reply(message) { setTimeout(function () { window.postMessage(JSON.stringify(message), "*"); }, 5); }
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type === "ready") reply(window.__state(0));
        if (message.type === "listSessions") reply({ type: "sessions", items: sessions });
      },
    };
  };
})();`;

/** The centre of the first element matching `selector` inside the `index`-th session row. */
function centre(page: Page, index: number, selector: string): Promise<Point> {
  return page.evaluate<Point>(`(() => {
    const row = document.querySelectorAll('[data-popover="sessions"] [data-row]')[${index}];
    const box = row.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
}

/** What a click at `point` would hit, by `data-role` of the nearest marked ancestor. */
function hit(page: Page, point: Point): Promise<string | null> {
  return page.evaluate<string | null>(`document.elementFromPoint(${point.x}, ${point.y})?.closest('[data-role]')?.dataset.role ?? null`);
}

describe.skipIf(!hasChrome)("sessions popover under a real pointer (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await page.click(await page.evaluate<Point>(`(() => { const box = document.querySelector('[data-role="sessions"]').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`));
    await waitFor(page, `document.querySelectorAll('[data-popover="sessions"] [data-row]').length === 3`);
    // The host streams the running session's state while the person works in the list.
    await page.evaluate(`(() => { let n = 0; window.__stream = setInterval(() => window.postMessage(JSON.stringify(window.__state(++n)), "*"), 50); })()`);
  }, 30_000);

  afterAll(() => page?.close());

  it("hovering a row puts its rename and archive buttons on top of the time, and the pencil opens the rename field", async () => {
    await page.move(await centre(page, 1, '[data-role="session-title"]'));
    await new Promise((resolve) => setTimeout(resolve, 200)); // a few state updates land while the pointer rests on the row
    const pencil = await centre(page, 1, '[data-role="session-rename"]');
    expect(await hit(page, pencil)).toBe("session-rename");
    expect(await hit(page, await centre(page, 1, '[data-role="session-archive"]'))).toBe("session-archive");

    await page.click(pencil);
    await waitFor(page, `document.querySelector('[data-role="session-rename-input"]') !== null`);
    expect(await page.evaluate<boolean>(`document.activeElement?.dataset.role === "session-rename-input"`)).toBe(true);
    expect(await page.evaluate<string[]>(`window.__posted.map((m) => m.type)`)).not.toContain("openSession");
  }, 15_000);

  it("the archive button under the pointer archives that session instead of opening it", async () => {
    await page.key("Escape"); // leaves the rename
    await waitFor(page, `document.querySelector('[data-role="session-rename-input"]') === null`);
    await page.move(await centre(page, 2, '[data-role="session-title"]'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.click(await centre(page, 2, '[data-role="session-archive"]'));
    await waitFor(page, `window.__posted.some((m) => m.type === "archive")`);
    const posted = await page.evaluate<{ type: string; durableId?: string; archived?: boolean }[]>(`window.__posted`);
    expect(posted.find((message) => message.type === "archive")).toEqual({ type: "archive", durableId: "id-3", archived: true });
    expect(posted.map((message) => message.type)).not.toContain("openSession");
    expect(await page.evaluate<boolean>(`!document.querySelector('[data-popover="sessions"]').hidden`)).toBe(true);
  }, 15_000);
});
