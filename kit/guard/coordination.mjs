// Service-owned coordination. No plugin liveness inference: ruling C1 defines activity by arriving hook calls.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { coordinationOf } from "./classify.mjs";

const execute = promisify(execFile);
export const LIVE_MS = 10 * 60_000;
export const LEASE_MS = 15 * 60_000;

async function git(cwd, args) {
  try {
    return (await execute("git", ["-C", cwd, ...args], { timeout: 1500, maxBuffer: 1024 * 1024 })).stdout;
  } catch (error) {
    // Non-repositories and unborn HEADs are ordinary inputs; unexpected infrastructure failures reach P44.
    if (error.code === 128 && /not a git repository|does not exist|unknown revision|bad revision|ambiguous argument|Needed a single revision/.test(error.stderr)) return null;
    throw error;
  }
}

/** Resolve existing ancestors as well as existing files, so symlinks do not create a second lease namespace. */
function canonical(file) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonical(parent), path.basename(file));
  }
}

function existingDirectory(file) {
  let directory = path.dirname(file);
  while (!fs.existsSync(directory) && directory !== path.dirname(directory)) directory = path.dirname(directory);
  return directory;
}

export class Coordination {
  constructor(now = Date.now) {
    this.now = now;
    this.roots = new Map();
    this.sessions = new Map();
    this.leases = new Map();
  }

  prune() {
    const now = this.now();
    for (const [root, sessions] of this.sessions) {
      for (const [session, at] of sessions) if (now - at >= LIVE_MS) sessions.delete(session);
      if (sessions.size === 0) this.sessions.delete(root);
    }
    for (const [file, lease] of this.leases) {
      if (lease.until <= now || !this.sessions.get(lease.root)?.has(lease.session)) this.leases.delete(file);
    }
    for (const [cwd, entry] of this.roots) if (now - entry.at >= LIVE_MS) this.roots.delete(cwd);
  }

  async root(cwd) {
    if (!fs.existsSync(cwd)) return null;
    const directory = canonical(cwd);
    let entry = this.roots.get(directory);
    if (!entry) {
      entry = { at: this.now(), result: git(directory, ["rev-parse", "--show-toplevel"]).then((value) => value ? canonical(value.trim()) : null) };
      this.roots.set(directory, entry);
      entry.result.catch(() => this.roots.delete(directory));
    }
    return entry.result;
  }

  async prepare(call) {
    this.prune();
    const intent = coordinationOf({ tool_name: call.tool, tool_input: call.input, cwd: call.cwd });
    const writes = [];
    for (const target of intent.writes) {
      const file = canonical(target);
      const root = await this.root(existingDirectory(file));
      if (root) writes.push({ file, root });
    }
    const roots = new Set();
    const current = call.cwd ? await this.root(call.cwd) : null;
    if (current) roots.add(current);
    const whole = new Set();
    for (const cwd of intent.whole) {
      const root = await this.root(cwd);
      if (root) whole.add(root);
    }
    for (const root of whole) roots.add(root);
    for (const { root } of writes) roots.add(root);
    if (call.session) for (const root of roots) {
      if (!this.sessions.has(root)) this.sessions.set(root, new Map());
      this.sessions.get(root).set(call.session, this.now());
    }
    const heads = new Map();
    for (const root of roots) {
      if (!writes.some((write) => write.root === root) && ![...this.leases.values()].some((lease) => lease.root === root)) continue;
      const head = (await git(root, ["rev-parse", "--verify", "HEAD"]))?.trim() ?? null;
      heads.set(root, head);
      if (!head) continue;
      for (const [file, lease] of this.leases) {
        if (lease.root !== root || lease.head === head) continue;
        const relative = path.relative(root, file);
        const changed = await git(root, ["log", "-1", "--format=%H", lease.head ? `${lease.head}..${head}` : head, "--", relative]);
        if (!changed?.trim()) continue;
        const dirty = await git(root, ["status", "--porcelain", "-z", "--", relative]);
        if (dirty === "" && this.leases.get(file) === lease) this.leases.delete(file);
      }
    }
    const neighbours = [...new Set([...whole].flatMap((root) => [...(this.sessions.get(root)?.keys() ?? [])].filter((session) => session !== call.session)))].sort();
    return { writes, heads, neighbours, whole: whole.size > 0 };
  }

  conflict(session, plan) {
    this.prune();
    for (const { file } of plan.writes) {
      for (const [leased, lease] of this.leases) {
        if (lease.session === session) continue;
        if (file !== leased && !file.startsWith(`${leased}${path.sep}`) && !leased.startsWith(`${file}${path.sep}`)) continue;
        const until = new Date(lease.until).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false });
        return `[guard] файл правит сессия «${lease.session}» до ${until}: ${file}. Продолжайте независимую работу; не обходите аренду.`;
      }
    }
    return null;
  }

  /** Synchronous check-and-reserve: two concurrent authorizations cannot both acquire the same file. */
  reserve(call, plan) {
    const conflict = this.conflict(call.session, plan);
    if (conflict) return conflict;
    if (call.session) for (const { file, root } of plan.writes) {
      this.leases.set(file, { root, session: call.session, until: this.now() + LEASE_MS, head: plan.heads.get(root) ?? null });
    }
    return null;
  }
}
