import { RpcError } from "../rpc/client";

/** Who holds a session file, as the host names it in a refusal (`session_held.holders`, `session_path_in_use.owner`). */
export type Holder = { pid?: number; cwd?: string; socket?: string; instance?: string };

/** What the live host is, as far as judging a refusal needs it. */
export type HostIdentity = { socket: string; instance?: string };

export type OpenFailure =
  /**
   * Waiting is the whole remedy: the file is held by something that is letting go, the host is draining, a teardown is
   * in flight. It belongs on the quiet line with its countdown — nothing is asked of the person.
   */
  | { kind: "retry"; text: string; holder?: Holder }
  /** The person has to decide or do something: it belongs in the top banner, where it stays until they do. */
  | { kind: "banner"; text: string };

/**
 * Refusals that time clears by itself. `session_path_in_use` is the host's own retryable answer (rpc.md: "the open is
 * a retry, not a failure" — it carries `retry_after_ms` while a generation parks the file); `session_closing` and
 * `session_busy_lifecycle` are a teardown or an open already in flight; the draining and memory ones say to ask again.
 * `closed`/`timeout` are the connection itself, which the line has always owned.
 */
const HEALS_WITH_TIME = new Set([
  "session_path_in_use",
  "session_closing",
  "session_busy_lifecycle",
  "host_stopping",
  "host_draining",
  "host_memory_pressure",
  "too_many_sessions",
  "closed",
  "timeout",
]);

const WORDS: Record<string, string> = {
  session_path_in_use: "Файл сессии ещё держит предыдущий хост OmO",
  session_closing: "Сессия ещё закрывается",
  session_busy_lifecycle: "Сессия сейчас открывается или закрывается",
  host_stopping: "Хост OmO останавливается",
  host_draining: "Хост OmO останавливается",
  host_memory_pressure: "Хосту OmO не хватает памяти",
  too_many_sessions: "У хоста OmO слишком много сессий",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One holder record, whatever shape it came in: `session_held` names a socket, `session_path_in_use` an instance. */
function holderOf(raw: unknown): Holder | undefined {
  if (!isObject(raw)) return undefined;
  const pid = raw["pid"];
  return {
    ...(typeof pid === "number" ? { pid } : {}),
    ...(optionalString(raw["cwd"]) !== undefined ? { cwd: raw["cwd"] as string } : {}),
    ...(optionalString(raw["host_socket"]) !== undefined ? { socket: raw["host_socket"] as string } : {}),
    ...(optionalString(raw["host_instance"]) !== undefined ? { instance: raw["host_instance"] as string } : {}),
    ...(optionalString(raw["instanceId"]) !== undefined ? { instance: raw["instanceId"] as string } : {}),
  };
}

/**
 * One socket path as the host spells it against ours. The host resolves the path it was given, so macOS answers
 * `/private/tmp/…` where the setting says `/tmp/…`; that one prefix is the whole difference.
 */
function sameSocket(theirs: string | undefined, ours: string): boolean {
  if (theirs === undefined) return false;
  const plain = (file: string): string => (file.startsWith("/private/") ? file.slice("/private".length) : file);
  return plain(theirs) === plain(ours);
}

/**
 * True when this holder is another copy of our own host: it serves the socket path this window's host serves, and it
 * is not the host that just answered us. A host never names itself as a holder, so its own socket path is already the
 * proof; the instance is compared as well whenever both sides give one.
 */
export function heldByAnotherHostCopy(holder: Holder | undefined, host: HostIdentity): boolean {
  if (holder === undefined || !sameSocket(holder.socket, host.socket)) return false;
  return host.instance === undefined || holder.instance === undefined || holder.instance !== host.instance;
}

/** The holder named in a refusal, if it named one. */
export function holderFrom(error: unknown, host: HostIdentity): Holder | undefined {
  if (!(error instanceof RpcError) || error.data === undefined) return undefined;
  const holders = error.data["holders"];
  if (Array.isArray(holders)) {
    const all = holders.map(holderOf).filter((one): one is Holder => one !== undefined);
    return all.find((one) => heldByAnotherHostCopy(one, host)) ?? all[0];
  }
  return holderOf(error.data["owner"]);
}

/**
 * Which side of the window a failed open belongs on. The line is for what waiting fixes — `session_path_in_use` is the
 * host's own retryable answer, and a reload normally re-attaches in milliseconds, so a path still held a moment later
 * is worth waiting out. The banner is for what the person must act on: no environment, a session file another program
 * has open, a model that does not exist, a malformed request.
 */
export function classifyOpen(error: unknown, host: HostIdentity): OpenFailure {
  if (!(error instanceof RpcError)) {
    return { kind: "banner", text: errorText(error) };
  }
  const holder = holderFrom(error, host);
  if (error.code === "session_held") {
    // Our own other copy is ours to wait out (and to own up to); any other program holding the file is the person's
    // to close, and no amount of retrying will do it for them.
    return heldByAnotherHostCopy(holder, host)
      ? { kind: "retry", text: heldText(holder), holder }
      : { kind: "banner", text: foreignHolderText(holder) };
  }
  if (HEALS_WITH_TIME.has(error.code)) {
    const text = WORDS[error.code] ?? error.message;
    return holder !== undefined ? { kind: "retry", text, holder } : { kind: "retry", text };
  }
  return { kind: "banner", text: error.message };
}

/** What the line says once it has stopped trying: who holds the file, and that waiting for them is all there is. */
export function giveUpText(holder: Holder | undefined, host: HostIdentity, lastError: string): string {
  if (!heldByAnotherHostCopy(holder, host)) return lastError;
  const pid = holder?.pid === undefined ? "" : ` (pid ${holder.pid})`;
  return `Файл сессии держит другая копия хоста OmO${pid} — она ещё работает. Сессия откроется сама, когда та её отпустит; повторять бесполезно.`;
}

function heldText(holder: Holder | undefined): string {
  const pid = holder?.pid === undefined ? "" : ` (pid ${holder.pid})`;
  return `Файл сессии держит другая копия хоста OmO${pid}`;
}

function foreignHolderText(holder: Holder | undefined): string {
  if (holder?.pid === undefined) return "Файл сессии открыт другой программой — закройте её";
  const where = holder.cwd === undefined ? "" : `, каталог ${holder.cwd}`;
  return `Файл сессии открыт другим процессом omo (pid ${holder.pid}${where}) — закройте его`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
