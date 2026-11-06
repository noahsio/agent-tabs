import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/**
 * The model ladder in a real browser: the composer's line while it walks, and its settings section. Layout — the row
 * grid, the wrapped failure checkboxes, where the line sits against the box — exists only here, and the shots go to
 * `/tmp/agent-tabs-shots/ladder/` so the two surfaces can be looked at.
 */
const SHOTS = "/tmp/agent-tabs-shots/ladder";

const LADDER_SETTINGS = {
  env: { name: "second", agentDir: "/Users/someone/.omo/agents/second" },
  ladder: {
    models: [
      {
        connection: "Шлюз (Anthropic API)",
        items: [
          { value: "gw-anthropic/opus-5-5", label: "Claude Opus 5.5" },
          { value: "gw-anthropic/opus-5", label: "Claude Opus 5" },
          { value: "gw-anthropic/opus-4-8", label: "Claude Opus 4.8" },
        ],
      },
      { connection: "Шлюз (OpenAI)", items: [{ value: "gw-openai/sol", label: "GPT 6.1 Sol" }] },
    ],
    rungs: [
      { id: "r1", action: { kind: "model", provider: "gw-anthropic", id: "opus-5-5" }, on: [], label: "Claude Opus 5.5" },
      { id: "r2", action: { kind: "model", provider: "gw-anthropic", id: "opus-5", text: "продолжай" }, on: ["empty", "silence", "transport"], label: "Claude Opus 5" },
      { id: "r3", action: { kind: "model", provider: "gw-anthropic", id: "opus-4-8" }, on: ["empty", "silence", "transport"], label: "Claude Opus 4.8" },
      { id: "r4", action: { kind: "model", provider: "gw-openai", id: "sol" }, on: ["refusal", "empty", "silence", "transport"], label: "GPT 6.1 Sol" },
      { id: "r5", action: { kind: "text", text: "продолжи" }, on: ["silence"], label: "продолжи" },
      { id: "r6", action: { kind: "model", provider: "gw-q", id: "dsv41-flash" }, on: ["refusal"], label: "dsv41-flash", missing: true },
      { id: "r7", action: { kind: "ask" }, on: ["refusal", "empty", "silence", "transport"], label: "Остановиться и спросить" },
    ],
  },
};

/**
 * A tab mid-walk: the person's message and the two lines the ladder wrote, with its own line over the composer.
 * The `ladder` message is what the host sends while the walk is in flight.
 */
const WALKING_STATE = {
  type: "state",
  reconnectable: true,
  commands: [],
  models: [{ provider: "gw-openai", id: "sol", name: "GPT 6.1 Sol" }],
  tab: { modelMode: "auto", durableId: "id-1" },
  state: {
    dialogs: [],
    agents: [],
    running: true,
    activity: "thinking",
    blocks: [
      { kind: "user", id: "u1", text: "Разбери результаты прогона по кошелькам и собери средства на один адрес", timestamp: 1 },
      { kind: "notice", id: "n1", level: "warn", text: "Модель отказалась отвечать на этот запрос — смените модель для этой сессии", details: "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy." },
      { kind: "notice", id: "n2", level: "info", text: "Модель отказалась — перешёл на GPT 6.1 Sol и повторил" },
      { kind: "user", id: "u2", text: "Разбери результаты прогона по кошелькам и собери средства на один адрес", timestamp: 2 },
    ],
  },
};

const SETTLED_LADDER = {
  type: "ladder",
  view: { state: "settled", model: "GPT 6.1 Sol", back: { provider: "gw-anthropic", id: "opus-5-5", label: "Claude Opus 5.5" } },
};
const WALKING_LADDER = { type: "ladder", view: { state: "walking", rung: 4, total: 7, label: "GPT 6.1 Sol" } };

/** The webview with no host behind it: `ready` gets `state`, `settingsGet` gets the ladder section's own state. */
function stub(onReady: unknown[]): string {
  return `
(function () {
  var settings = ${JSON.stringify(LADDER_SETTINGS)};
  var onReady = ${JSON.stringify(onReady)};
  function reply(message) { setTimeout(function () { window.postMessage(JSON.stringify(message), "*"); }, 5); }
  window.__posted = [];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type === "ready") onReady.forEach(reply);
        if (message.type === "settingsGet") reply({ type: "settings", state: settings });
      },
    };
  };
})();`;
}

const LADDER_LINE = '[data-role="ladder"]';
const lineText = `document.querySelector('${LADDER_LINE} [data-role="ladder-text"]').textContent`;

async function walkingTab(size = { width: 900, height: 700 }): Promise<Page> {
  const page = await openPage(await webviewPage(stub([WALKING_STATE, WALKING_LADDER])), size);
  await waitFor(page, `document.querySelector('${LADDER_LINE}') && !document.querySelector('${LADDER_LINE}').hidden`);
  return page;
}

async function ladderSettings(size = { width: 900, height: 1200 }): Promise<Page> {
  const page = await openPage(await webviewPage(stub([{ type: "state", reconnectable: true, commands: [], tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: false } }, { type: "openSettings", section: "ladder" }])), size);
  await waitFor(page, `document.querySelector('[data-rung]')`);
  // the shot shows the whole section at once: lift the modal's own height cap
  await page.evaluate(`(() => { const s = document.createElement("style"); s.textContent = ".settings{height:min(1150px,100%) !important}"; document.head.append(s); })()`);
  return page;
}

