import { describe, expect, it } from "vitest";
import { compareVersions, Freshness, type FreshnessDeps, installedVersion, RELOAD, RESTART, staleness, stalenessText } from "../../src/guard/freshness";

const KIT = "/Users/me/.omo/kit/02a3913362e1/guard";
const OLD_KIT = "/Users/me/.omo/kit/6cdd90b9ec09/guard";

const fresh = { running: "0.4.31", installed: "0.4.31", serviceKit: KIT, serviceProtocol: 2, expectedKit: KIT };

describe("is this window running what is installed", () => {
  it("versions_compare_by_number_not_as_text", () => {
    expect(compareVersions("0.4.21", "0.4.9")).toBeGreaterThan(0);
    expect(compareVersions("0.4.12", "0.4.29")).toBeLessThan(0);
    expect(compareVersions("0.4.29", "0.4.29")).toBe(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("the_newest_install_is_found_among_every_version_in_the_directory", () => {
    const names = ["local.agent-tabs-0.4.12", "local.agent-tabs-0.4.9", "local.agent-tabs-0.4.29", "ms-python.python-2024.1", ".DS_Store"];
    expect(installedVersion("/ext", () => names)).toBe("0.4.29");
  });

  it("an_unreadable_extensions_directory_claims_nothing", () => {
    expect(
      installedVersion("/ext", () => {
        throw new Error("EACCES");
      }),
    ).toBeUndefined();
    expect(installedVersion("/ext", () => [])).toBeUndefined();
  });

  it("a_window_behind_the_installed_build_is_the_first_thing_said", () => {
    expect(staleness({ ...fresh, running: "0.4.12", installed: "0.4.29", serviceKit: OLD_KIT })).toEqual({
      kind: "window",
      running: "0.4.12",
      installed: "0.4.29",
    });
  });

  it("a_window_running_the_newest_build_with_an_old_service_is_told_about_the_service", () => {
    expect(staleness({ ...fresh, serviceKit: OLD_KIT, serviceProtocol: undefined })).toEqual({ kind: "service", speaks: undefined });
    expect(staleness({ ...fresh, serviceKit: OLD_KIT, serviceProtocol: 2 })).toEqual({ kind: "service", speaks: 2 });
  });

  it("a_window_newer_than_anything_installed_is_not_called_stale", () => {
    // a build run from source, or the install dir read while a new version is unpacking
    expect(staleness({ ...fresh, running: "0.4.31", installed: "0.4.29" })).toBeUndefined();
    expect(staleness({ ...fresh, installed: undefined })).toBeUndefined();
  });

  it("a_window_that_does_not_know_its_own_version_claims_nothing_about_itself", () => {
    expect(staleness({ ...fresh, running: "", installed: "0.4.31" })).toBeUndefined();
    expect(staleness({ ...fresh, running: "", installed: "0.4.31", serviceKit: OLD_KIT })).toEqual({ kind: "service", speaks: 2 });
  });

  it("everything_current_says_nothing_at_all", () => {
    expect(staleness(fresh)).toBeUndefined();
  });

  it("the_window_notice_says_what_it_costs_and_the_service_notice_says_how_to_fix_it", () => {
    const window = stalenessText({ kind: "window", running: "0.4.12", installed: "0.4.29" });
    expect(window).toContain("0.4.12");
    expect(window).toContain("0.4.29");
    expect(window).toContain("из чужих сессий");
    const service = stalenessText({ kind: "service", speaks: undefined });
    expect(service).toContain("не из этой сборки");
    expect(service).toContain("прервутся"); // the cost of the restart is said, not hidden behind the button
    expect(RELOAD).toBe("Перезагрузить окно");
    expect(RESTART).toBe("Перезапустить службу");
  });

  // ---------- the notice itself ----------

  const NAMES = ["local.agent-tabs-0.4.12", "local.agent-tabs-0.4.31"];

  type Over = Partial<FreshnessDeps> & { press?: string | undefined };

  /** A window one build behind, with everything it talks to recorded. `press` is what the person does. */
  function notice(over: Over = {}) {
    const notified: Array<[string, string]> = [];
    const reloaded: string[] = [];
    const restarted: string[] = [];
    const logged: string[] = [];
    const freshness = new Freshness({
      running: "0.4.12",
      extensionsDir: "/ext",
      expectedKit: KIT,
      status: async () => ({ protocol: 2, kit: KIT }),
      notify: async (text, button) => {
        notified.push([text, button]);
        return "press" in over ? over.press : button;
      },
      reloadWindow: () => void reloaded.push("reload"),
      restartService: async () => void restarted.push("restart"),
      log: (text) => void logged.push(text),
      readDir: () => NAMES,
      ...over,
    });
    return { freshness, notified, reloaded, restarted, logged };
  }

  it("a_stale_window_is_told_once_however_often_it_is_asked", async () => {
    const { freshness, notified } = notice();
    await freshness.tell();
    await freshness.tell();
    await Promise.all([freshness.tell(), freshness.tell()]);
    expect(notified).toHaveLength(1); // once per window, not per tab and not per call
    expect(notified[0]?.[1]).toBe(RELOAD);
  });

  it("pressing_reload_reloads_the_window_and_touches_nothing_else", async () => {
    const { freshness, reloaded, restarted } = notice();
    expect(await freshness.tell()).toEqual({ kind: "window", running: "0.4.12", installed: "0.4.31" });
    expect(reloaded).toEqual(["reload"]);
    expect(restarted).toEqual([]);
  });

  it("a_dismissed_notice_changes_nothing_and_is_not_repeated", async () => {
    const { freshness, reloaded, notified } = notice({ press: undefined });
    expect(await freshness.tell()).toEqual({ kind: "window", running: "0.4.12", installed: "0.4.31" });
    expect(reloaded).toEqual([]);
    expect(await freshness.tell()).toBeUndefined();
    expect(notified).toHaveLength(1);
  });

  it("a_current_window_on_an_old_service_offers_the_restart", async () => {
    const { freshness, notified, restarted, reloaded } = notice({ running: "0.4.31", status: async () => ({ kit: OLD_KIT }) });
    expect(await freshness.tell()).toEqual({ kind: "service", speaks: undefined });
    expect(notified[0]?.[1]).toBe(RESTART);
    expect(notified[0]?.[0]).toContain("не из этой сборки");
    expect(restarted).toEqual(["restart"]);
    expect(reloaded).toEqual([]);
  });

  it("a_restart_that_fails_is_logged_and_never_thrown_at_activation", async () => {
    const { freshness, logged } = notice({
      running: "0.4.31",
      status: async () => ({ kit: OLD_KIT }),
      restartService: async () => {
        throw new Error("launchctl bootout failed");
      },
    });
    await expect(freshness.tell()).resolves.toEqual({ kind: "service", speaks: undefined });
    expect(logged.join()).toContain("launchctl bootout failed");
  });

  it("a_service_that_does_not_answer_is_not_news_here", async () => {
    const { freshness, notified } = notice({
      status: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await freshness.tell()).toBeUndefined();
    expect(notified).toEqual([]);
  });

  it("a_window_that_is_current_in_every_way_says_nothing", async () => {
    const { freshness, notified } = notice({ running: "0.4.31" });
    expect(await freshness.tell()).toBeUndefined();
    expect(notified).toEqual([]);
  });
});
