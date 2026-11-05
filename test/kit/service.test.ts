import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM without types
import { servicePaths } from "../../kit/guard/service.mjs";
import { serviceMayRun } from "../../kit/guard/sockets.mjs";
// @ts-expect-error plain ESM without types
import { createTelegram } from "../../kit/guard/telegram.mjs";
// @ts-expect-error plain ESM without types
import { loadDefaultRules } from "../../kit/guard/rules.mjs";
import {
  CWD,
  DECIDER_MODEL,
  FakeGateway,
  KEY,
  SESSION,
  bash,
  evalCall,
  evaluate,
  evaluateMonitor,
  makeClock,
  makeSvcDir,
  readRules,
  removeSvcDirs,
  send,
  start,
  subscribe,
  until,
  type Clock,
} from "./serviceHelpers";

let agentDir: string;
let gateway: FakeGateway;
let clock: Clock;
let svc: { close(): Promise<void> } | undefined;
let paths: { hookSock: string; adminSock: string; rules: string; cache: string };

const hook = (message: unknown) => send(paths.hookSock, message);
const admin = (message: unknown) => send(paths.adminSock, message);

async function boot(rulesPatch: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  agentDir = makeSvcDir(rulesPatch);
  paths = servicePaths(agentDir);
  svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn, ...options });
}

beforeEach(() => {
  gateway = new FakeGateway();
  clock = makeClock();
});

afterEach(async () => {
  await svc?.close();
  svc = undefined;
  removeSvcDirs();
});

