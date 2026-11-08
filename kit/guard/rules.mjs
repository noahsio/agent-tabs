// Guard rules v2: loading (v1 files are migrated), validation (FieldError[]) and compilation into matchers.
import { readFileSync } from "node:fs";
import { parseCidr } from "./ip.mjs";

/** Thrown by loadRules/compileRules; `errors` holds the FieldError list. */
export class RulesError extends Error {
  constructor(errors) {
    super(`invalid guard rules: ${errors.map((error) => `${error.field}${error.line ? `:${error.line}` : ""} ${error.message}`).join("; ")}`);
    this.errors = errors;
  }
}

export const GROUP_IDS = ["git-push", "history", "secrets", "external-ip", "global-install"];
export const DECIDER_MODES = ["decider-then-me", "ask-me", "deny"];
export const WAIT_SECONDS = [60, 180, 300];
const V1_BUILTIN_IDS = ["sudo", "chmod-777", "curl-write"];

// The switchable groups ("external-ip" is the IP check in classify.mjs, not a pattern list).
export const GROUP_RULES = {
  "git-push": [{ id: "git-push", label: "git push", patterns: ["\\bgit\\s+push(?![\\w-])"] }],
  history: [
    { id: "git-reset", label: "git reset", patterns: ["\\bgit\\s+reset(?![\\w-])"] },
    { id: "git-rebase", label: "git rebase", patterns: ["\\bgit\\s+rebase(?![\\w-])"] },
    { id: "git-clean", label: "git clean", patterns: ["\\bgit\\s+clean(?![\\w-])"] },
    { id: "git-checkout-discard", label: "git checkout discarding changes", patterns: ["\\bgit\\s+checkout\\s+(\\.|--)"] },
    { id: "git-restore-discard", label: "git restore discarding changes", patterns: ["\\bgit\\s+restore\\s+(\\.|--)"] },
    {
      id: "git-branch-delete",
      label: "git branch -D (or --delete --force)",
      patterns: [
        "\\bgit\\s+branch\\s+(\\S+\\s+)*-D(?![\\w-])",
        "\\bgit\\s+branch\\s+(\\S+\\s+)*-(df|fd)(?![\\w-])",
        "\\bgit\\s+branch\\s+(\\S+\\s+)*(-d|--delete)\\s+(\\S+\\s+)*(-f|--force)(?![\\w-])",
        "\\bgit\\s+branch\\s+(\\S+\\s+)*(-f|--force)\\s+(\\S+\\s+)*(-d|--delete)(?![\\w-])",
      ],
    },
    { id: "git-stash", label: "git stash (except list/show)", patterns: ["\\bgit\\s+stash(?!\\s+(list|show)(?![\\w-]))(?![\\w-])"] },
  ],
  secrets: [
    {
      id: "secrets-access",
      label: "access to keys and credentials",
      patterns: [
        // A public CA trust store is not a credential: cacert.pem, /etc/ssl/cert.pem, certifi's bundle and the env
        // vars that point at them are how ordinary code reaches the system roots (P43 measurement: they were 79 of
        // the 234 questions left on the person's corpus). A real key file still matches.
        // `(?<!\\)`: a backslash-escaped dot is regex or glob syntax, not a path on disk. The card the person
        // photographed was `grep -n '^\*\*/\*\.pem$' deploy/.rsyncignore` — a command that CHECKS .pem files are
        // excluded from a deploy, read as access to a key. Spelling `.pem` inside a pattern reads no key.
        "(\\.ssh(\\s|$|[\"'])|\\.aws/credentials|private\\.key|id_rsa|id_ed25519|keystore|(?<!cacert)(?<!/cert)(?<!ca-bundle)(?<!ca-certificates)(?<!\\\\)\\.pem([^A-Za-z0-9]|$))",
        // Anything under ~/.ssh/ except a pure read (cat/grep/head/tail/less/ssh -G/ssh-keygen -l, no redirect) of config, known_hosts or *.pub.
        "^(?!(cat|grep|head|tail|less|ssh\\s+-G|ssh-keygen\\s+(-\\S+\\s+)*-l)\\s(?![\\s\\S]*>(?!\\s*/dev/null(\\s|$)|&\\d))(?![\\s\\S]*\\.ssh/(?!(config|known_hosts)(?![\\w.-])|[\\w.-]+\\.pub(?![\\w.-]))))[\\s\\S]*\\.ssh/",
      ],
    },
  ],
  "global-install": [
    {
      id: "global-install",
      label: "global package install",
      patterns: [
        "\\bpip[0-9]?\\s+install",
        "\\bnpm\\s+(-\\S+\\s+)*(i|install|add)(\\s.*)?\\s(-g|--global)(?![\\w-])",
        "\\bnpm\\s+(-g|--global)\\s+(i|install|add)(?![\\w-])",
        "\\bpnpm\\s+add(\\s.*)?\\s(-g|--global)(?![\\w-])",
        "\\byarn\\s+global\\s+add",
      ],
    },
  ],
};

