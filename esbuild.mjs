import { build, context } from "esbuild";
import { existsSync } from "node:fs";

const watch = process.argv.includes("--watch");

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
};

const webviewOptions = {
  entryPoints: ["webview/main.ts"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
};

// The webview bundle is built only once its entry point exists.
const targets = [extensionOptions];
if (existsSync("webview/main.ts")) targets.push(webviewOptions);

if (watch) {
  for (const options of targets) {
    const ctx = await context(options);
    await ctx.watch();
  }
} else {
  for (const options of targets) await build(options);
}