describe("decision service: hook socket", () => {
  it("an_allowed_call_is_answered_at_once", async () => {
    await boot();
    expect(await hook({ op: "evaluate", call: bash("ls") })).toEqual({ decision: "allow", reason: expect.any(String) });
    expect(gateway.requests).toHaveLength(0);
  });

  it("a_hard_deny_never_reaches_a_human", async () => {
    await boot();
    expect((await hook(evaluate("rm -rf /"))).decision).toBe("deny");
    expect(await admin({ op: "pending" })).toEqual({ items: [] });
    expect(gateway.requests).toHaveLength(0);
  });

  it("the_service_reclassifies_and_never_trusts_the_hook_tier", async () => {
    await boot();
    const call = { ...bash("rm -rf /"), tier: "allow" };
    expect((await hook({ op: "evaluate", call, tier: "allow" })).decision).toBe("deny");
  });

  it("deny_mode_denies_disputed_calls", async () => {
    await boot({ decider: { mode: "deny" } });
    expect(await hook(evaluate("rm -rf $U"))).toEqual({ decision: "deny", reason: expect.stringContaining("спорная команда запрещена настройками защиты") });
    expect(gateway.requests).toHaveLength(0);
    expect(await admin({ op: "pending" })).toEqual({ items: [] });
  });

  it("decider_allow_is_final_in_decider_mode", async () => {
    await boot();
    gateway.verdict = "allow";
    const sub = await subscribe(paths.adminSock);
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("allow");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.url).toBe("http://gw.test/api/v1/messages");
    expect(gateway.requests[0]!.body.model).toBe("claude-haiku-test");
    expect(await admin({ op: "pending" })).toEqual({ items: [] });
    // Ruling P5: a final decider verdict reaches subscribers, so the chat can show the «Решатель» step.
    const resolved = await until(() => sub.events.find((event) => event.event === "resolved"));
    expect(resolved).toMatchObject({
      decision: "allow",
      by: "decider",
      session: SESSION,
      decider: { model: DECIDER_MODEL, decision: "allow", reason: "решатель: allow", ms: expect.any(Number) },
    });
    expect(sub.events.map((event) => event.event)).toEqual(["resolved"]);
    sub.close();
  });

  it("decider_allow_is_cached_for_24_hours", async () => {
    await boot();
    gateway.verdict = "allow";
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("allow");
    gateway.verdict = "ask";
    clock.advance(23 * 3600_000);
    expect((await hook(evaluate("rm -rf $U", "other-session"))).decision).toBe("allow");
    expect(gateway.requests).toHaveLength(1);
    clock.advance(2 * 3600_000);
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("pending");
    expect(gateway.requests).toHaveLength(2);
  });

  it("a_decider_deny_is_never_final_it_goes_to_the_person_with_the_verdict_on_the_card", async () => {
    await boot();
    gateway.verdict = "deny";
    const sub = await subscribe(paths.adminSock);
    const { decision, id } = await hook(evaluate("rm -rf $U"));
    expect(decision).toBe("pending");
    const { items } = await admin({ op: "pending" });
    expect(items).toEqual([expect.objectContaining({ id, decider: { model: DECIDER_MODEL, decision: "deny", reason: "решатель: deny", ms: expect.any(Number) } })]);
    expect(fs.existsSync(paths.cache)).toBe(false);
    // Ruling P5: the resolved event still carries the decider's verdict.
    await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs" });
    const resolved = await until(() => sub.events.find((event) => event.event === "resolved"));
    expect(resolved).toMatchObject({ id, decision: "allow", by: "agent-tabs", decider: { decision: "deny", reason: "решатель: deny" } });
    sub.close();
  });

  it("an_old_cached_decider_deny_also_goes_to_the_person", async () => {
    await boot();
    gateway.verdict = "allow";
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("allow");
    const cache = JSON.parse(fs.readFileSync(paths.cache, "utf8"));
    for (const entry of Object.values(cache) as { decision: string }[]) entry.decision = "deny";
    fs.writeFileSync(paths.cache, JSON.stringify(cache));
    expect((await hook(evaluate("rm -rf $U", "other-session"))).decision).toBe("pending");
    expect(gateway.requests).toHaveLength(1);
  });

  it("decider_ask_goes_to_a_human_with_the_verdict_on_the_card", async () => {
    await boot();
    gateway.verdict = "ask";
    const { decision, id } = await hook(evaluate("rm -rf $U"));
    expect(decision).toBe("pending");
    const { items } = await admin({ op: "pending" });
    expect(items).toEqual([
      {
        id,
        session: SESSION,
        cwd: CWD,
        tool: "bash",
        command: "rm -rf $U",
        reasons: [expect.stringContaining("rm-rf-variable")],
        decider: { model: DECIDER_MODEL, decision: "ask", reason: "решатель: ask", ms: expect.any(Number) },
        createdAt: new Date(clock.t).toISOString(),
      },
    ]);
    expect(fs.existsSync(paths.cache)).toBe(false);
  });

  it("a_failing_decider_allows_and_logs_instead_of_asking", async () => {
    // P44: the person photographed a card whose only reason was «решатель ответил не по формату». Our infrastructure
    // failing is not evidence about the command, so it is logged and allowed, and no card is opened.
    await boot();
    for (const verdict of ["status500"] as const) {
      gateway.verdict = verdict;
      const out = await hook(evaluate(`rm -rf $U/o ${verdict}`));
      expect([verdict, out.decision], verdict).toEqual([verdict, "allow"]);
      expect([verdict, out.reason], verdict).toEqual([verdict, expect.stringContaining("решатель недоступен")]);
    }
    expect((await admin({ op: "pending" })).items).toHaveLength(0);
  });

  it("no_transport_allows_and_logs", async () => {
    await boot({ decider: { model: "nowhere/model-x" } });
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("allow");
    expect(gateway.requests).toHaveLength(0);
    expect((await admin({ op: "pending" })).items).toHaveLength(0);
  });

  it("a_docker_mount_of_home_is_for_the_person_only", async () => {
    await boot();
    gateway.verdict = "allow";
    const home = path.join(path.dirname(agentDir), "home");
    expect((await hook(evaluate(`docker run --rm -v ${home}:/h alpine ls /h`))).decision).toBe("pending");
    expect(gateway.requests).toHaveLength(0);
    const [item] = (await admin({ op: "pending" })).items;
    expect(item.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^docker-mount: /)]));
    expect(item.decider).toBeUndefined();
  });

  it("no_model_chosen_allows_and_skips_the_cache", async () => {
    await boot();
    gateway.verdict = "allow";
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("allow"); // cached by the model
    const rules = JSON.parse(readRules(agentDir));
    expect((await admin({ op: "rules.set", rules: { ...rules, decider: { ...rules.decider, model: "" } } })).ok).toBe(true);
    // No model is a configuration gap, not a verdict (P44): allowed, logged, and the model is never called.
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("allow");
    expect(gateway.requests).toHaveLength(1);
    expect((await admin({ op: "pending" })).items).toHaveLength(0);
  });

  it("ask_me_mode_skips_the_decider", async () => {
    await boot({ decider: { mode: "ask-me" } });
    gateway.verdict = "allow";
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("pending");
    expect(gateway.requests).toHaveLength(0);
  });

  it("allow_once_releases_one_call_only", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    const waiting = hook({ op: "wait", id, ticket });
    expect(await admin({ op: "answer", id, decision: "allow-once", by: "cli" })).toEqual({ ok: true });
    expect((await waiting).decision).toBe("allow");
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("pending");
  });

  it("a_human_deny_is_reused_for_the_same_call_within_60_s", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    const waiting = hook({ op: "wait", id, ticket });
    await admin({ op: "answer", id, decision: "deny", by: "agent-tabs" });
    expect((await waiting).decision).toBe("deny");
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("deny");
    clock.advance(61_000);
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("pending");
  });

  it("answer_reuse_window_60_s", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook({ op: "evaluate", call: evalCall('await tool.bash("rm -rf $U")') });
    const waiting = hook({ op: "wait", id, ticket });
    await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs" });
    expect((await waiting).decision).toBe("allow");
    // The eval's own bash call, same session, within 60 s: released.
    clock.advance(59_000);
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("allow");
    // Exactly one: a second bash is a new question.
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("pending");
  });

  it("one_action_costs_one_question_when_the_eval_runs_it_through_monitor", async () => {
    // P42. The person's two cards were one action: an `eval` calling tool.monitor({command}), and the inner command
    // asked again as its own Monitor card. The classifier now reads tool.monitor, so both hash to the same key.
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook({ op: "evaluate", call: evalCall('await tool.monitor({description:"d", command:"rm -rf $U"})') });
    const waiting = hook({ op: "wait", id, ticket });
    await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs" });
    expect((await waiting).decision).toBe("allow");
    expect((await hook(evaluateMonitor("rm -rf $U"))).decision).toBe("allow");
    // Still exactly one: a second monitor of the same command is a new question.
    expect((await hook(evaluateMonitor("rm -rf $U"))).decision).toBe("pending");
  });

  it("an_outer_allow_never_blesses_a_different_inner_command", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook({ op: "evaluate", call: evalCall('await tool.monitor({description:"d", command:"rm -rf $U"})') });
    const waiting = hook({ op: "wait", id, ticket });
    await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs" });
    await waiting;
    // A different command, through either door: its own question.
    expect((await hook(evaluateMonitor("rm -rf $V"))).decision).toBe("pending");
    expect((await hook(evaluate("rm -rf $V"))).decision).toBe("pending");
  });

  it("answer_reuse_window_60_s_needs_the_same_session_and_time", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook({ op: "evaluate", call: evalCall('await tool.bash("rm -rf $U")') });
    const waiting = hook({ op: "wait", id, ticket });
    await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs" });
    await waiting;
    expect((await hook(evaluate("rm -rf $U", "another-session"))).decision).toBe("pending");
    clock.advance(61_000);
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("pending");
  });

  it("an_open_request_is_shared_by_the_same_call", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const first = await hook(evaluate("rm -rf $U"));
    const second = await hook(evaluate("rm -rf $U"));
    expect(second).toEqual({ decision: "pending", id: first.id, ticket: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(second.ticket).not.toBe(first.ticket);
    expect((await admin({ op: "pending" })).items).toHaveLength(1);
  });

  it("the_hook_socket_cannot_answer", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id } = await hook(evaluate("rm -rf $U"));
    expect(await hook({ op: "answer", id, decision: "allow-once" })).toEqual({ error: "unknown op" });
    for (const op of ["pending", "rules.get", "rules.set", "subscribe", "status"]) expect(await hook({ op })).toEqual({ error: "unknown op" });
    expect((await admin({ op: "pending" })).items).toHaveLength(1);
  });

  it("unanswered_requests_are_denied_after_the_wait", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    const waiting = hook({ op: "wait", id, ticket });
    clock.advance(179_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await admin({ op: "pending" })).items).toHaveLength(1);
    clock.advance(2_000);
    expect(await waiting).toEqual({ decision: "deny", reason: expect.stringContaining("180") });
    expect(await admin({ op: "pending" })).toEqual({ items: [] });
  });

  it("service_restart_mid_wait_denies", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    const waiting = hook({ op: "wait", id, ticket });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await svc!.close();
    svc = undefined;
    expect((await waiting).decision).toBe("deny");
  });

  it("waiting_on_an_unknown_request_denies", async () => {
    await boot();
    expect((await hook({ op: "wait", id: "0123456789ab" })).decision).toBe("deny");
  });

  it("a_write_to_the_guard_files_is_denied", async () => {
    await boot();
    const call = { tool: "write", input: { path: path.join(agentDir, "guard", "rules.json") }, cwd: CWD, session: SESSION };
    expect((await hook({ op: "evaluate", call })).decision).toBe("deny");
    const elsewhere = { tool: "write", input: { path: "/work/proj/a.txt" }, cwd: CWD, session: SESSION };
    expect((await hook({ op: "evaluate", call: elsewhere })).decision).toBe("allow");
  });

  it("an_unknown_write_tool_asks_so_that_the_person_can_actually_approve_it", async () => {
    // Ruling P45: this used to be a flat deny, and a deny nobody can approve is the failure already fixed once for
    // the argv shape. The guard still cannot read what such a tool would write, so the call stops — but it stops at
    // a question, and the answer goes through: the card names the tool, and allowing it allows the call.
    await boot({ decider: { mode: "ask-me" } });
    const call = { tool: "fs_write_v2", input: {}, cwd: CWD, session: SESSION };
    const { decision, id } = await hook({ op: "evaluate", call });
    expect(decision).toBe("pending");
    const { items } = await admin({ op: "pending" });
    expect(items).toEqual([expect.objectContaining({ id, reasons: [expect.stringContaining("неизвестный инструмент записи")] })]);
    await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs" });
    expect(await admin({ op: "pending" })).toEqual({ items: [] });

    // And in the default mode the decider gets to answer it first, like any other disputed call.
    await svc!.close();
    svc = undefined;
    await boot();
    gateway.verdict = "allow";
    expect((await hook({ op: "evaluate", call: { tool: "runCommand", input: {}, cwd: CWD, session: SESSION } })).decision).toBe("allow");
    expect(gateway.requests).toHaveLength(1);
  });

  it("a_command_tool_without_its_command_is_denied", async () => {
    await boot();
    for (const call of [{ tool: "bash", input: {}, cwd: CWD, session: SESSION }, { tool: "eval", input: "ls", cwd: CWD, session: SESSION }]) {
      expect(await hook({ op: "evaluate", call })).toEqual({ decision: "deny", reason: expect.stringContaining("некорректный вызов инструмента") });
    }
  });

  it("commands_that_differ_only_in_dropped_options_never_share_a_cached_verdict", async () => {
    await boot();
    gateway.verdict = "allow";
    const commands = ["rm -rf $V", "cd /other && rm -rf $V", "rm -rf $V/a", "rm -rf $V $W"];
    for (const command of commands) await hook(evaluate(command));
    expect(gateway.requests).toHaveLength(commands.length);
    await hook(evaluate(commands[1]!));
    expect(gateway.requests).toHaveLength(commands.length);
  });
});

