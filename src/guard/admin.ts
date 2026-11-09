import net from "node:net";
import { readLines, request, servicePaths, writeLine } from "../../kit/guard/sockets.mjs";
import { RECONNECT_DELAYS_MS } from "../daemon";
import type { FieldError } from "../settings/protocol";

export type GroupId = "git-push" | "history" | "secrets" | "external-ip" | "global-install";
export type DeciderMode = "decider-then-me" | "ask-me" | "deny";
export type WaitSeconds = 60 | 180 | 300;

/** `<agentDir>/guard/rules.json` v2 (kit/guard/rules.mjs validates it; `allow` and `builtinEscalate` are not edited here). */
export type RulesV2 = {
  version: 2;
  hardDeny: string[];
  groups: Record<GroupId, boolean>;
  askCustom: string[];
  allow: unknown[];
  builtinEscalate: unknown[];
  ipWhitelist: Array<{ cidr: string; note?: string }>;
  decider: { mode: DeciderMode; model?: string; timeoutMs: number };
  /** `card` is the person's UI preference (P27): the service always publishes events, the chat shows a card when on. */
  human: {
    waitSeconds: WaitSeconds;
    card: boolean;
    telegram: boolean;
    /** Where the Telegram questions go (a numeric chat id), and the one user whose presses count; the bot token is in keys/. */
    telegramChat?: string;
    telegramUser?: string;
  };
};

/**
 * An open request as the service shows it (command and code already redacted and capped). For an eval, `command` is
 * the shell commands its code runs, one per line, and `code` the code itself (B2); free text, redacted again by the
 * StatePoster on the way to a webview.
 */
export type PendingView = {
  id: string;
  session: string;
  coordinationId?: string;
  sessionLabel?: string;
  cwd: string;
  tool: string;
  command: string;
  code?: string;
  reasons: string[];
  decider?: { model?: string; decision: string; reason: string; ms: number };
  /** Legible «always allow» shapes the person can add from the card (program + flags, operands hidden as `*`). */
  proposal?: Array<{ scope: string; label: string }>;
  createdAt: string;
};

export type DeferredView = PendingView & { deferredAt: string };

export type CoordinationView = {
  id: string;
  session: string;
  label: string;
  kind: string;
  state: string;
  subject: string;
  participants: Array<{ session: string; label: string }>;
};

/** How this window answers «whose session is this»: it has the tab, it knows whose it is, or it has never heard of it. */
export type ClaimVerdict = "own" | "knows" | "no";

export type GuardEvent =
  | { event: "coordination"; items: CoordinationView[] }
  /**
   * A request the service placed with this window. `only`: this window claimed the session, and no other window was
   * given it. `outside`: nobody has the session open, so this window is the one to raise it outside the chats. Neither:
   * nobody claimed it and every window got it.
   */
  | { event: "pending"; item: PendingView; only?: true; outside?: { owner: string | null } }
  /** Whose session is this? Answered with `claim()` on the subscription's own connection, before the service places it. */
  | { event: "claim"; id: string; session: string }
  | {
      event: "resolved";
      id: string;
      decision: "allow" | "deny";
      by: "agent-tabs" | "cli" | "telegram" | "timeout" | "decider" | "whitelist";
      session: string;
      decider?: PendingView["decider"];
      item?: PendingView;
      /** The person's own whitelist allowed this call with no card: the shapes that matched. */
      whitelist?: { scopes: string[] };
      /** A deny's words for the agent, as the person wrote them (redacted by the service). */
      message?: string;
      deferred?: true;
    };

export type RulesSetResult = { ok: true } | { ok: false; errors: FieldError[] };

/** What the settings need of the admin socket. */
export type GuardRulesAdmin = Pick<GuardAdmin, "rulesGet" | "rulesSet" | "close">;

const REQUEST_MS = 10_000;
/**
 * The admin protocol this build speaks. 2 takes part in the claim round, so the service may place a request with this
 * window alone; a service that answers `status` without a `protocol` is older than this build and cannot route at all.
 */
