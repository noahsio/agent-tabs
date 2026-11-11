import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll } from "vitest";

/**
 * Real hit testing and paint order exist only in a browser; jsdom dispatches a click on whatever node it is given.
 * Only `chrome-headless-shell` is used: it is a bare binary, not an app bundle, so macOS never shows it in the Dock
 * (the full Google Chrome flashes there even with --headless=new). `AGENT_TABS_CHROME_BIN` names one explicitly; else
 * the newest Playwright-installed shell (`npx playwright install chromium-headless-shell`). Without one the tests skip.
 */
function headlessShell(): string | undefined {
  const explicit = process.env["AGENT_TABS_CHROME_BIN"];
  if (explicit !== undefined && explicit !== "") return existsSync(explicit) ? explicit : undefined;
  const root = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
  for (const build of builds) {
    for (const arch of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64"]) {
      const binary = join(root, build, arch, "chrome-headless-shell");
      if (existsSync(binary)) return binary;
    }
  }
  return undefined;
}

export const CHROME = headlessShell() ?? "";
/** Opt-in (`npm run test:chrome`), and only with the Dock-less headless shell. */
export const hasChrome = process.env["AGENT_TABS_CHROME"] === "1" && CHROME !== "";

/** Every Chrome this worker started and has not closed: none may outlive the tests. */
const running = new Set<ChildProcess>();

function killAll(): void {
  for (const chrome of running) chrome.kill("SIGKILL");
  running.clear();
}

if (hasChrome) {
  afterAll(killAll); // the test file's teardown, a failed one included
  process.once("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      killAll();
      process.kill(process.pid, signal); // then die of it as before
    });
  }
}

export type Point = { x: number; y: number };