describe("decision service: admin socket", () => {
  it("answers_are_first_wins_and_checked", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id } = await hook(evaluate("rm -rf $U"));
    expect(await admin({ op: "answer", id, decision: "allow-once", by: "nobody" })).toMatchObject({ ok: false });
    expect(await admin({ op: "answer", id, decision: "allow", by: "cli" })).toMatchObject({ ok: false });
    expect(await admin({ op: "answer", id: "ffffffffffff", decision: "deny", by: "cli" })).toMatchObject({ ok: false });
    expect(await admin({ op: "answer", id, decision: "deny", by: "cli" })).toEqual({ ok: true });
    expect(await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs" })).toMatchObject({ ok: false });
  });

  it("a_deny_with_a_message_tells_the_agent_what_to_do_instead", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const sub = await subscribe(paths.adminSock);
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    const waiting = hook({ op: "wait", id, ticket });
    expect(await admin({ op: "answer", id, decision: "deny", by: "agent-tabs", message: `  сначала прогони npm test ${KEY}  ` })).toEqual({ ok: true });
    const reply = await waiting;
    expect(reply).toEqual({ decision: "deny", reason: "[guard] Человек: сначала прогони npm test ‹redacted›" });
    // the same call again within the reuse window gets the same words
    expect(await hook(evaluate("rm -rf $U"))).toEqual({ decision: "deny", reason: "[guard] Человек: сначала прогони npm test ‹redacted›" });
    const resolved = await until(() => sub.events.find((event) => event.event === "resolved"));
    expect(resolved).toMatchObject({ id, decision: "deny", by: "agent-tabs", message: "сначала прогони npm test ‹redacted›" });
    sub.close();
  });

  it("a_deny_message_is_checked", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id } = await hook(evaluate("rm -rf $U"));
    expect(await admin({ op: "answer", id, decision: "deny", by: "agent-tabs", message: "x".repeat(2001) })).toMatchObject({ ok: false });
    expect(await admin({ op: "answer", id, decision: "deny", by: "agent-tabs", message: 42 })).toMatchObject({ ok: false });
    expect(await admin({ op: "answer", id, decision: "deny", by: "agent-tabs", message: "   " })).toMatchObject({ ok: false });
    expect(await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs", message: "ok" })).toMatchObject({ ok: false });
    // nothing was taken as an answer: a valid one still wins
    expect(await admin({ op: "answer", id, decision: "deny", by: "agent-tabs", message: "x".repeat(2000) })).toEqual({ ok: true });
  });

  it("rules_set_validates_and_writes_nothing_on_error", async () => {
    await boot();
    const before = readRules(agentDir);
    const { rules } = await admin({ op: "rules.get" });
    const bad = { ...rules, askCustom: ["a*", "b*", "c*", "bad[glob"] };
    expect(await admin({ op: "rules.set", rules: bad })).toMatchObject({ ok: false, errors: [{ field: "askCustom", line: 4 }] });
    expect(readRules(agentDir)).toEqual(before);
    expect(await admin({ op: "status" })).toMatchObject({ version: expect.any(Number), protocol: 2, rulesOk: true });
  });

  it("rules_set_writes_valid_rules_and_takes_effect", async () => {
    await boot();
    const { rules } = await admin({ op: "rules.get" });
    expect(rules.version).toBe(2);
    expect(await admin({ op: "rules.set", rules: { ...rules, decider: { ...rules.decider, mode: "deny" } } })).toEqual({ ok: true });
    expect(JSON.parse(readRules(agentDir)).decider.mode).toBe("deny");
    expect((fs.statSync(paths.rules).mode & 0o777).toString(8)).toBe("600");
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("deny");
  });

  it("invalid_rules_on_disk_fail_closed", async () => {
    agentDir = makeSvcDir();
    fs.writeFileSync(path.join(agentDir, "guard", "rules.json"), JSON.stringify({ version: 2, hardDeny: "x" }));
    paths = servicePaths(agentDir);
    svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    expect(await admin({ op: "status" })).toMatchObject({ version: expect.any(Number), protocol: 2, kit: expect.any(String), rulesOk: false });
    expect((await hook(evaluate("ls"))).decision).toBe("deny");
  });

  it("subscribers_see_pending_and_resolved", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const sub = await subscribe(paths.adminSock);
    const { id } = await hook(evaluate("rm -rf $U"));
    await until(() => sub.events.length >= 1);
    await admin({ op: "answer", id, decision: "deny", by: "agent-tabs" });
    const events = await until(() => (sub.events.length >= 2 ? sub.events : undefined));
    expect(events.map((e) => e.event)).toEqual(["pending", "resolved"]);
    expect(events[0].item).toMatchObject({ id, session: SESSION, command: "rm -rf $U" });
    expect(events[1]).toMatchObject({ id, decision: "deny", by: "agent-tabs", session: SESSION });
    sub.close();
  });

  it("a_late_subscriber_sees_the_open_requests", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id } = await hook(evaluate("rm -rf $U"));
    const sub = await subscribe(paths.adminSock);
    const [event] = await until(() => (sub.events.length >= 1 ? sub.events : undefined));
    expect(event).toMatchObject({ event: "pending", item: { id } });
    sub.close();
  });

  it("a_timeout_is_a_resolved_event", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const sub = await subscribe(paths.adminSock);
    const { id } = await hook(evaluate("rm -rf $U"));
    clock.advance(181_000);
    expect(await until(() => sub.events.find((event) => event.event === "resolved"))).toMatchObject({ id, decision: "deny", by: "timeout" });
    sub.close();
  });

  it("pending_view_carries_no_key", async () => {
    await boot();
    gateway.verdict = "ask";
    const command = `rm -rf $U https://user:${KEY}@example.com/repo.git`;
    const sub = await subscribe(paths.adminSock);
    expect((await hook(evaluate(command))).decision).toBe("pending");
    const view = await admin({ op: "pending" });
    expect(view.items).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.items[0].command).toContain("‹redacted›");
    await until(() => sub.events.length >= 1);
    expect(JSON.stringify(sub.events)).not.toContain(KEY);
    // The decider sees the redacted command too.
    expect(JSON.stringify(gateway.requests.map((request) => request.body))).not.toContain(KEY);
    sub.close();
  });

  it("an_eval_shows_its_shell_commands_and_keeps_the_code_apart_both_redacted", async () => {
    await boot();
    gateway.verdict = "ask";
    const code = `const token = "${KEY}";\nawait tool.bash("rm -rf $U https://u:${KEY}@example.com/r.git");\nawait tool.bash("git status");`;
    expect((await hook({ op: "evaluate", call: evalCall(code) })).decision).toBe("pending");
    const [item] = (await admin({ op: "pending" })).items;
    expect(item.tool).toBe("eval");
    expect(item.command).toBe("rm -rf $U https://u:‹redacted›@example.com/r.git\ngit status");
    expect(item.code).toBe(code.split(KEY).join("‹redacted›"));
    // the decider gets the commands and the code apart, never the key
    const sent = JSON.stringify(gateway.requests[0]!.body);
    expect(sent).not.toContain(KEY);
    const data = JSON.parse(/<data-[0-9a-f]+>\n(.*)\n<\/data-/s.exec(gateway.requests[0]!.body.messages[0].content)![1]!);
    expect(data.command).toBe(item.command);
    expect(data.code).toBe(item.code);
    // a bash call has no code field
    expect((await hook(evaluate("rm -rf $U/o feature"))).decision).toBe("pending");
    expect((await admin({ op: "pending" })).items.find((other: { tool: string }) => other.tool === "bash")).not.toHaveProperty("code");
  });

  it("the_eval_code_is_capped_like_the_command", async () => {
    await boot({ decider: { mode: "ask-me" } });
    await hook({ op: "evaluate", call: evalCall(`await tool.bash("rm -rf $U");\n// ${"x".repeat(10_000)}`) });
    const [item] = (await admin({ op: "pending" })).items;
    expect(item.command).toBe("rm -rf $U");
    expect(item.code.length).toBe(4096);
  });

  it("the_pending_command_is_capped_at_4096_chars", async () => {
    await boot({ decider: { mode: "ask-me" } });
    await hook(evaluate(`rm -rf $U ${"x".repeat(10_000)}`));
    const [item] = (await admin({ op: "pending" })).items;
    expect(item.command.length).toBeLessThanOrEqual(4096);
  });
});

