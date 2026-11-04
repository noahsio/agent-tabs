import type { Checkpointer } from "../rewind/checkpointer";
import { agentTouches } from "../rewind/children";
import { ancestors, findUserEntry, type Entry } from "../rewind/edits";
import { forkDraft, forkTitle, writeFork, type ForkDraft } from "../rewind/fork";
import { applyRewind, planRewind, type RewindPlan } from "../rewind/plan";
import { snapshotExists } from "../rewind/snapshot";
import type { CheckpointLog, CheckpointPoint, SentMode } from "../rewind/store";
import type { SessionController } from "../sessions/controller";
import type { Availability, MessageActionsMessage, RewindPreviewMessage, RewoundMessage } from "./protocol";

export const HINTS = {
  busy: "Дождитесь конца хода",
  noGit: "Откат кода работает только в git-проекте",
  steer: "Для сообщения, отправленного во время работы, откат недоступен",
  noSnapshot: "Снимок не сохранился",
  offBranch: "Сообщение не в текущей ветке разговора",
  notFound: "Сообщение не найдено в журнале сессии",
  liveUnknown: "Не удалось проверить, не идёт ли ход в другой сессии этого проекта",
  changed: "Файлы изменились — проверьте список ещё раз",
} as const;

const EXCERPT_CHARS = 40;

/** First failing of: not git, sent while running, no snapshot (no point or its ref is gone), a turn running. */
export function rewindAvailability(input: {
  repo: string | undefined;
  sent: SentMode | undefined;
  point: CheckpointPoint | undefined;
  snapshotExists: boolean;
  busy: boolean;
}): Availability {
  if (input.repo === undefined) return { ok: false, reason: HINTS.noGit };
  if (input.sent !== undefined) return { ok: false, reason: HINTS.steer };
  if (input.point === undefined || !input.snapshotExists) return { ok: false, reason: HINTS.noSnapshot };
  if (input.busy) return { ok: false, reason: HINTS.busy };
  return { ok: true };
}

export function forkAvailability(running: boolean): Availability {
  return running ? { ok: false, reason: HINTS.busy } : { ok: true };
}

/** First non-empty line, at most 40 characters, `…` when cut. */
export function excerpt(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line;
}

function filesWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return "файл";
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "файла";
  return "файлов";
}

export function rewoundNotice(count: number, messageExcerpt: string): string {
  return `Откатили ${count} ${filesWord(count)} к сообщению «${messageExcerpt}»`;
}

/** What the service needs from a session controller. */
export type ActionsController = Pick<SessionController, "cwd" | "sessionUuid" | "state" | "tabState" | "journal" | "note">;

export type MessageActionsDeps = {
  controller: ActionsController;
  checkpointer: Checkpointer;
  runningCwds: () => Promise<string[]>;
  /** `name`: the fork's session name, set once its tab has opened it. */
  openFork: (sessionPath: string, draft: ForkDraft, name: string) => void;
  now?: () => Date;
};

type Prepared = { ok: true; plan: RewindPlan; excerpt: string } | { ok: false; reason: string; excerpt: string };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The ↺ menu of one tab: availability, rewind preview and apply, fork into a new tab. */
export class MessageActions {
  constructor(private readonly deps: MessageActionsDeps) {}

  async menu(blockId: string): Promise<MessageActionsMessage> {
    let rewind: Availability;
    try {
      rewind = (await this.rewindState(blockId)).availability;
    } catch (error) {
      rewind = { ok: false, reason: errorText(error) };
    }
    return { type: "messageActions", blockId, fork: forkAvailability(this.deps.controller.state.running), rewind };
  }

  async preview(blockId: string, fork: boolean): Promise<RewindPreviewMessage> {
    return previewMessage(blockId, fork, await this.prepare(blockId));
  }

  /**
   * Applies the plan the person confirmed, and only that one: the plan is made again and its fingerprint compared with
   * the confirmed one. Anything changed meanwhile (a file edited, a new agent edit) → nothing is applied and a fresh
   * preview goes back with the reason. A partial failure records what went through and names both lists.
   */
  async rewind(blockId: string, fork: boolean, fingerprint: string): Promise<{ rewound: RewoundMessage; preview?: RewindPreviewMessage }> {
    const prepared = await this.prepare(blockId);
    if (!prepared.ok) return { rewound: { type: "rewound", blockId, ok: false, reason: prepared.reason } };
    if (prepared.plan.fingerprint !== fingerprint) {
      return { rewound: { type: "rewound", blockId, ok: false, reason: HINTS.changed }, preview: previewMessage(blockId, fork, prepared) };
    }
    const { controller, checkpointer } = this.deps;
    let applied: Awaited<ReturnType<typeof applyRewind>>;
    try {
      applied = await applyRewind(prepared.plan);
    } catch (error) {
      return { rewound: { type: "rewound", blockId, ok: false, reason: errorText(error) } };
    }
    if (controller.sessionUuid !== undefined && applied.after.length > 0) {
      await checkpointer.store
        .append(controller.sessionUuid, applied.after.map(({ path, hash }) => ({ type: "after" as const, path, hash, at: Date.now() })))
        .catch(() => undefined);
    }
    if (applied.count > 0) controller.note("info", rewoundNotice(applied.count, prepared.excerpt));
    if (applied.failures.length > 0) {
      const failed = applied.failures.map((failure) => `${failure.path} (${failure.reason})`).join(", ");
      const done = applied.done.length > 0 ? `Откатили: ${applied.done.join(", ")}. ` : "";
      return { rewound: { type: "rewound", blockId, ok: false, reason: `${done}Не удалось откатить: ${failed}` } };
    }
    if (fork) {
      const forked = await this.fork(blockId);
      if (!forked.ok) controller.note("warn", `Не удалось ответвить разговор: ${forked.reason}`);
    }
    return { rewound: { type: "rewound", blockId, ok: true, count: applied.count } };
  }

