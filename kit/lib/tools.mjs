// The kit's tool switches, shared by setup-omo and the settings modal: CodeGraph (MCP server + hooks), global
// instructions (F6 mechanism B), settings.json lists, the superpowers fork (an OmO package shared with its Claude plugin). One decision, one place.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ENV_NAMES, resolveEnv } from "./envs.mjs";
import { writeIfChanged } from "./files.mjs";
import { parseJsonc } from "./jsonc.mjs";
import { writeHooksJson } from "./hooks.mjs";

// Pinned commit of https://github.com/yasherisa/superpowers (HEAD on 2026-11-03).
export const SUPERPOWERS_URL = "https://github.com/yasherisa/superpowers";
export const SUPERPOWERS_REF = "d592fb71e6a6ffb8325e24005e18f61100d31b94";
/** The ref setup installs and «обновить» checks out: the pinned one, unless OMO_KIT_SUPERPOWERS_REF overrides it. */
export const pinnedSuperpowersRef = () => process.env.OMO_KIT_SUPERPOWERS_REF || SUPERPOWERS_REF;
export const CURATED_SKILLS = ["repo-task-proof-loop", "prompt-master", "security-audit", "chainium-agent"];

const CODEGRAPH_SCRIPTS = { SessionStart: "codegraph-init.sh", UserPromptSubmit: "codegraph-prompt.mjs" };

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const asJson = (value) => JSON.stringify(value, null, 2) + "\n";
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const expectObject = (value, name) => {
  if (value !== undefined && !isObject(value)) throw new Error(`"${name}" must be an object`);
};
const expectArray = (value, name) => {
  if (value !== undefined && !Array.isArray(value)) throw new Error(`"${name}" must be an array`);
};
export const validateMcp = (mcp) => expectObject(mcp.mcpServers, "mcpServers");
export const validateSettings = (settings) => {
  expectArray(settings.skills, "skills");
  expectArray(settings.extensions, "extensions");
  expectArray(settings.packages, "packages");
};
export const validateHooks = (config) => {
  expectObject(config.hooks, "hooks");
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    expectArray(groups, `hooks.${event}`);
    for (const group of groups) if (!isObject(group)) throw new Error(`hooks.${event} has a non-object group`);
  }
};
export const validateState = (state) => expectObject(state.hooks, "hooks");

/** Parse an existing config file (JSONC tolerated) and validate its shape; throws naming the file. */
export function loadConfig(file, validate, warn = (message) => console.log(message)) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  try {
    const value = text.trim() === "" ? {} : parseJsonc(text);
    try {
      JSON.parse(text);
    } catch {
      if (text.trim() !== "") warn(`warning: ${file} has comments or trailing commas; it will be rewritten as plain JSON (backup kept)`);
    }
    if (!isObject(value)) throw new Error("top level is not an object");
    validate?.(value);
    return value;
  } catch (error) {
    throw new Error(`cannot use ${file}: ${error.message}`);
  }
}

export function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

const kitRoot = (home) => path.join(home, ".omo/kit");
/** The kit's own hook commands (the only ones ever trusted) live under `~/.omo/kit/`. */
export const isKitCommand = (command, home) => typeof command === "string" && command.includes(kitRoot(home) + path.sep);
const isCodegraphCommand = (command, home) =>
  isKitCommand(command, home) && Object.values(CODEGRAPH_SCRIPTS).some((script) => command.includes(`${path.sep}${script}`));