export const REMOTE_ASK_RULES = [
  { label: "На удалённой машине: рекурсивное удаление путей с переменными, шаблонами или выходом из папки", patterns: [
    "(?<![\\w.-])(?<!git\\s)rm\\s+(-[\\w-]+\\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\\s+-[\\w-]+)*(\\s+[^\\s;&|()]+)*?\\s+(?![;&|()])(?!\\d*[<>])(?=[^\\s;&|()]*(\\.\\.|[*?\\[{])|(?!(\\./)?[\\w@%+=:,-][\\w@%+=:,.-]*(/[\\w@%+=:,.-]+)*/?(?=[\\s;&|)]|$)))",
    "^(?=[\\s\\S]*(\\b(cd|pushd|popd)\\b|\\())(?=[\\s\\S]*(?<![\\w.-])(?<!git\\s)rm\\s+(-[\\w-]+\\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?![\\w-]))",
  ] },
  { label: "На удалённой машине: удаление контейнеров и образов Docker", patterns: [
    "\\bdocker\\s+(rm|rmi)(?![\\w-])",
  ] },
  { label: "На удалённой машине: удаление и очистка ресурсов Docker", patterns: [
    "\\bdocker\\s+(container|image|volume|network)\\s+(rm|prune)(?![\\w-])",
    "\\bdocker\\s+(system|builder)\\s+prune(?![\\w-])",
    "\\bdocker(-compose|\\s+compose)\\s+(-[\\w-]+\\s+(\\S+\\s+)?)*(rm(?![\\w-])|down(\\s+-[\\w-]+)*\\s+(-v|--volumes)(?![\\w-]))",
  ] },
  { label: "На удалённой машине: удаление объектов и очистка таблиц SQL", patterns: [
    "\\b([Dd][Rr][Oo][Pp]\\s+([Tt][Aa][Bb][Ll][Ee]|[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]|[Ss][Cc][Hh][Ee][Mm][Aa]|[Vv][Ii][Ee][Ww]|[Ii][Nn][Dd][Ee][Xx]|[Rr][Oo][Ll][Ee]|[Uu][Ss][Ee][Rr])|[Tt][Rr][Uu][Nn][Cc][Aa][Tt][Ee]\\s+[Tt][Aa][Bb][Ll][Ee])\\b",
    "\\b[Dd][Ee][Ll][Ee][Tt][Ee]\\s+[Ff][Rr][Oo][Mm]\\s+[^\\s;]+(?=[\\s;]|$)(?!\\s+[Ww][Hh][Ee][Rr][Ee]\\b)",
    "\\b[Dd][Ee][Ll][Ee][Tt][Ee]\\s+[Ff][Rr][Oo][Mm]\\s+[^;]*?\\b[Ww][Hh][Ee][Rr][Ee]\\s+[(\\s]*(1|[Tt][Rr][Uu][Ee]|(\\w+)\\s*=\\s*\\2|'(\\w*)'\\s*=\\s*'\\3'|\\\"(\\w*)\\\"\\s*=\\s*\\\"\\4\\\")\\s*[)\\s]*($|[;'\\\"\\\\])",
    "\\b[Dd][Ee][Ll][Ee][Tt][Ee]\\s+[Ff][Rr][Oo][Mm]\\s+[^;]*?\\b[Ww][Hh][Ee][Rr][Ee]\\b[^;]*\\s[Oo][Rr]\\s+[(\\s]*(1|[Tt][Rr][Uu][Ee]|(\\w+)\\s*=\\s*\\2|'(\\w*)'\\s*=\\s*'\\3'|\\\"(\\w*)\\\"\\s*=\\s*\\\"\\4\\\")(?![\\w=])",
  ] },
  { label: "На удалённой машине: массовое или принудительное завершение процессов", patterns: [
    "\\b(pkill|killall)(?![\\w-])",
    "\\bkill\\s+(-9|-KILL|-SIGKILL|-s\\s+(9|KILL|SIGKILL))(?![\\w-])",
  ] },
];