describe("decision service: telegram", () => {
  it("a_human_question_goes_to_telegram_and_a_button_answers_it", async () => {
    const calls: { method: string; params: any }[] = [];
    let pressed: string | undefined;
    const transport = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "sendMessage") return { ok: true, result: {} };
      if (method === "getUpdates" && pressed) {
        const data = pressed;
        pressed = undefined;
        return { ok: true, result: [{ update_id: 7, callback_query: { id: "q", data, message: { chat: { id: 42 } }, from: { id: 1 } } }] };
      }
      return { ok: true, result: [] };
    };
    const telegram = createTelegram({ token: "t", chatId: "42" }, transport);
    await boot({ decider: { mode: "ask-me" }, human: { telegram: true } }, { telegram, telegramPollMs: 10 });
    const sub = await subscribe(paths.adminSock);
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    await until(() => calls.some((call) => call.method === "sendMessage"));
    expect(JSON.stringify(calls.find((call) => call.method === "sendMessage")!.params)).toContain(`ag:a:${id}`);
    const waiting = hook({ op: "wait", id, ticket });
    pressed = `ag:a:${id}`;
    expect((await waiting).decision).toBe("allow");
    expect(await until(() => sub.events.find((event) => event.event === "resolved"))).toMatchObject({ id, by: "telegram" });
    sub.close();
  });
});

