import { readdirSync } from "node:fs";

/** `local.agent-tabs-0.4.29` -> `0.4.29`; anything else is not one of our installs. */
const INSTALL = /^local\.agent-tabs-(\d+\.\d+\.\d+)$/;

/** Newest first, by number and not by string («0.4.9» is older than «0.4.21»). */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    const diff = (a[at] ?? 0) - (b[at] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The newest build sitting in the extensions dir, whatever this window happens to be running. */
export function installedVersion(extensionsDir: string, readDir: (path: string) => string[] = readdirSync): string | undefined {
  let newest: string | undefined;
  let names: string[];
  try {
    names = readDir(extensionsDir);
  } catch {
    return undefined; // not readable: nothing to compare against, and nothing is claimed
  }
  for (const name of names) {
    const version = INSTALL.exec(name)?.[1];
    if (version !== undefined && (newest === undefined || compareVersions(version, newest) > 0)) newest = version;
  }
  return newest;
}

/** What is out of date, if anything. One per window: the notice is about the window, not about a tab. */
export type Staleness =
  /** This window's extension host loaded an older build than the newest installed; only a reload picks it up. */
  | { kind: "window"; running: string; installed: string }
  /**
   * The decision service running for this environment is not the one this build installs. It is a LaunchAgent pointed
   * at a content-hashed copy of `kit/guard`, rebooted only when protection is turned on, so a newer extension leaves
   * the old service running — and an old service cannot route a request to the window that owns it.
   */
  | { kind: "service"; speaks: number | undefined };

/**
 * Whether this window is running what is installed, and whether the service it talks to is the one this build expects.
 * The window check comes first: a stale window is why two windows render one request two ways, and it is the thing the
 * person can fix in one click. Only one is reported, so a window that is behind is not also told about its service —
 * reloading it may well be all that is needed.
 */
export function staleness(input: {
  /** This window's own version (`context.extension.packageJSON.version`). */
  running: string;
  /** The newest build in the extensions dir. */
  installed: string | undefined;
  /** `kit` from the service's `status`; undefined when it is too old to say. */
  serviceKit: string | undefined;
  /** `protocol` from the service's `status`; undefined when it is too old to say. */
  serviceProtocol: number | undefined;
  /** Where this build's guard kit installs to (`guardFilesDir`). */
  expectedKit: string;
}): Staleness | undefined {
  // an unknown own version claims nothing: it would make every install look newer than this window
  if (input.running !== "" && input.installed !== undefined && compareVersions(input.installed, input.running) > 0) {
    return { kind: "window", running: input.running, installed: input.installed };
  }
  if (input.serviceKit !== input.expectedKit) return { kind: "service", speaks: input.serviceProtocol };
  return undefined;
}

export const RELOAD = "Перезагрузить окно";
export const RESTART = "Перезапустить службу";

export type FreshnessDeps = {
  /** This window's own version. */
  running: string;
  /** VS Code's extensions dir for this window. */
  extensionsDir: string;
  /** Where this build's guard kit installs to. */
  expectedKit: string;
  /** The service's `status`; rejects when nothing answers (not news here: enabling protection says that itself). */
  status: () => Promise<{ protocol?: number; kit?: string }>;
  notify: (text: string, button: string) => Promise<string | undefined>;
  reloadWindow: () => void;
  /** Re-runs protection setup, which reboots the LaunchAgent with this build's kit. */
  restartService: () => Promise<void>;
  log: (text: string) => void;
  readDir?: (path: string) => string[];
};

/**
 * Tells the person, at most once in the life of this window, when the window cannot do what it claims: it is running an
 * older build than the one installed, or the service answering it is not the one this build installs. Once per window
 * and never per tab — they have fifteen windows and no way to tell which of them is still deciding for itself whose
 * request a card is.
 */
export class Freshness {
  private told = false;

  constructor(private readonly deps: FreshnessDeps) {}

  async tell(): Promise<Staleness | undefined> {
    if (this.told) return undefined;
    this.told = true; // before the awaits: two calls in flight must not become two notifications
    let service: { protocol?: number; kit?: string };
    try {
      service = await this.deps.status();
    } catch {
      return undefined;
    }
    const stale = staleness({
      running: this.deps.running,
      installed: installedVersion(this.deps.extensionsDir, this.deps.readDir),
      serviceKit: service.kit,
      serviceProtocol: service.protocol,
      expectedKit: this.deps.expectedKit,
    });
    if (stale === undefined) return undefined;
    this.deps.log(`Это окно не на той сборке: ${JSON.stringify(stale)}`);
    const button = stale.kind === "window" ? RELOAD : RESTART;
    if ((await this.deps.notify(stalenessText(stale), button)) !== button) return stale;
    if (stale.kind === "window") this.deps.reloadWindow();
    else {
      try {
        await this.deps.restartService();
      } catch (error) {
        this.deps.log(`Службу защиты не удалось перезапустить: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return stale;
  }
}

/** What the person is told, once per window. It says what is wrong and what it costs them, never just «update». */
export function stalenessText(stale: Staleness): string {
  if (stale.kind === "window") {
    return (
      `Это окно работает на Agent Tabs ${stale.running}, а установлена ${stale.installed}. ` +
      "Расширение загружается один раз при старте окна, поэтому до перезагрузки окно ведёт себя по-старому — " +
      "в том числе может показывать запросы защиты из чужих сессий."
    );
  }
  const speaks = stale.speaks === undefined ? "она старее этой сборки" : `она отвечает по протоколу ${stale.speaks}`;
  return (
    `Служба защиты запущена не из этой сборки Agent Tabs (${speaks}). ` +
    "Пока это так, запрос не удаётся отдать именно тому окну, которому он принадлежит, и он может появиться в чужом чате. " +
    "Перезапуск службы перезапускает и хост OmO: текущие ходы во всех окнах этой среды прервутся."
  );
}