// Checks for commands that run on another host (ssh, a heredoc fed to a remote shell). Built in, so that
// deleting or editing an allow rule cannot switch them off.
export const REMOTE_CHECKS = {
  denyIf: [
    "(^|[^\\w])rm\\s+(-\\S+\\s+)+/([\\s*\\\"']|$)",
    "(^|[^\\w])mkfs",
    "(^|[^\\w])dd\\s+[^;|&]*of=/dev/",
    "(^|[^\\w])fdisk(\\s|$)",
    "(^|[^\\w])find\\s+(-[HLP]\\s+)*/+\\.?/*\\s([^;|&]*\\s)?-delete(?![\\w-])",
    "\\bdiskutil\\s+(erase\\w*|zeroDisk|randomDisk|secureErase|partitionDisk)\\b",
  ],
  escalateIf: REMOTE_ASK_RULES.flatMap((entry) => entry.patterns),
};

const V1_GROUP_OF = {
  "git-push": "git-push",
  "git-reset": "history",
  "git-rebase": "history",
  "git-clean": "history",
  "git-branch-delete": "history",
  "git-checkout-discard": "history",
  "git-restore-discard": "history",
  "git-stash": "history",
  "secrets-access": "secrets",
  "global-install": "global-install",
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

/** Message for a glob the matcher cannot use, or null. Globs: `*`, `?`, `[...]`, `\` escapes the next char. */
export function globError(glob) {
  if (typeof glob !== "string" || !glob.trim()) return "пустое правило";
  for (let index = 0; index < glob.length; index += 1) {
    if (glob[index] === "\\") index += 1;
    else if (glob[index] === "[") {
      const close = glob.indexOf("]", index + 2);
      if (close < 0) return "незакрытая квадратная скобка «[»";
      index = close;
    }
  }
  return null;
}

function regexError(pattern) {
  try {
    new RegExp(pattern);
    return null;
  } catch (error) {
    return `invalid regex ${JSON.stringify(pattern)}: ${error.message}`;
  }
}

function lineErrors(field, values, check) {
  if (!Array.isArray(values)) return [{ field, message: "нужен список" }];
  return values.flatMap((value, index) => {
    const message = check(value);
    return message ? [{ field, line: index + 1, message }] : [];
  });
}

function escalateErrors(field, entries) {
  if (!Array.isArray(entries)) return [{ field, message: "нужен список правил" }];
  return entries.flatMap((entry, index) => {
    if (!isObject(entry) || typeof entry.id !== "string" || !entry.id || typeof entry.label !== "string" || !Array.isArray(entry.patterns) || entry.patterns.length === 0) {
      return [{ field, line: index + 1, message: "нужны id, label и непустой patterns" }];
    }
    return entry.patterns.map(regexError).filter(Boolean).map((message) => ({ field, line: index + 1, message }));
  });
}

function allowErrors(entries) {
  const field = "allow";
  if (!Array.isArray(entries)) return [{ field, message: "нужен список правил" }];
  return entries.flatMap((entry, index) => {
    const valid =
      isObject(entry) && typeof entry.id === "string" && entry.id && typeof entry.label === "string" && typeof entry.pattern === "string" && Array.isArray(entry.denyIf);
    if (!valid || (entry.escalateIf !== undefined && !Array.isArray(entry.escalateIf))) {
      return [{ field, line: index + 1, message: "нужны id, label, pattern, denyIf (и escalateIf — список, если есть)" }];
    }
    return [entry.pattern, ...entry.denyIf, ...(entry.escalateIf ?? [])]
      .map(regexError)
      .filter(Boolean)
      .map((message) => ({ field, line: index + 1, message }));
  });
}

/** Every problem of a v2 rules object as FieldError { field, line?, message }; [] when valid. */
export function validateRules(rules) {
  if (!isObject(rules)) return [{ field: "rules", message: "правила должны быть объектом" }];
  const errors = [];
  if (rules.version !== 2) errors.push({ field: "version", message: "version должна быть 2" });
  errors.push(...lineErrors("hardDeny", rules.hardDeny, globError));
  errors.push(...lineErrors("askCustom", rules.askCustom, globError));
  if (!isObject(rules.groups) || GROUP_IDS.some((id) => typeof rules.groups[id] !== "boolean")) {
    errors.push({ field: "groups", message: `нужны флаги ${GROUP_IDS.join(", ")}` });
  }
  errors.push(...allowErrors(rules.allow));
  errors.push(...escalateErrors("builtinEscalate", rules.builtinEscalate));
  errors.push(
    ...lineErrors("ipWhitelist", rules.ipWhitelist, (entry) =>
      isObject(entry) && parseCidr(entry.cidr) && (entry.note === undefined || typeof entry.note === "string") ? null : "не IP-адрес или подсеть",
    ),
  );
  const decider = isObject(rules.decider) ? rules.decider : {};
  if (!DECIDER_MODES.includes(decider.mode)) errors.push({ field: "decider.mode", message: `режим: ${DECIDER_MODES.join(" | ")}` });
  // "" (the default) and no key both mean no model chosen: disputed calls go to the person
  if (decider.model !== undefined && decider.model !== "" && (typeof decider.model !== "string" || !/^[^/\s]+\/\S+$/.test(decider.model))) {
    errors.push({ field: "decider.model", message: "модель в виде провайдер/id" });
  }
  if (!isPositiveInt(decider.timeoutMs)) errors.push({ field: "decider.timeoutMs", message: "положительное целое число миллисекунд" });
  const human = isObject(rules.human) ? rules.human : {};
  if (!WAIT_SECONDS.includes(human.waitSeconds)) errors.push({ field: "human.waitSeconds", message: `ожидание: ${WAIT_SECONDS.join(", ")} с` });
  if (typeof human.card !== "boolean" || typeof human.telegram !== "boolean") errors.push({ field: "human", message: "нужны флаги card и telegram" });
  // Telegram's numeric ids: a chat (a group's is negative) and, optionally, the one user whose presses count.
  if (human.telegramChat !== undefined && (typeof human.telegramChat !== "string" || !/^-?\d{1,20}$/.test(human.telegramChat))) {
    errors.push({ field: "human.telegramChat", message: "id чата — число" });
  }
  if (human.telegramUser !== undefined && (typeof human.telegramUser !== "string" || !/^\d{1,20}$/.test(human.telegramUser))) {
    errors.push({ field: "human.telegramUser", message: "id пользователя — число" });
  }
  return errors;
}

const readDefaults = () => JSON.parse(readFileSync(new URL("./default-rules.json", import.meta.url), "utf8"));

/**
 * v1 rules.json -> v2: groups from the v1 ids; hidden rules from the current defaults plus any custom v1 entries.
 * `defaults`: the parsed default-rules.json (the extension bundle has no import.meta.url and passes its kit's copy).
 */
export function migrateRules(v1, defaults = readDefaults()) {
  const escalate = Array.isArray(v1?.escalate) ? v1.escalate.filter(isObject) : [];
  const present = new Set(escalate.map((entry) => entry.id));
  const groups = Object.fromEntries(GROUP_IDS.map((group) => [group, group === "external-ip" || escalate.some((entry) => V1_GROUP_OF[entry.id] === group)]));
  const builtinIds = new Set(defaults.builtinEscalate.map((entry) => entry.id));
  const allowIds = new Set(defaults.allow.map((entry) => entry.id));
  const ipWhitelist = [...defaults.ipWhitelist];
  for (const cidr of Array.isArray(v1?.ipWhitelist) ? v1.ipWhitelist : []) {
    if (!ipWhitelist.some((entry) => entry.cidr === cidr)) ipWhitelist.push({ cidr });
  }
  const wait = Number(v1?.human?.waitSeconds);
  const model = typeof v1?.decider?.model === "string" && v1.decider.model ? v1.decider.model : undefined;
  return {
    version: 2,
    hardDeny: Array.isArray(v1?.hardDeny) ? v1.hardDeny : defaults.hardDeny,
    groups,
    askCustom: [],
    allow: [...defaults.allow, ...(Array.isArray(v1?.allow) ? v1.allow.filter((entry) => !allowIds.has(entry?.id)) : [])],
    builtinEscalate: [
      ...defaults.builtinEscalate.filter((entry) => present.has(entry.id) || !V1_BUILTIN_IDS.includes(entry.id)),
      ...escalate.filter((entry) => !V1_GROUP_OF[entry.id] && !builtinIds.has(entry.id)),
    ],
    ipWhitelist,
    decider: {
      mode: v1?.decider?.enabled === false ? "ask-me" : "decider-then-me",
      ...(model ? { model: model.includes("/") ? model : `gw-anthropic/${model}` } : {}),
      timeoutMs: isPositiveInt(v1?.decider?.timeoutMs) ? v1.decider.timeoutMs : defaults.decider.timeoutMs,
    },
    human: { waitSeconds: WAIT_SECONDS.find((seconds) => wait <= seconds) ?? 300, card: true, telegram: v1?.human?.telegram === true },
  };
}

/** Parsed rules.json content (v1 or v2) -> valid v2 rules; throws RulesError. */
export function parseRules(raw) {
  const rules = isObject(raw) && raw.version === 1 ? migrateRules(raw) : raw;
  const errors = validateRules(rules);
  if (errors.length > 0) throw new RulesError(errors);
  return rules;
}

export function loadRules(path) {
  return parseRules(JSON.parse(readFileSync(path, "utf8")));
}

export function loadDefaultRules() {
  return parseRules(readDefaults());
}

// Glob: `*` any run, `?` one char, `[...]` a class (`[!...]` negated), `\x` a literal x.
function globSource(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "\\" && index + 1 < glob.length) source += glob[(index += 1)].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[") {
      const close = glob.indexOf("]", index + 2);
      const body = glob.slice(index + 1, close).replace(/\\/g, "\\\\");
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = close;
    } else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
}

