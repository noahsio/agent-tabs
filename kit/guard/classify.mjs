// Pure command classifier for the agent guard: no fs, no network.
// classify({ tool_name, tool_input, cwd }, rules) -> { tier, reasons, normalized, key }; commandsOf(tool, input).
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { compileRules } from "./rules.mjs";
import { publicIpsOutside } from "./ip.mjs";

const MAX_DEPTH = 6;
const SUBST = "\u0001"; // stands for a $( ) / backtick substitution whose body was split out
const PROC_SUBST = "\u0003"; // stands for a <( ) / >( ) process substitution whose body was split out
// Stands for a value eval code interpolates into a shell string (`${expr}`, `"…" + expr`): part of one word, contents unknown.
const UNKNOWN = "\u0004";
const NON_EXEC_HEADS = new Set(["echo", "printf", "grep", "rg", "cat"]);
const NON_EXEC_GIT = new Set(["commit", "tag", "log", "diff", "show", "grep"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "tcsh", "csh", "su"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "{", "}", "!", "time"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

// ---------- shell splitting ----------

/** Index of the char closing the group opened just before `from`; respects quotes. -1 when unbalanced. */
function findClosing(text, from, open, close) {
  let depth = 1;
  let quote = "";
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = "";
    } else if (char === "\\") index += 1;
    else if (char === "$" && text[index + 1] === "'") {
      index = ansiQuoteEnd(text, index);
      if (index < 0) return -1;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === open) depth += 1;
    else if (char === close && (depth -= 1) === 0) return index;
  }
  return -1;
}

/** A `$( )`, `$(( ))`, `<( )`/`>( )` or backtick substitution starting at `index`: { end, segments, placeholder } or null. */
function substitutionAt(command, index, depth) {
  if (depth >= MAX_DEPTH) return null;
  if (command[index] === "`") {
    const end = command.indexOf("`", index + 1);
    return end > 0 ? { end, segments: splitSegments(command.slice(index + 1, end), depth + 1), placeholder: SUBST } : null;
  }
  if ((command[index] === "<" || command[index] === ">") && command[index + 1] === "(") {
    const end = findClosing(command, index + 2, "(", ")");
    return end < 0 ? null : { end, segments: splitSegments(command.slice(index + 2, end), depth + 1), placeholder: PROC_SUBST };
  }
  if (command[index] !== "$" || command[index + 1] !== "(") return null;
  const end = findClosing(command, index + 2, "(", ")");
  if (end < 0) return null;
  const body = command.slice(index + 2, end);
  // Arithmetic yields a number; only the command substitutions inside it run.
  if (isArithmetic(body)) return { end, segments: substitutionsIn(body.slice(1, -1), depth + 1), placeholder: "0" };
  return { end, segments: splitSegments(body, depth + 1), placeholder: SUBST };
}

/** Segments of every substitution inside `text` (an arithmetic body). */
function substitutionsIn(text, depth) {
  const segments = [];
  for (let index = 0; index < text.length; index += 1) {
    const found = substitutionAt(text, index, depth);
    if (found) {
      segments.push(...found.segments);
      index = found.end;
    }
  }
  return segments;
}

/** Text with `$( )`, `${ }` and backtick groups replaced by `0`; unbalanced text is returned as is. */
function withoutSubstitutions(text) {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    let end = -1;
    if (char === "$" && next === "(") end = findClosing(text, index + 2, "(", ")");
    else if (char === "$" && next === "{") end = findClosing(text, index + 2, "{", "}");
    else if (char === "`") end = text.indexOf("`", index + 1);
    else {
      out += char;
      continue;
    }
    if (end < 0) return text;
    out += "0";
    index = end;
  }
  return out;
}

/** `$(( … ))` body `( … )`: arithmetic unless it reads as a subshell (`;`, `&&`, two words in a row). */
function isArithmetic(body) {
  if (!body.startsWith("(") || !body.endsWith(")") || findClosing(body, 1, "(", ")") !== body.length - 1) return false;
  return !/[;\n]|&&|[A-Za-z_]\w*[ \t]+[A-Za-z_]/.test(withoutSubstitutions(body.slice(1, -1)));
}

const HEREDOC_MARK = "\u0002"; // `<<\u0002<n>` stands for heredoc body n, moved to ctx.bodies
const HEREDOC_OPERATOR_RE = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_][\w.-]*))/;
const HEREDOC_TOKEN_RE = /<<\u0002(\d+)/g;

/** Body of the heredoc whose lines start at `start`: { text, next } (next = index after the terminator line) or null. */
function heredocBody(command, start, operator) {
  const delimiter = operator[2] ?? operator[3] ?? operator[5];
  for (let lineStart = start; ; ) {
    const newline = command.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? command.length : newline;
    const line = command.slice(lineStart, lineEnd);
    if ((operator[1] ? line.replace(/^\t+/, "") : line).trimEnd() === delimiter) {
      return { text: command.slice(start, Math.max(start, lineStart - 1)), next: newline < 0 ? command.length : newline + 1 };
    }
    if (newline < 0) return null;
    lineStart = newline + 1;
  }
}

/**
 * Moves heredoc bodies into ctx.bodies as { text, quoted, clean } and leaves `<<\u0002<n>` in their place. An operator counts
 * outside quotes and comments; `clean` means the `<<` and the line end before the body sat at top level (nothing open:
 * no `$(`, backtick, `${`, quote, subshell), or the whole `$( )` is exactly `cat <<'QUOTED' … QUOTED` (the usual commit
 * message form: the body only ever reaches cat). A heredoc without its terminator line is left as is.
 */
function stripHeredocs(command, ctx) {
  if (!command.includes("<<")) return command;
  let out = "";
  const open = []; // innermost last: { kind: ' " ( $( { `, at }
  let pending = []; // bodies whose lines start after the newline at bodiesAt
  let bodiesAt = -1;
  let resumeAt = -1; // index just after the last pending terminator line
  for (let index = 0; index < command.length; index += 1) {
    if (index === bodiesAt) {
      if (open.length > 0) for (const body of pending) if (!body.catSubstitution) body.clean = false; // the command line runs on into the bodies
      out += "\n";
      index = resumeAt - 1;
      bodiesAt = -1;
      pending = [];
      continue;
    }
    const char = command[index];
    const next = command[index + 1];
    const inside = open.at(-1)?.kind;
    if (inside === "'") {
      if (char === "'") open.pop();
      out += char;
      continue;
    }
    if (char === "\\") {
      out += command.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (char === "$" && (next === "(" || next === "{")) {
      open.push({ kind: next === "(" ? "$(" : "{", at: index });
      out += char + next;
      index += 1;
      continue;
    }
    if (inside === '"') {
      if (char === '"') open.pop();
      else if (char === "`") open.push({ kind: "`", at: index });
      out += char;
      continue;
    }
    if (char === "$" && next === "'") {
      const end = ansiQuoteEnd(command, index);
      if (end < 0) return out + command.slice(index); // unterminated: leave the rest as is
      out += command.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "'" || char === '"' || char === "(") open.push({ kind: char, at: index });
    else if (char === "`") {
      if (inside === "`") open.pop();
      else open.push({ kind: "`", at: index });
    } else if ((char === ")" && (inside === "(" || inside === "$(")) || (char === "}" && inside === "{")) open.pop();
    else if (char === "#" && (index === 0 || /[\s;&|(]/.test(command[index - 1]))) {
      const newline = command.indexOf("\n", index);
      const stop = newline < 0 ? command.length : newline;
      out += command.slice(index, stop);
      index = stop - 1;
      continue;
    } else if (char === "<" && next === "<" && command[index + 2] !== "<" && command[index - 1] !== "<") {
      const operator = HEREDOC_OPERATOR_RE.exec(command.slice(index));
      const start = bodiesAt >= 0 ? resumeAt : command.indexOf("\n", index) + 1;
      const body = operator && start > 0 ? heredocBody(command, start, operator) : null;
      if (body) {
        if (bodiesAt < 0) bodiesAt = start - 1;
        resumeAt = body.next;
        const quoted = Boolean(operator[2] ?? operator[3] ?? operator[4]);
        const top = open.at(-1);
        const lineEnd = command.indexOf("\n", index);
        const catSubstitution =
          quoted &&
          top?.kind === "$(" &&
          bodiesAt === start - 1 &&
          /^\s*cat\s+$/.test(command.slice(top.at + 2, index)) &&
          /^[ \t]*$/.test(command.slice(index + operator[0].length, lineEnd)) &&
          /^\s*\)/.test(command.slice(body.next));
        const entry = { text: body.text, quoted, clean: open.length === 0 || catSubstitution, catSubstitution };
        ctx.bodies.push(entry);
        pending.push(entry);
        out += `<<${HEREDOC_MARK}${ctx.bodies.length - 1}`;
        index += operator[0].length - 1;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/** `$'…'` whose `$` is at `index`: the index of its closing quote (a backslash takes the next char), or -1. */
function ansiQuoteEnd(text, index) {
  for (let at = index + 2; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === "'") return at;
  }
  return -1;
}

const ANSI_ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };

/** The value of a `$'…'` body: backslash escapes decoded. */
function decodeAnsiQuote(body) {
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|[\s\S])/g, (match, escape) => {
    if (/^x[0-9A-Fa-f]/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (/^[0-7]+$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    return ANSI_ESCAPES[escape] ?? escape;
  });
}

/** Splits a shell command into simple-command strings, recursing into $( ), backticks and ( ). */
function splitSegments(command, depth = 0) {
  const segments = [];
  let current = "";
  let quote = "";
  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };
  const substitute = (index) => {
    const found = substitutionAt(command, index, depth);
    if (!found) return index;
    segments.push(...found.segments);
    current += found.placeholder;
    return found.end;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "\\" && quote !== "'") {
      current += char + (next ?? "");
      index += 1;
    } else if (quote) {
      if (char === quote) quote = "";
      const end = quote !== "'" && ((char === "$" && next === "(") || char === "`") ? substitute(index) : index;
      if (end !== index) index = end;
      else current += char;
    } else if (char === "$" && next === "'" && ansiQuoteEnd(command, index) > 0) {
      const end = ansiQuoteEnd(command, index);
      current += command.slice(index, end + 1);
      index = end;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (((char === "$" || char === "<" || char === ">") && next === "(") || char === "`") {
      const end = substitute(index);
      if (end !== index) index = end;
      else current += char;
    } else if (char === "(" && /(?:^|\s)[A-Za-z_]\w*\+?=$/.test(current)) {
      // `NAME=( … )` is an array assignment, not a subshell: keep it in the word, still split out its substitutions.
      const end = findClosing(command, index + 1, "(", ")");
      if (end < 0) {
        flush();
        continue;
      }
      segments.push(...substitutionsIn(command.slice(index + 1, end), depth));
      current += "(0)";
      index = end;
    } else if (char === ";" || char === "\n" || char === "(" || char === ")" || char === "|") {
      flush();
      if (char === "|" && next === "|") index += 1;
      else if (char === "|" && next === "&") index += 1;
    } else if (char === "&") {
      const redirect = current.endsWith(">") || current.endsWith("<") || next === ">";
      if (redirect) current += char;
      else {
        flush();
        if (next === "&") index += 1;
      }
    } else current += char;
  }
  flush();
  return segments;
}

/** Shell-like word split with quote and backslash removal; `quoted` marks words that had quotes. */
function shellWordsDetailed(segment) {
  const words = [];
  let word = "";
  let started = false;
  let quoted = false;
  let quote = "";
  const push = () => {
    if (started) words.push({ value: word, quoted });
    word = "";
    started = false;
    quoted = false;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && index + 1 < segment.length) word += segment[(index += 1)];
      else word += char;
    } else if (char === "$" && segment[index + 1] === "'" && ansiQuoteEnd(segment, index) > 0) {
      const end = ansiQuoteEnd(segment, index);
      word += decodeAnsiQuote(segment.slice(index + 2, end));
      started = true;
      quoted = true;
      index = end;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
      quoted = true;
    } else if (char === "\\" && index + 1 < segment.length) {
      word += segment[(index += 1)];
      started = true;
    } else if (/\s/.test(char)) push();
    else {
      word += char;
      started = true;
    }
  }
  push();
  return words;
}

