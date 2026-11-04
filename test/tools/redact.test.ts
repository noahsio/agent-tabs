import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = new URL("../../tools/mining/redact.py", import.meta.url).pathname;

function redact(text: string): string {
  const result = spawnSync("python3", ["-I", SCRIPT], { input: text, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`redact.py failed: ${result.stderr}`);
  return result.stdout;
}

describe("mining redaction", () => {
  it("secrets_are_redacted", () => {
    for (const secret of ["sshpass -p hunter2 ssh a@b", "curl -H 'Authorization: Bearer abcdefgh1234'", "sk-ant-abcdefgh12345678"]) {
      expect(redact(secret)).toContain("‹redacted›");
    }
    expect(redact("sshpass -p hunter2 ssh a@b")).not.toContain("hunter2");
  });

  it("keeps ordinary commands intact", () => {
    expect(redact("git status && ls -la")).toBe("git status && ls -la");
  });
});
