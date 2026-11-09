#!/usr/bin/env node
// Wire CodeGraph and curated skills into an OmO environment. Idempotent.
// Usage: node kit/setup-omo.mjs [--env system|second|default] [--superpowers] [--guard] [--update-packages] [--dry-run] [--home <dir>]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnv } from "./lib/envs.mjs";
import { writeIfChanged } from "./lib/files.mjs";
import { setJsoncPath } from "./lib/jsonc.mjs";
import { lspDaemonDir } from "./sandbox/profile.mjs";
import { guardFilesDir, installGuardFiles } from "./guard/install.mjs";
import {
  CURATED_SKILLS,
  SUPERPOWERS_URL,
  claudePluginInstallCommands,
  claudePluginState,
  defaultSuperpowersDir,
  findOnPath,
  loadConfig,
  pinnedSuperpowersRef,
  setCodegraph,
  setGlobalInstructions,
  superpowersState,
  validateHooks,
  validateMcp,
  validateSettings,
  validateState,
  withSuperpowers,
} from "./lib/tools.mjs";

const kitDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { env: "system", guard: false, superpowers: false, updatePackages: false, dryRun: false, home: os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env") options.env = argv[++i];
    else if (arg === "--home") options.home = path.resolve(argv[++i]);
    else if (arg === "--guard") options.guard = true;
    else if (arg === "--superpowers") options.superpowers = true;
    else if (arg === "--update-packages") options.updatePackages = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

const asJson = (value) => JSON.stringify(value, null, 2) + "\n";

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * Clone (or move) the superpowers fork to the pinned ref; with `--update-packages`, to the remote HEAD. The clone is
 * OMO_KIT_SUPERPOWERS_DIR when set, else the one this environment already uses or one found in a known place (the
 * legacy `~/.omo/packages/…` included), else a new one in the neutral default dir.
 */
function ensureSuperpowers(envInfo, options, log) {
  const url = process.env.OMO_KIT_SUPERPOWERS_URL || SUPERPOWERS_URL;
  const pinned = pinnedSuperpowersRef();
  const target = process.env.OMO_KIT_SUPERPOWERS_DIR || superpowersState(envInfo).dir || defaultSuperpowersDir(options.home);
  const wanted = options.updatePackages ? git(["ls-remote", url, "HEAD"]).split(/\s/)[0] : pinned;
  const current = fs.existsSync(path.join(target, ".git")) ? git(["rev-parse", "HEAD"], target) : null;
  if (current === wanted) return target;
  if (options.dryRun) {
    log(`would ${current ? "move" : "clone"} superpowers to ${wanted}`);
    return target;
  }
  if (!current) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    git(["clone", "--quiet", url, target]);
  } else git(["fetch", "--quiet", "origin"], target);
  git(["checkout", "--quiet", "--detach", wanted], target);
  log(`superpowers at ${wanted}`);
  return target;
}

function resolveCodegraph(envInfo, log) {
  const binary = envInfo.codegraph ?? findOnPath("codegraph");
  if (!binary) log("warning: codegraph not found on PATH; mcp.json and codegraph hooks skipped");
  else if (!fs.existsSync(binary)) log(`warning: ${binary} does not exist yet`);
  return binary;
}

/** Copy kit hooks into ~/.omo/kit/<content hash>/ and return that directory. */
function installKit(home, dryRun, report) {
  const sourceDir = path.join(kitDir, "hooks");
  const files = fs.readdirSync(sourceDir).sort();
  const hash = createHash("sha256");
  for (const name of files) hash.update(name).update(fs.readFileSync(path.join(sourceDir, name)));
  const targetDir = path.join(home, ".omo/kit", hash.digest("hex").slice(0, 12), "hooks");
  for (const name of files) {
    const outcome = writeIfChanged(path.join(targetDir, name), fs.readFileSync(path.join(sourceDir, name), "utf8"), {
      mode: 0o755,
      dryRun,
    });
    report(path.join(targetDir, name), outcome);
  }
  return targetDir;
}

function mergeUnique(existing, additions) {
  const list = Array.isArray(existing) ? existing : [];
  return [...list, ...additions.filter((item) => !list.includes(item))];
}

