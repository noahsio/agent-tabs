import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { classify } from "../../kit/guard/classify.mjs";
// @ts-expect-error plain ESM without types
import { isUserAllow, loadDefaultRules, makeWhitelistEntry, validateRules, WHITELIST_ID_PREFIX } from "../../kit/guard/rules.mjs";

const defaults = loadDefaultRules();
const CWD = "/work/proj";

/** Rules with the person's «always allow» entries for the given shape globs added to the v2 allow list. */
const withWhitelist = (...scopes: string[]) => ({
  ...defaults,
  allow: [...defaults.allow, ...scopes.map((scope, index) => makeWhitelistEntry({ scope, now: () => 1_700_000_000_000 + index }))],
});

const bash = (command: string, rules = defaults) => classify({ tool_name: "bash", tool_input: { command }, cwd: CWD }, rules);
const evalCode = (code: string, rules = defaults) => classify({ tool_name: "eval", tool_input: { language: "js", code }, cwd: CWD }, rules);

describe("whitelist entry shape", () => {
  it("makeWhitelistEntry produces a valid v2 allow entry", () => {
    const entry = makeWhitelistEntry({ scope: "docker run *", session: "sess-1", now: () => 1_700_000_000_000 });
    expect(entry).toMatchObject({ user: true, scope: "docker run *", denyIf: [], session: "sess-1" });
    expect(entry.id.startsWith(WHITELIST_ID_PREFIX)).toBe(true);
    expect(isUserAllow(entry)).toBe(true);
    expect(isUserAllow(defaults.allow[0])).toBe(false);
    expect(validateRules({ ...defaults, allow: [...defaults.allow, entry] })).toEqual([]);
  });
});

describe("whitelist allows without asking", () => {
  it("a command whose shape is whitelisted is allowed, with no card", () => {
    expect(bash('docker run -v "$HOME":/host alpine sh').tier).toBe("escalate"); // baseline: a bind-mount asks
    expect(bash('docker run -v "$HOME":/host alpine sh', withWhitelist("docker run *")).tier).toBe("allow");
    // Operand/path changes still match the shape — the whole point of a shape over an exact command.
    expect(bash('docker run -v /data:/host ubuntu bash', withWhitelist("docker run *")).tier).toBe("allow");
  });

  it("an rm -rf of a path in a variable (a build dir) is whitelistable — it is an ask, not a deny", () => {
    expect(bash("rm -rf $BUILD_DIR").tier).toBe("escalate");
    expect(bash("rm -rf $BUILD_DIR", withWhitelist("rm -rf *")).tier).toBe("allow");
  });

  it("the whitelist allow is marked distinctly in the decision record", () => {
    const verdict = bash('docker run -v "$HOME":/host alpine sh', withWhitelist("docker run *"));
    expect(verdict.tier).toBe("allow");
    expect(verdict.whitelisted).toEqual([expect.objectContaining({ scope: "docker run *" })]);
    // A plain allow carries no whitelist attribution.
    expect(bash("ls -la").whitelisted).toBeUndefined();
  });

  it("an eval whose extracted command matches is allowed, so the repeating card stops", () => {
    expect(evalCode('const cp=require("node:child_process"); cp.execSync("docker run -v /:/host alpine sh")').tier).toBe("escalate");
    expect(evalCode('const cp=require("node:child_process"); cp.execSync("docker run -v /:/host alpine sh")', withWhitelist("docker run *")).tier).toBe("allow");
  });
});

describe("whitelist cannot open a deny", () => {
  it("whitelisting rm -rf / does nothing — it is still denied", () => {
    for (const scope of ["rm -rf *", "rm -rf /", "rm *"]) {
      expect(bash("rm -rf /", withWhitelist(scope)).tier).toBe("deny");
      expect(bash("rm -rf /", withWhitelist(scope)).whitelisted).toBeUndefined();
    }
  });

  it("a deny mixed with a whitelisted leaf still denies the whole call", () => {
    expect(bash('docker run -v "$HOME":/host alpine sh ; rm -rf /', withWhitelist("docker run *")).tier).toBe("deny");
  });

  it("a remote destructive form over ssh stays an ask even when its local shape is whitelisted", () => {
    expect(bash("ssh host 'pkill -f worker'").tier).toBe("escalate");
    // keying on the local `pkill *` shape must not clear a remote escalation
    expect(bash("ssh host 'pkill -f worker'", withWhitelist("pkill *")).tier).toBe("escalate");
  });
});

describe("whitelist proposal on the card", () => {
  it("an escalating non-remote command offers a legible shape to always allow", () => {
    const verdict = bash('docker run -v "$HOME":/host alpine sh');
    expect(verdict.tier).toBe("escalate");
    expect(verdict.proposal).toEqual([{ scope: "docker run *", label: "всегда разрешать: docker run *" }]);
  });

  it("a remote destructive form is not offered for whitelisting", () => {
    const verdict = bash("ssh host 'pkill -f worker'");
    expect(verdict.tier).toBe("escalate");
    expect(verdict.proposal).toBeUndefined();
  });

  it("a command that matches no entry still asks as before", () => {
    expect(bash('docker run -v "$HOME":/host alpine sh', withWhitelist("tar *")).tier).toBe("escalate");
  });
});
