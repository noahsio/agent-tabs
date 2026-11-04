import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildOmoEnv, redact } from "../src/env";

const OMO = "/usr/bin/omo";

describe("buildOmoEnv", () => {
  it("gw_api_key_is_no_longer_required", () => {
    expect(buildOmoEnv({}, [{ name: "OMO_CODING_AGENT_DIR", value: "/a" }], "omo").ok).toBe(true);
  });

  it("scrubs_inherited_provider_vars", () => {
    const base = {
      ANTHROPIC_BASE_URL: "u",
      ANTHROPIC_AUTH_TOKEN: "t",
      OMO_PROFILE: "p",
      CLAUDE_CONFIG_DIR: "c",
      GW_TOKEN: "g",
      PATH: "/bin",
    };
    const result = buildOmoEnv(
      base,
      [
        { name: "OMO_CODING_AGENT_DIR", value: "/a" },
        { name: "GW_API_KEY", value: "k" },
      ],
      OMO,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.env).sort()).toEqual(
      ["GW_API_KEY", "OMO_CODING_AGENT_DIR", "PATH"].sort(),
    );
  });

  it("settings_vars_override_and_add", () => {
    const result = buildOmoEnv(
      { CLAUDE_CONFIG_DIR: "old" },
      [
        { name: "CLAUDE_CONFIG_DIR", value: "new" },
        { name: "OMO_CODING_AGENT_DIR", value: "/a" },
        { name: "GW_API_KEY", value: "k" },
      ],
      OMO,
    );
    expect(result.ok && result.value.env.CLAUDE_CONFIG_DIR).toBe("new");
  });

  it("refuses_without_the_agent_dir", () => {
    expect(buildOmoEnv({}, [], OMO)).toEqual({ ok: false, missing: ["OMO_CODING_AGENT_DIR"] });
  });

  it("expands_tilde_in_paths", () => {
    const result = buildOmoEnv(
      {},
      [
        { name: "OMO_CODING_AGENT_DIR", value: "~/x" },
        { name: "GW_API_KEY", value: "k" },
      ],
      "~/.local/bin/omo",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const home = homedir();
    expect(result.value.agentDir).toBe(`${home}/x`);
    expect(result.value.env.OMO_CODING_AGENT_DIR).toBe(`${home}/x`);
    expect(result.value.omoPath).toBe(`${home}/.local/bin/omo`);
  });
});

describe("redact", () => {
  it("redact_hides_secret_values", () => {
    expect(redact("auth k123 failed", ["k123"])).toBe("auth ‹redacted› failed");
  });

  it("redact_longest_first_no_tail_leak", () => {
    expect(redact("key k123 end", ["k1234", "k123", "k12345"])).toBe(
      "key ‹redacted› end",
    );
    expect(redact("x k12345 y", ["k1234", "k12345"])).toBe("x ‹redacted› y");
  });
});

describe("buildOmoEnv secrets", () => {
  it("collects_settings_values_and_secret_named_env_values", () => {
    const result = buildOmoEnv(
      {},
      [
        { name: "OMO_CODING_AGENT_DIR", value: "/agent" },
        { name: "GW_API_KEY", value: "key-1" },
        { name: "SHORT", value: "abc" },
        { name: "OTHER", value: "other-value" },
      ],
      OMO,
    );
    expect(result.ok && result.value.secrets.sort()).toEqual(
      ["/agent", "key-1", "other-value"].sort(),
    );
  });

  it("agent_dir_from_base_is_not_trusted", () => {
    expect(
      buildOmoEnv(
        { OMO_CODING_AGENT_DIR: "/b" },
        [{ name: "GW_API_KEY", value: "k" }],
        OMO,
      ),
    ).toEqual({ ok: false, missing: ["OMO_CODING_AGENT_DIR"] });
  });

  it("empty_required_value_counts_as_missing", () => {
    expect(
      buildOmoEnv(
        {},
        [
          { name: "OMO_CODING_AGENT_DIR", value: "" },
          { name: "GW_API_KEY", value: "k" },
        ],
        OMO,
      ),
    ).toEqual({ ok: false, missing: ["OMO_CODING_AGENT_DIR"] });
  });
});
