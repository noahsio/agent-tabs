import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor, webviewPage } from "../helpers/chrome";

/** Where the «always allow» whitelist screenshots land (the card option and the settings list). */
const SHOTS = process.env["AGENT_TABS_SHOTS"] ?? "/tmp/agent-tabs-shots/whitelist";

const REQUEST = {
  id: "wl123wl123wl",
  session: "s1",
  cwd: "/work/proj",
  tool: "bash",
  command: 'docker run -v "$HOME":/host alpine sh',
  reasons: ["docker-mount: монтирование домашней папки выходит за песочницу"],
  proposal: [{ scope: "docker run *", label: "всегда разрешать: docker run *" }],
  createdAt: "2026-11-07T10:00:00.000Z",
};

const CARD_STUB = `
(function () {
  var blocks = [{ kind: "tool", id: "t1", name: "bash", summary: "docker run", input: "docker run", output: "", truncated: false, state: "ok" }];
  window.__posted = [];
  window.__host = function (message) { window.postMessage(JSON.stringify(message), "*"); };
  window.__state = function () {
    window.__host({ type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "s1" }, state: { blocks: blocks, dialogs: [], agents: [], running: true, activity: "thinking" } });
  };
  window.acquireVsCodeApi = function () {
    return { getState: function () { return undefined; }, setState: function () {}, postMessage: function (m) { window.__posted.push(m); if (m.type === "ready") setTimeout(window.__state, 5); } };
  };
})();`;

const SECURITY = {
  state: "on",
  consent: { plist: "/h/x.plist", kitDir: "/h/guard", hooksJson: "/a/hooks.json", profile: "/a/sandbox.sb", writeDenies: [] },
  text: { hardDeny: "rm -rf /", askCustom: "", ipWhitelist: "" },
  groups: { "git-push": true, history: true, secrets: true, "external-ip": true, "global-install": false },
  decider: { mode: "decider-then-me", model: "gw-x/m1", timeoutMs: 20000 },
  human: { waitSeconds: 300, card: true, telegram: false },
  telegram: { chat: "", legacy: false, ready: false },
  models: [{ connection: "Шлюз", items: [{ value: "gw-x/m1", label: "Claude" }] }],
  whitelist: [
    { id: "user-1", scope: "docker run *", addedAt: "2026-11-07T10:00:00.000Z", session: "0f8e2c1a-5b7d-4e3f-9a21-c4d5e6f70812" },
    { id: "user-2", scope: "tar -czf *", addedAt: "2026-11-06T18:30:00.000Z" },
    { id: "user-3", scope: "rm -rf *", addedAt: "2026-11-05T09:15:00.000Z" },
  ],
};
const SETTINGS_STATE = { env: { name: "second", agentDir: "/a" }, security: SECURITY };
const SETTINGS_STUB = `
(function () {
  var state = ${JSON.stringify(SETTINGS_STATE)};
  function reply(m) { setTimeout(function () { window.postMessage(JSON.stringify(m), "*"); }, 5); }
  window.acquireVsCodeApi = function () {
    return { getState: function () { return undefined; }, setState: function () {}, postMessage: function (m) {
      if (m.type === "ready") reply({ type: "state", reconnectable: true, commands: [], tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: [], dialogs: [], agents: [], running: false } });
      if (m.type === "settingsGet") reply({ type: "settings", state: state });
    } };
  };
  setTimeout(function () { window.postMessage(JSON.stringify({ type: "openSettings", section: "security" }), "*"); }, 50);
})();`;

const host = (page: Page, message: unknown): Promise<unknown> => page.evaluate(`window.__host(${JSON.stringify(message)})`);

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot(join(SHOTS, `${name}.png`));
}

describe.skipIf(!hasChrome)("whitelist screenshots (headless Chrome)", () => {
  let card: Page;
  let settings: Page;

  beforeAll(async () => {
    card = await openPage(await webviewPage(CARD_STUB));
    await waitFor(card, `document.querySelector('[data-block="t1"]') !== null`);
    settings = await openPage(await webviewPage(SETTINGS_STUB), { width: 900, height: 1200 });
    await waitFor(settings, `document.querySelector('[data-popover="settings"]') && !document.querySelector('[data-popover="settings"]').hidden`);
  }, 30_000);

  afterAll(async () => {
    await card?.close();
    await settings?.close();
  });

  it("the card offers «Разрешать такое впредь» with the shape spelled out", async () => {
    await host(card, { type: "guardRequest", request: REQUEST });
    await waitFor(card, `[...document.querySelectorAll(".ask .opt")].some((node) => node.textContent.includes("Разрешать такое впредь"))`);
    const option = await card.evaluate<string>(
      `[...document.querySelectorAll(".ask .opt")].find((node) => node.textContent.includes("Разрешать такое впредь")).textContent`,
    );
    expect(option).toContain("docker run *");
    await shot(card, "card-always-allow");
  });

  it("«Безопасность» lists the whitelist entries with a «Забыть» each", async () => {
    await settings.evaluate(`document.querySelector('[data-section="security"]').click()`);
    await waitFor(settings, `!document.querySelector('[data-section-body="security"]').hidden`);
    await waitFor(settings, `document.querySelectorAll('[data-whitelist]').length === 3`);
    const scopes = await settings.evaluate<string[]>(`[...document.querySelectorAll('[data-whitelist] code')].map((node) => node.textContent)`);
    expect(scopes).toEqual(["docker run *", "tar -czf *", "rm -rf *"]);
    await settings.evaluate(`[...document.querySelectorAll(".st-h3")].find((node) => node.textContent.includes("Всегда разрешать")).scrollIntoView({ block: "start" })`);
    await shot(settings, "settings-whitelist-list");
  });
});
