import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { runThinHook } from "../../kit/guard/thinHook.mjs";
// @ts-expect-error plain ESM without types
import { installGuardFiles } from "../../kit/guard/install.mjs";
import { readLines, servicePaths, writeLine } from "../../kit/guard/sockets.mjs";
import { KIT } from "./helpers";
import { SESSION, homeOf, makeSvcDir, removeSvcDirs, send, start, writeRules } from "./serviceHelpers";

/** Open admin requests, polled until there is one. */
async function pendingItems(adminSock: string): Promise<any[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const { items } = await send(adminSock, { op: "pending" });
    if (items.length > 0) return items;
    if (Date.now() > deadline) throw new Error("no pending request in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** An object is sent as one JSON line; `{ raw }` is written as is; "drop" closes without a reply; "hang" never answers. */
type Reply = Record<string, unknown> | { raw: string } | "drop" | "hang";

/** A hook-socket look-alike: records every connection and call, answers `answer` to evaluate and `waitAnswer` to wait. */
class FakeService {
  connections = 0;
  seen: any[] = [];
  waits: any[] = [];
  answer: Reply = { decision: "allow", reason: "[guard] разрешено" };
  waitAnswer: Reply = { decision: "deny", reason: "[guard] человек запретил (agent-tabs)" };
  private server?: net.Server;
  async listen(file: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.server = net.createServer((socket) => {
      this.connections += 1;
      readLines(socket, (message: any) => {
        if (message?.op === "evaluate") this.seen.push(message.call);
        if (message?.op === "wait") this.waits.push(message);
        const reply = message?.op === "wait" ? this.waitAnswer : this.answer;
        if (reply === "drop") socket.destroy();
        else if (reply !== "hang") {
          if ("raw" in reply) socket.write(String(reply.raw));
          else writeLine(socket, reply);
          socket.end();
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(file, resolve));
  }
  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

let agentDir: string;
let home: string;
let svc: FakeService;
let opts: { agentDir: string; home: string };

const bash = (command: string) => ({ tool_name: "bash", tool_input: { command }, cwd: "/work/proj", session_id: SESSION, tool_use_id: "t1" });
const call = (tool_name: string, tool_input: unknown) => ({ tool_name, tool_input, cwd: "/work/proj", session_id: SESSION, tool_use_id: "t1" });
const decision = (out: any) => ({
  permissionDecision: out.hookSpecificOutput?.permissionDecision,
  permissionDecisionReason: out.hookSpecificOutput?.permissionDecisionReason,
});
const reason = (out: any): string => out.hookSpecificOutput?.permissionDecisionReason ?? "";
const hookSock = () => servicePaths(agentDir).hookSock;

beforeEach(async () => {
  agentDir = makeSvcDir();
  home = homeOf(agentDir);
  opts = { agentDir, home };
  svc = new FakeService();
  await svc.listen(hookSock());
});

afterEach(async () => {
  await svc.close();
  removeSvcDirs();
});

describe("thin hook", () => {
  it("a_safe_call_is_allowed_without_the_service", async () => {
    expect(await runThinHook(bash("git status"), opts)).toEqual({});
    expect(await runThinHook(call("grep", { pattern: "git push" }), opts)).toEqual({});
    expect(await runThinHook(call("write", { path: "/work/proj/a.txt", content: "x" }), opts)).toEqual({});
    expect(svc.connections).toBe(0);
  });

  it("session_start_gets_the_nested_sandbox_note_without_the_service", async () => {
    const out = await runThinHook({ hook_event_name: "SessionStart", session_id: SESSION, cwd: "/work/proj", source: "startup" }, opts);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    const note: string = out.hookSpecificOutput.additionalContext;
    expect(note).toContain("swift build|test|run --disable-sandbox");
    expect(note).toContain("-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePackageSandbox=YES");
    expect(note).toMatch(/git clone.*git init.*git remote add.*git config.*попросите человека/s);
    expect(svc.connections).toBe(0);
  });

  it("a_disputed_call_goes_to_the_service", async () => {
    svc.answer = { decision: "deny", reason: "нет" };
    expect(decision(await runThinHook(bash("git push"), opts))).toEqual({ permissionDecision: "deny", permissionDecisionReason: "[guard] нет" });
    expect(svc.seen).toEqual([{ tool: "bash", input: { command: "git push" }, cwd: "/work/proj", session: SESSION }]);
  });

  it("a_service_allow_is_an_explicit_allow", async () => {
    svc.answer = { decision: "allow", reason: "[guard] решатель разрешил: ок" };
    expect(decision(await runThinHook(bash("git push"), opts))).toEqual({ permissionDecision: "allow", permissionDecisionReason: "[guard] решатель разрешил: ок" });
  });

  it("a_pending_call_waits_with_its_ticket", async () => {
    svc.answer = { decision: "pending", id: "r1", ticket: "tk-1" };
    svc.waitAnswer = { decision: "allow", reason: "[guard] человек разрешил один раз (agent-tabs)" };
    const out = await runThinHook(bash("git push"), opts);
    expect(decision(out)).toEqual({ permissionDecision: "allow", permissionDecisionReason: "[guard] человек разрешил один раз (agent-tabs)" });
    expect(svc.waits).toEqual([{ op: "wait", id: "r1", ticket: "tk-1" }]);
  });

  it("a_connection_drop_mid_wait_denies", async () => {
    svc.answer = { decision: "pending", id: "r1", ticket: "tk-1" };
    svc.waitAnswer = "drop";
    const out = await runThinHook(bash("git push"), opts);
    expect(decision(out).permissionDecision).toBe("deny");
    expect(reason(out)).toContain("[guard]");
  });

  it("no_answer_within_the_budget_denies", async () => {
    svc.answer = { decision: "pending", id: "r1", ticket: "tk-1" };
    svc.waitAnswer = "hang";
    const t0 = Date.now();
    const out = await runThinHook(bash("git push"), { ...opts, budgetMs: 300 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(decision(out).permissionDecision).toBe("deny");
    expect(reason(out)).toContain("нет ответа службы защиты");
  });

  it("an_error_reply_denies", async () => {
    svc.answer = { error: "unknown op" };
    const out = await runThinHook(bash("git push"), opts);
    expect(decision(out).permissionDecision).toBe("deny");
    expect(reason(out)).toContain("unknown op");
  });

  it("non_json_partial_null_and_malformed_replies_deny", async () => {
    const replies: Reply[] = [{ raw: "garbage\n" }, { raw: '{"decision":"al' }, { raw: "null\n" }, { raw: "[]\n" }, { decision: "maybe" }, { decision: "pending" }];
    for (const reply of replies) {
      svc.answer = reply;
      const out = await runThinHook(bash("git push"), opts);
      expect([reply, decision(out).permissionDecision]).toEqual([reply, "deny"]);
      expect(reason(out).startsWith("[guard] ")).toBe(true);
    }
  });

  it("a_reason_that_is_not_a_string_is_shown_safely", async () => {
    for (const bad of [{ x: 1 }, null, 42]) {
      svc.answer = { decision: "deny", reason: bad };
      const out = await runThinHook(bash("git push"), opts);
      expect(decision(out).permissionDecision).toBe("deny");
      expect(typeof reason(out)).toBe("string");
      expect(reason(out)).not.toContain("[object");
    }
  });

  it("a_command_tool_without_its_command_is_denied_without_the_service", async () => {
    for (const [tool, input] of [["bash", {}], ["bash", "ls"], ["eval", { language: "js", code: 3 }], ["monitor", { type: "command" }]] as const) {
      expect(reason(await runThinHook(call(tool, input), opts))).toBe("[guard] некорректный вызов инструмента");
    }
    expect(svc.connections).toBe(0);
  });

  it("bash_input_keys_that_submit_go_to_the_service", async () => {
    expect(await runThinHook(call("bash_input", { bash_id: "b1", keys: ["ctrl+c"] }), opts)).toEqual({});
    expect(svc.connections).toBe(0);
    svc.answer = { decision: "deny", reason: "[guard] нет" };
    expect(decision(await runThinHook(call("bash_input", { bash_id: "b1", keys: ["up", "enter"] }), opts)).permissionDecision).toBe("deny");
    expect(decision(await runThinHook(call("bash_input", { bash_id: "b1", keys: ["up"], submit: true }), opts)).permissionDecision).toBe("deny");
    expect(svc.connections).toBe(2);
  });

  it("a_rules_file_that_cannot_be_stat_ed_is_not_the_defaults", async () => {
    const guardDir = servicePaths(agentDir).dir;
    fs.chmodSync(guardDir, 0o000);
    try {
      const out = await runThinHook(bash("git status"), opts);
      expect(decision(out).permissionDecision).toBe("deny");
    } finally {
      fs.chmodSync(guardDir, 0o700);
    }
  });

  it("an_unreadable_rules_file_leaves_the_decision_to_the_service", async () => {
    fs.rmSync(servicePaths(agentDir).rules);
    fs.mkdirSync(servicePaths(agentDir).rules);
    svc.answer = { decision: "deny", reason: "[guard] правила защиты невалидны — исправьте их в настройках" };
    expect(reason(await runThinHook(bash("git status"), opts))).toContain("правила защиты невалидны");
    expect(svc.connections).toBe(1);
  });

  it("stale_socket_file_denies_fast", async () => {
    await svc.close();
    fs.rmSync(hookSock(), { force: true });
    fs.writeFileSync(hookSock(), "");
    const t0 = Date.now();
    const out = await runThinHook(bash("git push"), opts);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(decision(out).permissionDecision).toBe("deny");
    expect(reason(out)).toContain("служба защиты не запущена");
  });

  it("a_missing_socket_denies_with_the_hint", async () => {
    await svc.close();
    fs.rmSync(hookSock(), { force: true });
    expect(reason(await runThinHook(bash("git push"), opts))).toBe(
      "[guard] служба защиты не запущена — включите защиту в настройках Agent Tabs → Безопасность",
    );
  });

  describe("every tool that runs or writes reaches the service", () => {
    const disputed: Record<string, unknown> = {
      bash_input: { bash_id: "b1", input: "git push" },
      monitor: { type: "command", command: "git push", description: "x" },
      eval: { language: "ts", summary: "x", code: "await $`git push`" },
      write: { path: "@AGENT/hooks.json", content: "{}" },
      edit: { path: "@AGENT/guard/rules.json", oldText: "a", newText: "b" },
      apply_patch: { input: "*** Begin Patch\n*** Update File: @AGENT/hooks.json\n*** End Patch" },
    };
    it.each(Object.keys(disputed))("tool_%s_is_covered", async (tool) => {
      const input = JSON.parse(JSON.stringify(disputed[tool]).replaceAll("@AGENT", agentDir));
      svc.answer = { decision: "deny", reason: "[guard] нет" };
      expect(decision(await runThinHook(call(tool, input), opts)).permissionDecision).toBe("deny");
      expect(svc.seen.map((seen) => seen.tool)).toContain(tool);
    });
  });

  it("an_unknown_write_tool_is_denied", async () => {
    for (const tool of ["fs_write_v2", "run_script", "remote_exec", "spawn_process"]) {
      const out = await runThinHook({ tool_name: tool, tool_input: {} }, opts);
      expect(decision(out).permissionDecision).toBe("deny");
      expect(reason(out)).toContain("неизвестный инструмент записи");
    }
    expect(svc.connections).toBe(0);
  });

  it("write_like_names_are_tokens_and_mcp_or_innocent_names_go_to_the_service", async () => {
    for (const tool of ["runCommand", "shell_exec"]) expect(reason(await runThinHook(call(tool, {}), opts))).toContain("неизвестный инструмент записи");
    expect(svc.connections).toBe(0);
    svc.answer = { decision: "deny", reason: "[guard] спорная команда запрещена настройками защиты" };
    for (const tool of ["truncate", "prune", "credit", "mcp_fs_write_file"]) {
      expect(reason(await runThinHook(call(tool, {}), opts))).not.toContain("неизвестный инструмент записи");
    }
    expect(svc.seen.map((seen) => seen.tool)).toEqual(["truncate", "prune", "credit", "mcp_fs_write_file"]);
  });

  it("subagent_memory_goal_and_codegraph_tools_pass_without_the_service", async () => {
    const tools = ["task", "task_output", "task_send", "task_cancel", "memory", "create_goal", "mcp_codegraph_codegraph_explore", "lsp_diagnostics", "web_fetch",
      "team_create", "thread_send", "workflow", "workpool", "mcp_read_resource", "lsp_prepare_rename", "onboarding_understand", "nudge", "session_entries",
      "look_at", "mcp_context7_resolve-library-id", "mcp_context7_query-docs"];
    for (const tool of tools) {
      expect([tool, await runThinHook(call(tool, {}), opts)]).toEqual([tool, {}]);
    }
    expect(svc.connections).toBe(0);
  });

  it("the_question_tools_are_read_only", async () => {
    for (const tool of ["ask_user_question", "request_user_input"]) expect(await runThinHook(call(tool, { questions: [] }), opts)).toEqual({});
    expect(svc.connections).toBe(0);
  });

  it("broken_stdin_denies", async () => {
    expect(decision(await runThinHook("{", opts)).permissionDecision).toBe("deny");
    expect(decision(await runThinHook("[]", opts)).permissionDecision).toBe("deny");
  });

  it("invalid_rules_leave_the_decision_to_the_service", async () => {
    fs.writeFileSync(servicePaths(agentDir).rules, JSON.stringify({ version: 2, hardDeny: "x" }));
    svc.answer = { decision: "deny", reason: "[guard] правила защиты невалидны — исправьте их в настройках" };
    expect(reason(await runThinHook(bash("git status"), opts))).toContain("правила защиты невалидны");
    expect(svc.connections).toBe(1);
  });
});

describe("thin hook against the real service", () => {
  it("a_human_allow_once_reaches_the_hook", async () => {
    await svc.close();
    writeRules(agentDir, { decider: { mode: "ask-me" } });
    const service = await start(agentDir);
    try {
      const pending = runThinHook(bash("git push origin main"), opts);
      const paths = servicePaths(agentDir);
      const [item] = await pendingItems(paths.adminSock);
      expect(item).toMatchObject({ tool: "bash", command: "git push origin main", session: SESSION });
      expect(await send(paths.adminSock, { op: "answer", id: item.id, decision: "allow-once", by: "agent-tabs" })).toEqual({ ok: true });
      expect(decision(await pending)).toEqual({ permissionDecision: "allow", permissionDecisionReason: "[guard] человек разрешил один раз (agent-tabs)" });
    } finally {
      await service.close();
    }
  });

  it("the_service_stopping_mid_wait_denies", async () => {
    await svc.close();
    writeRules(agentDir, { decider: { mode: "ask-me" } });
    const service = await start(agentDir);
    const pending = runThinHook(bash("git push origin main"), opts);
    await pendingItems(servicePaths(agentDir).adminSock);
    await service.close();
    expect(decision(await pending).permissionDecision).toBe("deny");
  });
});

describe("hook.mjs entry", () => {
  const run = (args: string[], stdin: string, entry = path.join(KIT, "guard", "hook.mjs")): Promise<{ status: number | null; stdout: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn("node", [entry, ...args], {
        env: { PATH: process.env.PATH ?? "", HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin.end(stdin);
    });

  it("prints_json_and_exits_0_on_allow_deny_and_errors", async () => {
    const allowed = await run(["--agent-dir", agentDir], JSON.stringify(bash("git status")));
    expect(allowed).toEqual({ status: 0, stdout: "{}\n" });
    svc.answer = { decision: "deny", reason: "[guard] нет" };
    const denied = await run(["--agent-dir", agentDir], JSON.stringify(bash("git push")));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[guard] нет" } });
    const noDir = await run([], JSON.stringify(bash("git status")));
    expect(noDir.status).toBe(0);
    expect(JSON.parse(noDir.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("the_installed_copy_runs_on_its_own", async () => {
    const entry = path.join(installGuardFiles(home), "hook.mjs");
    expect(await run(["--agent-dir", agentDir], JSON.stringify(bash("git status")), entry)).toEqual({ status: 0, stdout: "{}\n" });
    await svc.close();
    fs.rmSync(hookSock(), { force: true });
    const denied = await run(["--agent-dir", agentDir], JSON.stringify(bash("git push")), entry);
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason).toContain("служба защиты не запущена");
  });

  it("a_copy_with_a_module_missing_fails_closed", async () => {
    const dir = installGuardFiles(home);
    fs.rmSync(path.join(dir, "classify.mjs"));
    const result = await run(["--agent-dir", agentDir], JSON.stringify(bash("git status")), path.join(dir, "hook.mjs"));
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/^\[guard\] ошибка хука защиты: /);
  });
});
