import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELD_RETRY_PAUSES_MS, heldPause, ReconnectLoop, RETRY_PAUSES_MS, retryPause } from "../../src/sessions/reconnect";

/** The loop under a clock we own: `runs` records when it asked for an attempt, `told` how often the line was updated. */
function loop(): { loop: ReconnectLoop; runs: number[]; told: () => number } {
  const runs: number[] = [];
  let updates = 0;
  const made = new ReconnectLoop(
    () => runs.push(Date.now()),
    () => (updates += 1),
  );
  return { loop: made, runs, told: () => updates };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the automatic reconnect schedule", () => {
  it("pauses_grow_by_the_schedule_and_then_hold_at_its_cap", () => {
    expect(RETRY_PAUSES_MS.map((_, index) => retryPause(index + 1))).toEqual([1_000, 2_000, 5_000, 10_000, 20_000, 30_000]);
    expect(retryPause(7)).toBe(30_000);
    expect(retryPause(99)).toBe(30_000);
    expect(Math.min(...RETRY_PAUSES_MS)).toBeGreaterThanOrEqual(1_000); // never faster than once a second
  });

  it("attempts_again_by_itself_after_each_pause_without_anyone_clicking", () => {
    const { loop: made, runs } = loop();
    made.failed("omo host exited");
    expect(made.view).toMatchObject({ attempt: 1, waitMs: 1_000, error: "omo host exited" });

    vi.advanceTimersByTime(999);
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveLength(1);
    expect(made.view).toMatchObject({ attempt: 1 });
    expect(made.view?.waitMs).toBeUndefined(); // in flight: the line spins without a countdown

    made.failed("omo host exited");
    expect(made.view).toMatchObject({ attempt: 2, waitMs: 2_000 });
    vi.advanceTimersByTime(2_000);
    expect(runs).toHaveLength(2);
  });

  it("the_pause_reaches_its_cap_and_the_loop_keeps_trying_there_instead_of_giving_up", () => {
    const { loop: made, runs } = loop();
    for (const pause of RETRY_PAUSES_MS) {
      made.failed("down");
      expect(made.view?.waitMs).toBe(pause);
      vi.advanceTimersByTime(pause);
    }
    expect(runs).toHaveLength(RETRY_PAUSES_MS.length);
    expect(made.view?.capped).toBe(true);

    for (let extra = 0; extra < 3; extra++) {
      made.failed("down");
      expect(made.view).toMatchObject({ waitMs: 30_000, capped: true });
      vi.advanceTimersByTime(30_000);
    }
    expect(runs).toHaveLength(RETRY_PAUSES_MS.length + 3);
  });

  it("never_has_two_attempts_in_flight", () => {
    const { loop: made, runs } = loop();
    made.failed("down");
    vi.advanceTimersByTime(1_000);
    expect(runs).toHaveLength(1);

    // The attempt has not reported back: no timer is armed, so no amount of waiting starts a second one.
    vi.advanceTimersByTime(10 * 60_000);
    expect(runs).toHaveLength(1);
    expect(made.waiting).toBe(false);
  });

  it("повторить_сейчас_cuts_the_pause_short_and_does_not_fire_it_twice", () => {
    const { loop: made, runs } = loop();
    made.failed("down");
    made.failed("down"); // a second failure replaces the first pause rather than adding a timer
    expect(made.waiting).toBe(true);

    made.now();
    expect(runs).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(runs).toHaveLength(1);

    made.now(); // nothing is waiting: there is nothing to cut short
    expect(runs).toHaveLength(1);
  });

  it("a_success_clears_the_line_and_starts_the_schedule_over", () => {
    const { loop: made } = loop();
    made.failed("down");
    made.failed("down");
    made.stop();
    expect(made.view).toBeUndefined();
    expect(made.waiting).toBe(false);

    made.failed("down again");
    expect(made.view).toMatchObject({ attempt: 1, waitMs: 1_000 });
  });

  it("the_held_schedule_is_fast_at_first_bounded_and_ends", () => {
    expect(HELD_RETRY_PAUSES_MS).toEqual([300, 700, 1_500, 3_000, 5_000, 5_000]);
    expect(heldPause(1)).toBeLessThan(1_000); // a path that is free re-attaches in milliseconds; a held one frees fast
    expect(HELD_RETRY_PAUSES_MS.reduce((all, pause) => all + pause, 0)).toBeLessThanOrEqual(16_000);
    expect(heldPause(HELD_RETRY_PAUSES_MS.length + 1)).toBeUndefined(); // it ENDS: nothing retries for ever
  });

  /** Bounded, with its own growing cooldown, and loud when it stops — one tab's whole budget at a held path. */
  it("a_tab_at_a_held_path_makes_at_most_the_schedule_and_then_says_it_stopped", () => {
    const { loop: made, runs } = loop();
    for (let attempt = 1; ; attempt += 1) {
      const pause = heldPause(attempt);
      if (pause === undefined) {
        made.giveUp("другая копия хоста OmO держит файл");
        break;
      }
      made.failed("файл сессии держат", pause);
      expect(made.view).toMatchObject({ attempt, waitMs: pause });
      vi.advanceTimersByTime(pause);
    }
    expect(runs).toHaveLength(HELD_RETRY_PAUSES_MS.length);
    expect(made.view).toMatchObject({ attempt: HELD_RETRY_PAUSES_MS.length, givenUp: true });
    expect(made.view?.waitMs).toBeUndefined(); // nothing counts down, and «Повторить сейчас» has nothing to cut short
    expect(made.waiting).toBe(false);

    vi.advanceTimersByTime(10 * 60_000);
    expect(runs).toHaveLength(HELD_RETRY_PAUSES_MS.length); // it really stopped
    made.now();
    expect(runs).toHaveLength(HELD_RETRY_PAUSES_MS.length);
  });

  it("a_session_that_opens_after_all_clears_the_line_it_gave_up_on", () => {
    const { loop: made } = loop();
    made.giveUp("файл сессии держат");
    made.stop();
    expect(made.view).toBeUndefined();

    made.failed("down");
    expect(made.view).toMatchObject({ attempt: 1, waitMs: 1_000 });
    expect(made.view?.givenUp).toBeUndefined();
  });

  it("nothing_runs_after_dispose", () => {
    const { loop: made, runs } = loop();
    made.failed("down");
    made.dispose();
    expect(made.view).toBeUndefined();
    vi.advanceTimersByTime(10 * 60_000);
    expect(runs).toHaveLength(0);

    made.failed("down"); // a disposed loop takes nothing on
    made.now();
    vi.advanceTimersByTime(10 * 60_000);
    expect(runs).toHaveLength(0);
    expect(made.view).toBeUndefined();
  });
});
