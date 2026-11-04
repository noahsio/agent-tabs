// Builds the webview in memory and writes dist/harness.html: one self-contained page (CSS, bundle, sample data, a
// stubbed acquireVsCodeApi) to open in any browser for visual checks. Never writes dist/webview.js or dist/webview.css:
// those are what the extension package ships. Usage: node scripts/harness.mjs
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const app = await build({ entryPoints: ["webview/main.ts"], outdir: "dist/harness-build", bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
const output = (extension) => app.outputFiles.find((file) => file.path.endsWith(extension)).text;
const sample = await build({ entryPoints: ["webview/dev/sample-state.ts"], bundle: true, write: false, platform: "browser", format: "iife", globalName: "agentTabsSample", target: "es2022" });

// A replacer function, not a string: "$&" and friends inside the bundles must stay literal.
const template = readFileSync("webview/dev/harness.html", "utf8")
  .replace("/*CSS*/", () => output(".css"))
  .replace("/*SAMPLE*/", () => sample.outputFiles[0].text.replaceAll("</script", "<\\/script"))
  .replace("/*APP*/", () => output(".js").replaceAll("</script", "<\\/script"));
writeFileSync("dist/harness.html", template);
console.log("dist/harness.html written");
