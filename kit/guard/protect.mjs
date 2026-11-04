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

/** Why a bash command / eval code must be decided by a human only, or null. */
export function guardStateReason(text, { cwd, agentDir, home }) {
  if (cwd && [agentDir, path.join(home, ".omo", "kit")].some((dir) => isInside(realpathOrSelf(cwd), realpathOrSelf(dir)) || isInside(cwd, dir))) {
    return "команда запускается в папке решателя или кита";
  }
  if (!text) return null;
  if (/agent-guard/i.test(text)) return "команда упоминает agent-guard";
  if (/guardctl/i.test(text)) return "команда вызывает guardctl";
  // Paths, not words: prose about the guard (a spec the code writes to a project file) names none of these.
  const joined = joinedLiterals(text);
  if (GUARD_STATE_FILE_RE.test(joined)) return "команда обращается к файлам состояния решателя (guard/rules.json, cache, answers, сокеты…)";
  if (/hooks(-state)?\.json/i.test(text)) return "команда упоминает hooks.json / hooks-state.json";
  const folded = fold(joined);
  for (const dir of agentDirs(agentDir, home).flatMap((dir) => [path.join(dir, "guard"), path.join(dir, "keys")])) {
    if (spellings(dir, home).some((form) => folded.includes(form))) return "команда обращается к папке решателя или ключей";
  }
  for (const dir of [agentDir, path.join(home, ".omo", "kit")]) {
    if (spellings(dir, home).some((form) => folded.includes(form))) return "команда обращается к папке агента или кита";
  }
  return null;
}