const globToRegExp = (glob) => new RegExp(`^${globSource(glob)}$`, "s");
// An «ask» line with `*` is a glob over the whole leaf command; without `*` it matches as a whole-word substring.
const askToRegExp = (glob) => (glob.includes("*") ? globToRegExp(glob) : new RegExp(`(?<![\\w-])${globSource(glob)}(?![\\w-])`, "s"));

/** Escalation categories in force: the switched-on groups, then the built-in ones. */
/**
 * Ruling P45: the ask list is destructive forms and the guard's own decision surface. Nothing else interrupts the
 * person. These ids keep their place in a
 * rules file (so an older file still validates, and the Безопасность section still round-trips it) but no longer
 * match anything: `git push`, the history group, secrets, global installs, `sudo`, `chmod 777` and curl-with-a-body
 * were all questions about things that are not destructive and cannot disable the guard. The DENY set is untouched —
 * everything it denied it still denies — and so is guard-state, docker mounts that escape the sandbox, and the
 * deny-set forms seen on another host.
 */
const RETIRED_ASK_IDS = new Set(["sudo", "chmod-777", "curl-write"]);
const RETIRED_ASK_GROUPS = new Set(["git-push", "history", "secrets", "global-install", "external-ip"]);

export function escalationRules(rules) {
  const groups = GROUP_IDS.filter((group) => !RETIRED_ASK_GROUPS.has(group) && rules.groups[group]);
  return [...groups.flatMap((group) => GROUP_RULES[group] ?? []), ...rules.builtinEscalate.filter((entry) => !RETIRED_ASK_IDS.has(entry.id))];
}

