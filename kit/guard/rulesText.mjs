// Rules as editable text: one rule per line (settings fields), IP lines with `# note`, import of Claude's permissions.deny.
import { parseCidr } from "./ip.mjs";
import { globError } from "./rules.mjs";

/**
 * Text field -> { values, errors }. Blank lines are skipped; `line` counts every line from 1.
 * kind "glob": values are the trimmed lines; kind "ip": `<ip|cidr>[ # note]` -> { cidr, note? }.
 */
export function parseLines(text, kind) {
  const values = [];
  const errors = [];
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      if (kind === "ip") {
        const hash = line.indexOf("#");
        const cidr = (hash < 0 ? line : line.slice(0, hash)).trim();
        const note = hash < 0 ? "" : line.slice(hash + 1).trim();
        if (!parseCidr(cidr)) errors.push({ line: index + 1, message: `«${cidr}» — не IP-адрес и не подсеть` });
        else values.push(note ? { cidr, note } : { cidr });
        return;
      }
      const message = globError(line);
      if (message) errors.push({ line: index + 1, message });
      else values.push(line);
    });
  return { values, errors };
}

/** IP whitelist entries -> text for the settings field (inverse of parseLines(…, "ip")). */
export function formatIpLines(entries) {
  return entries.map((entry) => (entry.note ? `${entry.cidr} # ${entry.note}` : entry.cidr)).join("\n");
}

/** Claude settings JSON -> «always deny» lines: Bash(x:*) -> "x*", Bash(x) -> "x"; anything else is skipped. */
export function importClaudeDeny(settingsJson) {
  const deny = settingsJson?.permissions?.deny;
  const lines = [];
  let skipped = 0;
  for (const rule of Array.isArray(deny) ? deny : []) {
    const match = typeof rule === "string" ? /^Bash\((.*)\)$/s.exec(rule.trim()) : null;
    const body = match?.[1].trim();
    if (!body) {
      skipped += 1;
      continue;
    }
    lines.push(body.endsWith(":*") ? `${body.slice(0, -2)}*` : body);
  }
  return { lines, skipped };
}
