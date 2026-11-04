import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** Set to a directory to keep screenshots of the states checked here. */
const SHOTS = process.env["AGENT_TABS_SHOTS"];

/** A running turn; host messages are posted with `window.__host(message)`, the webview's posts kept in `window.__posted`. */
const STUB = `
(function () {
  var blocks = [
    { kind: "user", id: "u1", text: "запушь изменения в main и проверь, что CI зелёный", timestamp: Date.now() },
    { kind: "assistant", id: "a1", text: "Сначала проверю статус репозитория, затем отправлю коммиты.", thinking: "", streaming: false },
    { kind: "tool", id: "t1", name: "bash", summary: "git status", input: "git status", output: "clean", truncated: false, state: "ok" },
  ];
  window.__posted = [];
  window.__host = function (message) { window.postMessage(JSON.stringify(message), "*"); };
  window.__state = function (patch) {
    var state = { blocks: blocks, dialogs: [], agents: [], running: true, activity: "thinking" };
    for (var key in patch) state[key] = patch[key];
    window.__host({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "s1" }, state: state });
  };
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        window.__posted.push(message);
        if (message.type === "ready") setTimeout(function () { window.__state({}); }, 5);
      },
    };
  };
})();`;

const REQUEST = {
  id: "abc123abc123",
  session: "s1",
  cwd: "/work/proj",
  tool: "bash",
  command: "git push origin main",
  reasons: ["отправка в git"],
  decider: { model: "claude-haiku", decision: "ask", reason: "push в общую ветку main, нужен человек", ms: 1200 },
  createdAt: "2026-11-04T10:00:00.000Z",
};

const QUESTIONS = [
  {
    id: "q1",
    header: "Кэш",
    question: "Как хранить кэш каталога после смены ноды?",
    options: [
      { label: "TTL и запасной кэш", description: "Отдавать сохранённый список до 10 минут; пустой ответ ноды его не перезаписывает" },
      { label: "Только на диске", description: "Список живёт до перезапуска; проще, но после смены ноды может устареть" },
      { label: "Без кэша", description: "Каждый раз спрашивать ноду; пустой список будет виден сразу" },
    ],
    multiSelect: false,
  },
  {
    id: "q2",
    header: "Проверки",
    question: "Какие проверки добавить?",
    options: [
      { label: "Юнит-тесты", description: "CatalogService: пустой ответ не затирает кэш" },
      { label: "Интеграционные", description: "Смена ноды на живом стенде, около 4 минут" },
      { label: "Линтер", description: "swiftlint по изменённым файлам" },
    ],
    multiSelect: true,
  },
];

type Box = { left: number; width: number; top: number; bottom: number; height: number; radius: string; background: string };

