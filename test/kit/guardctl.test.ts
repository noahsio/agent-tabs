import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { guardctlMain } from "../../kit/guard/guardctl.mjs";
// @ts-expect-error plain ESM without types
import { servicePaths } from "../../kit/guard/service.mjs";
import { evalCall, evaluate, makeSvcDir, removeSvcDirs, send, start, subscribe, until } from "./serviceHelpers";

let svc: { close(): Promise<void> } | undefined;
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  removeSvcDirs();
});

async function withPending() {
  const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
  const paths = servicePaths(agentDir);
  svc = await start(agentDir);
  const { id, ticket } = await send(paths.hookSock, evaluate("rm -rf $U/main"));
  return { agentDir, paths, id: id as string, ticket: ticket as string };
}

async function guardctl(agentDir: string, args: string[], answer: boolean | null = true) {
  const lines: string[] = [];
  const questions: string[] = [];
  const status = await guardctlMain(
    { agentDir, positional: args },
    {
      confirm: (question: string) => (questions.push(question), answer),
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(line),
    },
  );
  return { status, output: lines.join("\n"), questions };
}

describe("guardctl", () => {
  it("cli_answers_over_the_admin_socket_after_tty_confirmation", async () => {
    const { agentDir, paths, id, ticket } = await withPending();
    const sub = await subscribe(paths.adminSock);
    const waiting = send(paths.hookSock, { op: "wait", id, ticket });
    const result = await guardctl(agentDir, ["allow", id], true);
    expect(result.status).toBe(0);
    expect(result.questions[0]).toContain("rm -rf $U/main");
    expect((await waiting).decision).toBe("allow");
    expect(await until(() => sub.events.find((event) => event.event === "resolved"))).toMatchObject({ id, decision: "allow", by: "cli" });
    sub.close();
  });

  it("without_a_terminal_nothing_is_answered", async () => {
    const { agentDir, paths, id } = await withPending();
    const result = await guardctl(agentDir, ["allow", id], null);
    expect(result.status).toBe(1);
    expect(result.output).toContain("/dev/tty");
    expect((await send(paths.adminSock, { op: "pending" })).items.map((item: any) => item.id)).toEqual([id]);
  });

  it("a_refused_confirmation_answers_nothing", async () => {
    const { agentDir, paths, id } = await withPending();
    expect((await guardctl(agentDir, ["deny", id], false)).status).toBe(1);
    expect((await send(paths.adminSock, { op: "pending" })).items).toHaveLength(1);
  });

  it("deny_and_pending_work_and_an_unknown_id_fails", async () => {
    const { agentDir, paths, id } = await withPending();
    const listed = await guardctl(agentDir, ["pending"]);
    expect(listed.status).toBe(0);
    expect(listed.output).toContain(id);
    expect(listed.output).toContain("rm -rf $U/main");
    expect((await guardctl(agentDir, ["deny", "ffffffffffff"])).status).toBe(1);
    expect((await guardctl(agentDir, ["deny", id])).status).toBe(0);
    expect((await send(paths.adminSock, { op: "pending" })).items).toEqual([]);
    expect((await guardctl(agentDir, ["bogus"])).status).toBe(2);
  });

  it("an_eval_is_printed_as_its_commands_then_its_code", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    const paths = servicePaths(agentDir);
    svc = await start(agentDir);
    const { id } = await send(paths.hookSock, { op: "evaluate", call: evalCall('const where = "origin";\nawait tool.bash("rm -rf $U");') });
    const listed = (await guardctl(agentDir, ["pending"])).output;
    expect(listed.indexOf("    rm -rf $U")).toBeGreaterThan(listed.indexOf(id));
    expect(listed.indexOf("код eval:")).toBeGreaterThan(listed.indexOf("    rm -rf $U"));
    expect(listed).toContain('      const where = "origin";');
    const asked = (await guardctl(agentDir, ["deny", id], false)).questions[0] ?? "";
    expect(asked.indexOf("код eval:")).toBeGreaterThan(asked.indexOf("rm -rf $U"));
  });

  it("no_service_is_a_clear_error", async () => {
    const agentDir = makeSvcDir();
    const result = await guardctl(agentDir, ["pending"]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("служба защиты");
  });

  it("an_error_reply_is_reported_not_a_crash", async () => {
    const agentDir = makeSvcDir();
    const socketPath = path.join(agentDir, "guard", "admin.sock");
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.end(`${JSON.stringify({ error: "unknown op" })}\n`);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await guardctl(agentDir, ["allow", "0123456789ab"]);
      expect(result.status).toBe(1);
      expect(result.output).toContain("unknown op");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
