import fs from "node:fs";
import path from "node:path";

/**
 * Metadata directly in cwd, selected by GIT_DIR=., with an explicit worktree. A sandbox that forbids creating .git
 * can still exercise a real disposable repository. No git init, hooks, or access to the checkout's index.
 */
export function makeScratchRepo(parent: string): string {
  const root = fs.mkdtempSync(path.join(parent, "repo-"));
  fs.mkdirSync(path.join(root, "objects"));
  fs.mkdirSync(path.join(root, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, "config"), [
    "[core]", "\tbare = false", "\tworktree = .",
    "[user]", "\tname = Coordination Fixture", "\temail = fixture@example.invalid",
    "[commit]", "\tgpgsign = false", "",
  ].join("\n"));
  return fs.realpathSync(root);
}