describe("decision service: telegram per environment", () => {
  it("the_bot_token_comes_from_the_key_file_and_the_chat_from_the_rules", async () => {
    const sent: { url: string; body: any }[] = [];
    const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
      if (!String(url).startsWith("https://api.telegram.org/")) return gateway.fetchFn(url, init);
      const body = JSON.parse(String(init.body ?? "{}"));
      sent.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true, result: String(url).endsWith("/getUpdates") ? [] : {} }));
    };
    agentDir = makeSvcDir({ decider: { mode: "ask-me" }, human: { telegram: true, telegramChat: "42" } });
    fs.writeFileSync(path.join(agentDir, "keys", "telegram.key"), "123456:key-file-token-abcdefghij", { mode: 0o600 });
    paths = servicePaths(agentDir);
    svc = await start(agentDir, { now: clock.now, fetchFn, telegram: undefined, tgEnvPath: path.join(agentDir, "no-tg.env"), telegramSendMs: 0 });
    await hook(evaluate("rm -rf $U"));
    const first = await until(() => sent.find((call) => call.url.endsWith("/sendMessage")));
    expect(first.url).toBe("https://api.telegram.org/bot123456:key-file-token-abcdefghij/sendMessage");
    expect(first.body.chat_id).toBe("42");

    // the chat follows the rules the service owns
    const { rules } = await admin({ op: "rules.get" });
    expect(await admin({ op: "rules.set", rules: { ...rules, human: { ...rules.human, telegramChat: "77" } } })).toEqual({ ok: true });
    await hook(evaluate("rm -rf $U --force"));
    const second = await until(() => sent.filter((call) => call.url.endsWith("/sendMessage"))[1]);
    expect(second.body.chat_id).toBe("77");
  });
});

describe("decision service: sockets", () => {
  it("socket_files_are_0600_in_a_0700_dir", async () => {
    await boot();
    expect((fs.statSync(path.dirname(paths.hookSock)).mode & 0o777).toString(8)).toBe("700");
    expect((fs.statSync(paths.hookSock).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(paths.adminSock).mode & 0o777).toString(8)).toBe("600");
    expect(paths.hookSock).toBe(path.join(agentDir, "guard", "hook.sock"));
    expect(paths.adminSock).toBe(path.join(agentDir, "guard", "admin.sock"));
  });

  it("a_socket_path_longer_than_103_bytes_fails_startup_naming_it", async () => {
    agentDir = makeSvcDir();
    const deep = path.join(agentDir, "x".repeat(90));
    fs.mkdirSync(deep);
    await expect(start(deep)).rejects.toThrow(path.join(deep, "guard", "hook.sock"));
  });

  it("stale_socket_files_are_unlinked_at_start", async () => {
    agentDir = makeSvcDir();
    paths = servicePaths(agentDir);
    fs.writeFileSync(paths.hookSock, "stale");
    fs.writeFileSync(paths.adminSock, "stale");
    svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    expect((await hook(evaluate("ls"))).decision).toBe("allow");
  });

  it("a_second_service_on_the_same_agent_dir_refuses_to_start", async () => {
    await boot();
    await expect(start(agentDir)).rejects.toThrow(/уже запущена/);
    expect((await hook(evaluate("ls"))).decision).toBe("allow");
  });

  it("close_removes_the_socket_files", async () => {
    await boot();
    await svc!.close();
    svc = undefined;
    expect(fs.existsSync(paths.hookSock)).toBe(false);
    expect(fs.existsSync(paths.adminSock)).toBe(false);
  });

  it("garbage_on_the_hook_socket_is_an_error_not_a_crash", async () => {
    await boot();
    const reply = await new Promise<string>((resolve) => {
      const socket = net.createConnection(paths.hookSock, () => socket.write("not json\n"));
      let buffer = "";
      socket.on("data", (chunk) => (buffer += chunk));
      socket.on("close", () => resolve(buffer));
    });
    expect(JSON.parse(reply)).toEqual({ error: "bad request" });
    expect((await hook(evaluate("ls"))).decision).toBe("allow");
  });
});