const basename = (word) => word.slice(word.lastIndexOf("/") + 1);

// Words that run the next word as the command; their own options (with values where listed) are skipped.
const WRAPPER_VALUE_OPTIONS = {
  sudo: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-R", "-T"],
  env: ["-u", "-C", "--unset", "--chdir"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  nice: ["-n", "--adjustment"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  time: ["-o", "-f", "--output", "--format"],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"],
  xargs: ["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "--max-args", "--max-procs", "--arg-file", "--delimiter", "--max-lines", "--replace"],
};

/** Index of the first word that is the real command (after env assignments, keywords and wrappers with their options). */
function headIndex(words) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    const name = basename(word);
    if (/^[A-Za-z_]\w*=/.test(word) || KEYWORDS.has(word)) {
      index += 1;
      continue;
    }
    const withValue = Object.hasOwn(WRAPPER_VALUE_OPTIONS, name) ? WRAPPER_VALUE_OPTIONS[name] : null;
    if (!withValue || (name === "command" && /^-[a-zA-Z]*[vV]/.test(words[index + 1] ?? ""))) break; // `command -v x` only looks up
    index += 1;
    while (index < words.length && /^-./.test(words[index])) {
      const option = words[index];
      index += withValue.includes(option) ? 2 : 1;
      if (option === "--") break;
    }
    if (name === "timeout" && index < words.length) index += 1; // the duration
  }
  return index;
}

/** `env -S 'cmd args'` / `--split-string=…`: the string's words take its place. */
function splitEnvStrings(words) {
  const out = [];
  const split = (text) => text.trim().split(/\s+/);
  let inEnv = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (inEnv && (word === "-S" || word === "--split-string") && words[index + 1] !== undefined) {
      out.push(...split(words[(index += 1)]));
      continue;
    }
    const inline = inEnv ? /^(?:-S|--split-string=)(.+)$/s.exec(word) : null;
    if (inline) {
      out.push(...split(inline[1]));
      continue;
    }
    out.push(word);
    if (basename(word) === "env") inEnv = true;
    else if (!word.startsWith("-") && !/^[A-Za-z_]\w*=/.test(word)) inEnv = false;
  }
  return out;
}

/** Removes `git -C dir`, `--git-dir=...`, `-c k=v` and friends so that `git -C x push` == `git push`. */
function normalizeGit(words, head) {
  const out = words.slice(0, head);
  out.push("git");
  let index = head + 1;
  while (index < words.length && words[index].startsWith("-")) {
    index += GIT_OPTIONS_WITH_VALUE.has(words[index]) ? 2 : 1;
  }
  return [...out, ...words.slice(index)];
}