export const ADMIN_PROTOCOL = 2;
/** A subscription that ends sooner than this after its confirmation counts as a flap; five in a row stop the retries. */
const STABLE_MS = 5_000;
const MAX_FLAPS = 5;

/** The service runs with rules it reports invalid (its rules.json was edited by hand); `errors` says what is wrong. */
export class GuardRulesInvalid extends Error {
  constructor(readonly errors: FieldError[]) {
    super(`правила службы защиты не прошли проверку: ${errors.map((error) => `${error.field}${error.line !== undefined ? `:${error.line}` : ""} ${error.message}`).join("; ")}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvent(value: unknown): value is GuardEvent {
  if (isObject(value) && value["event"] === "coordination") {
    return Array.isArray(value["items"]) && value["items"].every((item: unknown) =>
      isObject(item) && ["id", "session", "label", "kind", "state", "subject"].every((key) => typeof item[key] === "string") &&
      Array.isArray(item["participants"]) && item["participants"].every((participant: unknown) =>
        isObject(participant) && typeof participant["session"] === "string" && typeof participant["label"] === "string"));
  }
  return isObject(value) && (value["event"] === "pending" || value["event"] === "resolved" || value["event"] === "claim");
}

/** A live subscription: it ends with `stop`, and answers the service's claim rounds on its own connection. */
export type GuardSubscription = {
  stop(): void;
  /** Who owns the session of request `id`. Dropped when the connection is down: the service's round times out instead. */
  claim(id: string, verdict: ClaimVerdict, owner?: string): void;
};

/**
 * The extension's client of the decision service's admin socket (`<agentDir>/guard/admin.sock`, closed to the
 * sandbox). Every call is one request on a connection of its own; a subscription holds one open and, when the service
 * goes away (launchd restarts it), subscribes again with the bounded policy (P6): up to five tries, 1–16 s apart, a
 * successful one resets the count; after the last one `onGiveUp` runs and nothing retries. A service that confirms and
 * drops the subscription within 5 s five times in a row (a crash loop) also ends the retries.
 */
export class GuardAdmin {
  private readonly stops = new Set<() => void>();

  private constructor(
    private readonly socket: string,
    private readonly delays: readonly number[],
    private readonly stableMs: number,
  ) {}

  /** Rejects when the service does not answer. */
  static async connect(agentDir: string, options: { reconnectDelaysMs?: readonly number[]; stableMs?: number } = {}): Promise<GuardAdmin> {
    const admin = new GuardAdmin(servicePaths(agentDir).adminSock, options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS, options.stableMs ?? STABLE_MS);
    await admin.call({ op: "status" });
    return admin;
  }

  /**
   * What the service is: its version, the admin protocol it speaks and the kit directory it was loaded from. An older
   * service answers without `protocol` and `kit`, which is how a window knows it cannot be routed to.
   */
  async status(): Promise<{ version: number; protocol?: number; kit?: string; rulesOk: boolean }> {
    const reply = await this.call({ op: "status" });
    return {
      version: typeof reply["version"] === "number" ? reply["version"] : 0,
      ...(typeof reply["protocol"] === "number" ? { protocol: reply["protocol"] } : {}),
      ...(typeof reply["kit"] === "string" ? { kit: reply["kit"] } : {}),
      rulesOk: reply["rulesOk"] === true,
    };
  }

  /** The service's rules; rejects with GuardRulesInvalid when it reports them invalid. */
  async rulesGet(): Promise<RulesV2> {
    const reply = await this.call({ op: "rules.get" });
    if (Array.isArray(reply["errors"]) && reply["errors"].length > 0) throw new GuardRulesInvalid(reply["errors"] as FieldError[]);
    if (!isObject(reply["rules"])) throw new GuardRulesInvalid([{ field: "rules", message: "служба защиты не прислала правила" }]);
    return reply["rules"] as RulesV2;
  }

  async rulesSet(rules: RulesV2): Promise<RulesSetResult> {
    const reply = await this.call({ op: "rules.set", rules });
    if (reply["ok"] === true) return { ok: true };
    if (Array.isArray(reply["errors"])) return { ok: false, errors: reply["errors"] as FieldError[] };
    return { ok: false, errors: [{ field: "rules", message: String(reply["error"] ?? "служба защиты не приняла правила") }] };
  }

  async pending(): Promise<PendingView[]> {
    const items = (await this.call({ op: "pending" }))["items"];
    return Array.isArray(items) ? (items as PendingView[]) : [];
  }

  async deferred(): Promise<DeferredView[]> {
    const items = (await this.call({ op: "deferred" }))["items"];
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is DeferredView =>
      isObject(item) && typeof item["id"] === "string" && typeof item["session"] === "string" &&
      typeof item["cwd"] === "string" && typeof item["tool"] === "string" && typeof item["command"] === "string" &&
      typeof item["createdAt"] === "string" && Number.isFinite(Date.parse(item["createdAt"])) &&
      typeof item["deferredAt"] === "string" && Number.isFinite(Date.parse(item["deferredAt"])) &&
      (item["code"] === undefined || typeof item["code"] === "string") &&
      Array.isArray(item["reasons"]) && item["reasons"].every((reason: unknown) => typeof reason === "string"));
  }

  /** `message`: a deny's words for the agent (the hook's deny reason); free text, never logged. */
  async answer(id: string, decision: "allow-once" | "allow-always" | "deny", message?: string): Promise<void> {
    const reply = await this.call({ op: "answer", id, decision, by: "agent-tabs", ...(message !== undefined ? { message } : {}) });
    if (reply["ok"] !== true) throw new Error(String(reply["error"] ?? "служба защиты не приняла ответ"));
  }

  /**
   * Events from now on (the open requests first); the returned function ends the subscription. `onSubscribed` runs
   * each time the service confirms, the first time and after every resubscription (before that one's replay).
   */
  subscribe(listener: (event: GuardEvent) => void, onGiveUp?: () => void, onSubscribed?: () => void, coordination = false): GuardSubscription {
    let current: net.Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    let failures = 0;
    let flaps = 0;
    let confirmedAt: number | undefined;
    const giveUp = (): void => {
      stop();
      onGiveUp?.();
    };
    const stop = (): void => {
      stopped = true;
      clearTimeout(timer);
      current?.destroy();
      this.stops.delete(stop);
    };
    const open = (): void => {
      const socket = net.createConnection(this.socket);
      current = socket;
      confirmedAt = undefined;
      socket.on("connect", () => writeLine(socket, { op: "subscribe", protocol: ADMIN_PROTOCOL, coordination }));
      readLines(socket, (message) => {
        if (stopped) return;
        if (confirmedAt === undefined) {
          if (isObject(message) && message["ok"] === true) {
            confirmedAt = Date.now();
            failures = 0;
            onSubscribed?.();
          }
        } else if (isEvent(message)) listener(message);
      });
      socket.on("error", () => undefined); // "close" follows
      socket.on("close", () => {
        if (stopped) return;
        if (confirmedAt !== undefined) {
          flaps = Date.now() - confirmedAt < this.stableMs ? flaps + 1 : 0;
          if (flaps >= MAX_FLAPS) return giveUp();
        }
        const delay = this.delays[failures];
        failures += 1;
        if (delay === undefined) return giveUp();
        timer = setTimeout(open, delay);
      });
    };
    this.stops.add(stop);
    open();
    return {
      stop,
      claim: (id, verdict, owner) => {
        if (stopped || current === undefined || current.destroyed) return;
        writeLine(current, { op: "claim", id, verdict, ...(owner !== undefined ? { owner } : {}) });
      },
    };
  }

  /** Ends every subscription; calls already sent finish on their own connections. */
  close(): void {
    for (const stop of [...this.stops]) stop();
  }

  private async call(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await request(this.socket, message, REQUEST_MS);
    if (!isObject(reply)) throw new Error("служба защиты ответила не объектом");
    return reply;
  }
}
