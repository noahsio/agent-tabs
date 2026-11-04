import { modelsSource, readLiveKey } from "./config";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/daemon";
import { buildOmoEnv } from "../../src/env";
import { stopScratchHost } from "./scratchHost";

const LIVE = process.env["AGENT_TABS_LIVE"] === "1";
const SCRATCH_ROOT = "/tmp/agent-tabs-live-daemon"; // its own host: the e2e file may run in parallel
const AGENT_DIR = join(SCRATCH_ROOT, "agent");


describe.skipIf(!LIVE)("DaemonManager (live omo)", () => {
  let manager: DaemonManager | undefined;
  afterAll(async () => {
    manager?.dispose();
    await stopScratchHost(AGENT_DIR);
  }, 30_000);

  it("connects_and_reports_multi_session", async () => {
    await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
    await chmod(AGENT_DIR, 0o700);
    await copyFile(modelsSource, join(AGENT_DIR, "models.json"));
    const built = buildOmoEnv(
      { PATH: process.env["PATH"] ?? "", HOME: homedir(), DO_NOT_TRACK: "1" },
      [
        { name: "OMO_CODING_AGENT_DIR", value: AGENT_DIR },
        { name: "GW_API_KEY", value: readLiveKey() },
      ],
      "~/.local/bin/omo",
    );
    if (!built.ok) throw new Error(`env incomplete: ${built.missing.join(",")}`);
    manager = new DaemonManager(built.value);
    const client = await manager.client();
    const info = await client.request<{ capabilities?: string[] }>("get_protocol_info");
    console.log("protocol info keys:", Object.keys(info));
    expect(JSON.stringify(info)).toContain("multi_session");
  }, 120_000);
});