/** `//*`, `/./`, `/tmp/../`, `~/./` -> `/*`, `/`, `/`, `~`: one spelling per path for the hard-deny globs. */
function normalizeTarget(target) {
  if (!target.includes("/")) return target;
  const normalized = path.posix.normalize(target);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** `rm -r -f /`, `rm -rf -- /`, `rm --recursive --force /` -> `rm -rf /` so the hard-deny globs see one form. */
function normalizeRm(words, head) {
  if (basename(words[head]) !== "rm") return words;
  let recursive = false;
  let force = false;
  let optionsEnded = false;
  const targets = [];
  for (const word of words.slice(head + 1)) {
    if (!optionsEnded && word === "--") optionsEnded = true;
    else if (!optionsEnded && word.startsWith("--")) {
      recursive ||= word === "--recursive";
      force ||= word === "--force";
    } else if (!optionsEnded && /^-[A-Za-z]+$/.test(word)) {
      recursive ||= /[rR]/.test(word);
      force ||= word.includes("f");
    } else targets.push(word);
  }
  return recursive && force ? [...words.slice(0, head), "rm", "-rf", ...targets.map(normalizeTarget)] : words;
}

const normalizeWords = (words, head) => (basename(words[head]) === "git" ? normalizeGit(words, head) : normalizeRm(words, head));

const REDIRECT_OPERATOR_RE = /^\d*(?:>>?|<<?<?|&>>?)&?\d*$/;

/** A quoted multi-word argument is prose, unless it is (part of) a redirect target: `> "a b/.ssh/key"`. */
function isProse(word, previous) {
  if (!word.quoted || !/\s/.test(word.value)) return false;
  return !(/^\d*[<>&]/.test(word.value) || (previous && REDIRECT_OPERATOR_RE.test(previous.value)));
}

/** Heads whose quoted prose arguments are data, never commands (see spec: echo, git commit -m "...", ...). */
function isNonExecuting(words, head, segment) {
  if (/<<|`|\$\(/.test(segment) || segment.includes(SUBST)) return false;
  const command = basename(words[head]);
  if (NON_EXEC_HEADS.has(command)) return true;
  if (command === "git") return NON_EXEC_GIT.has(normalizeGit(words, head)[head + 1]);
  return command === "gh" && ["pr", "issue"].includes(words[head + 1]) && ["create", "comment"].includes(words[head + 2]);
}

/** A shell invoked without -c and without a script file reads its program from stdin / a heredoc. */
function readsStdin(words, head) {
  const rest = words.slice(head + 1);
  return rest.includes("-s") || readsStdinScript(rest) || !rest.some((word) => !word.startsWith("-") && !/^\d*[<>]/.test(word));
}

const DANGEROUS_GIT_CONFIG_RE =
  /^(?:alias\.[^=]*=!|core\.(?:pager|sshcommand|fsmonitor|editor|hookspath|askpass)=|sequence\.editor=|diff\.external=|credential\.helper=|gpg\.program=)/i;
const DANGEROUS_SUBCOMMAND_OPTION = {
  grep: /^(?:-O|--open-files-in-pager)(?![\w-])|^-O./,
  log: /^--output(?:=|$)/,
  diff: /^--output(?:=|$)/,
  show: /^--output(?:=|$)/,
};

/** git options that run a program or write a file: `-c alias.x=!cmd`, `-c core.pager=...`, `grep -O`, `log --output`. */
function hasDangerousGitOption(words, head) {
  let index = head + 1;
  while (index < words.length && words[index].startsWith("-")) {
    const option = words[index];
    let config;
    if (option === "-c" || option === "--config-env") config = words[index + 1];
    else if (option.startsWith("--config-env=")) config = option.slice("--config-env=".length);
    else if (option.startsWith("-c") && !option.startsWith("--")) config = option.slice(2);
    if (config !== undefined && (DANGEROUS_GIT_CONFIG_RE.test(config) || config.includes(UNKNOWN))) return true;
    if (option.startsWith("--exec-path=") && option.includes(UNKNOWN)) return true;
    index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  const pattern = DANGEROUS_SUBCOMMAND_OPTION[words[index]];
  return Boolean(pattern) && words.slice(index + 1).some((word) => pattern.test(word));
}

const DECLARE = new Set(["export", "local", "readonly", "declare", "typeset"]);
const ASSIGNMENT_RE = /^([A-Za-z_]\w*)=(.*)$/s;
const UNRESOLVABLE_VALUE_RE = /[$`'"\\\n\u0001\u0002\u0003\u0004]/;
const VAR_REF_RE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
// Interpreters that read their program from stdin when given no script (a heredoc body is then their code), by eval language.
const INTERPRETER_LANGUAGE = {
  python: "python", node: "js", bun: "js", deno: "js", ruby: "ruby", perl: "perl", php: "php", osascript: "applescript", lua: "lua", swift: "swift",
};
const interpreterOf = (command) => INTERPRETER_LANGUAGE[/^python[\d.]*$/.test(command) ? "python" : /^lua[\d.]*$/.test(command) ? "lua" : command];
// Option that carries inline code, per interpreter.
const CODE_FLAGS = {
  python: ["-c"], js: ["-e", "--eval", "-p", "--print"], ruby: ["-e"], perl: ["-e", "-E"], php: ["-r"], applescript: ["-e"], lua: ["-e"], swift: ["-e"],
};
const STDIN_SCRIPTS = new Set(["-", "/dev/stdin", "/dev/fd/0"]);
// Environment variables whose value git, ssh or an editor runs as a command.
const COMMAND_ENV = new Set([
  "GIT_SSH_COMMAND", "GIT_SSH", "GIT_PAGER", "GIT_EDITOR", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "GIT_PROXY_COMMAND", "SSH_ASKPASS", "EDITOR", "VISUAL", "PAGER", "BASH_ENV",
]);
const SSH_OPTIONS_WITH_VALUE = new Set(["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
const SSHPASS_OPTIONS_WITH_VALUE = new Set(["-p", "-f", "-d", "-P"]);
// ssh -o options whose value ssh runs: on this machine, or (RemoteCommand) on the host.
const SSH_COMMAND_OPTION_RE = /^(ProxyCommand|LocalCommand|KnownHostsCommand|RemoteCommand)\s*[= ]\s*([\s\S]+)$/i;
const DOCKER_EXEC_OPTIONS_WITH_VALUE = new Set(["-u", "--user", "-e", "--env", "-w", "--workdir", "--env-file", "--detach-keys"]);
const REMOTE_EXEC = new Set(["exec", "execute"]);
const SOURCE_HEADS = new Set(["source", "."]);
// Consumers that only read a quoted, top-level heredoc as data.
const DATA_CONSUMERS = new Set(["cat", "tee", "grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "jq", "wc", "sort", "uniq", "head", "tail", "diff"]);

/** Fresh per-command context: heredoc bodies, variables assigned a literal earlier in the command, paths for checks. */
function newContext(where, bodies = []) {
  return { ...where, bodies, vars: new Map() };
}

/** `$NAME` / `${NAME}` whose every assignment so far in the command was the same literal -> that literal. */
function resolveVariables(segment, ctx) {
  if (ctx.vars.size === 0 || !segment.includes("$")) return segment;
  return segment.replace(VAR_REF_RE, (match, braced, bare) => ctx.vars.get(braced ?? bare) ?? match);
}

/** Records `NAME=literal` (bare or after export/local/…); a name also set otherwise (another value, for, read) never resolves. */
function recordAssignments(words, head, ctx) {
  const unknown = (name) => ctx.vars.set(name, null);
  let candidates = [];
  if (head >= words.length) candidates = words;
  else if (DECLARE.has(words[head])) candidates = words.slice(head + 1);
  else if (words[head] === "for" && words[head + 1]) unknown(words[head + 1]);
  else if (words[head] === "read") words.slice(head + 1).forEach(unknown);
  for (const word of candidates) {
    const match = ASSIGNMENT_RE.exec(word);
    if (!match) continue;
    const [, name, value] = match;
    if (UNRESOLVABLE_VALUE_RE.test(value) || (ctx.vars.has(name) && ctx.vars.get(name) !== value)) unknown(name);
    else ctx.vars.set(name, value);
  }
}

const DOCKER_VOLUME_OPTIONS = new Set(["-v", "--volume", "--mount"]);

/** `docker run|create` / `docker compose run` bind-mount sources that expose /, the home dir, ~/.omo, ~/Library/LaunchAgents or the agent dir. */
function dockerMountReason(words, head, ctx) {
  const tool = basename(words[head]);
  let start;
  if (tool === "docker-compose" || (tool === "docker" && words[head + 1] === "compose")) start = words.indexOf("run", head + 1) + 1;
  else if (tool === "docker") {
    const at = words[head + 1] === "container" ? head + 2 : head + 1;
    start = words[at] === "run" || words[at] === "create" ? at + 1 : 0;
  } else return null;
  if (start <= 0) return null;
  const home = ctx.home.replace(/\/+$/, "");
  const guarded = [`${home}/.omo`, `${home}/Library/LaunchAgents`, ...(ctx.agentDir ? [ctx.agentDir] : [])].map((dir) => path.posix.normalize(dir).replace(/\/+$/, ""));
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    const [option, inline] = word.includes("=") && word.startsWith("-") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
    if (!DOCKER_VOLUME_OPTIONS.has(option) && !/^-v./.test(word)) continue;
    const value = /^-v./.test(word) && option === word ? word.slice(2) : (inline ?? words[(index += 1)] ?? "");
    const source = option === "--mount" ? /(?:^|,)(?:source|src)=([^,]+)/.exec(value)?.[1] : value.includes(":") ? value.slice(0, value.indexOf(":")) : undefined;
    if (!source) continue;
    let resolved = source.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home).replace(/^(?:\$PWD|\$\{PWD\})(?=\/|$)/, ctx.cwd || ".");
    if (!resolved.startsWith("/")) {
      if (!/^\.{1,2}(\/|$)/.test(resolved) || !ctx.cwd.startsWith("/")) continue; // named volume or unknown base
      resolved = path.posix.join(ctx.cwd, resolved);
    }
    const mount = path.posix.normalize(resolved).replace(/(.)\/+$/, "$1");
    const hit = mount === "/" || guarded.some((dir) => dir === mount || dir.startsWith(`${mount}/`) || mount.startsWith(`${dir}/`));
    if (hit) return `docker-mount: docker mounts ${source} (home, /, ~/.omo, LaunchAgents or the agent dir)`;
  }
  return null;
}

/** `ssh [opts] host [cmd…]`, also behind `sshpass [opts]`: { remote: words ([] for none) | null when not ssh, local: commands ssh runs here }. */
function sshParts(words, head) {
  const local = [];
  let index = head;
  if (basename(words[index]) === "sshpass") {
    index += 1;
    while (words[index]?.startsWith("-")) index += SSHPASS_OPTIONS_WITH_VALUE.has(words[index]) ? 2 : 1;
  }
  if (basename(words[index] ?? "") !== "ssh") return { remote: null, local };
  index += 1;
  let remoteCommand = null;
  while (words[index]?.startsWith("-")) {
    const option = words[index];
    const value = option === "-o" ? words[index + 1] : option.startsWith("-o") ? option.slice(2) : undefined;
    const command = value === undefined ? null : SSH_COMMAND_OPTION_RE.exec(value);
    if (command && /^RemoteCommand$/i.test(command[1])) remoteCommand = command[2];
    else if (command) local.push(command[2]);
    index += SSH_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  if (index >= words.length) return { remote: null, local };
  return { remote: [...(remoteCommand === null ? [] : [remoteCommand]), ...withoutRedirects(words.slice(index + 1))], local };
}

/** Words minus local redirections (heredocs, `< file`, `2>&1`, `> out`): they are not part of a wrapped command. */
function withoutRedirects(words) {
  const kept = [];
  for (let at = 0; at < words.length; at += 1) {
    if (/^\d*(?:>>?|<|<<<|&>>?)$/.test(words[at])) at += 1; // operator; its target is the next word
    else if (!/^\d*(?:[<>]|&>)/.test(words[at])) kept.push(words[at]);
  }
  return kept;
}

/** `docker exec [opts] container cmd…` / `kubectl exec … [--] cmd…`: the command words, or null. */
function containerCommand(words, head) {
  if (basename(words[head]) === "kubectl") {
    const dashes = words.indexOf("--", head + 2);
    return dashes > 0 ? words.slice(dashes + 1) : null;
  }
  let index = head + 2;
  while (words[index]?.startsWith("-")) index += DOCKER_EXEC_OPTIONS_WITH_VALUE.has(words[index]) ? 2 : 1;
  return index + 1 < words.length ? words.slice(index + 1) : null;
}

/** The command words a wrapper (ssh, `remote-exec`, `docker|kubectl exec`) runs: { inner, remote } or null. */
function wrappedCommand(words, head) {
  const command = basename(words[head]);
  const ssh = sshParts(words, head);
  if (ssh.remote) return { inner: ssh.remote, remote: "ssh" };
  if (command === "remote-exec" && REMOTE_EXEC.has(words[head + 1])) return { inner: withoutRedirects(words.slice(head + 2)), remote: "remote-exec" };
  if ((command === "docker" || command === "kubectl") && words[head + 1] === "exec") {
    const inner = containerCommand(words, head);
    return inner && { inner: withoutRedirects(inner), remote: "container" };
  }
  return null;
}

const readsStdinScript = (rest) => rest.some((word) => STDIN_SCRIPTS.has(word));

/** sed without an `e`/`w` command, awk without system()/pipes/getline: they only read their input. */
function isDataConsumer(words, head) {
  const command = basename(words[head]);
  const args = words.slice(head + 1);
  if (command === "git") {
    const rest = normalizeGit(words, head).slice(head + 1);
    return rest[0] === "commit" && rest.some((word, at) => ((word === "-F" || word === "--file") && STDIN_SCRIPTS.has(rest[at + 1])) || word === "--file=-");
  }
  if (!DATA_CONSUMERS.has(command)) return false;
  if (command === "sed") return !args.some((word) => !/^-[nErsuz]+$/.test(word) && /(^|[^A-Za-z\\])[ew]([^A-Za-z]|$)/.test(word));
  if (command === "awk" || command === "gawk") return !args.some((word) => /system|getline|\|/.test(word));
  return true;
}

/**
 * Who reads this segment's stdin, through ssh / `remote-exec` / `docker|kubectl exec`:
 * { kind: "shell" | "code" | "data" | "other", language?, remote, login? }.
 */
function stdinConsumer(words, head, remote = null) {
  const wrapped = wrappedCommand(words, head);
  if (wrapped) {
    // ssh and remote-exec hand one command line to a remote shell; docker/kubectl exec pass argv as is.
    const inner = wrapped.remote === "container" ? wrapped.inner : shellWordsDetailed(wrapped.inner.join(" ")).map((word) => word.value);
    const innerHead = headIndex(inner);
    const via = wrapped.remote ?? remote;
    // `ssh host` alone is a login shell reading stdin; a wrapped command that is only wrappers (`docker exec c env`) is not.
    if (innerHead >= inner.length) return wrapped.remote === "ssh" && inner.length === 0 ? { kind: "shell", remote: via, login: true } : { kind: "other", remote: via };
    return stdinConsumer(inner, innerHead, via);
  }
  const command = basename(words[head]);
  const rest = words.slice(head + 1);
  if (SHELLS.has(command)) return { kind: readsStdin(words, head) ? "shell" : "other", remote };
  const language = interpreterOf(command);
  if (language) {
    const reads = readsStdinScript(rest) || rest.every((word) => /^\d*[<>]/.test(word));
    return { kind: reads ? "code" : "other", language, remote };
  }
  return { kind: isDataConsumer(words, head) ? "data" : "other", remote };
}

/** Text the segment feeds to stdin: heredoc bodies { text, quoted, clean } and here-strings (substitutions already split out). */
function stdinFeeds(segment, words, ctx) {
  const feeds = [...segment.matchAll(HEREDOC_TOKEN_RE)].map((match) => ctx.bodies[Number(match[1])]).filter(Boolean);
  words.forEach((word, index) => {
    if (word === "<<<" && words[index + 1] !== undefined) feeds.push({ text: words[index + 1], quoted: true, clean: true });
    else if (word.startsWith("<<<") && word.length > 3) feeds.push({ text: word.slice(3), quoted: true, clean: true });
  });
  return feeds;
}

/** Leaves of a program run on another host (ssh, remote-exec) or here (remote null); a remote one also gets a whole-script leaf. */
function programLeaves(text, remote, depth, ctx) {
  const here = ctx.cd;
  if (remote) ctx.cd = undefined; // another host or container starts in a directory we do not know
  const leaves = expand(text, depth + 1, ctx);
  ctx.cd = here;
  if (!remote) return leaves;
  // A container reached through ssh/remote-exec is judged as that host's command (remote-exec trust and remote checks included).
  const label = (leaf) => (leaf.remote === "container" && remote !== "container" ? remote : (leaf.remote ?? remote));
  return [...leaves.map((leaf) => ({ ...leaf, remote: label(leaf) })), { script: true, text, remote }];
}

/** Leaves of code given to an interpreter: its literal shell commands; unreadable process calls go to `forced`. */
function codeLeaves(language, code, remote, depth, ctx, forced) {
  const scanned = scanCode(language, code);
  if (scanned.unparsed) forced.push(`unparsed-code: ${language} code calls a process that cannot be read statically`);
  return scanned.commands.flatMap((inner) => programLeaves(inner, remote, depth, ctx));
}

/** rm -r and find -delete / -exec rm: { destructive, texts } with one `rm -rf <t>` / `find <t> -delete` text per normalised target. */
function destructiveTargetTexts(words, head, cd) {
  const command = basename(words[head]);
  // A relative target after `cd <known dir>` in the same command is that dir's child (`cd / && rm -rf *` -> `rm -rf /*`).
  const resolve = (target) => normalizeTarget(cd && !/^[/~$]/.test(target) ? path.posix.join(cd, target) : target);
  if (command === "rm") {
    let recursive = false;
    let optionsEnded = false;
    const targets = [];
    for (const word of words.slice(head + 1)) {
      if (!optionsEnded && word === "--") optionsEnded = true;
      else if (!optionsEnded && word.startsWith("--")) recursive ||= word === "--recursive";
      else if (!optionsEnded && /^-[A-Za-z]+$/.test(word)) recursive ||= /[rR]/.test(word);
      else if (!/^\d*[<>]/.test(word)) targets.push(word);
    }
    return { destructive: recursive, texts: recursive ? targets.map((target) => `rm -rf ${resolve(target)}`) : [] };
  }
  if (command === "find") {
    let index = head + 1;
    while (/^-[HLP]$|^-O\d*$|^-D$/.test(words[index] ?? "")) index += words[index] === "-D" ? 2 : 1;
    const targets = [];
    while (index < words.length && !/^[-(!]/.test(words[index])) targets.push(words[(index += 1) - 1]);
    const expression = words.slice(index);
    const deletes = expression.includes("-delete") || expression.some((word, at) => /^-(exec|execdir|ok|okdir)$/.test(word) && basename(expression[at + 1] ?? "") === "rm");
    return { destructive: deletes, texts: deletes ? (targets.length > 0 ? targets : ["."]).map((target) => `find ${resolve(target)} -delete`) : [] };
  }
  return { destructive: false, texts: [] };
}

/** `cd`/`pushd` to a known directory (absolute, ~, $HOME, or relative to a known one) -> ctx.cd; anything else -> unknown. */
function trackDirectory(words, head, ctx) {
  const target = words.slice(head + 1).find((word) => !word.startsWith("-")) ?? "~";
  const absolute = /^(?:~|\$HOME|\$\{HOME\})(?:\/|$)|^\//.test(target);
  // A directory an eval interpolated stays unknown, and so does every relative path under it.
  if (target.includes(UNKNOWN) || (ctx.cd?.includes(UNKNOWN) && !absolute)) ctx.cd = UNKNOWN;
  else if (absolute) ctx.cd = target;
  else ctx.cd = ctx.cd && !/[$`\u0001\u0003]/.test(target) ? path.posix.join(ctx.cd, target) : undefined;
}

const NETWORK_HEADS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "sshpass", "nc", "ncat", "netcat", "socat", "telnet", "ftp"]);
const WRITE_HEADS = new Set(["mv", "tee", "dd"]);
const RECURSIVE_MODE_HEADS = new Set(["chmod", "chown", "chgrp"]);

/** `scheme://host[:port]/…` whose host is not an interpolated value (the port and path may be). */
function knownHostUrl(word) {
  const authority = /^[a-z][\w+.-]*:\/\/([^/?#]*)/i.exec(word)?.[1];
  return authority !== undefined && /^[^\s:@\u0004]+(?::[^@]*)?$/.test(authority);
}

/** Targets of `>`/`>>`/`&>` redirections among the words. */
function writeRedirectTargets(words) {
  const targets = [];
  words.forEach((word, at) => {
    if (/^\d*(?:>>?|&>>?)\|?$/.test(word)) targets.push(words[at + 1] ?? "");
    else {
      const inline = /^\d*(?:>>?|&>>?)\|?(.+)$/.exec(word)?.[1];
      if (inline && !inline.startsWith("&")) targets.push(inline);
    }
  });
  return targets;
}

/**
 * Where an eval-interpolated value makes a delete, write or network target unknown: { deleted, written, host } flags.
 * Deletes (rm, rm -r, find -delete) also count a relative path under a directory such a value led to (`cd ${d} && rm -rf x`).
 */
function unknownTargets(words, head, ctx, destructive) {
  const command = basename(words[head]);
  const args = words.slice(head + 1);
  const operands = withoutRedirects(args);
  const unknownCwd = Boolean(ctx.cd?.includes(UNKNOWN));
  const deletes = destructive || command === "rm";
  const deleted = deletes && operands.some((word) => word.includes(UNKNOWN) || (unknownCwd && !/^[-/~$]/.test(word)));
  let written = writeRedirectTargets(args).some((word) => word.includes(UNKNOWN));
  if (WRITE_HEADS.has(command)) written ||= operands.some((word) => word.includes(UNKNOWN));
  if (RECURSIVE_MODE_HEADS.has(command) && operands.some((word) => /^-[a-zA-Z]*R/.test(word) || word === "--recursive")) written ||= operands.some((word) => word.includes(UNKNOWN));
  if (command === "cp") {
    const flag = operands.findIndex((word) => word === "-t" || word === "--target-directory");
    const inline = operands.find((word) => word.startsWith("--target-directory="));
    written ||= (flag >= 0 ? (operands[flag + 1] ?? "") : (inline ?? operands.at(-1) ?? "")).includes(UNKNOWN);
  }
  const host = NETWORK_HEADS.has(command) && args.some((word) => word.includes(UNKNOWN) && !knownHostUrl(word));
  return { deleted, written, host };
}

/** Raw segment -> list of leaf commands { text, texts, matchTexts, helpOnly, dynamic, forced, remote, … }. */
function analyzeSegment(rawSegment, depth, ctx) {
  const segment = resolveVariables(rawSegment, ctx);
  const detailed = shellWordsDetailed(segment);
  const words = splitEnvStrings(detailed.map((word) => word.value));
  const head = headIndex(words);
  recordAssignments(words, head, ctx);
  const nested = [];
  const forced = [];
  // Values git/ssh/editors run as commands: `GIT_SSH_COMMAND=… git`, `export GIT_PAGER=…`.
  const assignments = head >= words.length ? words : DECLARE.has(words[head]) ? words.slice(head + 1) : words.slice(0, head);
  for (const word of assignments) {
    const assignment = ASSIGNMENT_RE.exec(word);
    if (assignment && COMMAND_ENV.has(assignment[1]) && assignment[2] && depth < MAX_DEPTH) nested.push(...expand(assignment[2], depth + 1, ctx));
  }
  if (head >= words.length) return nested;
  const command = basename(words[head]);
  if (depth < MAX_DEPTH) {
    // stdin: a quoted heredoc at top level read by a data-only consumer is data; anything else runs (fail closed).
    const consumer = stdinConsumer(words, head);
    const feeds = stdinFeeds(segment, words, ctx);
    for (const feed of feeds) {
      if (feed.quoted && feed.clean && consumer.kind === "data") continue;
      if (consumer.kind === "code") nested.push(...codeLeaves(consumer.language, feed.text, consumer.remote, depth, ctx, forced));
      else nested.push(...programLeaves(feed.text, consumer.remote, depth, ctx));
    }
    const readsProgram = consumer.kind === "shell" || consumer.kind === "code";
    if (readsProgram && feeds.length === 0 && !consumer.login) forced.push(`stdin-program: ${command} runs a program read from stdin`);
    const ssh = sshParts(words, head);
    for (const local of ssh.local) nested.push(...expand(local, depth + 1, ctx));
    const wrapped = wrappedCommand(words, head);
    // The wrapped command itself (unless it is just the stdin reader of a fed program, e.g. `ssh h bash -s <<EOF`).
    if (wrapped && wrapped.inner.length > 0 && !(readsProgram && feeds.length > 0)) {
      // ssh/remote-exec hand over one command line; a container gets argv (re-quoted so it parses back to the same words).
      const line = wrapped.remote === "container" ? wrapped.inner.map(shellQuote).join(" ") : wrapped.inner.join(" ");
      nested.push(...programLeaves(line, wrapped.remote, depth, ctx));
    }
    if (SHELLS.has(command)) {
      const flagIndex = words.findIndex((word, position) => position > head && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
      if (flagIndex >= 0 && words[flagIndex + 1] !== undefined) return [...nested, ...expand(words[flagIndex + 1], depth + 1, ctx)];
    }
    if (command === "eval" && words.length > head + 1) return [...nested, ...expand(words.slice(head + 1).join(" "), depth + 1, ctx)];
    const language = interpreterOf(command);
    const codeFlag = language ? words.findIndex((word, position) => position > head && CODE_FLAGS[language].includes(word)) : -1;
    const code = codeFlag > 0 ? words[codeFlag + 1] : language === "js" && words[head + 1] === "eval" ? words[head + 2] : undefined;
    if (language && code !== undefined) {
      // Code built by the shell (`-c "$(…)"`, `-c "$VAR"`) cannot be read; literal code is scanned like eval.
      if (/[\u0001\u0003\u0004]/.test(code) || /^\$\{?\w+\}?$/.test(code.trim())) forced.push(`dynamic-code: ${command} runs code produced by the shell`);
      // Literal inline code: Python/JS are read like eval; other languages keep the plain text checks (`perl -pi -e 's/…/'`).
      else if (language === "python" || language === "js") nested.push(...codeLeaves(language, code, null, depth, ctx, forced));
    }
    if ((SHELLS.has(command) || SOURCE_HEADS.has(command) || language) && words.slice(head + 1).some((word) => word.includes(PROC_SUBST))) {
      forced.push("process-substitution: runs a program produced by another command");
    }
  }
  const normalized = normalizeWords(words, head);
  const { destructive, texts: targetTexts } = destructiveTargetTexts(words, head, ctx.cd);
  const unknown = unknownTargets(words, head, ctx, destructive);
  if (unknown.deleted) forced.push("unknown-target: deletes a path the eval code computes (not known statically)");
  if (unknown.written) forced.push("unknown-target: writes to a path the eval code computes (not known statically)");
  if (command === "cd" || command === "pushd") trackDirectory(words, head, ctx);
  if (destructive && words.slice(0, head).some((word) => basename(word) === "xargs")) {
    forced.push("xargs: rm -r / find -delete get their targets from stdin (unknown)");
  }
  const kept = isNonExecuting(words, head, segment)
    ? detailed.filter((word, position) => position <= head || !isProse(word, detailed[position - 1])).map((word) => word.value)
    : words;
  const matchWords = kept === words ? normalized : normalizeWords(kept, head);
  const unique = (items) => [...new Set(items)];
  return [
    ...nested,
    {
      text: normalized.join(" "),
      // What the rules see: the command as written, without its wrappers, and once per destructive target.
      texts: unique([normalized.join(" "), normalized.slice(head).join(" "), ...targetTexts]),
      matchTexts: unique([matchWords.join(" "), matchWords.slice(head).join(" "), ...targetTexts]),
      raw: words.map(shellQuote).join(" "),
      helpOnly: words.includes("--help"),
      gitDanger: command === "git" && hasDangerousGitOption(words, head),
      // An interpolated value as the command, as git's subcommand or as the command `find -exec` runs.
      dynamic:
        words[head].startsWith("$") ||
        words[head].startsWith(SUBST) ||
        words[head].includes(UNKNOWN) ||
        (command === "git" && (normalizeGit(words, head)[head + 1] ?? "").includes(UNKNOWN)) ||
        (command === "find" && words.some((word, at) => /^-(exec|execdir|ok|okdir)$/.test(word) && (words[at + 1] ?? "").includes(UNKNOWN))),
      unknownHost: unknown.host,
      forced,
      remote: null,
      dockerMount: dockerMountReason(words, head, ctx),
    },
  ];
}

function expand(command, depth, ctx) {
  return splitSegments(stripHeredocs(command, ctx), depth).flatMap((segment) => analyzeSegment(segment, depth, ctx));
}

// ---------- eval (JS / Python) scanning ----------

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

/**
 * Reads a JS string/template literal starting at `start`. Returns { end, value, dynamic }: each `${expr}` is the literal a
 * `resolve(name)` gives, else UNKNOWN; `dynamic` when an interpolation is not a plain value (see interpolated).
 * `raw` (a String.raw template) keeps every backslash sequence as written.
 */
function readString(code, start, resolve, raw = false) {
  const quote = code[start];
  let value = "";
  let dynamic = false;
  let index = start + 1;
  for (; index < code.length; index += 1) {
    const char = code[index];
    if (char === "\\" && raw) value += char + (code[(index += 1)] ?? "");
    else if (char === "\\") {
      const next = code[(index += 1)];
      if (next === "x") { value += String.fromCharCode(parseInt(code.slice(index + 1, index + 3), 16)); index += 2; }
      else if (next === "u") { value += String.fromCharCode(parseInt(code.slice(index + 1, index + 5), 16)); index += 4; }
      else if (next === "\n") continue;
      else value += ESCAPES[next] ?? next;
    } else if (char === quote) return { end: index, value, dynamic };
    else if (quote === "`" && char === "$" && code[index + 1] === "{") {
      const close = skipBalanced(code, index + 2, "{", "}");
      const part = interpolated(code.slice(index + 2, close), resolve);
      dynamic ||= part === null;
      value += part ?? UNKNOWN;
      index = close;
    } else value += char;
  }
  return { end: index, value, dynamic };
}

// Values the shell checks already know by name: the home dir (`rm -rf $HOME`, docker mounts) and the working dir.
const KNOWN_VALUES = {
  "os.homedir()": "$HOME", "homedir()": "$HOME", "process.env.HOME": "$HOME", "Bun.env.HOME": "$HOME", "process.cwd()": "$PWD",
};
const PLAIN_VALUE_RE = /^(?:await\s+)?[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\??\.?\s*(?:\(\)|\[\]))*$|^\d+(?:\.\d+)?$/;

/**
 * An interpolated expression -> the string it stands for: a name's literal (resolve), UNKNOWN for any other plain value
 * (a name, member chain, call or index without string literals), or null when it is not plain (`a ? "x" : y`, `a + b`).
 */
function interpolated(expression, resolve) {
  let text = expression.trim();
  const known = KNOWN_VALUES[text.replace(/\s+/g, "")];
  if (known) return known;
  if (/["'`]/.test(text)) return null;
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/\([^()[\]]*\)/g, "()").replace(/\[[^()[\]]*\]/g, "[]");
  }
  if (!PLAIN_VALUE_RE.test(text)) return null;
  const constant = /^[A-Za-z_$][\w$]*$/.test(text) ? resolve?.(text) : undefined;
  return constant ?? UNKNOWN;
}

/** `code` of the same length with comments, string contents and template text blanked; `${…}` expressions are kept. */
function codeSkeleton(code) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  let out = "";
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    if (char === "/" && (next === "/" || next === "*")) {
      const stop = next === "/" ? code.indexOf("\n", index) : code.indexOf("*/", index + 2);
      const end = stop < 0 ? code.length : next === "/" ? stop : stop + 2;
      out += blank(code.slice(index, end));
      index = end;
    } else if (char === '"' || char === "'") {
      const end = readString(code, index).end;
      out += char + blank(code.slice(index + 1, end)) + code.slice(end, end + 1);
      index = end + 1;
    } else if (char === "`") {
      out += char;
      for (index += 1; index < code.length && code[index] !== "`"; ) {
        if (code[index] === "\\") {
          out += blank(code.slice(index, index + 2));
          index += 2;
        } else if (code[index] === "$" && code[index + 1] === "{") {
          const close = skipBalanced(code, index + 2, "{", "}");
          out += `\${${codeSkeleton(code.slice(index + 2, close))}${code.slice(close, close + 1)}`;
          index = close + 1;
        } else out += blank(code[(index += 1) - 1]);
      }
      out += code.slice(index, index + 1);
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** A string literal without interpolations -> its value; null otherwise. */
function plainLiteral(text) {
  if (!/^["'`]/.test(text)) return null;
  const literal = readString(text, 0);
  return literal.end === text.length - 1 && !literal.dynamic && !literal.value.includes(UNKNOWN) ? literal.value : null;
}

/**
 * The string an initializer at `at` always evaluates to -> { value, end }, or null: a string or template literal (String.raw
 * included; interpolations as readString resolves them, none dynamic) or a resolvable name, then any number of
 * `.replace` / `.replaceAll` with two plain literals, run as JS runs them, on a value with no unknown part (a match inside
 * a computed value would move the replacement).
 */
function staticString(code, at, resolve) {
  let value;
  let end;
  const rawTag = /^String\.raw\s*`/.exec(code.slice(at, at + 24));
  if (rawTag || /["'`]/.test(code[at] ?? "")) {
    const literal = readString(code, rawTag ? at + rawTag[0].length - 1 : at, resolve, Boolean(rawTag));
    if (literal.dynamic || literal.end >= code.length) return null;
    value = literal.value;
    end = literal.end + 1;
  } else {
    const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(at))?.[0];
    value = name === undefined ? undefined : resolve(name);
    if (value === undefined) return null;
    end = at + name.length;
  }
  for (let call; (call = /^\s*\.\s*(replaceAll|replace)\s*\(/.exec(code.slice(end))); ) {
    const open = end + call[0].length - 1;
    const [pattern, replacement, ...rest] = splitArgs(code, open).map(plainLiteral);
    if (pattern == null || replacement == null || rest.length > 0 || value.includes(UNKNOWN)) return null;
    value = call[1] === "replaceAll" ? value.replaceAll(pattern, replacement) : value.replace(pattern, replacement);
    end = skipBalanced(code, open + 1, "(", ")") + 1;
  }
  return { value, end };
}

const CLOSER = { "(": ")", "[": "]", "{": "}" };
// eval, new Function and with can bind any name anew
const REBINDABLE_RE = /(?<![\w$.])(?:eval|Function|with)\s*\(/;

/** Every use of a name: not a property (`a.name`), a spread or rest (`...name`) included. */
const wordRe = (name) => new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${name.replaceAll("$", "\\$")}(?![\\w$])`, "g");

/** Bracket nesting depth of the skeleton at `index` (0: top level). */
const depthAt = (skeleton, index) => [...skeleton.slice(0, index)].reduce((sum, char) => sum + ("{([".includes(char) ? 1 : ")]}".includes(char) ? -1 : 0), 0);

/**
 * A use of a const that cannot bind it anew: not after a declaring keyword, not an assignment, update or for-in/of
 * target, and not inside a parameter list (`(…) =>`, `(…) {`) or a destructuring pattern (`{…} =`, `const […]`).
 */
function plainUse(skeleton, index, length) {
  if (/(?:(?<![\w$])(?:const|let|var|function|class)|\+\+|--|\.\.\.)\s*$/.test(skeleton.slice(Math.max(0, index - 16), index))) return false;
  if (/^\s*(?:(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?!=)|\+\+|--|(?:of|in)(?![\w$]))/.test(skeleton.slice(index + length, index + length + 16))) return false;
  for (let at = index - 1, depth = 0; at >= 0; at -= 1) {
    const char = skeleton[at];
    if (")]}".includes(char)) depth += 1;
    else if ("([{".includes(char) && depth > 0) depth -= 1;
    else if ("([{".includes(char)) {
      const close = skipBalanced(skeleton, at + 1, char, CLOSER[char]);
      if (close >= skeleton.length) return false;
      const after = skeleton.slice(close + 1, close + 40);
      if (char === "(" && /^\s*(?:=>|\{)/.test(after)) return false;
      if (char !== "(" && (/^\s*=(?![=>])/.test(after) || /(?<![\w$])(?:const|let|var)\s*$/.test(skeleton.slice(Math.max(0, at - 8), at)))) return false;
    }
  }
  return true;
}

/**
 * name -> the string it always holds, or undefined. The code declares it exactly once, at top level, with a static
 * initializer (staticString), and otherwise only interpolates it (`${name}`); a `const` may also be used as a plain value
 * (an argument, an array item, a `.replace` receiver) unless eval / Function / with could bind it anew.
 */
function constantResolver(code) {
  const skeleton = codeSkeleton(code);
  const rebindable = REBINDABLE_RE.test(skeleton);
  const resolving = new Set();
  const resolveName = (name) => {
    const id = name.replaceAll("$", "\\$");
    const declarations = [...skeleton.matchAll(new RegExp(`(?<![\\w$.])(const|let|var)\\s+${id}\\s*=(?![=>])\\s*`, "g"))];
    if (declarations.length !== 1) return undefined;
    const [declaration] = declarations;
    const at = declaration.index + declaration[0].length;
    if (depthAt(skeleton, declaration.index) !== 0) return undefined;
    const initializer = staticString(code, at, resolve);
    if (!initializer || !/^[ \t]*(?:[;,\n]|$)/.test(code.slice(initializer.end))) return undefined;
    const plainAllowed = declaration[1] === "const" && !rebindable;
    for (const use of skeleton.matchAll(wordRe(name))) {
      if (use.index >= declaration.index && use.index < at) continue;
      const wrapped = /\$\{\s*$/.test(skeleton.slice(Math.max(0, use.index - 64), use.index)) && /^\s*\}/.test(skeleton.slice(use.index + name.length));
      if (!wrapped && !(plainAllowed && plainUse(skeleton, use.index, name.length))) return undefined;
    }
    return initializer.value;
  };
  const resolve = (name) => {
    if (resolving.has(name)) return undefined;
    resolving.add(name);
    try {
      return resolveName(name);
    } finally {
      resolving.delete(name);
    }
  };
  return resolve;
}

/** Index of the closing char matching depth 1 opened before `from`; skips strings and comments. */
function skipBalanced(code, from, open, close) {
  let depth = 1;
  for (let index = from; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") index = readString(code, index).end;
    else if (char === "/" && code[index + 1] === "/") index = (code.indexOf("\n", index) + 1 || code.length) - 1;
    else if (char === "/" && code[index + 1] === "*") index = (code.indexOf("*/", index) + 1 || code.length) ;
    else if (char === open) depth += 1;
    else if (char === close && (depth -= 1) === 0) return index;
  }
  return code.length;
}

/** Splits the call arguments starting after `(` at `open`; returns trimmed top-level argument texts. */
function splitArgs(code, open) {
  const args = [];
  let depth = 0;
  let begin = open + 1;
  for (let index = open + 1; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") index = readString(code, index).end;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) { args.push(code.slice(begin, index).trim()); return args.filter(Boolean); }
      depth -= 1;
    } else if (char === "," && depth === 0) { args.push(code.slice(begin, index).trim()); begin = index + 1; }
  }
  return args.filter(Boolean);
}

/** Top-level `+` terms of an expression (strings and brackets respected). */
function sumTerms(text) {
  const terms = [];
  let depth = 0;
  let begin = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") index = readString(text, index).end;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "+" && depth === 0) {
      terms.push(text.slice(begin, index).trim());
      begin = index + 1;
    }
  }
  return [...terms, text.slice(begin).trim()];
}

/**
 * String literal, or a `+` concatenation with at least one (a name `resolve` knows counts as one), -> { value, dynamic };
 * a plain non-literal term is interpolated like `${term}`. null when not such an expression.
 */
function literalValue(text, resolve) {
  let value = "";
  let dynamic = false;
  let literal = false;
  for (const term of sumTerms(text.trim())) {
    if (/^["'`]/.test(term)) {
      const read = readString(term, 0, resolve);
      if (read.end !== term.length - 1) return null;
      value += read.value;
      dynamic ||= read.dynamic;
      literal = true;
    } else {
      const constant = /^[A-Za-z_$][\w$]*$/.test(term) ? resolve?.(term) : undefined;
      const part = constant ?? interpolated(term, resolve);
      if (part === null) return null;
      value += part;
      literal ||= constant !== undefined;
    }
  }
  return literal ? { value, dynamic } : null;
}

const shellQuote = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * `["git","push"]` -> { text: "git push", dynamic }; an element that is a plain value (`["git", "-C", repo]`) is an
 * unknown value, as `${repo}` is in a template. null when any element is neither (a spread, a ternary, …).
 */
function arrayCommand(text, resolve) {
  const items = arrayItems(text, resolve);
  if (!items || items.length === 0) return null;
  return { text: items.map((item) => shellQuote(item.value)).join(" "), dynamic: items.some((item) => item.dynamic) };
}

/** Elements of an array literal as { value, dynamic } (a spread array literal `...[…]` inlined), or null. */
function arrayItems(text, resolve) {
  if (!text.startsWith("[")) return null;
  const plainItem = (item) => {
    const part = interpolated(item, resolve);
    return part === null ? null : { value: part, dynamic: false };
  };
  const items = splitArgs(text, 0).flatMap((item) => (item.startsWith("...[") ? (arrayItems(item.slice(3), resolve) ?? [null]) : [literalValue(item, resolve) ?? plainItem(item)]));
  return items.some((item) => item === null) ? null : items;
}

/** Value of `key: <literal>` in an object-literal argument. */
function objectProperty(text, key) {
  if (!text.startsWith("{")) return undefined;
  for (const part of splitArgs(text, 0)) {
    const match = /^["']?(\w+)["']?\s*:\s*([\s\S]*)$/.exec(part);
    if (match && match[1] === key) return match[2];
  }
  return undefined;
}

const CALL_RE =
  /(?<![\w$.])(tool\.bash|Bun\.spawnSync|Bun\.spawn|Bun\.\$|(?:(?:child_process|childProcess|cp)\.)?(?:execFileSync|execFile|execSync|exec|spawnSync|spawn))\s*([(`])|(?<![\w$.])\$`|\.(execFileSync|execSync|spawnSync)\s*\(/g;
// A process API is in use (a regex `.exec(` is not one).
const PROCESS_HINT_RE =
  /child_process|\bBun\.(?:spawn|spawnSync|\$)|\btool\.bash\b|(?<![\w$.])\$`|(?<![\w$.])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(|\.(?:spawn|spawnSync|execSync|execFile|execFileSync)\s*\(/;
const FALLBACK_DANGER_RE = /\bgit\s+push\b|\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|-r\s+-f|-f\s+-r)\b/;

/**
 * The directory a call runs in: `{ cwd: … }` among its arguments or Bun's `` $`…`.cwd(…) `` -> its value (UNKNOWN when
 * computed); undefined when the call names none.
 */
function callCwd(code, match, resolve) {
  const position = match.index + match[0].length - 1;
  let expression;
  if ((match[2] ?? (match[3] ? "(" : "`")) === "`") {
    const after = code.slice(readString(code, position).end + 1);
    const call = /^\s*\.cwd\s*\(/.exec(after);
    expression = call ? splitArgs(after, call[0].length - 1)[0] : undefined;
  } else {
    for (const arg of splitArgs(code, position)) {
      if (!arg.startsWith("{")) continue;
      expression = splitArgs(arg, 0).includes("cwd") ? "cwd" : objectProperty(arg, "cwd");
      if (expression !== undefined) break;
    }
  }
  if (expression === undefined) return undefined;
  return literalValue(expression, resolve)?.value ?? interpolated(expression, resolve) ?? UNKNOWN;
}

/** One matched call -> { text, dynamic } or null; a `cwd` option becomes a leading `cd <dir> &&`. */
function commandOfCall(code, match, resolve) {
  const found = callCommand(code, match, resolve);
  const cwd = found ? callCwd(code, match, resolve) : undefined;
  return cwd === undefined ? found : { text: `cd ${shellQuote(cwd)} && ${found.text}`, dynamic: found.dynamic };
}

/** One matched call's command -> { text, dynamic } or null when the command is not statically known. */
function callCommand(code, match, resolve) {
  const callee = match[1] ?? match[3] ?? "$";
  const opener = match[2] ?? (match[3] ? "(" : "`");
  const position = match.index + match[0].length - 1;
  if (opener === "`") {
    const literal = readString(code, position, resolve);
    return { text: literal.value, dynamic: literal.dynamic };
  }
  const args = splitArgs(code, position);
  if (args.length === 0) return null;
  const first = args[0];
  if (callee === "tool.bash") {
    const value = first.startsWith("{") ? objectProperty(first, "command") : first;
    const literal = value === undefined ? null : literalValue(value, resolve);
    return literal && { text: literal.value, dynamic: literal.dynamic };
  }
  const spawnLike = /spawn|execFile/.test(callee);
  const cmdArray = first.startsWith("{") ? objectProperty(first, "cmd") : undefined;
  const asArray = arrayCommand(cmdArray ?? first, resolve);
  if (asArray) return asArray;
  const literal = literalValue(first, resolve);
  if (!literal) return null;
  if (spawnLike && args[1]?.startsWith("[")) {
    const extra = arrayCommand(args[1], resolve);
    if (!extra) return null;
    return { text: `${shellQuote(literal.value)} ${extra.text}`, dynamic: literal.dynamic || extra.dynamic };
  }
  return { text: literal.value, dynamic: literal.dynamic };
}

/**
 * Top-level helpers `function name(a, b) {…}` / `const name = (async) (a, b) => {…}` with plain parameters, as
 * { name, params, open, close } (`open` / `close`: the body's braces).
 */
function helperFunctions(code, skeleton) {
  const helpers = [];
  for (const match of skeleton.matchAll(/(?<![\w$.])(?:(?:async\s+)?function\s*([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/g)) {
    const paren = match.index + match[0].length - 1;
    const params = splitArgs(code, paren);
    if (depthAt(skeleton, match.index) !== 0 || !params.every((param) => /^[A-Za-z_$][\w$]*$/.test(param))) continue;
    const afterParams = skipBalanced(skeleton, paren + 1, "(", ")") + 1;
    const brace = (match[1] ? /^\s*\{/ : /^\s*=>\s*\{/).exec(skeleton.slice(afterParams));
    if (!brace) continue;
    const open = afterParams + brace[0].length - 1;
    helpers.push({ name: match[1] ?? match[2], params, open, close: skipBalanced(skeleton, open + 1, "{", "}") });
  }
  return helpers;
}

/**
 * A process call in a helper that runs its parameters (`const run = (args) => Bun.spawn(args, { cwd })`) -> the commands
 * of every call of the helper, with the call's arguments in place of the parameters. null when that cannot be read: a
 * parameter used anywhere else in the body, a helper declared twice, passed around, called from its own body or never.
 */
function helperCommands(code, match, resolve, scan) {
  const helper = scan.helpers.find((entry) => match.index > entry.open && match.index < entry.close);
  if (!helper || scan.rebindable) return null;
  const opener = match.index + match[0].length - 1;
  const end = code[opener] === "`" ? readString(code, opener).end : skipBalanced(code, opener + 1, "(", ")");
  const uses = [];
  for (const [position, param] of helper.params.entries()) {
    for (const use of scan.skeleton.slice(0, helper.close).matchAll(wordRe(param))) {
      if (use.index < helper.open) continue;
      // `{ cwd }` shorthand / `{ key: cwd }`: a property value, read only
      const inObject = /[{,:]\s*$/.test(scan.skeleton.slice(0, use.index)) && /^\s*[,}]/.test(scan.skeleton.slice(use.index + param.length)) && innermostOpener(scan.skeleton, use.index) === "{";
      // after the call, a parameter may only be read into an object (`return { args, stdout }`)
      if (use.index > end && inObject) continue;
      if (use.index < opener || use.index > end) return null;
      const shorthand = inObject && !/:\s*$/.test(scan.skeleton.slice(0, use.index));
      uses.push({ at: use.index, length: param.length, position, prefix: shorthand ? `${param}: ` : "" });
    }
  }
  const declarations = [...scan.skeleton.matchAll(new RegExp(`(?<![\\w$.])(?:function\\s*|class\\s+|(?:const|let|var)\\s+)${helper.name.replaceAll("$", "\\$")}(?![\\w$])`, "g"))];
  if (uses.length === 0 || declarations.length !== 1) return null;
  const declaredAt = declarations[0].index + declarations[0][0].length - helper.name.length;
  const calls = [];
  for (const use of scan.skeleton.matchAll(wordRe(helper.name))) {
    if (use.index === declaredAt) continue;
    const paren = /^\s*\(/.exec(scan.skeleton.slice(use.index + helper.name.length));
    if (!paren || (use.index > helper.open && use.index < helper.close)) return null;
    calls.push(use.index + helper.name.length + paren[0].length - 1);
  }
  if (calls.length === 0) return null;
  const commands = [];
  for (const paren of calls) {
    const args = splitArgs(code, paren);
    if (args.length < helper.params.length) return null;
    let text = code.slice(match.index, end + 1);
    for (const use of [...uses].sort((left, right) => right.at - left.at)) {
      const offset = use.at - match.index;
      text = `${text.slice(0, offset)}${use.prefix}${args[use.position]}${text.slice(offset + use.length)}`;
    }
    const inlined = [...text.matchAll(CALL_RE)][0];
    const found = inlined?.index === 0 ? commandOfCall(text, inlined, resolve) : null;
    if (!found) return null;
    commands.push(found);
  }
  return commands;
}

/** The opening bracket of the innermost group around `index`, or undefined at top level. */
function innermostOpener(text, index) {
  for (let at = index - 1, depth = 0; at >= 0; at -= 1) {
    if (")]}".includes(text[at])) depth += 1;
    else if ("([{".includes(text[at]) && (depth -= 1) < 0) return text[at];
  }
  return undefined;
}

/** JS code -> { commands, unparsed }. `unparsed` means process calls could not be read confidently. */
function scanEval(code) {
  const commands = [];
  let confident = true;
  const resolve = constantResolver(code);
  const skeleton = codeSkeleton(code);
  const scan = { skeleton, helpers: helperFunctions(code, skeleton), rebindable: REBINDABLE_RE.test(skeleton) };
  for (const match of code.matchAll(CALL_RE)) {
    const inlined = helperCommands(code, match, resolve, scan);
    if (inlined) {
      commands.push(...inlined.map((found) => found.text));
      if (inlined.some((found) => found.dynamic)) confident = false;
      continue;
    }
    const found = commandOfCall(code, match, resolve);
    if (found) {
      commands.push(found.text);
      if (found.dynamic) confident = false;
    } else confident = false;
  }
  const unparsed = PROCESS_HINT_RE.test(code) && (!confident || commands.length === 0);
  return { commands, unparsed };
}

function allLiterals(code) {
  const literals = [];
  for (let index = 0; index < code.length; index += 1) {
    if ('"\'`'.includes(code[index])) {
      const literal = readString(code, index);
      literals.push(literal.value);
      index = literal.end;
    }
  }
  return literals;
}

const PY_CALL_RE = /(?<![\w.])(subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)|os\.(?:system|popen)|os\.(?:exec|spawn)\w*)\s*\(/g;
const PY_HINT_RE = /\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*)\b|\bpty\.spawn\b|\bcommands\.getoutput\b/;

/** Python code -> { commands, unparsed }: literal subprocess / os.system calls; os.exec… and os.spawn… are never read. */
function scanPython(code) {
  const commands = [];
  let confident = true;
  for (const match of code.matchAll(PY_CALL_RE)) {
    const first = splitArgs(code, match.index + match[0].length - 1)[0] ?? "";
    const readable = !/^os\.(?:exec|spawn)/.test(match[1]);
    const literal = readable ? literalValue(first) : null;
    const found = readable ? (arrayCommand(first) ?? (literal && { text: literal.value, dynamic: literal.dynamic })) : null;
    if (found) {
      commands.push(found.text);
      if (found.dynamic) confident = false;
    } else confident = false;
  }
  return { commands, unparsed: PY_HINT_RE.test(code) && (!confident || commands.length === 0) };
}

const JS_LANGUAGES = new Set(["", "js", "javascript", "ts", "typescript", "jsx", "tsx", "bun", "node"]);
const PY_LANGUAGES = new Set(["py", "python", "python3"]);
const SHELL_LANGUAGES = new Set(["sh", "bash", "zsh", "shell"]);

// Languages read only for "does it start a process at all" (heredocs fed to these interpreters).
const PROCESS_API_RE = {
  ruby: /\b(?:system|exec|spawn|syscall)\b|`|%x[({[<|]|\bIO\.popen\b|\bOpen3\b/,
  perl: /\b(?:system|exec)\b|`|\bqx\s*[({[<|/]|\bopen\s*\(?[^;]*\|/,
  php: /\b(?:shell_exec|exec|system|passthru|proc_open|popen|pcntl_exec)\s*\(|`/,
  applescript: /\bdo\s+shell\s+script\b/i,
};

/** eval / stdin code -> { commands, unparsed } by language; an unknown language is unparsed. */
function scanCode(language, code) {
  const name = String(language ?? "").toLowerCase();
  if (SHELL_LANGUAGES.has(name)) return { commands: [code], unparsed: false };
  if (PY_LANGUAGES.has(name)) return scanPython(code);
  if (JS_LANGUAGES.has(name)) return scanEval(code);
  if (PROCESS_API_RE[name]) return { commands: [], unparsed: PROCESS_API_RE[name].test(code) };
  return { commands: [], unparsed: true };
}

// ---------- tool inputs ----------

export const FILE_WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch"]);
// Tools that run nothing and write no project file (OmO 5.1.59 binary and plugin; test/kit/fixtures/omo-5.1.59-tools.json):
// built-ins marked writeCapable:false or workspaceEffect:"read", the question tools, the terminal companions (F7),
// subagent calls (the child session's own calls pass through the hooks), the memory and goal tools (ruling P29) and the
// orchestration/session tools (P30). Still escalated: lsp_rename, computer*, omo_browser_bridge, omo_desktop_toolkit, show_html_page.
export const READ_TOOLS = new Set([
  "read", "grep", "find", "glob", "ls", "list", "todo", "tool_search", "look_at",
  "lsp_diagnostics", "lsp_goto_definition", "lsp_find_references", "lsp_symbols",
  "web_search", "web_fetch", "webfetch", "x_search",
  "ask_user_question", "request_user_input", "bash_output", "kill_bash", "bash_resize",
  "task", "task_output", "task_send", "task_cancel", "task_create", "task_get", "task_list", "task_update",
  "memory", "create_goal", "update_goal", "get_goal",
  // ruling P30: agent orchestration and session tools (no shell, no project file writes)
  "team_create", "team_delete", "workflow", "workpool",
  "thread_answer", "thread_bind", "thread_bindings", "thread_create", "thread_handoff", "thread_interrupt", "thread_list",
  "thread_outbox", "thread_outbox_ack", "thread_read", "thread_rebind", "thread_rename", "thread_report", "thread_send",
  "thread_set_model", "thread_set_reasoning", "thread_unbind",
  "mcp_list_resources", "mcp_read_resource", "session_entries", "lsp_prepare_rename",
  "onboarding_memory_apply", "onboarding_session_history", "onboarding_understand", "nudge",
]);
// MCP tools register as mcp_<server>_<tool> (docs/mcp.md SERVER_NAMESPACE). MCP servers are the user's own choice: a
// tool is allowed unless its name has a write verb (then it escalates); read names (get, list, search, query, docs…)
// and names with neither are allowed. codegraph_explore is read-only by its own declaration.
const MCP_TOOL_RE = /^mcp_/i;
export const MCP_READ_TOOLS = new Set(["mcp_codegraph_codegraph_explore"]);
const MCP_WRITE_VERBS = new Set([
  "create", "delete", "remove", "update", "write", "edit", "put", "post", "patch", "push", "send", "publish", "deploy", "merge",
  "exec", "execute", "run", "shell", "kill", "drop", "insert", "upload", "move", "rename", "transfer", "pay", "approve",
  "comment", "close", "reopen", "assign", "rewrite", "replace", "apply", "add", "set", "save",
]);
// Any other tool with one of these words in its name is denied, not asked (spec §4.3; powershell: commands not parsed).
const WRITE_LIKE_WORDS = new Set(["write", "edit", "patch", "exec", "shell", "powershell", "bash", "eval", "run", "spawn", "monitor"]);

/** Name words: split on `_`, `-`, `.` and camelCase humps, lower-cased (`runCommand` -> run, command). */
const nameWords = (name) =>
  String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.\-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

/** The write verbs in an MCP tool's own name (the part after mcp_<server>_), camelCase humps kept as word breaks. */
const mcpWriteVerbs = (name) => {
  const raw = String(name ?? "");
  const own = /^mcp_([^_]+)_(.+)$/i.exec(raw)?.[2] ?? raw.replace(/^mcp_+/i, "");
  return [...new Set(nameWords(own).filter((word) => MCP_WRITE_VERBS.has(word)))];
};

const COMMAND_TOOLS = new Set(["bash", "bash_input", "monitor", "eval"]);
const EVAL_CELL_ACTIONS = new Set(["list", "peek", "stop"]);
// bash_input keys that submit the line: with no `input` they replay whatever the terminal holds (history recall).
const SUBMIT_KEY_RE = /\b(?:enter|return)\b|[\r\n]/i;

/**
 * Tool call -> { commands, unparsedCode } | "write" | "read" | "mcp" (judged by its name) | "unknown-write" | "invalid" (a
 * command tool without a string command: denied) | "replay" (bash_input keys that submit: escalated). Fields per live check F7.
 */
function extractCalls(toolName, toolInput) {
  const isObject = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput);
  if (COMMAND_TOOLS.has(toolName) && !isObject && toolInput !== undefined) return "invalid";
  const input = isObject ? toolInput : {};
  if (toolName === "bash") return typeof input.command === "string" ? { commands: [input.command], unparsedCode: "" } : "invalid";
  if (toolName === "bash_input") {
    if (typeof input.input === "string") return { commands: [input.input], unparsedCode: "" };
    if (input.input !== undefined) return "invalid";
    const keys = Array.isArray(input.keys) ? input.keys : [];
    return input.submit === true || keys.some((key) => typeof key === "string" && SUBMIT_KEY_RE.test(key)) ? "replay" : "read";
  }
  if (toolName === "monitor") {
    if (input.action === "rearm" || (input.type !== undefined && input.type !== "command")) return "read";
    if (typeof input.command === "string") return { commands: [input.command], unparsedCode: "" };
    // no type: following a path or RPC sessions is reading; anything else is a command call without its command
    return input.type === undefined && (input.path !== undefined || input.target !== undefined) ? "read" : "invalid";
  }
  if (toolName === "eval") {
    // the cell controls (OmO docs/rpc.md «Eval cell control») observe or cancel the session's own cells
    if (input.code === undefined && EVAL_CELL_ACTIONS.has(input.action)) return "read";
    if (typeof input.code !== "string") return "invalid";
    const code = input.code;
    const scanned = scanCode(input.language, code);
    return { commands: scanned.commands, unparsedCode: scanned.unparsed ? code || " " : "" };
  }
  if (FILE_WRITE_TOOLS.has(toolName)) return "write";
  if (READ_TOOLS.has(toolName) || MCP_READ_TOOLS.has(toolName)) return "read";
  if (MCP_TOOL_RE.test(toolName)) return "mcp";
  return "unknown-write";
}

/**
 * A tool the guard does not know, not an MCP tool, with a write-like word in its name: denied by the hook and the
 * service. Pass the name as the tool call gives it (camelCase humps are word breaks).
 */
export function isUnknownWriteTool(toolName) {
  const name = String(toolName ?? "");
  if (MCP_TOOL_RE.test(name) || extractCalls(name.toLowerCase(), {}) !== "unknown-write") return false;
  return nameWords(name).some((word) => WRITE_LIKE_WORDS.has(word));
}

/** Shell commands a tool call runs: string[], or "write" | "read" | "mcp" | "unknown-write" (eval with unreadable process calls included) | "invalid" | "replay". */
export function commandsOf(toolName, toolInput) {
  const calls = extractCalls(String(toolName ?? "").toLowerCase(), toolInput);
  if (typeof calls === "string") return calls;
  return calls.unparsedCode ? "unknown-write" : calls.commands.map((command) => command.replaceAll(UNKNOWN, "${…}"));
}

// ---------- classification ----------

const show = (text) => text.replaceAll(UNKNOWN, "${…}").replaceAll(SUBST, "$(…)").replaceAll(PROC_SUBST, "<(…)").replace(HEREDOC_TOKEN_RE, "<<…");
const hashKey = (normalized, cwd) => createHash("sha256").update(`${normalized}\0${cwd}`).digest("hex").slice(0, 32);

// The editable allow rule that trusts `remote-exec` (its remote commands still meet REMOTE_CHECKS and hardDeny).
const REMOTE_EXEC_RULE_ID = "remote-exec";
// An allow-tier match never switches off the secrets check (remote command or not, a key path is a key path).
const ALWAYS_CHECKED_ID = "secrets-access";

function escalationReasons(text, matchers, onlyAlwaysChecked = false) {
  const reasons = [];
  for (const entry of matchers.escalate) {
    if (onlyAlwaysChecked && entry.id !== ALWAYS_CHECKED_ID) continue;
    if (entry.regexes.some((regex) => regex.test(text))) reasons.push(`${entry.id}: ${entry.label}`);
  }
  for (const entry of matchers.askCustom) if (entry.regex.test(text)) reasons.push(`ask-custom: ${entry.glob}`);
  if (onlyAlwaysChecked || !matchers.ipCheck) return reasons;
  const ips = publicIpsOutside(text, matchers.whitelist);
  if (ips.length > 0) reasons.push(`ip-egress: public IP ${ips.join(", ")} is not whitelisted`);
  return reasons;
}

/**
 * classify({ tool_name, tool_input, cwd, agent_dir?, home? }, rules) -> { tier, reasons, normalized, key }.
 * agent_dir / home (default: the user's home) only feed the docker bind-mount check.
 */
export function classify(input, rules) {
  const matchers = compileRules(rules);
  const toolName = String(input.tool_name ?? "").toLowerCase();
  const cwd = input.cwd ?? "";
  const calls = extractCalls(toolName, input.tool_input);
  const key = (source) => hashKey(source || toolName, cwd);
  if (calls === "unknown-write") {
    if (isUnknownWriteTool(input.tool_name)) {
      return { tier: "deny", reasons: [`unknown-write-tool: неизвестный инструмент записи «${toolName}»`], normalized: `${toolName}:`, key: key(`${toolName}:${JSON.stringify(input.tool_input ?? {})}`) };
    }
    return { tier: "escalate", reasons: [`unknown-tool: инструмент «${toolName}» неизвестен защите`], normalized: `${toolName}:`, key: key(`${toolName}:${JSON.stringify(input.tool_input ?? {})}`) };
  }
  if (calls === "mcp") {
    const verbs = mcpWriteVerbs(input.tool_name);
    if (verbs.length > 0) {
      return { tier: "escalate", reasons: [`mcp-write: MCP-инструмент «${toolName}» может менять данные (${verbs.join(", ")})`], normalized: `${toolName}:`, key: key(`${toolName}:${JSON.stringify(input.tool_input ?? {})}`) };
    }
  }
  if (calls === "invalid") return { tier: "deny", reasons: ["invalid-call: некорректный вызов инструмента"], normalized: `${toolName}:`, key: key(`${toolName}:invalid`) };
  if (calls === "replay") {
    return { tier: "escalate", reasons: ["history-replay: повтор команды из истории (bash_input без текста отправляет строку терминала)"], normalized: `${toolName}:replay`, key: key(`${toolName}:${JSON.stringify(input.tool_input ?? {})}`) };
  }
  if (typeof calls === "string") return { tier: "allow", reasons: [], normalized: "", key: key("") };

  const where = { cwd, home: input.home ?? os.homedir(), agentDir: input.agent_dir };
  const bodies = [];
  const { commands, unparsedCode } = calls;
  const all = commands.flatMap((command) => expand(command, 0, newContext(where, bodies)));
  const leaves = all.filter((leaf) => !leaf.script);
  const scripts = all.filter((leaf) => leaf.script);
  const evalText = (code) => `eval:${code.replace(/\s+/g, " ").trim().slice(0, 4096)}`;
  const normalized = unparsedCode
    ? evalText(unparsedCode)
    : leaves.length > 0
      ? show(leaves.map((leaf) => leaf.text).join(" ; "))
      : toolName === "eval"
        ? evalText(String(input.tool_input?.code ?? ""))
        : "";
  // Cache/dedupe key: un-normalized words (git options, env, wrappers kept) and heredoc bodies, so different commands never share a verdict.
  const keySource = unparsedCode || leaves.length === 0 ? normalized : [...leaves.map((leaf) => leaf.raw), ...bodies.map((body) => body.text)].join(" ; ");

  const denied = [];
  const escalated = [];
  const anyMatch = (regexes, texts) => texts.find((text) => regexes.some((regex) => regex.test(text)));
  // On another host (ssh, remote-exec) every remote check applies; inside a container only the catastrophic denies.
  const remoteCheck = (texts, where) => {
    const deniedText = anyMatch(matchers.remote.denyIf, texts);
    if (deniedText) denied.push(`remote-deny: ${show(deniedText)}`);
    const escalatedText = deniedText || where === "container" ? undefined : anyMatch(matchers.remote.escalateIf, texts);
    if (escalatedText) escalated.push(`remote-escalate: ${show(escalatedText)}`);
    return Boolean(deniedText || escalatedText);
  };
  // Commands under `remote-exec` are trusted like the command itself only while the remote-exec allow rule exists (fail closed).
  const remoteExecTrusted = matchers.allow.some((entry) => entry.id === REMOTE_EXEC_RULE_ID);
  // A whole remote script: cd + rm across lines, etc.
  for (const script of scripts) remoteCheck([script.text], script.remote);
  for (const leaf of leaves) {
    const globText = leaf.texts.map((text) => [text, matchers.hardDeny.find((entry) => entry.regex.test(text))]).find(([, glob]) => glob);
    // Ruling P26: on another host or in a container a hard-deny line asks; REMOTE_CHECKS still deny the catastrophic forms.
    if (globText && !leaf.remote) {
      denied.push(`hard-deny: ${show(globText[0])} matches ${globText[1].glob}`);
      continue;
    }
    if (leaf.helpOnly) continue;
    escalated.push(...leaf.forced);
    if (globText) escalated.push(`hard-deny-elsewhere: ${show(globText[0])} matches ${globText[1].glob} (${leaf.remote})`);
    if (leaf.remote && (remoteCheck(leaf.texts, leaf.remote) || globText)) continue;
    if (leaf.remote === "remote-exec" && remoteExecTrusted) {
      // The remote checks match text: they cannot see behind a value the eval code computes.
      if (leaf.texts.some((text) => text.includes(UNKNOWN))) escalated.push("remote-unknown: удалённая команда содержит значение, вычисляемое кодом eval");
      for (const text of leaf.texts) escalated.push(...escalationReasons(text, matchers, true));
      continue;
    }
    const allowed = matchers.allow.find((entry) => entry.regex.test(leaf.text));
    if (allowed) {
      if (allowed.denyIf.some((regex) => regex.test(leaf.text))) denied.push(`deny-if: ${show(leaf.text)} (${allowed.id})`);
      else if (allowed.escalateIf.some((regex) => regex.test(leaf.text))) escalated.push(`escalate-if: ${show(leaf.text)} (${allowed.id})`);
      else escalated.push(...escalationReasons(leaf.text, matchers, true));
      continue;
    }
    if (leaf.gitDanger) escalated.push("git-dangerous-option: git: опасная опция (executes a program or writes a file)");
    if (leaf.dynamic) escalated.push("dynamic-command: динамическая команда (head word is a variable or substitution)");
    if (leaf.dockerMount) escalated.push(leaf.dockerMount);
    if (leaf.unknownHost && matchers.ipCheck) escalated.push("ip-egress: network target is not known statically (a value the eval code computes)");
    for (const text of leaf.matchTexts) escalated.push(...escalationReasons(text, matchers));
  }
  if (unparsedCode) {
    escalated.push("unparsed-eval: код вызывает процесс, команду которого не прочитать статически");
    const literals = allLiterals(unparsedCode);
    // Arguments may be assembled out of order (["git", ...args]): also pair "git" with every other literal.
    const gitPairs = literals.includes("git") ? literals.map((literal) => `git ${literal}`) : [];
    const haystack = [literals.join(" "), ...gitPairs, unparsedCode].join("\n");
    escalated.push(...escalationReasons(haystack, matchers).map((reason) => `unparsed eval: ${reason}`));
    if (FALLBACK_DANGER_RE.test(haystack)) escalated.push("unparsed eval: git push or rm -rf in process-spawning code");
  }

  const unique = (items) => [...new Set(items)];
  if (denied.length > 0) return { tier: "deny", reasons: unique(denied), normalized, key: key(keySource) };
  if (escalated.length > 0) return { tier: "escalate", reasons: unique(escalated), normalized, key: key(keySource) };
  return { tier: "allow", reasons: [], normalized, key: key(keySource) };
}

// ---------- file-writing tools ----------

const PATCH_HEADER_RE = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/;

/** Paths a write/edit/apply_patch call touches, as given (unresolved); [] for other tools or unreadable input. */
export function fileWriteTargets(input) {
  const toolName = String(input.tool_name ?? "").toLowerCase();
  const toolInput = input.tool_input;
  if (!FILE_WRITE_TOOLS.has(toolName)) return [];
  if (toolName === "apply_patch") {
    const patch = typeof toolInput === "string" ? toolInput : typeof toolInput?.input === "string" ? toolInput.input : "";
    return patch
      .split(/\r?\n/)
      .map((line) => PATCH_HEADER_RE.exec(line.trim())?.[1]?.trim())
      .filter(Boolean);
  }
  const target = toolInput?.path ?? toolInput?.file_path;
  return typeof target === "string" && target ? [target] : [];
}