const compiled = new WeakMap();

/** Valid v2 rules -> matchers, memoized per rules object; throws RulesError. */
export function compileRules(rules) {
  let result = compiled.get(rules);
  if (!result) {
    const errors = validateRules(rules);
    if (errors.length > 0) throw new RulesError(errors);
    result = {
      hardDeny: rules.hardDeny.map((glob) => ({ glob, regex: globToRegExp(glob) })),
      askCustom: rules.askCustom.map((glob) => ({ glob, regex: askToRegExp(glob) })),
      escalate: escalationRules(rules).map((entry) => ({ id: entry.id, label: entry.label, regexes: entry.patterns.map((pattern) => new RegExp(pattern)) })),
      allow: rules.allow.map((entry) => ({
        id: entry.id,
        regex: new RegExp(entry.pattern),
        denyIf: entry.denyIf.map((pattern) => new RegExp(pattern)),
        escalateIf: [], // P45: retired with the rest of the ask list; denyIf below is untouched
        // The person's own «always allow» entries carry `user`; a clean match on one is attributed to the whitelist in
        // the decision record. `scope` is the legible glob they confirmed (program + leading flags).
        user: entry.user === true,
        label: typeof entry.label === "string" ? entry.label : entry.id,
        scope: typeof entry.scope === "string" ? entry.scope : undefined,
      })),
      // P45: the bare-public-IP check is retired. REMOTE_CHECKS is not: every line of it, deny and ask alike, is a
      // destructive form, and the person's Seatbelt sandbox does not reach the other machine — so `rm -rf /srv/app`,
      // `docker volume prune`, `DROP TABLE`, a `DELETE FROM` with no WHERE and `pkill` over ssh still ask.
      // A remote command that is not one of those forms (`ssh host uptime`) is allowed.
      remote: { denyIf: REMOTE_CHECKS.denyIf.map((pattern) => new RegExp(pattern)), escalateIf: REMOTE_CHECKS.escalateIf.map((pattern) => new RegExp(pattern)) },
      ipCheck: false,
      whitelist: rules.ipWhitelist.map((entry) => parseCidr(entry.cidr)),
    };
    compiled.set(rules, result);
  }
  return result;
}