describe("decision service: rules file", () => {
  it("a_missing_rules_file_means_the_defaults", async () => {
    agentDir = makeSvcDir();
    fs.rmSync(path.join(agentDir, "guard", "rules.json"));
    paths = servicePaths(agentDir);
    svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    expect(await admin({ op: "status" })).toMatchObject({ rulesOk: true });
    expect((await hook(evaluate("rm -rf /"))).decision).toBe("deny");
  });

  it("a_rules_write_that_lands_while_the_service_starts_is_picked_up", async () => {
    agentDir = makeSvcDir();
    paths = servicePaths(agentDir);
    const later = { ...JSON.parse(fs.readFileSync(paths.rules, "utf8")), askCustom: ["written while starting"] };
    const read = fs.readFileSync;
    let first = true;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const content = read(file, options as BufferEncoding);
      if (first && file === paths.rules) {
        first = false;
        fs.writeFileSync(paths.rules, JSON.stringify(later)); // the extension's write right after the service's first read
      }
      return content;
    }) as typeof fs.readFileSync);
    try {
      svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    } finally {
      spy.mockRestore();
    }
    expect(first).toBe(false);
    expect((await admin({ op: "rules.get" })).rules.askCustom).toEqual(["written while starting"]);
  });
});

describe("serviceMayRun", () => {
  it("a_fresh_lock_or_a_live_socket_means_a_service_may_own_the_rules", async () => {
    agentDir = makeSvcDir();
    paths = servicePaths(agentDir);
    expect(await serviceMayRun(agentDir)).toBe(false);
    fs.writeFileSync(path.join(agentDir, "guard", "service.lock"), "{}");
    expect(await serviceMayRun(agentDir)).toBe(true); // starting: no socket yet
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(agentDir, "guard", "service.lock"), old, old);
    expect(await serviceMayRun(agentDir)).toBe(false); // stale: its holder never answered
    fs.rmSync(path.join(agentDir, "guard", "service.lock"));
    svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    expect(await serviceMayRun(agentDir)).toBe(true);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("decision service: limits on what the sandbox can reach", () => {
  it("open_requests_are_capped_per_session_and_in_total", async () => {
    await boot({ decider: { mode: "ask-me" } });
    for (let index = 0; index < 10; index += 1) expect((await hook(evaluate(`rm -rf $U/o b${index}`))).decision).toBe("pending");
    expect(await hook(evaluate("rm -rf $U/o b10"))).toEqual({ decision: "deny", reason: expect.stringContaining("слишком много ожидающих решений") });
    for (let session = 1; session < 5; session += 1) {
      for (let index = 0; index < 10; index += 1) expect((await hook(evaluate(`rm -rf $U/o b${index}`, `s${session}`))).decision).toBe("pending");
    }
    expect((await hook(evaluate("rm -rf $U/o x", "s9"))).reason).toContain("слишком много ожидающих решений");
    expect((await admin({ op: "pending" })).items).toHaveLength(50);
  });

  it("decider_calls_are_bounded_and_overflow_is_allowed", async () => {
    await boot();
    gateway.verdict = "allow";
    gateway.hold = true;
    const calls = Array.from({ length: 10 }, (_, index) => hook(evaluate(`rm -rf $U/c${index}`, `s${index}`)));
    await until(() => gateway.requests.length === 2);
    await sleep(150);
    expect(gateway.requests).toHaveLength(2);
    // 2 running + 8 queued: the next call does not wait for the decider.
    const overflow = await hook(evaluate("rm -rf $U/overflow", "sx"));
    expect(overflow.decision).toBe("allow"); // P44: our own queue being full is not a question for the person
    expect((await admin({ op: "pending" })).items).toHaveLength(0);
    gateway.release();
    expect((await Promise.all(calls)).map((result) => result.decision)).toEqual(Array(10).fill("allow"));
    expect(gateway.requests).toHaveLength(10);
  });

  it("identical_calls_share_one_decider_call", async () => {
    await boot();
    gateway.verdict = "allow";
    gateway.hold = true;
    const calls = ["s1", "s2", "s3"].map((session) => hook(evaluate("rm -rf $U", session)));
    await until(() => gateway.requests.length === 1);
    await sleep(100);
    gateway.release();
    expect((await Promise.all(calls)).map((result) => result.decision)).toEqual(["allow", "allow", "allow"]);
    expect(gateway.requests).toHaveLength(1);
  });

  it("telegram_sends_are_rate_limited_and_duplicates_collapse", async () => {
    const sent: any[] = [];
    const transport = async (method: string, params: any) => {
      if (method === "sendMessage") sent.push(params);
      return { ok: true, result: method === "getUpdates" ? [] : {} };
    };
    const telegram = createTelegram({ token: "t", chatId: "42" }, transport);
    await boot({ decider: { mode: "ask-me" }, human: { telegram: true } }, { telegram, telegramSendMs: 300 });
    await hook(evaluate("rm -rf $U/o a", "s1"));
    await hook(evaluate("rm -rf $U/o b", "s1"));
    await hook(evaluate("rm -rf $U/o a", "s2"));
    await sleep(100);
    expect(sent).toHaveLength(1);
    await until(() => sent.length === 2);
    await sleep(700);
    expect(sent).toHaveLength(2);
    expect((await admin({ op: "pending" })).items).toHaveLength(3);
  });

  it("an_idle_hook_connection_is_dropped_but_a_wait_is_not", async () => {
    await boot({ decider: { mode: "ask-me" } }, { requestDeadlineMs: 50 });
    const closedAfter = await new Promise<number>((resolve) => {
      const started = Date.now();
      const socket = net.createConnection(paths.hookSock);
      socket.on("close", () => resolve(Date.now() - started));
      socket.on("error", () => undefined);
    });
    expect(closedAfter).toBeLessThan(1000);
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    const waiting = hook({ op: "wait", id, ticket });
    await sleep(200);
    await admin({ op: "answer", id, decision: "allow-once", by: "cli" });
    expect((await waiting).decision).toBe("allow");
  });

  it("a_byte_trickle_does_not_extend_the_request_deadline", async () => {
    await boot({}, { requestDeadlineMs: 300 });
    const closedAfter = await new Promise<number>((resolve) => {
      const started = Date.now();
      const socket = net.createConnection(paths.hookSock);
      const trickle = setInterval(() => socket.write("{"), 100); // never a full line
      socket.on("close", () => {
        clearInterval(trickle);
        resolve(Date.now() - started);
      });
      socket.on("error", () => undefined);
    });
    expect(closedAfter).toBeGreaterThanOrEqual(250);
    expect(closedAfter).toBeLessThan(1000);
  });

  it("tickets_per_request_are_capped", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const first = await hook(evaluate("rm -rf $U"));
    for (let index = 1; index < 16; index += 1) expect(await hook(evaluate("rm -rf $U"))).toMatchObject({ decision: "pending", id: first.id });
    expect(await hook(evaluate("rm -rf $U"))).toEqual({ decision: "deny", reason: expect.stringContaining("слишком много вызовов") });
    // Spent tickets free their place.
    const waiting = hook({ op: "wait", id: first.id, ticket: first.ticket });
    await sleep(50);
    await admin({ op: "answer", id: first.id, decision: "deny", by: "cli" });
    expect((await waiting).decision).toBe("deny");
  });

  it("the_card_cwd_is_capped", async () => {
    await boot({ decider: { mode: "ask-me" } });
    await hook({ op: "evaluate", call: { ...bash("rm -rf $U"), cwd: `/w/${"d".repeat(10_000)}` } });
    const [item] = (await admin({ op: "pending" })).items;
    expect(item.cwd.length).toBeLessThanOrEqual(4096);
  });
});

describe("decision service: wait tickets", () => {
  it("a_wait_without_the_callers_ticket_gets_an_error_and_consumes_nothing", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    await admin({ op: "answer", id, decision: "allow-once", by: "agent-tabs" });
    expect(await hook({ op: "wait", id })).toEqual({ error: expect.any(String) });
    expect(await hook({ op: "wait", id, ticket: "0".repeat(32) })).toEqual({ error: expect.any(String) });
    expect((await hook({ op: "wait", id, ticket })).decision).toBe("allow");
    // A ticket is spent once it has been answered.
    expect(await hook({ op: "wait", id, ticket })).toEqual({ error: expect.any(String) });
  });

  it("a_shared_request_settles_each_caller_with_its_own_tool", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const fromEval = await hook({ op: "evaluate", call: evalCall('await tool.bash("rm -rf $U")') });
    const fromBash = await hook(evaluate("rm -rf $U"));
    expect(fromBash.id).toBe(fromEval.id);
    const waits = [hook({ op: "wait", id: fromEval.id, ticket: fromEval.ticket }), hook({ op: "wait", id: fromBash.id, ticket: fromBash.ticket })];
    await sleep(50);
    await admin({ op: "answer", id: fromEval.id, decision: "allow-once", by: "agent-tabs" });
    expect((await Promise.all(waits)).map((result) => result.decision)).toEqual(["allow", "allow"]);
    expect((await hook(evaluate("rm -rf $U"))).decision).toBe("pending");
  });
});