/** The newest installed kit hooks dir (`~/.omo/kit/<hash>/hooks`) that has both CodeGraph scripts, else null. */
function installedKitHooks(home) {
  const root = kitRoot(home);
  if (!fs.existsSync(root)) return null;
  const candidates = fs
    .readdirSync(root)
    .map((name) => path.join(root, name, "hooks"))
    .filter((dir) => Object.values(CODEGRAPH_SCRIPTS).every((script) => fs.existsSync(path.join(dir, script))));
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

/** A node binary for the prompt hook: this process when it is node (setup), else node on PATH (the VS Code host is Electron). */
function nodeBinary() {
  if (path.basename(process.execPath) === "node") return process.execPath;
  const found = findOnPath("node");
  if (!found) throw new Error("node not found on PATH");
  return found;
}

/**
 * Turn CodeGraph on or off: the `codegraph` MCP server in mcp.json and the kit's SessionStart/UserPromptSubmit hooks
 * (written through writeHooksJson, so every kit handler's trust is re-issued). Other servers, foreign handlers and
 * other kit handlers stay; a CodeGraph handler is replaced in place so the rest keep their indexes. `hooksDir` defaults
 * to the newest installed kit, `codegraph` to the environment's binary or the one on PATH. Returns the files written
 * (with dryRun: the files that would be).
 */
export function setCodegraph(envInfo, on, { dryRun = false, now = new Date(), backup, codegraph, hooksDir } = {}) {
  const home = envInfo.home;
  const mcpFile = path.join(envInfo.agentDir, "mcp.json");
  const hooksFile = path.join(envInfo.agentDir, "hooks.json");
  const mcp = loadConfig(mcpFile, validateMcp);
  const config = loadConfig(hooksFile, validateHooks);
  config.hooks ??= {};
  let wanted = {};
  if (on) {
    const binary = codegraph ?? envInfo.codegraph ?? findOnPath("codegraph");
    if (!binary) throw new Error("codegraph not found on PATH");
    const dir = hooksDir ?? installedKitHooks(home);
    if (!dir) throw new Error(`the kit is not installed in ${kitRoot(home)}; run kit/setup-omo.mjs first`);
    wanted = {
      SessionStart: `OMO_CODEGRAPH_BIN=${shq(binary)} ${shq(path.join(dir, CODEGRAPH_SCRIPTS.SessionStart))}`,
      UserPromptSubmit: `OMO_CODEGRAPH_BIN=${shq(binary)} ${shq(nodeBinary())} ${shq(path.join(dir, CODEGRAPH_SCRIPTS.UserPromptSubmit))}`,
    };
    mcp.mcpServers = { ...mcp.mcpServers, codegraph: { command: binary, args: ["serve", "--mcp"] } };
  } else if (mcp.mcpServers) delete mcp.mcpServers.codegraph;

  for (const event of Object.keys(CODEGRAPH_SCRIPTS)) {
    const command = wanted[event];
    const groups = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    let placed = command === undefined;
    const kept = [];
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = [];
      for (const existing of group.hooks) {
        if (!isCodegraphCommand(existing?.command, home)) handlers.push(existing);
        else if (!placed) {
          handlers.push({ type: "command", command });
          placed = true;
        }
      }
      // a group emptied here goes; one that was empty already is not ours to drop
      if (handlers.length > 0 || group.hooks.length === 0) kept.push({ ...group, hooks: handlers });
    }
    if (!placed) kept.push({ hooks: [{ type: "command", command }] });
    if (kept.length > 0) config.hooks[event] = kept;
    else delete config.hooks[event];
  }

  const written = [];
  if (writeIfChanged(mcpFile, asJson(mcp), { dryRun, now, backup }) !== "unchanged") written.push(mcpFile);
  const outcome = writeHooksJson(envInfo.agentDir, config, { isOwn: (command) => isKitCommand(command, home), dryRun, now, backup });
  if (outcome.hooks !== "unchanged") written.push(hooksFile);
  if (outcome.state !== "unchanged") written.push(path.join(envInfo.agentDir, "hooks-state.json"));
  return written;
}

/** On when both the MCP server and a CodeGraph hook are configured. */
export function codegraphState(envInfo) {
  const mcp = loadConfig(path.join(envInfo.agentDir, "mcp.json"), validateMcp);
  const config = loadConfig(path.join(envInfo.agentDir, "hooks.json"), validateHooks);
  const hooked = Object.values(config.hooks ?? {}).some((groups) =>
    groups.some((group) => Array.isArray(group.hooks) && group.hooks.some((handler) => isCodegraphCommand(handler?.command, envInfo.home))),
  );
  return { on: isObject(mcp.mcpServers?.codegraph) && hooked };
}

const claudeMdOf = (envInfo) => path.join(envInfo.claudeDir, "CLAUDE.md");
const agentsMdOf = (envInfo) => path.join(envInfo.agentDir, "AGENTS.md");
/** OmO's pi-rules always loads `<home>/.claude/CLAUDE.md` (os.homedir(), not CLAUDE_CONFIG_DIR — F6). */
const isSystemClaudeDir = (envInfo) => path.resolve(envInfo.claudeDir) === path.join(envInfo.home, ".claude");

/** The target of `<agentDir>/AGENTS.md` when it is a symlink; null when it is absent; "file" when it is anything else. */
function agentsMdLink(envInfo) {
  const link = agentsMdOf(envInfo);
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return null;
  }
  return stat.isSymbolicLink() ? path.resolve(envInfo.agentDir, fs.readlinkSync(link)) : "file";
}