// ---------- user «always allow» whitelist ----------

/** Every user-owned whitelist entry starts with this; a built-in allow entry never does. */
export const WHITELIST_ID_PREFIX = "user-";

/** True for an allow entry the person added themselves (the «always allow» whitelist), not a built-in one. */
export const isUserAllow = (entry) => isObject(entry) && entry.user === true;

/**
 * A glob (`*`, `?`, `[...]`) -> the regex source an `allow` entry's `pattern` holds. The whole leaf command must match,
 * so it is anchored. The person edits and reads the glob (`scope`); this is only how the matcher sees it.
 */
export const globPattern = (glob) => globToRegExp(glob).source;

/**
 * One «always allow» whitelist entry for `scope` (a glob over the normalized command the classifier reads: program +
 * its leading flags + `*`). Stored in the v2 `allow` list, so it is consulted only AFTER the deny set (hard-deny and
 * the remote destructive forms run first in classify) — a whitelist entry can never turn a deny into an allow.
 * `denyIf` stays empty: the person is marking a shape safe, not writing new deny guards.
 */
export function makeWhitelistEntry({ scope, session, now = Date.now, id }) {
  const at = now();
  return {
    id: id ?? `${WHITELIST_ID_PREFIX}${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: `всегда разрешать: ${scope}`,
    pattern: globPattern(scope),
    denyIf: [],
    user: true,
    scope,
    addedAt: new Date(at).toISOString(),
    ...(typeof session === "string" && session ? { session } : {}),
  };
}
