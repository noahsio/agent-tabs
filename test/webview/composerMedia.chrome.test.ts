import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, waitFor } from "../helpers/chrome";

const SHOTS = process.env["AGENT_TABS_SHOTS"];
// The harness normally returns SVG; recalled attachments use createImageBitmap, which needs a raster image.
const IMAGE = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 300;
  const context = canvas.getContext("2d");
  context.fillStyle = "#edf3f8";
  context.fillRect(0, 0, 480, 300);
  context.fillStyle = "#24303c";
  context.fillRect(0, 0, 480, 58);
  context.font = "24px sans-serif";
  context.fillStyle = "#ffffff";
  context.fillText("Каталог", 24, 38);
  context.fillStyle = "#3a4a5a";
  context.fillRect(24, 88, 130, 130);
  context.fillRect(174, 88, 130, 130);
  context.fillRect(324, 88, 130, 130);
  return canvas.toDataURL("image/png");
})()`;
const LIGHT = {
  "--vscode-sideBar-background": "#f3f3f3",
  "--vscode-editor-background": "#ffffff",
  "--vscode-foreground": "#333333",
  "--vscode-editor-foreground": "#333333",
  "--vscode-descriptionForeground": "#616161",
  "--vscode-widget-border": "#c8c8c8",
  "--vscode-input-border": "#cecece",
  "--vscode-input-background": "#ffffff",
  "--vscode-toolbar-hoverBackground": "#e8e8e8",
  "--vscode-textCodeBlock-background": "#eaeaea",
  "--vscode-quickInput-background": "#f8f8f8",
  "--vscode-widget-shadow": "rgba(0, 0, 0, 0.16)",
};

async function capture(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot(join(SHOTS, `${name}.png`));
}

async function center(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
}

describe.skipIf(!hasChrome)("composer media in the built harness", () => {
  beforeAll(async () => {
    await promisify(execFile)(process.execPath, ["scripts/harness.mjs"]);
  });

  it.each([
    { width: 900, theme: "dark" },
    { width: 390, theme: "dark" },
    { width: 900, theme: "light" },
    { width: 390, theme: "light" },
  ])("previews and navigates inline and shelf images at $width px in $theme", async ({ width, theme }) => {
    const html = readFileSync("dist/harness.html", "utf8").replace('agentTabsSample.placeholderImage("#3a4a5a", "#24303c")', IMAGE);
    const page = await openPage(html, { width, height: 780 });
    try {
      if (theme === "light") await page.evaluate(`Object.entries(${JSON.stringify(LIGHT)}).forEach(([key, value]) => document.documentElement.style.setProperty(key, value))`);
      await waitFor(page, `document.querySelector(".feed [data-block]") !== null`);
      await page.evaluate(`(() => {
        const message = agentTabsSample.createSample(Date.now()).message;
        message.state.running = false;
        message.state.dialogs = [];
        message.state.agents = [];
        message.state.blocks = [
          { kind: "user", id: "media-case", text: "[картинка 1] Ошибка на первом экране.\\nБуквально: [картинка\\nРезультат на втором: [картинка 2]", images: [
            { id: "media:0", mimeType: "image/png", name: "before.png" },
            { id: "media:1", mimeType: "image/png", name: "after.png" },
            { id: "media:2", mimeType: "image/png", name: "reference.png" }
          ] },
          { kind: "assistant", id: "answer", text: "Проверяю [документацию](https://example.com/docs).", thinking: "", streaming: false }
        ];
        window.postMessage(JSON.stringify(message), "*");
      })()`);
      await waitFor(page, `document.querySelector('[data-block="media-case"]') !== null`);
      await page.evaluate(`(() => {
        const input = document.querySelector(".input");
        input.focus();
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(true);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      })()`);
      await page.key("ArrowUp");
      await waitFor(page, `document.querySelectorAll('.composer [data-status="ready"]').length === 3`);
      const prefix = `harness-${width}-${theme}`;
      await capture(page, `${prefix}-recalled`);
      const before = await page.evaluate<string>(`document.querySelector(".input").getBoundingClientRect().toJSON().height.toString()`);
      await page.move(await center(page, ".input .att"));
      expect(await page.evaluate<boolean>(`document.querySelector(".attachment-preview")?.hidden === false`)).toBe(true);
      await waitFor(page, `document.querySelector(".attachment-preview img")?.complete`);
      const geometry = await page.evaluate<{ width: number; left: number; right: number; top: number; bottom: number }>(`document.querySelector(".attachment-preview").getBoundingClientRect().toJSON()`);
      expect(geometry.width).toBeGreaterThan(150);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(780);
      expect(await page.evaluate<string>(`document.querySelector(".input").getBoundingClientRect().toJSON().height.toString()`)).toBe(before);
      expect(await page.evaluate<number>(`document.querySelector(".input .att").getBoundingClientRect().height`)).toBe(20);
      await capture(page, `${prefix}-inline-hover`);
      await page.click(await center(page, ".input .att .tn"));
      expect(await page.evaluate<string>(`document.querySelector('[data-role="lightbox-caption"]').textContent`)).toContain("1 / 3");
      await page.key("ArrowRight");
      expect(await page.evaluate<string>(`document.querySelector('[data-role="lightbox-caption"]').textContent`)).toContain("2 / 3");
      await page.key("ArrowRight");
      expect(await page.evaluate<string>(`document.querySelector('[data-role="lightbox-caption"]').textContent`)).toContain("3 / 3");
      await page.key("ArrowLeft");
      expect(await page.evaluate<string>(`document.querySelector('[data-role="lightbox-caption"]').textContent`)).toContain("2 / 3");
      await capture(page, `${prefix}-lightbox`);
      await page.key("Escape");
      await page.move(await center(page, ".thumb-view"));
      expect(await page.evaluate<boolean>(`document.querySelector(".attachment-preview")?.hidden === false`)).toBe(true);
      expect(await page.evaluate<number>(`document.querySelector(".thumb").getBoundingClientRect().height`)).toBe(26);
      await capture(page, `${prefix}-shelf-hover`);
      await page.click(await center(page, ".thumb-view"));
      expect(await page.evaluate<string>(`document.querySelector('[data-role="lightbox-caption"]').textContent`)).toContain("3 / 3");
      await page.key("Escape");
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
    } finally {
      await page.close();
    }
  }, 15_000);
});
