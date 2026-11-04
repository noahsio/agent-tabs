import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KIT = path.resolve(__dirname, "../../kit");

export function makeTmp(prefix = "omo-kit-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Local bare repo with one commit, standing in for the superpowers fork. Returns its path and head sha. */
export function makeBareRepo(root: string): { url: string; sha: string } {
  const work = path.join(root, "sp-work");
  const bare = path.join(root, "sp.git");
  fs.mkdirSync(path.join(work, "skills"), { recursive: true });
  fs.writeFileSync(path.join(work, "skills", "README.md"), "x\n");
  writeSuperpowersManifests(work);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(root, "clone", "-q", "--bare", work, bare);
  return { url: bare, sha: git(work, "rev-parse", "HEAD") };
}

/** The fork's Claude plugin manifests: the local marketplace `name` and the plugin `version`. */
export function writeSuperpowersManifests(dir: string, marketplace = "yasherisa-superpowers", version = "6.3.1-test.1"): void {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: marketplace, plugins: [{ name: "superpowers", source: "./" }] }));
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superpowers", version }));
}

/** A `claude` stub: each call appends `CLAUDE_CONFIG_DIR|args|stdin` to `log`; a non-zero `exitCode` fails it. */
export function makeFakeClaude(dir: string, log: string, { exitCode = 0, sleep = 0 }: { exitCode?: number; sleep?: number } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const script = [
    "#!/bin/sh",
    "if read -r line; then input=data; else input=eof; fi",
    `printf '%s|%s|%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" "$*" "$input" >> '${log}'`,
    sleep > 0 ? `sleep ${sleep}` : "",
    exitCode !== 0 ? `echo boom >&2; exit ${exitCode}` : "exit 0",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "claude"), script + "\n", { mode: 0o755 });
  return dir;
}

/** Clone the bare `url` to `dir` (the installed fork). */
export function cloneTo(url: string, dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync("git", ["clone", "-q", url, dir], { encoding: "utf8" });
}

/** Directory with an executable `codegraph` printing `stdout`. */
export function makeFakeCodegraph(dir: string, stdout: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "codegraph");
  fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${stdout}'\n`, { mode: 0o755 });
  return dir;
}

export function runSetup(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [path.join(KIT, "setup-omo.mjs"), ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: "/nonexistent-home",
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("OMO_KIT_SECOND_"))),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