export type Page = {
  /** `userGesture`: the page gets a transient user activation, as a real click gives it (the clipboard needs one). */
  evaluate<T>(expression: string, options?: { userGesture?: boolean }): Promise<T>;
  /** The pointer moves to `point` (hover). */
  move(point: Point): Promise<void>;
  /** Press and release at `point`, like a person's click: the browser picks the target by hit testing. */
  click(point: Point): Promise<void>;
  /** Two clicks at `point`, like a person selecting a word (a URL in a link). */
  doubleClick(point: Point): Promise<void>;
  /** Press at `from`, move, release at `to`: a person's drag, which over plain text selects it. */
  drag(from: Point, to: Point): Promise<void>;
  /** The system clipboard's text, read by the page itself. */
  clipboard(): Promise<string>;
  key(key: string, options?: { shift?: boolean; meta?: boolean }): Promise<void>;
  /** A mouse wheel turn at `point`: scrolls whatever the browser finds under it. */
  wheel(point: Point, deltaY: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  /** Resolves once Chrome has exited and its profile is gone. */
  close(): Promise<void>;
};

/** The webview bundle and its CSS on one page; `stub` defines `acquireVsCodeApi` before the bundle runs. */
export async function webviewPage(stub: string): Promise<string> {
  const app = await build({ entryPoints: ["webview/main.ts"], outdir: "dist/test-build", bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
  const output = (extension: string): string => app.outputFiles.find((file) => file.path.endsWith(extension))?.text ?? "";
  const script = (code: string): string => `<script>${code.replaceAll("</script", "<\\/script")}</script>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${output(".css")}</style></head><body><div id="app"></div>${script(stub)}${script(output(".js"))}</body></html>`;
}

/**
 * Opens `html` in a headless Chrome driven over the DevTools protocol on a pipe (fds 3/4, NUL-separated JSON): when the
 * worker dies the pipe closes and Chrome goes with it, even where no exit handler runs.
 */
export async function openPage(html: string, size = { width: 900, height: 700 }): Promise<Page> {
  const dir = mkdtempSync(join(tmpdir(), "agent-tabs-chrome-"));
  const file = join(dir, "page.html");
  writeFileSync(file, html);
  // Inside an agent's macOS sandbox Chrome's own sandbox cannot start (nested sandboxes are refused, the GPU process
  // dies and Chrome quits). AGENT_TABS_CHROME_NO_SANDBOX=1 runs the shell without it there: the page is our own bundle.
  const nested = process.env["AGENT_TABS_CHROME_NO_SANDBOX"] === "1" ? ["--no-sandbox"] : [];
  const chrome: ChildProcess = spawn(
    CHROME,
    [...nested, "--remote-debugging-pipe", `--user-data-dir=${join(dir, "profile")}`, `--window-size=${size.width},${size.height}`, "--no-first-run", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  running.add(chrome);
  chrome.once("exit", () => running.delete(chrome));
  const toChrome = chrome.stdio[3] as NodeJS.WritableStream;
  const fromChrome = chrome.stdio[4] as NodeJS.ReadableStream;
  let lastId = 0;
  let buffered = "";
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  fromChrome.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf("\0")) >= 0) {
      const reply = JSON.parse(buffered.slice(0, end)) as { id?: number; result?: unknown; error?: unknown };
      buffered = buffered.slice(end + 1);
      const waiter = reply.id === undefined ? undefined : pending.get(reply.id);
      if (waiter === undefined || reply.id === undefined) continue;
      pending.delete(reply.id);
      if (reply.error !== undefined) waiter.reject(new Error(JSON.stringify(reply.error)));
      else waiter.resolve(reply.result);
    }
  });
  /** A browser-level command, or a page one once `sessionId` is set; `Browser.*` stays browser-level either way. */
  let sessionId: string | undefined;
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++lastId;
      const session = method.startsWith("Browser.") ? undefined : sessionId;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      toChrome.write(`${JSON.stringify({ id, method, params, ...(session !== undefined ? { sessionId: session } : {}) })}\0`);
    });
  const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  const target = targetInfos.find((candidate) => candidate.type === "page");
  if (target === undefined) throw new Error("no page target");
  sessionId = (await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await send("Page.enable");
  // Scale 1: under an emulated scale of 2 Chrome stops painting :hover once the page relayouts (an emulation artifact).
  await send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `file://${file}` });
  const page: Page = {
    async evaluate<T>(expression: string, options: { userGesture?: boolean } = {}): Promise<T> {
      const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: options.userGesture === true,
      });
      if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    async move(point: Point): Promise<void> {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    },
    async click(point: Point): Promise<void> {
      await page.move(point);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    },
    async doubleClick(point: Point): Promise<void> {
      await page.move(point);
      for (const clickCount of [1, 2]) {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount });
      }
    },
    async drag(from: Point, to: Point): Promise<void> {
      await page.move(from);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...to, button: "left", buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 });
    },
    async clipboard(): Promise<string> {
      await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
      return page.evaluate<string>("navigator.clipboard.readText()", { userGesture: true });
    },
    async key(key: string, options: { shift?: boolean; meta?: boolean } = {}): Promise<void> {
      // A key an editable element acts on needs its real code (and Enter its text), or the browser only reports it.
      const codes: Record<string, number> = { Escape: 27, Enter: 13, Backspace: 8, Tab: 9 };
      const letter = /^[a-z]$/.test(key) ? key.toUpperCase() : undefined; // a shortcut's letter: ⌘C is KeyC, 67
      const event = {
        key,
        code: letter !== undefined ? `Key${letter}` : key,
        windowsVirtualKeyCode: codes[key] ?? letter?.charCodeAt(0) ?? 0,
        modifiers: (options.shift === true ? 8 : 0) | (options.meta === true ? 4 : 0),
        ...(key === "Enter" ? { text: "\r" } : {}),
      };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    },
    async wheel(point: Point, deltaY: number): Promise<void> {
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
    },
    async screenshot(path: string): Promise<void> {
      const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    async close(): Promise<void> {
      const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await exited; // a dying Chrome still writes its profile
      rmSync(dir, { recursive: true, force: true });
    },
  };
  await waitFor(page, "document.getElementById('app')?.childElementCount > 0");
  return page;
}

/** Polls `condition` in the page until it holds. */
export async function waitFor(page: Page, condition: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await page.evaluate<boolean>(`Boolean(${condition})`))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${condition}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
