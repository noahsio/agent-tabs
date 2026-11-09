import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runThinHook } from "../../kit/guard/thinHook.mjs";
import { makeClock, makeSvcDir, removeSvcDirs, send, start } from "./serviceHelpers";
import { makeScratchRepo } from "../helpers/scratchRepo";

const repo = path.resolve(import.meta.dirname, "../..");
const owner = "11111111-owner";
const neighbour = "22222222-neighbour";
let service: Awaited<ReturnType<typeof start>>;
let agentDir: string;
let clock: ReturnType<typeof makeClock>;

function call(tool: string, input: unknown, session = owner, cwd = repo): Record<string, unknown> {
  return { tool, input, session, cwd };
}
function evaluate(tool: string, input: unknown, session = owner, cwd = repo): Promise<Record<string, unknown>> {
  return send(service.paths.hookSock, { op: "evaluate", call: call(tool, input, session, cwd) });
}
const write = (file: string, session = owner, cwd = repo): Promise<Record<string, unknown>> =>
  evaluate("write", { path: file, content: "scratch" }, session, cwd);

beforeEach(async () => {
  agentDir = makeSvcDir({ decider: { mode: "deny" }, groups: { "git-push": false, history: false, secrets: false, "external-ip": false, "global-install": false } });
  clock = makeClock();
  service = await start(agentDir, { now: clock.now });
});
afterEach(async () => {
  await service?.close();
  removeSvcDirs();
  vi.unstubAllEnvs();
});

