// OmO extension of Agent Tabs: skills as Claude Code has them, whatever skills the person has (their own, a package's).
// Installed by the plugin into <agentDir>/extensions/agent-tabs-skills.ts (installSkillsExtension, install.mjs), which
// passes this environment's Claude dir. Kept apart from the guard: it reads two places and changes one prompt clause.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * OmO's own skill catalog ends its rule with this clause, which holds the model back from loading a skill. Claude
 * Code's Skill tool says the opposite: a relevant skill is invoked first, «a BLOCKING REQUIREMENT … BEFORE generating
 * any other response about the task». Measured on omo 5.1.64: with the clause, skills were read in 26 of 2070 tool
 * calls of the person's sessions, against 118 of 5607 in Claude Code.
 */
export const HOLD_BACK = "keyword overlap or mere availability is not a reason.";
export const CLAUDE_RULE =
  "when one is relevant, loading it is a blocking requirement: read its file first, before any other tool call or any reply about the task, as Claude Code's Skill tool requires; keyword overlap alone is not relevance.";

/** The skill folders of `<claudeDir>/skills`: its folders (or links to one) with a SKILL.md at their top, as Claude Code finds them. */
export function claudeSkillFolders(claudeDir) {
  const dir = path.join(claudeDir, "skills");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => path.join(dir, entry.name))
    .filter((folder) => {
      try {
        return fs.statSync(folder).isDirectory() && fs.existsSync(path.join(folder, "SKILL.md"));
      } catch {
        return false;
      }
    })
    .sort();
}

/** `entry` of settings.json's `skills` as an absolute path: `~` is the home dir, a relative path is under the agent dir. */
function resolveEntry(entry, agentDir) {
  const expanded = entry === "~" || entry.startsWith("~/") ? path.join(os.homedir(), entry.slice(1)) : entry;
  return path.resolve(agentDir, expanded);
}

function realOrSame(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/** The `skills` list of `<agentDir>/settings.json`, or nothing when it cannot be read. */
export function settingsSkills(agentDir) {
  try {
    const skills = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"))?.skills;
    return Array.isArray(skills) ? skills.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The Claude skills OmO is to load on top of what settings.json lists: all of them, like Claude Code, except one switched
 * off in «Инструменты» (`-<folder>`, OmO's own exact-path exclusion) and one settings.json already names (OmO loads that
 * itself; naming it twice would only be a collision).
 */
export function skillsToAdd(claudeDir, agentDir, entries = settingsSkills(agentDir)) {
  const listed = new Set();
  const off = new Set();
  for (const entry of entries) {
    if (entry.startsWith("-")) {
      const folder = resolveEntry(entry.slice(1), agentDir);
      off.add(folder).add(realOrSame(folder));
    } else if (!entry.startsWith("!") && !entry.startsWith("+")) {
      const folder = resolveEntry(entry, agentDir);
      listed.add(folder).add(realOrSame(folder));
    }
  }
  return claudeSkillFolders(claudeDir).filter((folder) => {
    const real = realOrSame(folder);
    return !listed.has(folder) && !listed.has(real) && !off.has(folder) && !off.has(real);
  });
}

/** The system prompt with OmO's holding-back clause turned into Claude Code's rule; undefined when there is no such clause. */
export function withClaudeRule(systemPrompt) {
  return typeof systemPrompt === "string" && systemPrompt.includes(HOLD_BACK) ? systemPrompt.replace(HOLD_BACK, CLAUDE_RULE) : undefined;
}

export default function skillsExtension(pi, options = {}) {
  const agentDir = options.agentDir ?? process.env.OMO_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omo/agent");
  const claudeDir = options.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  pi.on("resources_discover", async () => ({ skillPaths: skillsToAdd(claudeDir, agentDir) }));
  // Every run: the catalog is rebuilt into each system prompt, so the rule is in front of the model on every message.
  pi.on("before_agent_start", async (event) => {
    const systemPrompt = withClaudeRule(event.systemPrompt);
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });
}
