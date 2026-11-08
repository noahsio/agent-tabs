import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/**
 * The settings modal in a narrow panel, in a real browser: layout (container queries, flex-wrap) exists only there.
 * `SETTINGS_SHOTS=<dir>` also saves a screenshot of every section at 900, 600, 480 and 360 px.
 */
const MCP_MASK = "•••";
const STATE = {
  env: { name: "second", agentDir: "/Users/someone/.omo/agents/second" },
  connections: {
    gateways: [
      { id: "gw-anthropic", name: "Шлюз (Anthropic API)", protocol: "anthropic-messages", baseUrl: "https://ai.example.ru/api/gw/anthropic/v1", keyHint: "••••••b7f3", modelCount: 3, fetchedAt: new Date(Date.now() - 120_000).toISOString(), status: "ok" },
      { id: "gw-broken", name: "Сломанный шлюз с очень длинным названием", protocol: "openai-completions", baseUrl: "https://down.example.com/some/very/long/path/to/the/openai/compatible/endpoint", keyHint: "••••••0000", modelCount: 9, status: "error", error: "Шлюз «Сломанный» ответил 503" },
    ],
    accounts: [{ provider: "chatgpt-subscription", name: "me@example.com", displayName: "Моя подписка", status: "вход выполнен" }],
    apiKeys: [{ provider: "anthropic", keyHint: "••••••4321" }],
    any: true,
  },
  models: {
    rows: [
      { id: "main", title: "Главный агент", detail: "ведёт сессию", hint: "model_profile", model: "gw-x/m1", reasoning: "xhigh" },
      { id: "explore", title: "Разведка кода", detail: "быстро находит нужное в проекте", hint: "explore", model: "gw-x/m2", reasoning: "medium" },
      { id: "memory", title: "Память", detail: "разбирает ошибки", hint: "memory", model: "quick", categories: [{ value: "quick", label: "Быстрые задачи — m2 (quick)" }] },
    ],
    models: [{ connection: "Шлюз (Anthropic API)", items: [{ value: "gw-x/m1", label: "Claude Opus 5.5 с длинным именем" }, { value: "gw-x/m2", label: "m2" }] }],
  },
  security: {
    state: "off",
    consent: {
      plist: "/Users/someone/Library/LaunchAgents/local.agent-tabs.guard.1234abcd.plist",
      kitDir: "/Users/someone/.omo/kit/0123456789ab/guard",
      hooksJson: "/Users/someone/.omo/agents/second/hooks.json",
      profile: "/Users/someone/.omo/agents/second/guard/sandbox.sb",
      writeDenies: ["/opt/homebrew", "/Users/someone/.codegraph", "/Users/someone/dev/repo/bin/tool"],
    },
    text: { hardDeny: "rm -rf /\nsudo rm *", askCustom: "docker volume prune*", ipWhitelist: "203.0.113.10 # дев-сервер\n10.20.0.0/16 # офис" },
    groups: { "git-push": true, history: true, secrets: true, "external-ip": true, "global-install": false },
    decider: { mode: "decider-then-me", model: "gw-x/m1", timeoutMs: 20000 },
    human: { waitSeconds: 300, card: true, telegram: false },
    telegram: { chat: "", legacy: false, ready: false },
    models: [{ connection: "Шлюз (Anthropic API)", items: [{ value: "gw-x/m1", label: "Claude Opus 5.5" }] }],
  },
  tools: {
    codegraph: { on: true },
    superpowers: {
      mode: "skills",
      folder: "/Users/someone/.omo/superpowers",
      version: "6.3.1-yasherisa.3",
      sha: "d592fb7",
      pinned: "d592fb7",
      skills: 15,
      claude: [
        { dir: "/Users/someone/.claude", label: "~/.claude", plugin: "on" },
        { dir: "/Users/someone/.omo-second/claude", label: "~/.omo-second/claude", plugin: "absent" },
      ],
    },
    skills: [{ folder: "/c/skills/prompt-master", name: "prompt-master", on: true }, { folder: "/c/skills/supervisor", name: "supervisor", on: false }],
    otherSkills: [{ path: "/Users/someone/.omo-second/claude/skills/a-very-long-skill-folder-name-that-must-wrap", exists: false }],
    mcp: [{ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: MCP_MASK } }],
    hidden: ["tui", "keybindings", "help"],
    instructions: { on: true, path: "/Users/someone/.claude/CLAUDE.md", exists: true },
  },
  environment: {
    folders: { agentDir: "/Users/someone/.omo/agents/second", memoryHome: "~/memory", claudeDir: "/Users/someone/.claude" },
    omoVersion: "5.1.59",
    restartNeeded: false,
    restartHint: "Перезапустить OmO — нужно после смены папок",
    questionTimeoutMinutes: 5,
  },
};

const STUB = `
(function () {
  var state = ${JSON.stringify(STATE)};
  function reply(message) { setTimeout(function () { window.postMessage(JSON.stringify(message), "*"); }, 5); }
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type === "ready") reply({ type: "state", reconnectable: true, commands: [], tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: false } });
        if (message.type === "settingsGet") reply({ type: "settings", state: state });
      },
    };
  };
  setTimeout(function () { window.postMessage(JSON.stringify({ type: "openSettings", section: "connections" }), "*"); }, 50);
})();`;

