// Guard self-protection: the agent must not answer its own requests or change the guard, its rules or its hooks.
// - file-writing tools: targets under the protected roots are hard-denied (resolved against cwd, symlinks followed);
// - bash/eval text that names a path to the guard's state, the agent dir, the installed kit or the hook files goes to a human only.
import fs from "node:fs";
import path from "node:path";
import { ENV_NAMES, resolveEnv } from "../lib/envs.mjs";

const caseFold = process.platform === "darwin" || process.platform === "win32";
const fold = (value) => (caseFold ? value.toLowerCase() : value);

function realpathOrSelf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

/** Realpath of the nearest existing ancestor + the missing tail (a symlinked parent cannot hide the target). */
function resolveNearest(target) {
  let existing = target;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathOrSelf(existing), ...tail);
}

const expandHome = (target, home) => (target === "~" ? home : target.startsWith("~/") ? path.join(home, target.slice(2)) : target);

/** Files and trees the agent may never write: <agentDir>/guard, its hooks files, the installed kit, omo.jsonc. */
export function protectedRoots({ agentDir, home }) {
  return [
    path.join(agentDir, "guard"),
    path.join(agentDir, "hooks.json"),
    path.join(agentDir, "hooks-state.json"),
    path.join(home, ".omo", "kit"),
    path.join(home, ".omo", "omo.jsonc"),
  ];
}

function isInside(child, parent) {
  const relative = path.relative(fold(parent), fold(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** The first protected root a write target falls under, or null. */
export function protectedTarget(rawTarget, { cwd, agentDir, home }) {
  const absolute = path.resolve(cwd || "/", expandHome(rawTarget, home));
  const candidates = [absolute, resolveNearest(absolute)];
  for (const root of protectedRoots({ agentDir, home })) {
    const roots = [root, resolveNearest(root)];
    if (candidates.some((candidate) => roots.some((protectedRoot) => isInside(candidate, protectedRoot)))) return root;
  }
  return null;
}

/** The text of a call that guardStateReason reads: the command or code it runs, else its whole input. */
export function commandText(tool, input) {
  const value = tool === "bash" || tool === "monitor" ? input?.command : tool === "bash_input" ? input?.input : tool === "eval" ? input?.code : undefined;
  return typeof value === "string" ? value : JSON.stringify(input ?? {});
}

// A path into a guard dir that names one of its state files: rules, decider cache, answers, sandbox profile, lock, sockets.
const GUARD_STATE_FILE_RE =
  /(?<![\w.-])guard[\\/]+(?:[^\s"'`\\/]+[\\/]+)*(?:(?:rules|cache|answers|used|watchers|pending|sandbox)\.json|sandbox\.sb|service\.lock|[\w.-]+\.sock)(?![\w.-])/i;

/** `'a' + 'b'` -> `ab` and `"a", "b"` (path.join segments) -> `a/b`, so a path split across literals still reads as one. */
const joinedLiterals = (text) => text.replace(/["'`]\s*\+\s*["'`]/g, "").replace(/["'`]\s*,\s*["'`]/g, "/");

// Relative paths stay relative until the caller supplies HOME; configured absolute paths stay absolute.
export const ENV_AGENT_DIRS = [...new Set(ENV_NAMES.map((name) => resolveEnv(name, ".").agentDir))];

/** Every environment's agent dir, the current one first. */
const agentDirs = (agentDir, home) => [...new Set([agentDir, ...ENV_AGENT_DIRS.map((dir) => path.resolve(home, dir))])];

/** Spellings of a directory that a command could use: absolute, realpath, and the part below $HOME (~/x, $HOME/x). */
function spellings(dir, home) {
  const forms = new Set([dir, realpathOrSelf(dir)]);
  for (const form of [...forms]) {
    if (isInside(form, home) && fold(form) !== fold(home)) forms.add(path.relative(home, form));
  }
  return [...forms].filter((form) => form.length > 1).map(fold);
}

/**
 * Files inside an agent dir that decide what the guard and the agent may do: the hook wiring, the permission preset
 * and the provider credentials. The state dir and the keys dir are checked as directories, below.
 */
const AGENT_DECISION_FILES = ["hooks.json", "hooks-state.json", "settings.json", "models.json"];
// launchctl subcommands that could stop, replace or re-point the service's LaunchAgent.
const LAUNCHCTL_RE = /(?<![\w-])launchctl\s+(?:bootout|bootstrap|unload|load|disable|enable|remove|stop|kickstart|submit)(?![\w-])/i;

/**
 * Why a bash command / eval code must be decided by a human only, or null.
 *
 * Ruling P40. What this protects is the guard's own ability to decide: its state and keys, the kit it runs from, the
 * hook wiring and permission files, omo.jsonc, and the LaunchAgent that starts the service. It used to protect the
 * WHOLE agent dir and the whole kit tree, which made ordinary tooling human-only for merely naming a path inside
 * them — the person's two cards were `python3 …/binary-runtime/<v>/plugin/skills/…/find-agent-sessions.py --root
 * <agentDir>/projects`, a read-only script OmO itself ships, run to list its own sessions. The agent's data under
 * the agent dir (sessions, projects, memory, the unpacked runtime) is its work, not the guard's decision surface.
 *
 * This is the second layer, and deliberately a text heuristic: the Seatbelt profile is what actually refuses the
 * writes (kit/sandbox/profile.mjs), and file-writing tools are hard-denied by protectedTarget above. Narrowing the
 * heuristic does not widen what the sandbox allows.
 */
export function guardStateReason(text, { cwd, agentDir, home }) {
  const guardDirs = agentDirs(agentDir, home).flatMap((dir) => [path.join(dir, "guard"), path.join(dir, "keys")]);
  const kit = path.join(home, ".omo", "kit");
  // Running *inside* the state, keys or kit dir, where a relative path reaches them without naming them.
  if (cwd && [...guardDirs, kit].some((dir) => isInside(realpathOrSelf(cwd), realpathOrSelf(dir)) || isInside(cwd, dir))) {
    return "команда запускается в папке решателя, ключей или кита";
  }
  if (!text) return null;
  if (/agent-guard/i.test(text)) return "команда упоминает agent-guard";
  if (/guardctl/i.test(text)) return "команда вызывает guardctl";
  if (LAUNCHCTL_RE.test(text)) return "команда управляет автозапуском (launchctl)";
  // Paths, not words: prose about the guard (a spec the code writes to a project file) names none of these.
  const joined = joinedLiterals(text);
  if (GUARD_STATE_FILE_RE.test(joined)) return "команда обращается к файлам состояния решателя (guard/rules.json, cache, answers, сокеты…)";
  if (/hooks(-state)?\.json/i.test(text)) return "команда упоминает hooks.json / hooks-state.json";
  const folded = fold(joined);
  const names = (dirs) => dirs.some((dir) => spellings(dir, home).some((form) => folded.includes(form)));
  if (names(guardDirs)) return "команда обращается к папке решателя или ключей";
  if (names(agentDirs(agentDir, home).flatMap((dir) => AGENT_DECISION_FILES.map((file) => path.join(dir, file))))) {
    return "команда обращается к настройкам агента или его хукам";
  }
  if (names([kit, path.join(home, ".omo", "omo.jsonc")])) return "команда обращается к киту или omo.jsonc";
  if (names([path.join(home, "Library", "LaunchAgents")])) return "команда обращается к автозапуску (LaunchAgents)";
  return null;
}
