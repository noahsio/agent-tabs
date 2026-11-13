// Provisioning of the guard hook (run from the source kit, not from the installed copy): copy kit/guard into
// ~/.omo/kit/<content hash>/guard and add or remove our group in hooks.json — the same group under PreToolUse (the
// guard) and SessionStart (the sandbox note, P31) — through writeHooksJson, the only hooks.json writer (ruling P4),
// which re-trusts every kit handler (trust carries over by exact command, P22).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeIfChanged } from "../lib/files.mjs";
import { writeHooksJson } from "../lib/hooks.mjs";
import { isKitCommand, loadConfig, validateHooks } from "../lib/tools.mjs";
import { HOOK_TIMEOUT_SECONDS } from "./thinHook.mjs";

// Read only when no source is given: the extension bundle (CommonJS) has no import.meta.url and names its kit dir.
const ownDir = () => path.dirname(fileURLToPath(import.meta.url));
const EVENTS = ["PreToolUse", "SessionStart"];
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Copies every file of `source` (kit/guard; default: this module's dir) to ~/.omo/kit/<sha256 of names and contents,
 * 12 hex>/guard; returns that dir.
 */
export function installGuardFiles(home, source = ownDir()) {
  const targetDir = guardFilesDir(home, source);
  for (const name of guardFiles(source)) writeIfChanged(path.join(targetDir, name), fs.readFileSync(path.join(source, name), "utf8"), { mode: 0o644 });
  return targetDir;
}

const guardFiles = (source) => [...fs.readdirSync(source).filter((name) => fs.statSync(path.join(source, name)).isFile()), "../lib/envs.mjs"].sort();

/** Where installGuardFiles puts `source`, without writing anything (the consent dialog names it). */
export function guardFilesDir(home, source = ownDir()) {
  const hash = createHash("sha256");
  for (const name of guardFiles(source)) hash.update(name).update(fs.readFileSync(path.join(source, name)));
  return path.join(home, ".omo/kit", hash.digest("hex").slice(0, 12), "guard");
}

/** The loader OmO reads from `<agentDir>/extensions`: the skills extension of the kit copy at `kitGuard`, told the Claude dir. */
export function skillsExtensionLoader(kitGuard, claudeDir) {
  const module = JSON.stringify(path.join(kitGuard, "skills-extension.mjs"));
  return `import skills from ${module};\nexport default (pi) => skills(pi, { claudeDir: ${JSON.stringify(claudeDir)} });\n`;
}

/**
 * Puts the skills extension in place for this environment: the kit copy of `source` (kit/guard) and the loader in
 * `<agentDir>/extensions/agent-tabs-skills.ts`. Writes only what differs; returns the loader file. The plugin runs it on
 * every activation, so an update of the extension reaches OmO by itself (at its next start).
 */
export function installSkillsExtension(paths, source = ownDir()) {
  const kitGuard = installGuardFiles(paths.home, source);
  const loader = path.join(paths.agentDir, "extensions", "agent-tabs-skills.ts");
  writeIfChanged(loader, skillsExtensionLoader(kitGuard, paths.claudeDir), { mode: 0o644, backup: "rolling" });
  return loader;
}

/** Our hooks.json group (PreToolUse and SessionStart): no matcher (every tool), timeout 330 s. */
export function guardHookEntry({ node, kitDir, agentDir }) {
  return { hooks: [{ type: "command", command: `${shq(node)} ${shq(path.join(kitDir, "hook.mjs"))} --agent-dir ${shq(agentDir)}`, timeout: HOOK_TIMEOUT_SECONDS }] };
}

/** A guard handler of the kit: the thin hook, or the v1 agent-guard it replaces. */
const isGuardCommand = (command, home) =>
  isKitCommand(command, home) && [`${path.sep}guard${path.sep}hook.mjs`, `${path.sep}guard${path.sep}agent-guard.mjs`].some((script) => command.includes(script));

/**
 * Every kit guard handler in hooks.json as { event, command, timeout }, in EVENTS order; throws when hooks.json cannot
 * be used. The timeout is there so a caller can tell an entry an older version wrote from the one guardHookEntry
 * writes now.
 */
export function guardHandlers(paths) {
  const hooksFile = path.join(paths.agentDir, "hooks.json");
  if (!fs.existsSync(hooksFile)) return [];
  const config = loadConfig(hooksFile, validateHooks);
  return EVENTS.flatMap((event) =>
    (Array.isArray(config.hooks?.[event]) ? config.hooks[event] : []).flatMap((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).filter((handler) => isGuardCommand(handler?.command, paths.home)).map((handler) => ({ event, command: handler.command, timeout: handler.timeout })),
    ),
  );
}

/** The events whose groups hold a kit guard handler, in EVENTS order; throws when hooks.json cannot be used. */
export function guardHookEvents(paths) {
  return [...new Set(guardHandlers(paths).map((handler) => handler.event))];
}

/** One event's groups with ours placed (`entry`, at the first one of ours, else appended) or removed. */
function placeGroup(groups, on, entry, home) {
  let placed = !on;
  const kept = [];
  for (const group of groups) {
    const handlers = Array.isArray(group.hooks) ? group.hooks : [];
    const others = handlers.filter((handler) => !isGuardCommand(handler?.command, home));
    if (others.length === handlers.length) {
      kept.push(group);
      continue;
    }
    if (!placed) {
      kept.push(entry);
      placed = true;
    }
    if (others.length > 0) kept.push({ ...group, hooks: others });
  }
  if (!placed) kept.push(entry);
  return kept;
}

/**
 * Adds (`on`) or removes our group under every event of EVENTS in `<agentDir>/hooks.json`; `paths`: {agentDir, home}.
 * Ours = groups holding a kit guard handler: on, the first is replaced by `entry` in place and the rest go; off, they
 * go (no hooks.json: nothing is written). Other handlers in those groups and every other hook stay. Returns the files
 * written.
 */
export function setGuardHook(paths, on, entry) {
  const { agentDir, home } = paths;
  const hooksFile = path.join(agentDir, "hooks.json");
  if (!on && !fs.existsSync(hooksFile)) return [];
  const config = loadConfig(hooksFile, validateHooks);
  config.hooks ??= {};
  for (const event of EVENTS) {
    const kept = placeGroup(Array.isArray(config.hooks[event]) ? config.hooks[event] : [], on, entry, home);
    if (kept.length > 0) config.hooks[event] = kept;
    else delete config.hooks[event];
  }

  const outcome = writeHooksJson(agentDir, config, { isOwn: (command) => isKitCommand(command, home) });
  return [
    ...(outcome.hooks !== "unchanged" ? [hooksFile] : []),
    ...(outcome.state !== "unchanged" ? [path.join(agentDir, "hooks-state.json")] : []),
  ];
}
