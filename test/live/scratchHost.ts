import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostPidPath, hostSocketPath } from "../../src/daemon";

/** Pid of the host the extension code spawned for `agentDir`, if it is still that host. */
export function scratchHostPid(agentDir: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(hostPidPath(agentDir), "utf8").trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const command = processText(pid, "command=");
  return command?.includes(`unix://${hostSocketPath(agentDir)}`) === true ? pid : undefined;
}

/** True when the process environment has a variable with this NAME. Never returns or prints values. */
export function hostHasEnvName(pid: number, name: string): boolean {
  const text = processText(pid, "command=", true) ?? "";
  return new RegExp(`(^|\\s)${name}=`).test(text);
}

/** Stops only this scratch dir's own host: SIGTERM, then waits up to 10 s. */
export async function stopScratchHost(agentDir: string): Promise<void> {
  const pid = scratchHostPid(agentDir);
  if (pid === undefined) return;
  process.kill(pid, "SIGTERM");
  for (let tick = 0; tick < 100; tick++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill(pid, "SIGKILL");
}

function processText(pid: number, format: string, withEnv = false): string | undefined {
  try {
    const args = withEnv ? ["eww", "-o", format, "-p", String(pid)] : ["-o", format, "-p", String(pid)];
    return execFileSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}