describe("decision service: robustness", () => {
  it("an_admin_handler_error_is_a_reply_not_a_crash", async () => {
    agentDir = makeSvcDir();
    const rules = path.join(agentDir, "guard", "rules.json");
    fs.rmSync(rules);
    fs.mkdirSync(rules); // writeJsonAtomic cannot rename a file over a directory
    paths = servicePaths(agentDir);
    svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    expect(await admin({ op: "rules.set", rules: loadDefaultRules() })).toEqual({ ok: false, error: expect.any(String) });
    expect(await admin({ op: "status" })).toMatchObject({ version: expect.any(Number), protocol: 2, kit: expect.any(String), rulesOk: false });
  });

  it("one_service_per_agent_dir_even_when_started_concurrently", async () => {
    agentDir = makeSvcDir();
    paths = servicePaths(agentDir);
    const results = await Promise.allSettled([start(agentDir), start(agentDir)]);
    const started = results.filter((result) => result.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const refused = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String(refused[0]!.reason.message)).toMatch(/уже запущена/);
    svc = started[0]!.value;
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "guard", "service.lock"), "utf8"))).toMatchObject({ pid: process.pid });
    expect((await hook(evaluate("ls"))).decision).toBe("allow");
    await svc!.close();
    svc = undefined;
    expect(fs.existsSync(path.join(agentDir, "guard", "service.lock"))).toBe(false);
  });

  const lockFile = () => path.join(agentDir, "guard", "service.lock");
  const backdate = (file: string, ms: number) => {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(file, when, when);
  };

  it("a_lock_whose_pid_is_alive_but_whose_service_is_gone_is_replaced", async () => {
    agentDir = makeSvcDir();
    paths = servicePaths(agentDir);
    // After a reboot the old pid may belong to anything alive, e.g. this test runner's parent.
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, startedAt: Date.now() - 60_000 }));
    backdate(lockFile(), 60_000);
    svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    expect(JSON.parse(fs.readFileSync(lockFile(), "utf8"))).toMatchObject({ pid: process.pid });
    expect((await hook(evaluate("ls"))).decision).toBe("allow");
  });

  it("an_old_lock_of_a_live_service_is_respected", async () => {
    await boot();
    backdate(lockFile(), 60_000);
    await expect(start(agentDir)).rejects.toThrow(/уже запущена/);
    expect((await hook(evaluate("ls"))).decision).toBe("allow");
  });

  it("an_empty_lock_is_a_starting_service_for_10_s_then_stale", async () => {
    agentDir = makeSvcDir();
    paths = servicePaths(agentDir);
    fs.writeFileSync(lockFile(), "");
    await expect(start(agentDir)).rejects.toThrow(/уже запущена или запускается/);
    expect(fs.existsSync(paths.hookSock)).toBe(false);
    backdate(lockFile(), 11_000);
    svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    expect((await hook(evaluate("ls"))).decision).toBe("allow");
  });

  it("a_service_closing_slowly_leaves_a_new_services_sockets_and_lock_alone", async () => {
    await boot({ decider: { mode: "ask-me" } });
    const first = svc!;
    const { id, ticket } = await hook(evaluate("rm -rf $U"));
    // A waiter that never closes its end keeps the first service's close() waiting for the grace period.
    const lingering = net.createConnection(paths.hookSock, () => lingering.write(`${JSON.stringify({ op: "wait", id, ticket })}\n`));
    lingering.on("error", () => undefined);
    await sleep(50);
    backdate(lockFile(), 60_000);
    const closing = first.close();
    svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn });
    await closing;
    lingering.destroy();
    expect(fs.existsSync(paths.hookSock)).toBe(true);
    expect(fs.existsSync(paths.adminSock)).toBe(true);
    expect(fs.existsSync(lockFile())).toBe(true);
    expect((await hook(evaluate("ls"))).decision).toBe("allow");
    expect(await admin({ op: "status" })).toMatchObject({ rulesOk: true });
  });

  it("a_failed_start_removes_only_its_own_lock", async () => {
    agentDir = makeSvcDir();
    paths = servicePaths(agentDir);
    fs.mkdirSync(path.dirname(paths.adminSock), { recursive: true });
    // Something live on admin.sock makes the start fail after hook.sock listens; on its probe it may take the lock over.
    let takeOver = false;
    const squatter = net.createServer((socket) => {
      if (takeOver) fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, token: "someone-else" }));
      socket.destroy();
    });
    await new Promise<void>((resolve) => squatter.listen(paths.adminSock, resolve));
    try {
      await expect(start(agentDir)).rejects.toThrow(/уже запущена/);
      expect(fs.existsSync(lockFile())).toBe(false);
      takeOver = true;
      await expect(start(agentDir)).rejects.toThrow(/уже запущена/);
      expect(JSON.parse(fs.readFileSync(lockFile(), "utf8"))).toMatchObject({ token: "someone-else" });
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it("every_secret_the_service_can_see_is_redacted_and_reasons_are_capped", async () => {
    const envKey = "env-SECRET-abcdef0123456789";
    const tgToken = "123456:TG-SECRET-abcdefghijklmnop";
    const accountToken = "acct-SECRET-0123456789abcdef";
    const listedToken = "list-SECRET-0123456789abcdef";
    const nestedToken = "nest-SECRET-0123456789abcdef";
    process.env["AGS_TEST_GW_KEY"] = envKey;
    try {
      agentDir = makeSvcDir({ decider: { mode: "ask-me" }, askCustom: [`deploy ${"y".repeat(500)}`] });
      const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
      models.providers.envgw = { baseUrl: "http://env.test", api: "openai-completions", apiKey: "$AGS_TEST_GW_KEY" };
      fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models));
      fs.mkdirSync(path.join(agentDir, "anthropic-subscription-accounts", "work"), { recursive: true });
      fs.writeFileSync(path.join(agentDir, "anthropic-subscription-accounts", "work", "credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: accountToken }, tokens: [listedToken], accounts: [{ refresh: nestedToken }] }));
      const tgEnv = path.join(path.dirname(agentDir), "tg.env");
      fs.writeFileSync(tgEnv, `TG_BOT_TOKEN=${tgToken}\nTG_CHAT_ID=1\n`);
      const keyFileTgToken = "654321:TG-KEYFILE-abcdefghijklmnop";
      fs.writeFileSync(path.join(agentDir, "keys", "telegram.key"), keyFileTgToken, { mode: 0o600 });
      paths = servicePaths(agentDir);
      svc = await start(agentDir, { now: clock.now, fetchFn: gateway.fetchFn, tgEnvPath: tgEnv });
      const command = `deploy ${"y".repeat(500)} https://x:${envKey}@h/${tgToken}/${accountToken}/${listedToken}/${nestedToken}/${keyFileTgToken}`;
      expect((await hook(evaluate(command))).decision).toBe("pending");
      const view = await admin({ op: "pending" });
      const text = JSON.stringify(view);
      for (const secret of [envKey, tgToken, accountToken, listedToken, nestedToken, keyFileTgToken]) expect(text).not.toContain(secret);
      expect(view.items[0].reasons.length).toBeGreaterThan(0);
      for (const reason of view.items[0].reasons) expect(reason.length).toBeLessThanOrEqual(300);
    } finally {
      delete process.env["AGS_TEST_GW_KEY"];
    }
  });
});
