/**
 * Pauses (ms) before each automatic attempt to reach a session whose connection failed: 1, 2, 5, 10, 20 s, then every
 * 30 s. Bounded growth, never faster than once a second, so a host that is down is never stormed; the last pause
 * repeats instead of the loop quitting — the line keeps saying it is still trying, and «Повторить сейчас» is there for
 * impatience. Nobody has to click for the session to come back.
 */
export const RETRY_PAUSES_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

/** The pause before attempt `attempt` (1-based); past the schedule it stays at its cap. */
export function retryPause(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_PAUSES_MS.length) - 1;
  return RETRY_PAUSES_MS[index] as number;
}

/**
 * Pauses before each attempt to open a session whose file the host says is still held: 0.3, 0.7, 1.5, 3 and 5 s twice —
 * six attempts inside sixteen seconds. A reload re-attaches in milliseconds while the path is free (measured 4 ms,
 * host-race cases r3/r4, measured live), so a path still held is already the unusual case: the first pause is
 * sub-second because an ordinary holder lets go almost at once (3.5 s measured for an idle one), and the schedule ENDS
 * instead of repeating — a holder still there after sixteen seconds is another copy of the host that will not yield to
 * being asked again, and saying so plainly is worth more than a spinner. Six attempts per tab also keep a window full
 * of restored tabs from storming the host: ten tabs make at most seventy opens across those sixteen seconds.
 */
export const HELD_RETRY_PAUSES_MS: readonly number[] = [300, 700, 1_500, 3_000, 5_000, 5_000];

/** The pause before attempt `attempt` (1-based) at a held path, or undefined when the schedule is out of attempts. */
export function heldPause(attempt: number): number | undefined {
  return HELD_RETRY_PAUSES_MS[Math.max(attempt, 1) - 1];
}

/** What the line over the composer says; the details modal expands the same record. */
export type ReconnectView = {
  /** The whole message of the last failure: the line truncates it, the modal shows all of it. */
  error: string;
  /** Automatic attempts that have failed so far; 0 before the first one. */
  attempt: number;
  /** The pause now running, ms; absent while an attempt is in flight. */
  waitMs?: number;
  /** The pause has reached its cap: the extension keeps trying at that interval rather than giving up. */
  capped: boolean;
  /**
   * The retry has stopped: what holds the session will not let go for being asked again. The line stays — it is still
   * the quiet place for this, not the banner — but it counts nothing down and offers no «Повторить сейчас», because
   * there is nothing a click could do.
   */
  givenUp?: true;
  /**
   * There IS something a click could do, and only the person may decide it: the holder is a second copy of our own host
   * that the extension refused to stop by itself. The line offers to stop it, and `error` already carries the facts
   * they decide on.
   */
  offerStop?: true;
};

/**
 * The self-healing retry of one tab's connection: it holds the pause, the attempt count and the last failure, and
 * calls `run` when the pause is out. One attempt at a time — a pause is armed only by the attempt that reported back,
 * so two can never be in flight — and nothing is armed after `dispose`.
 */
export class ReconnectLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private current: ReconnectView | undefined;
  private disposed = false;

  constructor(
    private readonly run: () => void,
    private readonly changed: () => void,
  ) {}

  get view(): ReconnectView | undefined {
    return this.current;
  }

  /** Automatic attempts that have failed so far: what picks the next pause out of a schedule. */
  get attempts(): number {
    return this.attempt;
  }

  /** True while a pause is running: whoever wants an attempt now cuts it short instead of starting its own. */
  get waiting(): boolean {
    return this.timer !== undefined;
  }

  /** An attempt is in flight (ours, or the daemon's own reconnect): the line spins without a countdown. */
  trying(error: string | undefined = this.current?.error): void {
    this.clear();
    if (this.disposed || error === undefined) return;
    this.current = { error, attempt: this.attempt, capped: this.capped };
    this.changed();
  }

  /** An attempt failed: the next one is armed after `waitMs`, or after the connection schedule's own pause. */
  failed(error: string, waitMs?: number): void {
    this.clear();
    if (this.disposed) return;
    this.attempt += 1;
    const pause = waitMs ?? retryPause(this.attempt);
    this.current = { error, attempt: this.attempt, waitMs: pause, capped: this.capped };
    this.timer = setTimeout(() => this.fire(), pause);
    this.changed();
  }

  /**
   * The schedule is out of attempts and the thing in the way is not going to move for another one: the line says so
   * and arms nothing. `offerStop` when the person may still stop the holder themselves. `stop()` (the session opened)
   * or a new `failed` starts the loop over.
   */
  giveUp(error: string, offerStop = false): void {
    this.clear();
    if (this.disposed) return;
    this.current = { error, attempt: this.attempt, capped: this.capped, givenUp: true, ...(offerStop ? { offerStop: true as const } : {}) };
    this.changed();
  }

  /** «Повторить сейчас»: the pause is cut short. Nothing happens unless one is running. */
  now(): void {
    if (this.disposed || this.timer === undefined) return;
    this.fire();
  }

  /** It worked, or there is nothing left to retry: the line goes and the schedule starts over. */
  stop(): void {
    this.clear();
    this.attempt = 0;
    if (this.current === undefined) return;
    this.current = undefined;
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.current = undefined;
  }

  private get capped(): boolean {
    return this.attempt >= RETRY_PAUSES_MS.length;
  }

  private fire(): void {
    this.clear();
    this.trying();
    this.run();
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
