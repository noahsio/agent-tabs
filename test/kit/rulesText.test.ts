import { describe, expect, it } from "vitest";
import { formatIpLines, importClaudeDeny, parseLines } from "../../kit/guard/rulesText.mjs";

describe("rules as text lines", () => {
  it("an_invalid_glob_is_reported_with_its_line", () => {
    expect(parseLines("a*\nb\n\nc[\n", "glob").errors).toEqual([{ line: 4, message: expect.stringContaining("скобк") }]);
  });

  it("valid_glob_lines_are_kept_trimmed_and_blank_lines_dropped", () => {
    expect(parseLines("  rm -rf*  \n\ngit push --force\n[ab]c\n", "glob")).toEqual({ values: ["rm -rf*", "git push --force", "[ab]c"], errors: [] });
  });

  it("ip_lines_keep_notes", () => {
    expect(parseLines("203.0.113.10 # дев-сервер\n10.20.0.0/16", "ip").values).toEqual([{ cidr: "203.0.113.10", note: "дев-сервер" }, { cidr: "10.20.0.0/16" }]);
  });

  it("a_bad_ip_line_is_reported_with_its_line", () => {
    expect(parseLines("10.0.0.1\n\n999.1.1.1 # nope\n10.0.0.0/33", "ip").errors).toEqual([
      { line: 3, message: expect.any(String) },
      { line: 4, message: expect.any(String) },
    ]);
  });

  it("ip_lines_round_trip", () => {
    const entries = [{ cidr: "203.0.113.10", note: "дев-сервер" }, { cidr: "10.20.0.0/16" }];
    expect(formatIpLines(entries)).toBe("203.0.113.10 # дев-сервер\n10.20.0.0/16");
    expect(parseLines(formatIpLines(entries), "ip").values).toEqual(entries);
  });

  it("claude_deny_import", () => {
    expect(importClaudeDeny({ permissions: { deny: ["Bash(rm -rf:*)", "Bash(git push --force)", "Read(~/.ssh/**)"] } })).toEqual({
      lines: ["rm -rf*", "git push --force"],
      skipped: 1,
    });
  });

  it("claude_import_tolerates_missing_or_odd_settings", () => {
    expect(importClaudeDeny(null)).toEqual({ lines: [], skipped: 0 });
    expect(importClaudeDeny({ permissions: { deny: [42, "Bash", "Bash()"] } })).toEqual({ lines: [], skipped: 3 });
  });
});
