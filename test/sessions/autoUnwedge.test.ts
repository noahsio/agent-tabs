import { beforeEach, describe, expect, it } from "vitest";
import { AUTO_UNWEDGE_COOLDOWN_MS, claimAutoUnwedge, resetAutoUnwedge } from "../../src/sessions/autoUnwedge";

const NOW = new Date("2026-11-04T12:00:00Z").getTime();

beforeEach(() => resetAutoUnwedge());

describe("the ration for restarting a wedged session by itself", () => {
  it("gives_one_restart_per_session_and_then_waits_out_the_cooldown", () => {
    expect(claimAutoUnwedge("one", NOW)).toBe(true);
    expect(claimAutoUnwedge("one", NOW + 1)).toBe(false);
    expect(claimAutoUnwedge("one", NOW + AUTO_UNWEDGE_COOLDOWN_MS - 1)).toBe(false);
    expect(claimAutoUnwedge("one", NOW + AUTO_UNWEDGE_COOLDOWN_MS)).toBe(true);
    expect(claimAutoUnwedge("one", NOW + AUTO_UNWEDGE_COOLDOWN_MS + 1)).toBe(false); // the new claim started its own
  });

  it("counts_each_session_on_its_own", () => {
    expect(claimAutoUnwedge("one", NOW)).toBe(true);
    expect(claimAutoUnwedge("two", NOW)).toBe(true);
    expect(claimAutoUnwedge("one", NOW)).toBe(false);
  });
});