/**
 * Whether the environment's `<claudeDir>/CLAUDE.md` reaches OmO. For the system Claude dir it always does
 * (`always: true`: pi-rules loads it); otherwise through the link `<agentDir>/AGENTS.md` → `<claudeDir>/CLAUDE.md`.
 */
export function globalInstructionsState(envInfo) {
  const file = claudeMdOf(envInfo);
  const exists = fs.existsSync(file);
  if (isSystemClaudeDir(envInfo)) return { on: true, path: file, exists, always: true };
  return { on: agentsMdLink(envInfo) === file, path: file, exists };
}

/**
 * Link (on) or unlink (off) `<agentDir>/AGENTS.md` → `<claudeDir>/CLAUDE.md`; nothing to do for the system Claude dir
 * (a link would load it twice). An AGENTS.md that is not this link (a file, or a link elsewhere) is the person's own:
 * never replaced (throws, code AGENTS_MD_NOT_A_LINK) nor removed. Returns the paths changed.
 */
export function setGlobalInstructions(envInfo, on, { dryRun = false } = {}) {
  if (isSystemClaudeDir(envInfo)) return [];
  const link = agentsMdOf(envInfo);
  const target = claudeMdOf(envInfo);
  const current = agentsMdLink(envInfo);
  if (current !== null && current !== target) {
    // a file, or a link somewhere else: the person's own, never replaced nor removed
    if (!on) return [];
    const error = new Error(`${link} exists and is not a link to ${target}; it is left as it is`);
    error.code = "AGENTS_MD_NOT_A_LINK";
    throw error;
  }
  if (on === (current === target)) return [];
  if (dryRun) return [link];
  if (on) {
    fs.mkdirSync(envInfo.agentDir, { recursive: true });
    fs.symlinkSync(target, link);
  } else fs.rmSync(link);
  return [link];
}

/** Add (on) or remove (off) `entry` in the `skills` or `packages` list of `<agentDir>/settings.json`; returns the files written. */
export function setSettingsEntry(envInfo, list, entry, on, { backup, now = new Date() } = {}) {
  const file = path.join(envInfo.agentDir, "settings.json");
  const settings = loadConfig(file, validateSettings);
  const current = settings[list] ?? [];
  settings[list] = on ? (current.includes(entry) ? current : [...current, entry]) : current.filter((item) => item !== entry);
  return writeIfChanged(file, asJson(settings), { backup, now }) === "unchanged" ? [] : [file];
}

/** The fork's local Claude marketplace and its plugin: the same clone serves OmO (a `packages` entry) and Claude. */
export const SUPERPOWERS_MARKETPLACE = "yasherisa-superpowers";
export const SUPERPOWERS_PLUGIN = `superpowers@${SUPERPOWERS_MARKETPLACE}`;

/** Where setup clones the fork when there is none yet: OMO_KIT_SUPERPOWERS_DIR, else a neutral per-user data dir. */
export const defaultSuperpowersDir = (home) => process.env.OMO_KIT_SUPERPOWERS_DIR || path.join(home, ".local/share/agent-tabs/superpowers");
/** Where an existing clone may already be: the default, then the hand-moved and the legacy package places. */
const knownSuperpowersDirs = (home) =>
  process.env.OMO_KIT_SUPERPOWERS_DIR
    ? [process.env.OMO_KIT_SUPERPOWERS_DIR]
    : [defaultSuperpowersDir(home), path.join(home, ".omo/superpowers"), path.join(home, ".omo/packages/yasherisa-superpowers")];

const readJsonFile = (file) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** A clone of the fork: `<dir>/.claude-plugin/marketplace.json` names the fork's marketplace. */
export const isSuperpowersClone = (dir) =>
  typeof dir === "string" && readJsonFile(path.join(dir, ".claude-plugin/marketplace.json"))?.name === SUPERPOWERS_MARKETPLACE;
/** The clone's using-superpowers bootstrap: a pi extension (a package loads it itself; the legacy skills-dir mode lists it). */
const superpowersExtension = (dir) => path.join(dir, ".pi/extensions/superpowers.ts");
/** A settings entry as a path: `~` is home, a relative one is relative to the agent dir. */
const entryPath = (entry, { home, agentDir }) => path.resolve(agentDir, entry.replace(/^~(?=\/|$)/, home));
/** An OmO `packages` entry that is a clone itself (the normal way in). */
const isSuperpowersPackage = (entry, base) => typeof entry === "string" && isSuperpowersClone(entryPath(entry, base));
/** An OmO `skills` entry that is a clone's `skills` dir (legacy). */
const isSuperpowersSkills = (entry, base) =>
  typeof entry === "string" && path.basename(entry) === "skills" && isSuperpowersClone(path.dirname(entryPath(entry, base)));
