import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { servicePaths } from "../../kit/guard/service.mjs";
import { bash, evaluate, makeClock, makeSvcDir, readRules, removeSvcDirs, send, start, subscribe, until, type Clock } from "./serviceHelpers";

let agentDir: string;
let clock: Clock;
let svc: { close(): Promise<void> } | undefined;
let paths: { hookSock: string; adminSock: string; rules: string };

const hook = (message: unknown) => send(paths.hookSock, message);
const admin = (message: unknown) => send(paths.adminSock, message);

async function boot(rulesPatch: Record<string, unknown> = {}) {
  agentDir = makeSvcDir({ decider: { mode: "ask-me" }, ...rulesPatch });
  paths = servicePaths(agentDir);
  svc = await start(agentDir, { now: clock.now });
}

beforeEach(() => {
  clock = makeClock();
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  removeSvcDirs();
});

describe("whitelist from the card", () => {
  it("«allow-always» writes the proposed shape and allows this call", async () => {
    await boot();
    const pending = await hook(evaluate("rm -rf $BUILD_DIR"));
    expect(pending.decision).toBe("pending");
    const { items } = await admin({ op: "pending" });
    expect(items[0].proposal).toEqual([{ scope: "rm -rf *", label: "всегда разрешать: rm -rf *" }]);

    const answer = await admin({ op: "answer", id: pending.id, decision: "allow-always", by: "agent-tabs" });
    expect(answer).toEqual({ ok: true });
    const waited = await hook({ op: "wait", id: pending.id, ticket: pending.ticket });
    expect(waited.decision).toBe("allow");

    const rules = JSON.parse(readRules(agentDir));
    const entry = rules.allow.find((item: { scope?: string }) => item.scope === "rm -rf *");
    expect(entry).toMatchObject({ user: true, scope: "rm -rf *", denyIf: [] });
  });

  it("a later matching command is allowed with no card and is published as a whitelist allow", async () => {
    await boot();
    const first = await hook(evaluate("rm -rf $BUILD_DIR"));
    await admin({ op: "answer", id: first.id, decision: "allow-always", by: "agent-tabs" });
    await hook({ op: "wait", id: first.id, ticket: first.ticket });

    const sub = await subscribe(paths.adminSock);
    const again = await hook(evaluate("rm -rf $OTHER_DIR", "fresh-session"));
    expect(again.decision).toBe("allow");
    expect(again.reason).toContain("вайтлист");
    const event = await until(() => sub.events.find((entry) => entry.event === "resolved" && entry.by === "whitelist"));
    expect(event).toMatchObject({ decision: "allow", by: "whitelist", whitelist: { scopes: ["rm -rf *"] } });
    sub.close();
  });

  it("whitelisting never opens a deny: rm -rf / is still denied after the entry exists", async () => {
    await boot();
    const first = await hook(evaluate("rm -rf $BUILD_DIR"));
    await admin({ op: "answer", id: first.id, decision: "allow-always", by: "agent-tabs" });
    await hook({ op: "wait", id: first.id, ticket: first.ticket });
    expect((await hook(evaluate("rm -rf /"))).decision).toBe("deny");
  });

  it("«allow-always» on a request with no shape to pin is refused", async () => {
    await boot();
    const pending = await send(paths.hookSock, { op: "evaluate", call: bash("ssh host 'pkill -f worker'") });
    expect(pending.decision).toBe("pending");
    const { items } = await admin({ op: "pending" });
    expect(items[0].proposal).toBeUndefined();
    expect(await admin({ op: "answer", id: pending.id, decision: "allow-always", by: "agent-tabs" })).toMatchObject({ ok: false });
  });
});
