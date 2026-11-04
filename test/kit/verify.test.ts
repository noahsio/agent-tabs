import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { checkCommands, checkHooksListing, checkMcp, checkTrustRecords } from "../../kit/verify-omo.mjs";
// @ts-expect-error plain ESM without types
import { buildHooksState } from "../../kit/lib/trust.mjs";

describe("verify-omo pure checks", () => {
  it("checkCommands reports the missing skills", () => {
    expect(checkCommands([{ name: "skill:a" }], ["skill:a"]).ok).toBe(true);
    const result = checkCommands([{ name: "skill:a" }], ["skill:a", "skill:b"]);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("skill:b");
    expect(checkCommands(undefined, ["skill:a"]).ok).toBe(false);
  });

  it("checkMcp needs a connected server with at least one tool", () => {
    const ok = [{ name: "codegraph", status: "connected", toolCount: 1 }];
    expect(checkMcp({ mcpServers: ok }).ok).toBe(true);
    expect(checkMcp({ mcpServers: [{ name: "codegraph", status: "connected", toolCount: 0 }] }).ok).toBe(false);
    expect(checkMcp({ mcpServers: [{ name: "codegraph", status: "failed", toolCount: 1 }] }).ok).toBe(false);
    expect(checkMcp({ mcpServers: [] }).ok).toBe(false);
  });

  it("checkHooksListing wants every kit hook trusted and enabled", () => {
    const line = (status: string, disabled: string) =>
      `- hk_x_SessionStart_0_0 SessionStart source:global status:${status} disabled:${disabled} command:/home/.omo/kit/h/codegraph-init.sh`;
    const good = [line("trusted", "false"), line("trusted", "false")].join("\n");
    expect(checkHooksListing(good).ok).toBe(true);
    expect(checkHooksListing([line("trusted", "false"), line("untrusted", "false")].join("\n")).ok).toBe(false);
    expect(checkHooksListing([line("trusted", "false"), line("trusted", "true")].join("\n")).ok).toBe(false);
    expect(checkHooksListing("").ok).toBe(false);
  });

  it("checkTrustRecords validates hashes against the hooks.json path", () => {
    const file = "/tmp/x/agent/hooks.json";
    const config = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/k/kit/init.sh" }] }] } };
    const isOwn = (command: string) => command.includes("/k/kit/");
    const state = buildHooksState(config, file, {}, undefined, { isOwn });
    expect(checkTrustRecords(config, state, file, isOwn).ok).toBe(true);
    expect(checkTrustRecords(config, state, "/tmp/other/hooks.json", isOwn).ok).toBe(false);
    expect(checkTrustRecords(config, { hooks: {} }, file, isOwn).ok).toBe(false);
  });
});

describe("verify-omo exit code and spelling", () => {
  it("exitCode is 0 only when every check passes", async () => {
    // @ts-expect-error plain ESM without types
    const { exitCode } = await import("../../kit/verify-omo.mjs");
    expect(exitCode([{ ok: true }, { ok: true }])).toBe(0);
    expect(exitCode([{ ok: true }, { ok: false }])).toBe(1);
    expect(exitCode([])).toBe(1);
  });

  it("checkAgentDirSpelling requires the exact setup path", async () => {
    // @ts-expect-error plain ESM without types
    const { checkAgentDirSpelling } = await import("../../kit/verify-omo.mjs");
    expect(checkAgentDirSpelling("/h/.omo/agent", "/h/.omo/agent").ok).toBe(true);
    expect(checkAgentDirSpelling("/h/.omo/agent/", "/h/.omo/agent").ok).toBe(false);
    expect(checkAgentDirSpelling("/tmp/link", "/h/.omo/agent").ok).toBe(false);
    expect(checkAgentDirSpelling(undefined, "/h/.omo/agent").ok).toBe(false);
  });
});

describe("withScratchHost cleanup", () => {
  it("removes the scratch root (credential copies) and rejects when the omo binary is missing", async () => {
    // @ts-expect-error plain ESM without types
    const { withScratchHost } = await import("../../kit/verify-omo.mjs");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-verify-src-"));
    fs.writeFileSync(path.join(agentDir, "hooks.json"), JSON.stringify({ hooks: {} }));
    fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
    const envName = `unittest${process.pid}`;
    let seenRoot = "";
    await expect(
      withScratchHost(
        { envName, envInfo: { agentDir }, kitMarker: "/nowhere/kit/", omoBinary: "/nonexistent/omo" },
        async ({ scratchRoot, connectClient }: { scratchRoot: string; connectClient: () => Promise<unknown> }) => {
          seenRoot = scratchRoot;
          expect(fs.existsSync(path.join(scratchRoot, "agent", "auth.json"))).toBe(true);
          await connectClient();
        },
      ),
    ).rejects.toThrow(/could not start/);
    expect(seenRoot).not.toBe("");
    expect(fs.existsSync(seenRoot)).toBe(false);
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`omo-verify-${envName}-`))).toEqual([]);
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("removes the scratch root when setup throws before the host starts", async () => {
    // @ts-expect-error plain ESM without types
    const { withScratchHost } = await import("../../kit/verify-omo.mjs");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const envName = `unittest${process.pid}b`;
    await expect(
      withScratchHost({ envName, envInfo: { agentDir: "/nonexistent-agent-dir" }, kitMarker: "/k/", omoBinary: "/nonexistent/omo" }, async () => undefined),
    ).rejects.toThrow();
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`omo-verify-${envName}-`))).toEqual([]);
  });
});

describe("withScratchHost signals", () => {
  it("a second SIGINT during a slow host shutdown still removes the scratch root", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { spawn } = await import("node:child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-sigtest-"));
    const agentDir = path.join(dir, "src-agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "hooks.json"), JSON.stringify({ hooks: {} }));
    fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
    // Fake host: ignores SIGTERM for 1.5 s, so dispose is still awaiting it when the second SIGINT arrives.
    const fakeHost = path.join(dir, "fake-omo.sh");
    fs.writeFileSync(fakeHost, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 1500);\n", { mode: 0o755 });
    const envName = `sig${process.pid}`;
    const script = path.join(dir, "child.mjs");
    fs.writeFileSync(
      script,
      `import { withScratchHost } from ${JSON.stringify(path.resolve(__dirname, "../../kit/verify-omo.mjs"))};
await withScratchHost({ envName: ${JSON.stringify(envName)}, envInfo: { agentDir: ${JSON.stringify(agentDir)} }, kitMarker: "/k/", omoBinary: ${JSON.stringify(fakeHost)} },
  async ({ scratchRoot }) => { console.log("ROOT " + scratchRoot); await new Promise(() => {}); });
`,
    );
    const child = spawn("node", [script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    const deadline = Date.now() + 15000;
    while (!out.includes("ROOT ") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const root = out.split("ROOT ")[1]?.trim() ?? "";
    expect(root).toContain(`omo-verify-${envName}-`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(fs.existsSync(root)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30000);
});