/** An OmO `extensions` entry that is a clone's bootstrap extension (legacy). */
const isSuperpowersExtension = (entry, base) =>
  typeof entry === "string" && path.basename(entry) === "superpowers.ts" && isSuperpowersClone(path.resolve(entryPath(entry, base), "../../.."));
/** Whether a `skills` entry of the environment is a clone's `skills` dir (the settings view hides those). */
export const isSuperpowersSkillsEntry = (entry, envInfo) => isSuperpowersSkills(entry, envInfo);
const samePath = (a, b, base) => typeof a === "string" && entryPath(a, base) === path.resolve(b);

/**
 * How the environment's OmO gets superpowers: `package` (the clone itself in the `packages` list: skills, bootstrap
 * extension and hooks come with it — the normal state), `skills` (legacy: the clone's `<dir>/skills` in `skills`
 * and/or its bootstrap in `extensions`, to be migrated to the package) or `off`; `dir` is that clone, for `off` one
 * found in a known place (or null).
 */
export function superpowersState(envInfo) {
  const settings = loadConfig(path.join(envInfo.agentDir, "settings.json"), validateSettings);
  const viaPackage = (settings.packages ?? []).find((entry) => isSuperpowersPackage(entry, envInfo));
  const viaSkills = (settings.skills ?? []).find((entry) => isSuperpowersSkills(entry, envInfo));
  const viaExtension = (settings.extensions ?? []).find((entry) => isSuperpowersExtension(entry, envInfo));
  if (viaPackage !== undefined && viaSkills === undefined && viaExtension === undefined) return { mode: "package", dir: entryPath(viaPackage, envInfo) };
  if (viaPackage !== undefined) return { mode: "skills", dir: entryPath(viaPackage, envInfo) };
  if (viaSkills !== undefined) return { mode: "skills", dir: path.dirname(entryPath(viaSkills, envInfo)) };
  if (viaExtension !== undefined) return { mode: "skills", dir: path.resolve(entryPath(viaExtension, envInfo), "../../..") };
  return { mode: "off", dir: knownSuperpowersDirs(envInfo.home).find(isSuperpowersClone) ?? null };
}

/**
 * `settings` with superpowers on (the clone `dir` in `packages`, kept where it is, else last) or off (removed). Either
 * way any other clone's `packages` entry and every clone's legacy `skills`/`extensions` entries go; nothing else
 * changes, and the clone is never touched.
 */
export function withSuperpowers(settings, dir, on, envInfo) {
  const next = { ...settings };
  const dropLegacy = (key, isLegacy) => {
    if (!Array.isArray(settings[key])) return;
    const kept = settings[key].filter((item) => !isLegacy(item, envInfo));
    if (kept.length === settings[key].length) return;
    if (kept.length > 0) next[key] = kept;
    else delete next[key];
  };
  dropLegacy("skills", isSuperpowersSkills);
  dropLegacy("extensions", isSuperpowersExtension);
  const packages = (Array.isArray(settings.packages) ? settings.packages : []).filter((item) => samePath(item, dir, envInfo) || !isSuperpowersPackage(item, envInfo));
  const wanted = packages.filter((item) => !samePath(item, dir, envInfo));
  const result = on ? (packages.length === wanted.length ? [...packages, dir] : packages) : wanted;
  if (result.length > 0) next.packages = result;
  else delete next.packages;
  return next;
}

/** Turn superpowers on or off in `<agentDir>/settings.json` (see withSuperpowers); returns the files written. */
export function setSuperpowers(envInfo, dir, on, { backup, now = new Date() } = {}) {
  const file = path.join(envInfo.agentDir, "settings.json");
  const settings = withSuperpowers(loadConfig(file, validateSettings), dir, on, envInfo);
  return writeIfChanged(file, asJson(settings), { backup, now }) === "unchanged" ? [] : [file];
}

/** The plugin version in the clone's `.claude-plugin/plugin.json`, or undefined. */
export const superpowersPluginVersion = (dir) => {
  const version = readJsonFile(path.join(dir, ".claude-plugin/plugin.json"))?.version;
  return typeof version === "string" ? version : undefined;
};

