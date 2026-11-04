// Idempotent file writes with timestamped backups.
import fs from "node:fs";
import path from "node:path";

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function backupPath(file, now) {
  const base = `${file}.bak-${stamp(now)}`;
  let candidate = base;
  for (let n = 1; fs.existsSync(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** Links followed at most (the kernel's own limit is in this range); a longer chain is written as it is reached. */
const MAX_LINKS = 40;

/**
 * The file a write lands in, so every link on the way survives: the real path of an existing file (the whole chain
 * resolved); for a dangling chain, the final target it names.
 */
function realTarget(file) {
  let current = file;
  for (let hop = 0; hop < MAX_LINKS; hop++) {
    try {
      return fs.realpathSync(current);
    } catch {
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch {
        return current; // nothing there: the chain ends here
      }
      if (!stat.isSymbolicLink()) return current;
      current = path.resolve(path.dirname(current), fs.readlinkSync(current));
    }
  }
  return current;
}

/**
 * Write `content` to `file` only when it differs. An existing file is backed up first and keeps its mode
 * (`mode` applies only when the file is created). The write is atomic: a temp file in the same directory is renamed
 * over the target (a symlink's real target: the link stays a link). `backup: "rolling"` keeps ONE backup, `<file>.bak-agent-tabs`, overwritten on every write (for
 * writes that happen on every click); the default is a timestamped backup per write.
 * Returns "unchanged" | "created" | "updated"; with dryRun nothing touches the disk.
 */
export function writeIfChanged(file, content, { mode = 0o644, dryRun = false, now = new Date(), backup = "timestamped" } = {}) {
  const exists = fs.existsSync(file);
  if (exists && fs.readFileSync(file, "utf8") === content) return "unchanged";
  if (dryRun) return exists ? "updated" : "created";
  const target = realTarget(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existingMode = exists ? fs.statSync(file).mode & 0o777 : mode;
  if (exists) {
    const copy = backup === "rolling" ? `${file}.bak-agent-tabs` : backupPath(file, now);
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, existingMode);
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode: existingMode });
    fs.chmodSync(temp, existingMode); // the process umask must not narrow it
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return exists ? "updated" : "created";
}
