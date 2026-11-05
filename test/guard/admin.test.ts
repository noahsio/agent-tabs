import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuardAdmin, GuardRulesInvalid, type GuardEvent } from "../../src/guard/admin";
import { evaluate, makeSvcDir, removeSvcDirs, send, start, until } from "../kit/serviceHelpers";
// @ts-expect-error plain ESM without types
import { servicePaths } from "../../kit/guard/service.mjs";

type Service = { close(): Promise<void> };

let services: Service[] = [];
let admins: GuardAdmin[] = [];

async function boot(agentDir: string): Promise<Service> {
  const service = (await start(agentDir)) as Service;
  services.push(service);
  return service;
}

async function connect(agentDir: string, reconnectDelaysMs?: number[]): Promise<GuardAdmin> {
  const admin = await GuardAdmin.connect(agentDir, reconnectDelaysMs !== undefined ? { reconnectDelaysMs } : {});
  admins.push(admin);
  return admin;
}

afterEach(async () => {
  for (const admin of admins) admin.close();
  admins = [];
  for (const service of services) await service.close();
  services = [];
  removeSvcDirs();
});

describe("GuardAdmin", () => {
  it("connect_fails_when_the_service_is_not_running", async () => {
    await expect(GuardAdmin.connect(makeSvcDir())).rejects.toThrow();
  });

  it("rules_round_trip_and_invalid_rules_come_back_as_field_errors", async () => {
    const agentDir = makeSvcDir();
    await boot(agentDir);
    const admin = await connect(agentDir);
    const rules = await admin.rulesGet();
    expect(rules.version).toBe(2);
    expect(await admin.rulesSet({ ...rules, askCustom: ["docker volume prune*"] })).toEqual({ ok: true });
    expect((await admin.rulesGet()).askCustom).toEqual(["docker volume prune*"]);
    expect(await admin.rulesSet({ ...rules, askCustom: ["ok", "c["] })).toEqual({
      ok: false,
      errors: [{ field: "askCustom", line: 2, message: expect.stringContaining("скобка") }],
    });
  });

  it("rules_the_service_reports_invalid_reject_with_its_errors", async () => {
    const agentDir = makeSvcDir();
    fs.writeFileSync(path.join(agentDir, "guard", "rules.json"), JSON.stringify({ version: 2, hardDeny: ["c["] }));
    await boot(agentDir);
    const admin = await connect(agentDir);
    const failure = await admin.rulesGet().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GuardRulesInvalid);
    expect((failure as GuardRulesInvalid).errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: "hardDeny", line: 1 })]));
  });

  it("pending_and_answer_release_a_waiting_call", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    await boot(agentDir);
    const admin = await connect(agentDir);
    const hookSock = servicePaths(agentDir).hookSock as string;
    const { id, ticket } = await send(hookSock, evaluate("rm -rf $U"));
    expect((await admin.pending()).map((item) => item.id)).toEqual([id]);
    const waiting = send(hookSock, { op: "wait", id, ticket });
    await admin.answer(id, "allow-once");
    expect((await waiting).decision).toBe("allow");
    await expect(admin.answer(id, "deny")).rejects.toThrow(/уже отвечен/);
  });

  it("subscribe_reconnects_after_a_service_restart", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    const first = await boot(agentDir);
    const admin = await connect(agentDir, [20, 20, 40, 80, 160]);
    const events: GuardEvent[] = [];
    admin.subscribe((event) => events.push(event));
    const hookSock = servicePaths(agentDir).hookSock as string;
    await send(hookSock, evaluate("rm -rf $U"));
    await until(() => events.some((event) => event.event === "pending"));

    await first.close(); // launchd's KeepAlive starts it again
    services = services.filter((service) => service !== first);
    await boot(agentDir);
    events.length = 0;
    const { id } = await send(hookSock, evaluate("rm -rf $U --force"));
    const pending = await until(() => events.find((event) => event.event === "pending" && event.item.id === id));
    expect(pending).toMatchObject({ event: "pending", item: { command: "rm -rf $U --force" } });
  });

  it("subscribe_reports_every_confirmation_including_after_a_restart", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    const first = await boot(agentDir);
    const admin = await connect(agentDir, [20, 20, 40, 80, 160]);
    let confirmed = 0;
    admin.subscribe(
      () => undefined,
      undefined,
      () => (confirmed += 1),
    );
    await until(() => confirmed === 1);
    await first.close();
    services = services.filter((service) => service !== first);
    await boot(agentDir);
    await until(() => confirmed === 2, 2000);
  });

  it("subscribe_gives_up_after_the_bounded_tries", async () => {
    const agentDir = makeSvcDir({ decider: { mode: "ask-me" } });
    const service = await boot(agentDir);
    const admin = await connect(agentDir, [10, 10, 10, 10, 10]);
    let gaveUp = 0;
    const stale: GuardEvent[] = [];
    admin.subscribe((event) => stale.push(event), () => (gaveUp += 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.close();
    services = [];
    await until(() => gaveUp === 1, 2000);

    // nothing retries any more; a new subscription after the service is back is live
    await boot(agentDir);
    const events: GuardEvent[] = [];
    admin.subscribe((event) => events.push(event));
    const { id } = await send(servicePaths(agentDir).hookSock as string, evaluate("rm -rf $U"));
    await until(() => events.find((event) => event.event === "pending" && event.item.id === id));
    expect(stale).toEqual([]);
    expect(gaveUp).toBe(1);
  });

  it("a_flapping_subscription_stops_after_five_short_lives", async () => {
    // a service that confirms every subscription and drops it at once (crash loop after start)
    const dir = fs.mkdtempSync("/tmp/agf-");
    const agentDir = path.join(dir, "agent");
    fs.mkdirSync(path.join(agentDir, "guard"), { recursive: true });
    let subscriptions = 0;
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (line: string) => {
        if (line.includes('"subscribe"')) {
          subscriptions += 1;
          socket.end('{"ok":true}\n');
        } else socket.end('{"version":1}\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(servicePaths(agentDir).adminSock as string, resolve));
    try {
      const admin = await GuardAdmin.connect(agentDir, { reconnectDelaysMs: [5, 5, 5, 5, 5], stableMs: 5000 });
      admins.push(admin);
      let gaveUp = 0;
      admin.subscribe(() => undefined, () => (gaveUp += 1));
      await until(() => gaveUp === 1, 3000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(subscriptions).toBe(5);
      expect(gaveUp).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