/** `on`/`off` when `<claudeDir>/settings.json` enabledPlugins has the fork's plugin (installed), else `absent`. */
export function claudePluginState(claudeDir) {
  const enabled = readJsonFile(path.join(claudeDir, "settings.json"))?.enabledPlugins;
  const value = isObject(enabled) ? enabled[SUPERPOWERS_PLUGIN] : undefined;
  return value === true ? "on" : value === false ? "off" : "absent";
}

/** The Claude dirs the superpowers card reports on: `current`, then every kit environment's, each once. */
export const superpowersClaudeDirs = (home, current) => [...new Set([current, ...ENV_NAMES.map((name) => resolveEnv(name, home).claudeDir)])];

const GIT_TIMEOUT_MS = 60_000;
const CLAUDE_TIMEOUT_MS = 120_000;

/** Runs `file args` without a shell, stdin closed; one that outlives `timeoutMs` is killed and rejects with code `code`. */
function run(file, args, { cwd, env, timeoutMs, code }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, env, encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
      const name = `${path.basename(file)} ${args.join(" ")}`;
      if (!error) return resolve(String(stdout).trim());
      if (error.killed) {
        const timeout = new Error(`${name} timed out after ${timeoutMs / 1000} s`);
        timeout.code = code;
        timeout.timeoutMs = timeoutMs;
        return reject(timeout);
      }
      reject(new Error(`${name} failed: ${String(stderr).trim() || error.message}`));
    });
    child.stdin?.end();
  });
}

/** Runs git; one that outlives `timeoutMs` is killed and rejects with code GIT_TIMEOUT (and its `timeoutMs`). */
const gitAsync = (args, cwd, timeoutMs = GIT_TIMEOUT_MS) =>
  run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs, code: "GIT_TIMEOUT" });

/** The clone's short sha, or undefined when `dir` is not a git clone. */
export async function superpowersVersion(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return undefined;
  return gitAsync(["rev-parse", "--short=7", "HEAD"], dir);
}

/**
 * Fetch and check out `ref` (the pinned one by default) in the clone `dir`; returns the new short sha. Each git call is
 * limited to `timeoutMs` (60 s): a hung fetch rejects with code GIT_TIMEOUT before anything is checked out.
 */
export async function updateSuperpowers(dir, ref = pinnedSuperpowersRef(), { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`superpowers is not installed in ${dir}`);
  await gitAsync(["fetch", "--quiet", "origin"], dir, timeoutMs);
  await gitAsync(["checkout", "--quiet", "--detach", ref], dir, timeoutMs);
  return gitAsync(["rev-parse", "--short=7", "HEAD"], dir, timeoutMs);
}

/** The two commands that install the fork's plugin from the clone into `claudeDir` (setup prints them, never runs them). */
export function claudePluginInstallCommands(dir, claudeDir, home) {
  const prefix = path.resolve(claudeDir) === path.join(home, ".claude") ? "" : `CLAUDE_CONFIG_DIR=${shq(claudeDir)} `;
  return [`${prefix}claude plugin marketplace add ${shq(dir)}`, `${prefix}claude plugin install ${SUPERPOWERS_PLUGIN}`];
}

/**
 * In each of `claudeDirs` where the fork's plugin is installed: `claude plugin marketplace update` then `claude plugin
 * update`, under that environment's config dir (none for `<home>/.claude`, Claude's default). Each call is limited to
 * `timeoutMs` (120 s). Returns one `{ claudeDir, outcome: updated|failed|skipped, detail? }` per installed environment.
 */
export async function updateClaudePlugin(claudeDirs, home, { timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  const installed = claudeDirs.filter((claudeDir) => claudePluginState(claudeDir) !== "absent");
  if (installed.length === 0) return [];
  const claude = findOnPath("claude");
  if (claude === null) return installed.map((claudeDir) => ({ claudeDir, outcome: "skipped", detail: "claude not found on PATH" }));
  const results = [];
  for (const claudeDir of installed) {
    const env = { ...process.env };
    if (path.resolve(claudeDir) === path.join(home, ".claude")) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = claudeDir;
    const options = { cwd: home, env, timeoutMs, code: "CLAUDE_TIMEOUT" };
    try {
      await run(claude, ["plugin", "marketplace", "update", SUPERPOWERS_MARKETPLACE], options);
      await run(claude, ["plugin", "update", SUPERPOWERS_PLUGIN], options);
      results.push({ claudeDir, outcome: "updated" });
    } catch (error) {
      results.push({ claudeDir, outcome: "failed", detail: error.message });
    }
  }
  return results;
}