type Scenario = { name: string; section: string; setup: string };
const click = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}).click();`;
const SCENARIOS: Scenario[] = [
  { name: "connections", section: "connections", setup: "" },
  { name: "connections-form", section: "connections", setup: click('[data-add="key-or-gateway"]') },
  { name: "models", section: "models", setup: "" },
  { name: "security", section: "security", setup: "" },
  { name: "security-consent", section: "security", setup: click('[data-toggle="protection"]') + click('[data-toggle="telegram"]') },
  { name: "tools", section: "tools", setup: "" },
  { name: "tools-form", section: "tools", setup: click('[data-action="mcp.add"]') + click('[data-action="hidden.edit"]') },
  { name: "environment", section: "environment", setup: "" },
];

async function openSettings(width: number, tall: boolean): Promise<Page> {
  const page = await openPage(await webviewPage(STUB), { width, height: tall ? 2400 : 800 });
  await waitFor(page, `document.querySelector('[data-popover="settings"]') && !document.querySelector('[data-popover="settings"]').hidden && document.querySelector('[data-gateway]')`);
  // screenshots show a whole section at once: lift the modal's height cap and let the body grow
  if (tall) await page.evaluate(`(() => { const s = document.createElement("style"); s.textContent = ".settings{height:min(2300px,100%) !important}"; document.head.append(s); })()`);
  return page;
}

async function show(page: Page, scenario: Scenario): Promise<void> {
  await page.evaluate(`document.querySelector('[data-section="${scenario.section}"]').click()`);
  await waitFor(page, `!document.querySelector('[data-section-body="${scenario.section}"]').hidden`);
  if (scenario.setup !== "") await page.evaluate(`(() => { ${scenario.setup} })()`);
}

type Problem = string;
/** Text blocks squeezed under 200 px, a body that scrolls sideways, and any control wider than the body. */
const AUDIT = `(() => {
  const body = document.querySelector(".st-body");
  const bodyBox = body.getBoundingClientRect();
  const problems = [];
  const visible = (node) => node.getClientRects().length > 0;
  for (const node of body.querySelectorAll("div.st-grow, div.st-t, div.st-s, p.st-s")) {
    if (!visible(node) || (node.textContent || "").trim().length <= 12) continue;
    const width = node.getBoundingClientRect().width;
    if (width < 200) problems.push("narrow text " + Math.round(width) + "px: " + node.textContent.trim().slice(0, 40));
  }
  for (const node of body.querySelectorAll("*")) {
    if (!visible(node)) continue;
    const box = node.getBoundingClientRect();
    if (box.right > bodyBox.right + 1 && !node.closest("textarea, .st-rules")) problems.push("overflows right: " + node.tagName + "." + node.className + " " + (node.textContent || "").trim().slice(0, 30));
  }
  if (body.scrollWidth > body.clientWidth + 1) problems.push("body scrolls sideways: " + body.scrollWidth + " > " + body.clientWidth);
  return problems;
})()`;

describe.skipIf(!hasChrome)("the settings modal in a narrow panel (headless Chrome)", () => {
  it("at_400px_no_settings_text_column_is_squeezed_under_200px_and_nothing_scrolls_sideways", async () => {
    const page = await openSettings(400, false);
    try {
      const problems: Problem[] = [];
      for (const scenario of SCENARIOS) {
        await show(page, scenario);
        problems.push(...(await page.evaluate<string[]>(AUDIT)).map((problem) => `${scenario.name}: ${problem}`));
      }
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("a_gateway_card_puts_the_name_and_status_on_one_line_and_wraps_its_buttons_below_in_a_narrow_panel", async () => {
    const page = await openSettings(400, false);
    try {
      const layout = await page.evaluate<{ info: number; infoBottom: number; buttonsTop: number; buttonsLeft: number; cardLeft: number; sameLine: boolean }>(`(() => {
        const card = document.querySelector('[data-gateway="gw-anthropic"]');
        const info = card.querySelector(".st-grow").getBoundingClientRect();
        const first = card.querySelector("button.st-sm").getBoundingClientRect();
        const name = card.querySelector(".st-t").getBoundingClientRect();
        const badge = card.querySelector(".st-badge").getBoundingClientRect();
        return { info: info.width, infoBottom: info.bottom, buttonsTop: first.top, buttonsLeft: first.left, cardLeft: card.getBoundingClientRect().left, sameLine: Math.abs((name.top + name.bottom) / 2 - (badge.top + badge.bottom) / 2) < 8 };
      })()`);
      expect(layout.info).toBeGreaterThanOrEqual(200);
      expect(layout.buttonsTop).toBeGreaterThanOrEqual(layout.infoBottom - 1);
      expect(layout.buttonsLeft - layout.cardLeft).toBeLessThan(30); // left-aligned under the text
      expect(layout.sameLine).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  it.skipIf(process.env["SETTINGS_SHOTS"] === undefined)("screenshots", async () => {
    const dir = process.env["SETTINGS_SHOTS"] as string;
    mkdirSync(dir, { recursive: true });
    for (const width of [900, 600, 480, 360]) {
      const page = await openSettings(width, true);
      try {
        for (const scenario of SCENARIOS) {
          await show(page, scenario);
          await page.screenshot(join(dir, `${scenario.name}-${width}.png`));
        }
      } finally {
        await page.close();
      }
    }
  }, 120_000);
});