  async fork(blockId: string): Promise<Availability> {
    const { controller, checkpointer } = this.deps;
    const available = forkAvailability(controller.state.running);
    if (!available.ok) return available;
    const sessionPath = controller.tabState.sessionPath;
    if (sessionPath === undefined) return { ok: false, reason: HINTS.notFound };
    try {
      const { entries } = await controller.journal();
      const entry = findUserEntry(entries, blockId);
      const entryId = entry?.["id"];
      if (typeof entryId !== "string") return { ok: false, reason: HINTS.notFound };
      const result = await writeFork(sessionPath, entryId, this.deps.now?.() ?? new Date());
      if (controller.sessionUuid !== undefined) {
        const copied = new Set(result.chain.flatMap((item) => clientMessageIdOf(item) ?? []));
        await checkpointer.store.copyForFork(controller.sessionUuid, result.sessionUuid, copied).catch(() => undefined);
      }
      this.deps.openFork(result.sessionPath, result.draft, forkTitle(controller.state.title ?? ""));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }

  /** Re-checks availability, then plans the rewind from the active branch of the journal. */
  private async prepare(blockId: string): Promise<Prepared> {
    const { controller, checkpointer } = this.deps;
    try {
      const state = await this.rewindState(blockId);
      if (!state.availability.ok) return { ok: false, reason: state.availability.reason, excerpt: "" };
      const point = state.point as CheckpointPoint;
      const { entries, leafId } = await controller.journal();
      const chain = leafId === null ? [] : ancestors(entries, leafId);
      const entry = findUserEntry(chain, point.clientMessageId);
      if (entry === undefined) return { ok: false, reason: HINTS.offBranch, excerpt: "" };
      const text = excerpt(forkDraft(entry).text);
      const { touches, unknownTools } = await agentTouches({
        agentDir: checkpointer.agentDir,
        chain,
        fromIndex: chain.indexOf(entry),
        cwd: controller.cwd ?? point.repo,
      });
      const plan = await planRewind({ repo: point.repo, point, touches, unknownTools, after: state.log.after });
      return { ok: true, plan, excerpt: text };
    } catch (error) {
      return { ok: false, reason: errorText(error), excerpt: "" };
    }
  }

  private async rewindState(blockId: string): Promise<{ availability: Availability; point: CheckpointPoint | undefined; log: CheckpointLog }> {
    const { controller, checkpointer } = this.deps;
    const cwd = controller.cwd;
    const uuid = controller.sessionUuid;
    const repo = cwd === undefined ? undefined : await checkpointer.repoFor(cwd);
    const log: CheckpointLog = uuid === undefined ? { points: new Map(), sent: new Map(), after: new Map() } : await checkpointer.store.read(uuid);
    const point = log.points.get(blockId);
    const exists = point === undefined ? false : await snapshotExists(point.repo, point.id).catch(() => false);
    let busy = controller.state.running;
    let liveUnknown = false;
    if (!busy && repo !== undefined) {
      try {
        const others = await Promise.all((await this.deps.runningCwds()).map((other) => checkpointer.repoFor(other)));
        busy = others.includes(repo);
      } catch {
        liveUnknown = true; // «unknown» is not «none»: a turn elsewhere in this repo may be writing
      }
    }
    const availability = rewindAvailability({ repo, sent: log.sent.get(blockId), point, snapshotExists: exists, busy });
    return { availability: availability.ok && liveUnknown ? { ok: false, reason: HINTS.liveUnknown } : availability, point, log };
  }
}

function previewMessage(blockId: string, fork: boolean, prepared: Prepared): RewindPreviewMessage {
  const base = { type: "rewindPreview" as const, blockId, fork, excerpt: prepared.excerpt };
  return prepared.ok ? { ...base, ok: true, items: prepared.plan.items, fingerprint: prepared.plan.fingerprint } : { ...base, ok: false, reason: prepared.reason };
}

function clientMessageIdOf(entry: Entry): string | undefined {
  const message = entry["message"];
  if (entry["type"] !== "message" || typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  return record["role"] === "user" && typeof record["clientMessageId"] === "string" ? record["clientMessageId"] : undefined;
}