function setupOmoJsonc(home, dryRun, report, log) {
  const file = path.join(home, ".omo/omo.jsonc");
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  try {
    const edited =
      original === null
        ? asJson({ memory: { reflection: { category: "quick" } } })
        : setJsoncPath(original, ["memory", "reflection", "category"], "quick");
    report(file, writeIfChanged(file, edited, { dryRun }));
  } catch (error) {
    const note = `${file}.kit-note`;
    log(`warning: could not edit omo.jsonc safely (${error.message}); wrote ${note}`);
    report(note, writeIfChanged(note, `Set manually in omo.jsonc: { "memory": { "reflection": { "category": "quick" } } }\n`, { dryRun }));
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const envInfo = resolveEnv(options.env, options.home);
  const log = (message) => console.log(message);
  const report = (file, outcome) => {
    if (outcome !== "unchanged") log(`${options.dryRun ? "would " : ""}${outcome}: ${file}`);
  };
  const write = (file, content, mode) => report(file, writeIfChanged(file, content, { mode, dryRun: options.dryRun }));

  // Parse and validate every input first: a bad file aborts before anything is written, cloned or copied.
  const mcpFile = path.join(envInfo.agentDir, "mcp.json");
  const settingsFile = path.join(envInfo.agentDir, "settings.json");
  const hooksFile = path.join(envInfo.agentDir, "hooks.json");
  const stateFile = path.join(envInfo.agentDir, "hooks-state.json");
  const settings = loadConfig(settingsFile, validateSettings);
  // checked here so a bad one aborts before anything is written; setCodegraph re-reads them
  loadConfig(mcpFile, validateMcp);
  loadConfig(hooksFile, validateHooks);
  loadConfig(stateFile, validateState);
  // OmO binds hook trust to the agent dir spelling it is given (it does not canonicalize); never rewrite it here, just warn.
  if (fs.existsSync(envInfo.agentDir) && fs.realpathSync(envInfo.agentDir) !== envInfo.agentDir) {
    log(`warning: ${envInfo.agentDir} resolves to ${fs.realpathSync(envInfo.agentDir)}; OMO_CODING_AGENT_DIR must use exactly ${envInfo.agentDir} or the hooks stay untrusted`);
  }

  const codegraph = resolveCodegraph(envInfo, log);
  if (!options.dryRun) fs.mkdirSync(envInfo.agentDir, { recursive: true, mode: 0o700 });
  const superpowers = options.superpowers ? ensureSuperpowers(envInfo, options, log) : null;
  const hooksDir = codegraph ? installKit(options.home, options.dryRun, report) : null;
  const guardDir = options.dryRun ? guardFilesDir(options.home) : installGuardFiles(options.home);
  write(path.join(envInfo.agentDir, "extensions/coordinate.ts"),
    `export { default } from ${JSON.stringify(path.join(guardDir, "coordinate-extension.mjs"))};\n`);

  // settings.json
  const skills = CURATED_SKILLS.map((name) => path.join(envInfo.claudeDir, "skills", name)).filter((dir) => fs.existsSync(dir));
  // the fork as a `packages` entry (a legacy skills-dir connection becomes it); the same clone is the Claude plugin's marketplace
  const nextSettings = { ...settings, skills: mergeUnique(settings.skills, skills) };
  write(settingsFile, asJson(superpowers ? withSuperpowers(nextSettings, superpowers, true, envInfo) : nextSettings));

  // mcp.json + hooks.json + hooks-state.json
  if (codegraph) {
    for (const file of setCodegraph(envInfo, true, { dryRun: options.dryRun, codegraph, hooksDir })) log(`${options.dryRun ? "would write" : "written"}: ${file}`);
  }

  // <agentDir>/AGENTS.md -> <claudeDir>/CLAUDE.md (global instructions on by default)
  try {
    for (const file of setGlobalInstructions(envInfo, true, { dryRun: options.dryRun })) log(`${options.dryRun ? "would link" : "linked"}: ${file}`);
  } catch (error) {
    if (error.code !== "AGENTS_MD_NOT_A_LINK") throw error;
    log(`warning: ${error.message}; global instructions not linked`);
  }

  setupOmoJsonc(options.home, options.dryRun, report, log);

  // omo-<env> wrapper
  const template = fs.readFileSync(path.join(kitDir, "bin/omo-env"), "utf8");
  // every value sits inside "…" in the template: \ $ ` " would end or expand it (a function replacer: no $& patterns)
  const values = {
    "@ENV@": envInfo.name,
    "@AGENT_DIR@": envInfo.agentDir,
    "@MEMORY_HOME@": envInfo.memoryHome,
    "@CLAUDE_DIR@": envInfo.claudeDir,
    "@LSP_DAEMON_DIR@": lspDaemonDir(envInfo.agentDir),
    "@OMO_BIN@": path.join(options.home, ".local/bin/omo"),
  };
  const wrapper = template.replace(/@[A-Z_]+@/g, (name) => (values[name] ?? name).replace(/[\\$`"]/g, "\\$&"));
  write(path.join(options.home, ".local/bin", `omo-${envInfo.name}`), wrapper, 0o755);

  if (superpowers && claudePluginState(envInfo.claudeDir) === "absent") {
    log(`note: to use superpowers in Claude (${envInfo.claudeDir}) too, run:`);
    for (const command of claudePluginInstallCommands(superpowers, envInfo.claudeDir, options.home)) log(`  ${command}`);
  }

  if (options.guard) log("Защита включается отдельно в настройках Agent Tabs → Безопасность.");
  log(`\nИтог${options.dryRun ? " (предпросмотр, без записи)" : ""}: ${envInfo.name}`);
  log(`Каталог агента: ${envInfo.agentDir}`);
  log(`Настройки: ${settingsFile}`);
  log(codegraph ? `CodeGraph: подключён (${codegraph}); ${mcpFile}` : "CodeGraph: не найден. Установите CodeGraph и добавьте codegraph в PATH, затем повторите setup.");
  log(codegraph ? `Хуки: подключены (${hooksFile}); доверие: ${stateFile}` : "Хуки: пропущены (CodeGraph не найден); существующие хуки сохранены.");
  log(`omo.jsonc: ${path.join(options.home, ".omo/omo.jsonc")} (memory.reflection.category = quick; при предупреждении см. .kit-note)`);
  log(`Оболочка: ${path.join(options.home, ".local/bin", `omo-${envInfo.name}`)}`);
  log(`Навыки: ${skills.length}${skills.length ? ` (${skills.join(", ")})` : ""}`);
  log(`Не найдены: ${CURATED_SKILLS.filter((name) => !skills.includes(path.join(envInfo.claudeDir, "skills", name))).join(", ") || "нет"}`);
  log(superpowers ? `Superpowers: подключён (${superpowers})` : "Superpowers: пропущен; только по явному --superpowers.");
}

try {
  main();
} catch (error) {
  console.error(`setup-omo: ${error.message}`);
  process.exit(1);
}