describe("shared working copy decisions through the real hook socket", () => {
  it("denies another live session's file and names its owner and expiry", async () => {
    expect((await write("coordination-scratch.txt"))["decision"]).toBe("allow");
    const conflict = await write("coordination-scratch.txt", neighbour);
    expect(conflict["decision"]).toBe("deny");
    expect(conflict["reason"]).toMatch(/файл правит сессия «11111111» до \d\d:\d\d/);
  });

  it("recognizes the same root and file from a nested cwd", async () => {
    await write("coordination-scratch.txt");
    expect((await write("../coordination-scratch.txt", neighbour, path.join(repo, "kit")))["decision"]).toBe("deny");
  });

  it("treats special characters in file-tool paths as literal filenames", async () => {
    await write("price$USD[1].txt");
    expect((await write("price$USD[1].txt", neighbour))["decision"]).toBe("deny");
  });

  it("takes every patch path atomically, including moves", async () => {
    await write("occupied.txt");
    const patch = "*** Begin Patch\n*** Update File: free.txt\n*** Move to: occupied.txt\n@@\n-x\n+y\n*** End Patch\n";
    expect((await evaluate("apply_patch", patch, neighbour))["decision"]).toBe("deny");
    expect((await write("free.txt"))["decision"]).toBe("allow");
  });

  it("extends the lease on another write by its owner", async () => {
    await write("occupied.txt");
    clock.advance(9 * 60_000);
    await write("occupied.txt");
    clock.advance(7 * 60_000);
    expect((await write("occupied.txt", neighbour))["decision"]).toBe("deny");
  });

  it("releases the files when the owner's last call is ten minutes old", async () => {
    await write("occupied.txt");
    clock.advance(10 * 60_000);
    expect((await write("occupied.txt", neighbour))["decision"]).toBe("allow");
  });

  it("expires a lease after fifteen minutes even if the owner stays active", async () => {
    await write("occupied.txt");
    clock.advance(9 * 60_000);
    await write("other.txt");
    clock.advance(6 * 60_000);
    expect((await write("occupied.txt", neighbour))["decision"]).toBe("allow");
  });

  it.each([
    "printf x > occupied.txt",
    "printf x >>occupied.txt",
    "tee occupied.txt",
    "cp source.txt occupied.txt",
    "mv occupied.txt moved.txt",
    "dd if=/dev/zero of=occupied.txt",
    "sed -i '' 's/x/y/' occupied.txt",
    "cd kit && printf x > ../occupied.txt",
    "sh -c 'printf x > occupied.txt'",
  ])("protects recognized shell writes: %s", async (command) => {
    await write("occupied.txt");
    expect((await evaluate("bash", { command }, neighbour))["decision"]).toBe("deny");
    expect((await evaluate("bash", { command }, neighbour))["reason"]).toContain("11111111");
  });

  it.each([
    "git switch feature",
    "git checkout feature",
    "git checkout -- .",
    "git stash",
    "git reset --hard",
    "git rebase main",
    "git clean -fd",
    "git worktree remove ../other",
    "git -C kit switch feature",
  ])("requires the affected neighbour's consent before %s", async (command) => {
    await write("occupied.txt");
    const result = await evaluate("bash", { command }, neighbour);
    expect(result["decision"]).toBe("deny");
    const proposal = result["coordination"] as { id: string; state: string };
    expect(proposal.state).toBe("waiting");
    const { items } = await send(service.paths.adminSock, { op: "pending" });
    expect(items).toEqual([]);
    await send(service.paths.hookSock, { op: "coordinate", call: call("coordinate", { action: "object", id: proposal.id, reason: "Uncommitted work" }) });
    expect((await evaluate("bash", { command }, neighbour))["decision"]).toBe("deny");
  });

  it("does not turn a lone session's locally safe checkout into an ask", async () => {
    await write("occupied.txt");
    expect((await evaluate("bash", { command: "git checkout feature" }))["decision"]).toBe("allow");
  });

  it("does not count sessions from another repository or a directory outside git", async () => {
    await write("occupied.txt", owner, path.dirname(agentDir));
    expect((await evaluate("bash", { command: "git checkout feature" }, neighbour))["decision"]).toBe("allow");
  });

  it("passes writes through the thin hook while keeping safe reads local", async () => {
    await write("occupied.txt");
    const result = await runThinHook({
      tool_name: "write", tool_input: { path: "occupied.txt", content: "new" }, session_id: neighbour, cwd: repo,
    }, { agentDir });
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(await runThinHook({ tool_name: "read", tool_input: { path: "occupied.txt" }, session_id: neighbour, cwd: repo }, { agentDir })).toEqual({});
  });

  it("retains P44 when the service cannot answer a write", async () => {
    await service.close();
    expect(await runThinHook({
      tool_name: "write", tool_input: { path: "occupied.txt", content: "new" }, session_id: neighbour, cwd: repo,
    }, { agentDir })).toEqual({});
  });

  it("resolves symlinked ancestors of a not-yet-created file", async () => {
    const link = path.join(path.dirname(agentDir), "repo-link");
    fs.symlinkSync(repo, link);
    await write("new-file.txt");
    expect((await write(path.join(link, "new-file.txt"), neighbour))["decision"]).toBe("deny");
  });

  it("releases only committed clean files, retaining failed and dirty writes", async () => {
    const cwd = makeScratchRepo(path.dirname(agentDir));
    vi.stubEnv("GIT_DIR", ".");
    const git = (...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    expect(git("rev-parse", "--show-toplevel")).toBe(cwd);
    await write("first.txt", owner, cwd);
    await write("second.txt", owner, cwd);
    fs.writeFileSync(path.join(cwd, "first.txt"), "first\n");
    fs.writeFileSync(path.join(cwd, "second.txt"), "second\n");
    expect(() => git("commit", "-m", "No staged files")).toThrow();
    expect((await write("first.txt", neighbour, cwd))["decision"]).toBe("deny");
    git("add", "first.txt");
    git("commit", "-m", "Commit the first file", "--", "first.txt");
    expect((await write("first.txt", neighbour, cwd))["decision"]).toBe("allow");
    expect((await write("second.txt", neighbour, cwd))["decision"]).toBe("deny");
    git("add", "second.txt");
    git("commit", "-m", "Commit the second file", "--", "second.txt");
    fs.appendFileSync(path.join(cwd, "second.txt"), "unfinished\n");
    expect((await write("second.txt", neighbour, cwd))["decision"]).toBe("deny");
  });

  it("does not share leases between two real repositories", async () => {
    const first = makeScratchRepo(path.dirname(agentDir));
    const second = makeScratchRepo(path.dirname(agentDir));
    vi.stubEnv("GIT_DIR", ".");
    for (const cwd of [first, second]) expect(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()).toBe(cwd);
    await write("same.txt", owner, first);
    expect((await write("same.txt", neighbour, second))["decision"]).toBe("allow");
    expect((await evaluate("bash", { command: "git checkout feature" }, neighbour, second))["decision"]).toBe("allow");
  });

  it("serializes competing writes without partially acquiring a rejected patch", async () => {
    const results = await Promise.all([write("raced.txt"), write("raced.txt", neighbour)]);
    expect(results.map((result) => result["decision"]).sort()).toEqual(["allow", "deny"]);
  });

  it("rechecks leases after a human answers a pending shell write", async () => {
    const { rules } = await send(service.paths.adminSock, { op: "rules.get" });
    await send(service.paths.adminSock, { op: "rules.set", rules: { ...rules, decider: { ...rules.decider, mode: "ask-me" } } });
    const pending = await evaluate("bash", { command: "rm -rf $TARGET > delayed.txt" }, neighbour);
    expect(pending["decision"]).toBe("pending");
    await write("delayed.txt");
    await send(service.paths.adminSock, { op: "answer", id: pending["id"], decision: "allow-once", by: "agent-tabs" });
    expect((await send(service.paths.hookSock, { op: "wait", id: pending["id"], ticket: pending["ticket"] })).decision).toBe("deny");
  });

  it("defers a shared-copy action when the person is away", async () => {
    await write("occupied.txt");
    const pending = await evaluate("bash", { command: "git checkout feature" }, neighbour);
    expect(pending["decision"]).toBe("deny");
    clock.advance(120_000);
    const human = await send(service.paths.adminSock, { op: "pending" });
    expect(human.items).toHaveLength(1);
    clock.advance(181_000);
    // An incoming request runs the same fake-clock maintenance as the periodic service tick.
    await evaluate("bash", { command: "git checkout feature" }, neighbour);
    const { items } = await send(service.paths.adminSock, { op: "deferred" });
    expect(items[0].reasons.join(" ")).toContain("11111111");
  });

  it("does not let a whitelist or a previous neighbour set bypass shared-copy consent", async () => {
    const { rules } = await send(service.paths.adminSock, { op: "rules.get" });
    rules.allow.push({ id: "user-coordination", pattern: "git checkout *", label: "fixture", user: true, scope: "git checkout *", denyIf: [] });
    expect((await send(service.paths.adminSock, { op: "rules.set", rules })).ok).toBe(true);
    await write("occupied.txt");
    const pending = await evaluate("bash", { command: "git checkout feature" }, neighbour);
    expect(pending["decision"]).toBe("deny");
    const proposal = pending["coordination"] as { id: string };
    await send(service.paths.hookSock, { op: "coordinate", call: call("coordinate", { action: "agree", id: proposal.id }) });
    await write("third.txt", "third-session");
    const changed = await evaluate("bash", { command: "git checkout feature" }, neighbour);
    expect(changed["decision"]).toBe("deny");
    expect((changed["coordination"] as { id: string }).id).not.toBe(proposal.id);
    const stale = await send(service.paths.hookSock, { op: "coordinate", call: call("coordinate", { action: "status", id: proposal.id }, neighbour) });
    expect(stale.state).toBe("cancelled");
  });

  it("measures the added hook latency per write against a local read", async () => {
    const reads: number[] = [];
    const writes: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      for (const [tool, durations] of [["read", reads], ["write", writes]] as const) {
        const began = performance.now();
        const result = await runThinHook({ tool_name: tool, tool_input: { path: "latency.txt", content: "x" }, session_id: owner, cwd: repo }, { agentDir });
        if (tool === "write") expect(result.hookSpecificOutput?.permissionDecision).toBe("allow");
        else expect(result).toEqual({});
        durations.push(performance.now() - began);
      }
    }
    const median = (values: number[]): number => Number((values.slice(1).sort((left, right) => left - right)[10] ?? 0).toFixed(2));
    const measurement = `COORDINATION_LATENCY ${JSON.stringify({ samples: 20, coldWriteMs: writes[0], readMedianMs: median(reads), writeMedianMs: median(writes), addedMedianMs: median(writes) - median(reads) })}`;
    console.log(measurement);
    if (process.env["AGENT_TABS_COORDINATION_EVIDENCE"]) fs.appendFileSync(process.env["AGENT_TABS_COORDINATION_EVIDENCE"], `${measurement}\n`);
  });
});