function box(page: Page, selector: string): Promise<Box> {
  return page.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const r = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { left: r.left, width: r.width, top: r.top, bottom: r.bottom, height: r.height, radius: style.borderTopLeftRadius, background: style.backgroundColor };
  })()`);
}

const host = (page: Page, message: unknown): Promise<unknown> => page.evaluate(`window.__host(${JSON.stringify(message)})`);
const state = (page: Page, patch: unknown): Promise<unknown> => page.evaluate(`window.__state(${JSON.stringify(patch)})`);

/** Past the guard that keeps keystrokes meant for the composer off a prompt that just appeared. */
const settleKeys = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot(join(SHOTS, `${name}.png`));
}

describe.skipIf(!hasChrome)("the docked panel (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="t1"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("an_approval_sits_exactly_where_the_composer_was_with_its_width_and_form", async () => {
    const composer = await box(page, ".composer-box");
    await host(page, { type: "guardRequest", request: REQUEST });
    await waitFor(page, `document.querySelector(".ask") !== null`);
    const ask = await box(page, ".ask");
    expect(Math.abs(ask.left - composer.left)).toBeLessThan(0.5);
    expect(Math.abs(ask.width - composer.width)).toBeLessThan(0.5);
    expect(Math.abs(ask.bottom - composer.bottom)).toBeLessThan(0.5); // the same slot at the foot of the tab
    expect(ask.radius).toBe(composer.radius);
    expect(ask.background).toBe(composer.background);
    expect(await page.evaluate<boolean>(`getComputedStyle(document.querySelector(".composer-box")).display === "none"`)).toBe(true);
    expect(await page.evaluate<string>(`document.querySelector('[data-role="indicator"]').textContent`)).toBe("Ждёт вашего решения");
    await shot(page, "1-approval-bash");
  });

  it("deny_and_tell_the_agent_turns_the_row_into_a_field", async () => {
    await settleKeys();
    await page.key("3");
    await waitFor(page, `document.activeElement && document.activeElement.dataset.role === "ask-field"`);
    await page.evaluate(`(() => { const f = document.activeElement; f.value = "сначала прогони npm test, пушь только если всё зелёное"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await shot(page, "2-approval-deny-with-text");
    await page.key("Enter");
    const sent = await page.evaluate<unknown[]>(`window.__posted.filter((m) => m.type === "guardAnswer")`);
    expect(sent).toEqual([{ type: "guardAnswer", id: REQUEST.id, decision: "deny", message: "сначала прогони npm test, пушь только если всё зелёное" }]);
    await host(page, { type: "guardResolved", id: REQUEST.id, decision: "deny", by: "agent-tabs", message: "сначала прогони npm test, пушь только если всё зелёное" });
    await host(page, { type: "guardStep", id: "d1", tool: "bash", command: "npm test", decider: { model: "claude-haiku", decision: "allow", reason: "tests", ms: 1400 }, at: REQUEST.createdAt });
    await waitFor(page, `document.querySelector(".ask") === null`);
    expect(await page.evaluate<boolean>(`getComputedStyle(document.querySelector(".composer-box")).display !== "none"`)).toBe(true);
    await shot(page, "3-approval-results");
  });

  it("an_eval_approval_lists_its_commands_collapsed", async () => {
    const command = ["git fetch origin", "git rebase origin/main", "npm ci", "npm test -- --run", "npm run build", "rsync -az --delete dist/ deploy@stage:/srv/catalog/", "ssh deploy@stage 'systemctl restart catalog'", "curl -fsS https://stage.internal/health"].join("\n");
    const code = Array.from({ length: 12 }, (_, index) => `await tool.bash(steps[${index}]);`).join("\n");
    await host(page, { type: "guardRequest", request: { ...REQUEST, id: "eval00000000", tool: "eval", command, code, reasons: ["запись на другой сервер (rsync, ssh)"] } });
    await waitFor(page, `document.querySelector(".ask .lead") !== null`);
    await shot(page, "4-approval-eval");
    await host(page, { type: "guardResolved", id: "eval00000000", decision: "allow", by: "telegram" });
    await waitFor(page, `document.querySelector(".ask") === null`);
  });

  it("a_set_of_questions_has_chips_of_one_height_answered_or_not", async () => {
    await state(page, { dialogs: [{ id: "qs", method: "question", title: "Как хранить кэш?", questions: QUESTIONS }] });
    await waitFor(page, `document.querySelectorAll(".ask .qtab").length === 2`);
    // the composer had the focus (it came back after the last answer): the panel waits unfocused until Tab
    expect(await page.evaluate<boolean>(`document.activeElement === document.body`)).toBe(true);
    await shot(page, "5a-question-unfocused");
    await page.key("Tab");
    await waitFor(page, `document.activeElement && document.activeElement.classList.contains("ask")`);
    await settleKeys();
    await page.key("1"); // the first question answered: its chip gets a check, the second opens
    await waitFor(page, `document.querySelector(".ask .qtab svg") !== null`);
    await page.key("1");
    await page.key("3");
    await page.key("ArrowDown");
    await page.key("ArrowDown");
    const heights = await page.evaluate<number[]>(`[...document.querySelectorAll(".ask .qtab")].map((tab) => tab.getBoundingClientRect().height)`);
    expect(heights).toHaveLength(2);
    expect(heights[0]).toBe(heights[1]);
    expect(heights[0]).toBe(22);
    const composerWidth = await page.evaluate<number>(`(() => { const b = document.querySelector(".composer-box"); b.hidden = false; const w = b.getBoundingClientRect().width; b.hidden = true; return w; })()`);
    expect(Math.abs((await box(page, ".ask")).width - composerWidth)).toBeLessThan(0.5);
    await shot(page, "5-question-set");
    await page.key("Enter");
    await state(page, { dialogs: [] });
    await host(page, { type: "answerResult", dialogId: "qs", outcome: "applied" });
    await waitFor(page, `document.querySelector(".ask") === null`);
    await shot(page, "6-question-results");
  });

  it("several_prompts_show_a_counter", async () => {
    await host(page, { type: "guardRequest", request: { ...REQUEST, id: "one000000000" } });
    await host(page, { type: "guardRequest", request: { ...REQUEST, id: "two000000000", command: "git push --tags" } });
    await state(page, { dialogs: [{ id: "c1", method: "confirm", title: "Удалить 3 устаревших снапшота из .omo/cache?" }] });
    await waitFor(page, `document.querySelector('[data-role="ask-count"]') !== null`);
    expect(await page.evaluate<string>(`document.querySelector('[data-role="ask-count"]').textContent`)).toBe("‹1 из 3›");
    await shot(page, "7-counter");
    await host(page, { type: "guardResolved", id: "one000000000", decision: "allow", by: "telegram" });
    await host(page, { type: "guardResolved", id: "two000000000", decision: "allow", by: "telegram" });
    expect(await page.evaluate<boolean>(`document.querySelector('[data-role="ask-stop"]') !== null`)).toBe(true); // a turn runs
    await shot(page, "8-confirm");
    await state(page, { dialogs: [] });
  });

  it("another_sessions_request_waits_as_a_line_in_the_feed", async () => {
    await host(page, { type: "guardRequest", request: { ...REQUEST, id: "away00000000", cwd: "/work/other" }, elsewhere: true });
    await waitFor(page, `document.querySelector('[data-role="open-elsewhere"]') !== null`);
    expect(await page.evaluate<boolean>(`document.querySelector(".ask") === null`)).toBe(true);
    await shot(page, "10-elsewhere");
    await host(page, { type: "guardResolved", id: "away00000000", decision: "deny", by: "cli" });
  });
});

describe.skipIf(!hasChrome)("the docked panel at 420 px (headless Chrome)", () => {
  let page: Page;

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB), { width: 420, height: 700 });
    await waitFor(page, `document.querySelector('[data-block="t1"]') !== null`);
  }, 30_000);

  afterAll(() => page?.close());

  it("the_panel_still_spans_the_composers_width_and_never_scrolls_sideways", async () => {
    const composer = await box(page, ".composer-box");
    await state(page, { dialogs: [{ id: "q", method: "question", title: "Кэш", questions: [QUESTIONS[0]] }] });
    await waitFor(page, `document.querySelector(".ask") !== null`);
    const ask = await box(page, ".ask");
    expect(Math.abs(ask.width - composer.width)).toBeLessThan(0.5);
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
    await shot(page, "9-question-420");
  });
});