describe.skipIf(!hasChrome)("the model ladder (headless Chrome)", () => {
  it("the_walking_line_sits_under_the_composer_box_and_is_clickable_where_it_is_drawn", async () => {
    const page = await walkingTab();
    try {
      expect(await page.evaluate<string>(lineText)).toBe("Ступенька 4 из 7 · GPT 6.1 Sol");
      const box = await page.evaluate<{ lineTop: number; boxBottom: number; stop: { x: number; y: number } }>(`(() => {
        const line = document.querySelector('${LADDER_LINE}').getBoundingClientRect();
        const composer = document.querySelector(".composer-box").getBoundingClientRect();
        const stop = document.querySelector('[data-role="ladder-stop"]').getBoundingClientRect();
        return { lineTop: line.top, boxBottom: composer.bottom, stop: { x: stop.left + stop.width / 2, y: stop.top + stop.height / 2 } };
      })()`);
      expect(box.lineTop).toBeGreaterThanOrEqual(box.boxBottom - 1); // under the box, like the wedge line
      // a real click, picked by hit testing: nothing may be drawn over «Прервать»
      await page.click(box.stop);
      await waitFor(page, `window.__posted.some((message) => message.type === "ladderInterrupt")`);
      expect(await page.evaluate<boolean>(`document.querySelector('${LADDER_LINE}').hidden`)).toBe(true);
      mkdirSync(SHOTS, { recursive: true });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the_settled_line_offers_the_way_back_and_one_click_takes_it", async () => {
    const page = await walkingTab();
    try {
      await page.evaluate(`window.postMessage(JSON.stringify(${JSON.stringify(SETTLED_LADDER)}), "*")`);
      await waitFor(page, `document.querySelector('[data-role="ladder-back"]') && !document.querySelector('[data-role="ladder-back"]').hidden`);
      expect(await page.evaluate<string>(lineText)).toBe("Сессия осталась на GPT 6.1 Sol");
      const spot = await page.evaluate<{ x: number; y: number }>(`(() => {
        const back = document.querySelector('[data-role="ladder-back"]').getBoundingClientRect();
        return { x: back.left + back.width / 2, y: back.top + back.height / 2 };
      })()`);
      await page.click(spot);
      await waitFor(page, `window.__posted.some((message) => message.type === "setModel" && message.model && message.model.id === "opus-5-5")`);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the_line_never_covers_the_input_and_the_tab_does_not_scroll_sideways", async () => {
    const page = await walkingTab({ width: 420, height: 700 });
    try {
      const layout = await page.evaluate<{ overlaps: boolean; sideways: boolean }>(`(() => {
        const line = document.querySelector('${LADDER_LINE}').getBoundingClientRect();
        const input = document.querySelector(".input").getBoundingClientRect();
        return {
          overlaps: line.top < input.bottom - 1,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      })()`);
      expect(layout).toEqual({ overlaps: false, sideways: false });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("every_rung_row_fits_its_panel_and_shows_its_five_failures", async () => {
    const page = await ladderSettings({ width: 420, height: 900 });
    try {
      const audit = await page.evaluate<{ rungs: number; boxes: number[]; problems: string[] }>(`(() => {
        const body = document.querySelector(".st-body").getBoundingClientRect();
        const rows = [...document.querySelectorAll("[data-rung]")];
        const problems = [];
        for (const row of rows) {
          for (const node of row.querySelectorAll("*")) {
            if (node.getClientRects().length === 0) continue;
            if (node.getBoundingClientRect().right > body.right + 1) problems.push(row.dataset.rung + ": " + node.tagName + "." + node.className);
          }
        }
        return { rungs: rows.length, boxes: rows.map((row) => row.querySelectorAll('input[type="checkbox"]').length), problems };
      })()`);
      expect(audit.rungs).toBe(7);
      expect(audit.boxes).toEqual([5, 5, 5, 5, 5, 5, 5]);
      expect(audit.problems).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("screenshots", async () => {
    mkdirSync(SHOTS, { recursive: true });
    const walking = await walkingTab();
    try {
      await walking.screenshot(join(SHOTS, "composer-walking.png"));
      await walking.evaluate(`window.postMessage(JSON.stringify(${JSON.stringify(SETTLED_LADDER)}), "*")`);
      await waitFor(walking, `document.querySelector('[data-role="ladder-back"]') && !document.querySelector('[data-role="ladder-back"]').hidden`);
      await walking.screenshot(join(SHOTS, "composer-settled.png"));
    } finally {
      await walking.close();
    }
    const settings = await ladderSettings();
    try {
      await settings.screenshot(join(SHOTS, "settings-ladder.png"));
    } finally {
      await settings.close();
    }
    for (const name of ["composer-walking.png", "composer-settled.png", "settings-ladder.png"]) {
      expect(existsSync(join(SHOTS, name))).toBe(true);
    }
  }, 120_000);

  // the continuation extension: the edited ladder section, with a model rung (rung 2) carrying «продолжай» alongside
  // its model, and a pure text rung (rung 5) — the two shapes a rung can now take. Its own shot dir, for review.
  it("the_continuation_section_screenshot", async () => {
    const dir = "/tmp/agent-tabs-shots/ladder-cont";
    mkdirSync(dir, { recursive: true });
    const settings = await ladderSettings();
    try {
      const shot = join(dir, "settings-ladder-continue.png");
      await settings.screenshot(shot);
      expect(existsSync(shot)).toBe(true);
      // the combined rung's phrase is really in the field, not just the fixture
      expect(
        await settings.evaluate<string>(`document.querySelector('[data-rung="r2"] [data-role="rung-text"]').value`),
      ).toBe("продолжай");
    } finally {
      await settings.close();
    }
  }, 120_000);
});
