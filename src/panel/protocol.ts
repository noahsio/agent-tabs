import type { AgentStatus, Block, ChatState, ModelRef } from "../chat/model";
import type { DeferredQuestion } from "../deferred/questions";
export type { DeferredQuestion } from "../deferred/questions";
import type { PendingView } from "../guard/admin";
import type { RewindItem } from "../rewind/plan";
import type { AnswerOutcome, CommandRow, DialogAnswer, NextMode, OutgoingImage, TabState, UnwedgeOutcome } from "../sessions/controller";
import type { LadderView } from "../sessions/ladder";
import type { ReconnectView } from "../sessions/reconnect";
import type { LoginEvent } from "../settings/accounts";
import { isSettingsSection, type FieldError, type SettingsSection, type SettingsState } from "../settings/protocol";

/**
 * `reasoning`: OmO's own word on whether the model thinks (absent when its catalog does not say).
 * `acceptsImages`: whether the model takes image input (from its `input` modalities); absent when the catalog says
 * nothing about `input`, so a model of unknown capability is never warned against.
 */
export type ModelInfo = { provider: string; id: string; name?: string; reasoning?: boolean; acceptsImages?: boolean };

/**
 * Whether a model takes image input, read from the OmO Model object's `input` modalities. `undefined` when `input` is
 * not a list (the catalog is silent): a model of unknown capability must never be warned against.
 */
export function acceptsImageInput(input: unknown): boolean | undefined {
  if (!Array.isArray(input)) return undefined;
  return input.includes("image");
}

/**
 * The tab as the webview sees it: its saved state plus whether its session is pinned (the one source of that flag),
 * and `draft` while it is a new tab whose session does not exist yet (the sessions list shows it as its own row).
 */
export type TabView = TabState & { pinned?: boolean; draft?: true };

/** Host → webview: the whole state (first post, webview ready, reconnect); the webview re-renders only blocks that changed. */
export type StateMessage = {
  type: "state";
  state: ChatState;
  tab: TabView;
  models?: ModelInfo[];
  commands?: CommandRow[];
  thinkingLevels?: string[];
  /** The «/» menu's hidden OmO commands (names without «/»), from the window's settings; absent: the built-in list. */
  hiddenCommands?: readonly string[];
  /** False when «Переподключить» cannot help (e.g. the environment is incomplete). */
  reconnectable: boolean;
  /** The window's focus view is on: the feed folds each turn's steps (absent: off). */
  focusView?: true;
};

/**
 * Host → webview: what changed since the last state the webview has (see `diffState`). Blocks the webview already has
 * keep their objects; a list field is present only when it changed.
 */
export type StateDelta = {
  type: "delta";
  /** Blocks added or changed since the last post, whole. */
  changed: Block[];
  /** Ids of blocks that are gone. */
  removed: string[];
  /** Every block id in order; only when the sequence changed (added, removed or moved blocks). */
  order?: string[];
  state: Omit<ChatState, "blocks">;
  tab: TabView;
  reconnectable: boolean;
  models?: ModelInfo[];
  commands?: CommandRow[];
  thinkingLevels?: string[];
  hiddenCommands?: readonly string[];
  /** Always the current value, like `reconnectable`. */
  focusView?: true;
};

/** One row of the sessions list. */
export type SessionItem = {
  sessionPath: string;
  durableId: string;
  title: string;
  updatedAt: number;
  running: boolean;
  pinned: boolean;
  /** Hidden from the list unless the person asks to see the archive. */
  archived: boolean;
  current: boolean;
};

export type DeferredApproval = { kind: "approval"; id: string; sessionTitle: string; cwd?: string; createdAt: number; deferredAt: number; command: string; coordination?: string };
export type DeferredItem = DeferredQuestion | DeferredApproval;
export type DeferredResult = { type: "deferredResult"; kind: DeferredItem["kind"]; id: string } & ({ ok: true } | { ok: false; reason: string });
export type DeferredDelivery = { kind: "question" | "approval"; id: string; text: string; createdAt: number; reason: string };
/** `here`: the folders of this window's tabs (the plugin adds it per window); the rest are other projects. */
export type DeferredHostMessage = { type: "deferred"; items: DeferredItem[]; here?: string[]; deliveries?: DeferredDelivery[]; error?: string } | DeferredResult;
export type DeferredAction =
  | { type: "answerDeferredQuestion"; id: string; answers: string[] }
  | { type: "dismissDeferredQuestion"; id: string }
  | { type: "answerDeferredApproval"; id: string; decision: "allow-once" | "deny"; message?: string };

/** The inbox's host messages cross the same untrusted JSON boundary as its actions. */
export function parseDeferredHostMessage(raw: unknown): DeferredHostMessage | undefined {
  if (!isObject(raw)) return undefined;
  if (raw["type"] === "deferredResult") {
    const { id, kind, ok, reason } = raw;
    if (!isBlockId(id) || (kind !== "question" && kind !== "approval")) return undefined;
    if (ok === true) return { type: "deferredResult", id, kind, ok };
    if (ok === false && typeof reason === "string") return { type: "deferredResult", id, kind, ok, reason };
    return undefined;
  }
  if (raw["type"] !== "deferred" || !Array.isArray(raw["items"]) || (raw["error"] !== undefined && typeof raw["error"] !== "string")) return undefined;
  const here = raw["here"];
  if (here !== undefined && !(Array.isArray(here) && here.every((dir) => typeof dir === "string"))) return undefined;
  const items: DeferredItem[] = [];
  for (const item of raw["items"]) {
    if (!isObject(item) || !isBlockId(item["id"]) || typeof item["sessionTitle"] !== "string" ||
      typeof item["createdAt"] !== "number" || !Number.isFinite(new Date(item["createdAt"]).getTime()) ||
      typeof item["deferredAt"] !== "number" || !Number.isFinite(new Date(item["deferredAt"]).getTime()) ||
      (item["cwd"] !== undefined && typeof item["cwd"] !== "string")) return undefined;
    const common = { id: item["id"], sessionTitle: item["sessionTitle"], createdAt: item["createdAt"], deferredAt: item["deferredAt"],
      ...(typeof item["cwd"] === "string" ? { cwd: item["cwd"] } : {}) };
    if (item["kind"] === "approval" && typeof item["command"] === "string") {
      if (item["coordination"] !== undefined && typeof item["coordination"] !== "string") return undefined;
      items.push({ ...common, kind: "approval", command: item["command"], ...(typeof item["coordination"] === "string" ? { coordination: item["coordination"] } : {}) });
    } else if (item["kind"] === "question" && typeof item["sessionPath"] === "string" && Array.isArray(item["questions"]) &&
      item["questions"].length > 0 && (item["decided"] === undefined || typeof item["decided"] === "string")) {
      const questions: DeferredQuestion["questions"] = [];
      for (const question of item["questions"]) {
        if (!isObject(question) || typeof question["header"] !== "string" || typeof question["question"] !== "string" ||
          typeof question["multiSelect"] !== "boolean" || !Array.isArray(question["options"])) return undefined;
        const options: { label: string }[] = [];
        for (const option of question["options"]) {
          if (!isObject(option) || typeof option["label"] !== "string") return undefined;
          options.push({ label: option["label"] });
        }
        questions.push({ header: question["header"], question: question["question"], multiSelect: question["multiSelect"], options });
      }
      items.push({ ...common, kind: "question", sessionPath: item["sessionPath"], questions,
        ...(typeof item["decided"] === "string" ? { decided: item["decided"] } : {}) });
    } else return undefined;
  }
  const deliveries: DeferredDelivery[] = [];
  if (raw["deliveries"] !== undefined) {
    if (!Array.isArray(raw["deliveries"])) return undefined;
    for (const entry of raw["deliveries"]) {
      if (!isObject(entry) || !isBlockId(entry["id"]) || (entry["kind"] !== "question" && entry["kind"] !== "approval") ||
        typeof entry["text"] !== "string" || typeof entry["reason"] !== "string" || typeof entry["createdAt"] !== "number" || !Number.isFinite(new Date(entry["createdAt"]).getTime())) return undefined;
      deliveries.push({ id: entry["id"], kind: entry["kind"], text: entry["text"], reason: entry["reason"], createdAt: entry["createdAt"] });
    }
  }
  return { type: "deferred", items, ...(here !== undefined ? { here: here as string[] } : {}), ...(raw["deliveries"] !== undefined ? { deliveries } : {}),
    ...(typeof raw["error"] === "string" ? { error: raw["error"] } : {}) };
}

/** What `omo.task.output` (mode full) tells about one task, as the agent details modal shows it. */
export type AgentDetails = {
  /** The task as it was described (OmO returns its short description or summary, not the full prompt). */
  prompt?: string;
  /** The task's final response (markdown). */
  result?: string;
  transcript?: string;
  status?: AgentStatus;
  error?: string;
};

/** Host → webview: the answer to an `agentDetails` request. */
export type AgentDetailsMessage = { type: "agentDetails"; taskId: string } & (({ ok: true } & AgentDetails) | { ok: false; reason: string });

/** A verdict on one guarded call with no card before it, as the feed shows it: a decider's, or the person's whitelist. */
export type GuardStep = {
  id: string;
  tool: string;
  command: string;
  /** Exactly one of these is set: a decider's verdict, or the person's own whitelist allowing the call. */
  decider?: NonNullable<PendingView["decider"]>;
  whitelist?: { scopes: string[] };
  at: string;
  /** Only for a session no tab shows: the step names where it ran. */
  cwd?: string;
  /** The session that owns it, when the task registry named one whose tab is not open here; absent: not attributable. */
  owner?: string;
};

/** Host → webview: the guard's approval cards and decider steps (src/guard/approvals.ts). */
export type GuardHostMessage =
  | { type: "coordination"; lines: string[] }
  /**
   * An open request: a card, while `human.card` is on. `elsewhere`: not this tab's session, so the card is an offer and
   * says where it came from — `owner` is the session that owns it, and without it we could not attribute the request.
   */
  | { type: "guardRequest"; request: PendingView; elsewhere?: true; owner?: string }
  /** The request was answered (here, in another window, Telegram, the CLI) or timed out: the card collapses. */
  | { type: "guardResolved"; id: string; decision: "allow" | "deny"; by: string; message?: string }
  /** This tab's answer did not reach the service: the card takes answers again. */
  | { type: "guardAnswerFailed"; id: string; error: string }
  /** The service no longer has the request (it restarted while the window was away): the card closes without a verdict. */
  | { type: "guardClosed"; id: string }
  | ({ type: "guardStep" } & GuardStep)
  /** The window's subscription gave up (or works again): a quiet line over the open cards. */
  | { type: "guardSilent"; silent: boolean };

/** Whether a message action can run now; `reason` is the hint shown when it cannot. */
export type Availability = { ok: true } | { ok: false; reason: string };

/** Host → webview: the answer to a `messageActions` request (the ↺ menu of one user message). */
export type MessageActionsMessage = { type: "messageActions"; blockId: string; fork: Availability; rewind: Availability };

/**
 * Host → webview: what a rewind to this message would do, for the confirmation. `fingerprint` names exactly this plan
 * (items and the files' current bytes); the confirmed `rewind` carries it back, and a plan that changed meanwhile is not applied.
 */
export type RewindPreviewMessage = { type: "rewindPreview"; blockId: string; fork: boolean; excerpt: string } & (
  | { ok: true; items: RewindItem[]; fingerprint: string }
  | { ok: false; reason: string }
);

/** Host → webview: the outcome of a confirmed rewind. */
export type RewoundMessage = { type: "rewound"; blockId: string } & ({ ok: true; count: number } | { ok: false; reason: string });

/** Host → webview: a fork tab's composer starts with the forked message. */
export type DraftMessage = { type: "draft"; text: string; images: OutgoingImage[] };

/**
 * Host → webview: what an unwedge did — the session was unloaded and re-opened, or it was not (with the reason).
 * `auto` marks the extension's own attempt after an unanswered «Стоп»; "cooldown" is that attempt declined because
 * this session has already had one (see src/sessions/autoUnwedge.ts), so the person is offered the manual way.
 */
export type UnwedgedMessage = { type: "unwedged"; auto?: true } & (UnwedgeOutcome | { outcome: "cooldown" });

/** Host → webview: what became of «Отозвать» / «Изменить» on a queued message (a removed one's text comes back as a `draft`). */
export type QueueResultMessage = { type: "queueResult"; blockId: string; outcome: "removed" | "edited" | "delivered" | "failed" };

/** What a failing connection was for, as the details modal names it. */
export type ReconnectTarget = { host: string; session?: string };

/**
 * Host → webview: this tab cannot reach its session and the extension is retrying by itself (see ReconnectLoop). It is
 * one quiet line over the composer, never the banner at the top: the person is not asked to do anything. `active:
 * false` ends it — the session opened.
 */
export type ReconnectingMessage = { type: "reconnecting" } & ({ active: false } | ({ active: true; target: ReconnectTarget } & ReconnectView));

/**
 * Host → webview: the model ladder's own line over the composer — the step it is on while it walks, or the model it
 * left the session on once it has. `null` takes the line away (the walk ended, was interrupted, or a new message came).
 */
export type LadderMessage = { type: "ladder"; view: LadderView | null };

/** Host → webview. "sent" answers every "send": on `ok: false` the webview gives the text back to the input. */
export type HostMessage =
  | StateMessage
  | DeferredHostMessage
  | StateDelta
  | { type: "sent"; id: string; ok: boolean }
  /** Every "answer" gets one: "failed" gives the dialog back to the person, "closed" means OmO had already settled it. */
  | { type: "answerResult"; dialogId: string; outcome: AnswerOutcome }
  | QueueResultMessage
  | { type: "sessions"; items: SessionItem[] }
  | { type: "image"; id: string; dataUrl: string }
  | { type: "renamed"; ok: boolean; reason?: string }
  | { type: "settings"; state: SettingsState }
  /** The answer to one `settingsAction`; it never echoes the action (it may carry a key). */
  | { type: "settingsResult"; id: string; ok: boolean; error?: string; errors?: FieldError[]; notice?: string }
  | { type: "openSettings"; section: SettingsSection; firstRun?: true }
  /** A subscription login's progress, prompt or end, to every tab whose modal asked for the settings. */
  | { type: "settingsLogin"; event: LoginEvent }
  | AgentDetailsMessage
  | GuardHostMessage
  | MessageActionsMessage
  | RewindPreviewMessage
  | RewoundMessage
  | DraftMessage
  | UnwedgedMessage
  | LadderMessage
  | ReconnectingMessage;

/** The longest deny message («Запретить и сказать агенту…») a tab may send; the service checks the same bound. */
export const GUARD_MESSAGE_MAX = 2000;
export const MAX_IMAGES = 5;
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Per image, base64 characters (3.75 MiB of bytes), so every image stays under Anthropic's 5 MB. */
export const MAX_IMAGE_CHARS = 5_242_880;
/** All images of one message, base64 characters: the journal record that carries them stays well under omo's 16 MiB per record. */
export const MAX_MESSAGE_IMAGE_CHARS = 12_000_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function isNextMode(value: unknown): value is NextMode {
  return value === "ulw" || value === "mass ulw";
}

/** Webview → host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "listDeferred" }
  | DeferredAction
  /** `id` is the message's clientMessageId: its block in the feed has it from the moment it is sent. */
  | { type: "send"; id: string; text: string; mode: "auto" | "followUp"; images?: OutgoingImage[] }
  | { type: "stop" }
  /**
   * «Снять зависание»: the host unloads the session and re-opens it in this tab; it never unloads without this
   * message. Without `auto` it is the person's own click (after «Стоп» did not end the turn, or nothing came back for
   * minutes). With `auto` it is the composer asking by itself, once, because «Стоп» went unanswered; the host rations
   * those per session and may answer "cooldown" instead.
   */
  | { type: "unwedge"; auto?: true }
  /** «Прервать» on the ladder's line: the session stays on the model it is on and nothing is repeated. */
  | { type: "ladderInterrupt" }
  | { type: "answer"; dialogId: string; answer: DialogAnswer }
  | { type: "setModel"; model: ModelRef | "auto" }
  | { type: "setMode"; mode: NextMode | null }
  | { type: "reconnect" }
  /**
   * «Остановить ту копию» on the quiet line: the second copy of our own host that holds this tab's session file is
   * stopped on the person's say-so, after the extension refused to by itself. It carries nothing — which process that
   * is, is the host's own record of the refusal, never the webview's word.
   */
  | { type: "stopHolder" }
  | { type: "openLink"; url: string }
  /** A file a tool step names, opened in the editor (at a 1-based line). */
  | { type: "openFile"; path: string; line?: number }
  | { type: "setThinking"; level: string }
  | { type: "rename"; sessionPath?: string; name: string }
  | { type: "pin"; durableId: string; pinned: boolean }
  | { type: "archive"; durableId: string; archived: boolean }
  | { type: "listSessions" }
  | { type: "openSession"; sessionPath: string }
  | { type: "newSession" }
  /** The focus view switched from the «/» menu: the window's setting, so every tab follows. */
  | { type: "setFocusView"; enabled: boolean }
  /** «Перезапустить OmO» from the actions menu: the extension's command, with its confirmation. */
  | { type: "restartHost" }
  /** The context ring: compact the conversation now. */
  | { type: "compact" }
  | { type: "getImage"; id: string }
  | { type: "agentOutput"; taskId: string }
  | { type: "agentCancel"; taskId: string }
  | { type: "settingsGet" }
  /** A settings change; `action` is checked by the section's host and may carry a key: never logged. */
  | { type: "settingsAction"; id: string; section: SettingsSection; action: Record<string, unknown> }
  | { type: "agentDetails"; taskId: string }
  /**
   * «Разрешить один раз» / «Запретить» on an approval panel; answered over the service's admin socket. `message`: a
   * deny's words for the agent (non-blank, at most GUARD_MESSAGE_MAX characters); free text, never logged.
   */
  | { type: "guardAnswer"; id: string; decision: "allow-once" | "allow-always" | "deny"; message?: string }
  | { type: "messageActions"; blockId: string }
  | { type: "rewindPreview"; blockId: string; fork: boolean }
  | { type: "rewind"; blockId: string; fork: boolean; fingerprint: string }
  | { type: "fork"; blockId: string }
  /** The header's «Ответвить сессию»: the whole conversation as it stands, into a new tab. */
  | { type: "forkSession" }
  /** «Отозвать» / «Изменить» on a message waiting in OmO's queue. */
  | { type: "dequeue"; blockId: string }
  | { type: "editQueued"; blockId: string; text: string };

const MAX_BLOCK_ID_CHARS = 200;
const MAX_FINGERPRINT_CHARS = 128;

/** What the webview persists through `setState`: the tab, restored by the serializer. */
export type PersistedState = { tab: TabState };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * «Отложить» on a question: answered by this comment alone, so OmO settles it `comment-submitted` and the model reads an
 * instruction rather than silence (spec 2026-11-08 §5; measured live: both models carried on with the recommended option).
 */
export const DEFER_QUESTION_COMMENT =
  "Человек отложил вопрос: продолжай с рекомендованным вариантом и запиши допущение; необратимое по допущению не делай. Ответ придёт позже сообщением.";
const MAX_ANSWER_COMMENT = 2_000;

function parseAnswer(value: unknown): DialogAnswer | undefined {
  if (!isObject(value)) return undefined;
  const answer: DialogAnswer = {};
  if (typeof value["value"] === "string") answer.value = value["value"];
  if (typeof value["confirmed"] === "boolean") answer.confirmed = value["confirmed"];
  if (value["cancelled"] === true) answer.cancelled = true;
  if (isObject(value["answers"])) answer.answers = value["answers"];
  if (typeof value["comment"] === "string") {
    if (value["comment"].length > MAX_ANSWER_COMMENT) return undefined;
    answer.comment = value["comment"];
  }
  return answer;
}

/** All or nothing: one bad image, or too many characters in all, rejects the whole list. */
function parseImages(value: unknown): OutgoingImage[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return undefined;
  const images: OutgoingImage[] = [];
  let total = 0;
  for (const item of value) {
    if (!isObject(item)) return undefined;
    const { mimeType, data, name } = item;
    if (typeof mimeType !== "string" || !IMAGE_MIME_TYPES.has(mimeType)) return undefined;
    if (typeof data !== "string" || data.length > MAX_IMAGE_CHARS) return undefined;
    total += data.length;
    if (total > MAX_MESSAGE_IMAGE_CHARS || !BASE64.test(data)) return undefined;
    if (name !== undefined && typeof name !== "string") return undefined;
    images.push({ mimeType, data, ...(name !== undefined ? { name } : {}) });
  }
  return images;
}

/** Checks a message from the webview once, at the boundary; anything malformed is dropped. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!isObject(raw)) return undefined;
  switch (raw["type"]) {
    case "unwedge":
      return raw["auto"] === true ? { type: "unwedge", auto: true } : { type: "unwedge" };
    case "ready":
    case "stop":
    case "reconnect":
    case "stopHolder":
    case "listSessions":
    case "newSession":
    case "forkSession":
    case "restartHost":
    case "settingsGet":
    case "compact":
    case "ladderInterrupt":
      return { type: raw["type"] };
    case "send": {
      const mode = raw["mode"];
      if (!isBlockId(raw["id"]) || typeof raw["text"] !== "string" || (mode !== "auto" && mode !== "followUp")) return undefined;
      if (raw["images"] === undefined) return { type: "send", id: raw["id"], text: raw["text"], mode };
      const images = parseImages(raw["images"]);
      return images === undefined ? undefined : { type: "send", id: raw["id"], text: raw["text"], mode, images };
    }
    case "answer": {
      const answer = parseAnswer(raw["answer"]);
      if (typeof raw["dialogId"] !== "string" || answer === undefined) return undefined;
      return { type: "answer", dialogId: raw["dialogId"], answer };
    }
    case "setMode": {
      const mode = raw["mode"];
      return mode === null || isNextMode(mode) ? { type: "setMode", mode } : undefined;
    }
    case "setModel": {
      const model = raw["model"];
      if (model === "auto") return { type: "setModel", model };
      if (!isObject(model) || typeof model["provider"] !== "string" || typeof model["id"] !== "string") return undefined;
      return { type: "setModel", model: { provider: model["provider"], id: model["id"] } };
    }
    case "openLink":
      return typeof raw["url"] === "string" ? { type: "openLink", url: raw["url"] } : undefined;
    case "openFile": {
      const { path, line } = raw;
      if (typeof path !== "string" || !isLocalPath(path)) return undefined;
      if (line === undefined) return { type: "openFile", path };
      return typeof line === "number" && Number.isInteger(line) && line > 0 ? { type: "openFile", path, line } : undefined;
    }
    case "setThinking":
      return typeof raw["level"] === "string" ? { type: "setThinking", level: raw["level"] } : undefined;
    case "rename": {
      const { sessionPath, name } = raw;
      if (typeof name !== "string" || (sessionPath !== undefined && typeof sessionPath !== "string")) return undefined;
      return { type: "rename", name, ...(sessionPath !== undefined ? { sessionPath } : {}) };
    }
    case "setFocusView":
      return typeof raw["enabled"] === "boolean" ? { type: "setFocusView", enabled: raw["enabled"] } : undefined;
    case "pin":
      return typeof raw["durableId"] === "string" && typeof raw["pinned"] === "boolean"
        ? { type: "pin", durableId: raw["durableId"], pinned: raw["pinned"] }
        : undefined;
    case "archive":
      return typeof raw["durableId"] === "string" && typeof raw["archived"] === "boolean"
        ? { type: "archive", durableId: raw["durableId"], archived: raw["archived"] }
        : undefined;
    case "openSession":
      return typeof raw["sessionPath"] === "string" ? { type: "openSession", sessionPath: raw["sessionPath"] } : undefined;
    case "getImage":
      return typeof raw["id"] === "string" ? { type: "getImage", id: raw["id"] } : undefined;
    case "agentOutput":
    case "agentCancel":
    case "agentDetails":
      return typeof raw["taskId"] === "string" ? { type: raw["type"], taskId: raw["taskId"] } : undefined;
    case "settingsAction": {
      const { id, section, action } = raw;
      return typeof id === "string" && isSettingsSection(section) && isObject(action) ? { type: "settingsAction", id, section, action } : undefined;
    }
    case "guardAnswer": {
      const { id, decision, message } = raw;
      if (typeof id !== "string" || (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny")) return undefined;
      if (message === undefined) return { type: "guardAnswer", id, decision };
      const words = typeof message === "string" && decision === "deny" ? message.trim() : "";
      return words !== "" && words.length <= GUARD_MESSAGE_MAX ? { type: "guardAnswer", id, decision, message: words } : undefined;
    }
    case "listDeferred":
      return { type: "listDeferred" };
    case "dismissDeferredQuestion":
      return isBlockId(raw["id"]) ? { type: "dismissDeferredQuestion", id: raw["id"] } : undefined;
    case "answerDeferredQuestion": {
      const { id, answers } = raw;
      if (!isBlockId(id) || !Array.isArray(answers) || answers.length < 1 || answers.length > 3 ||
        !answers.every((answer: unknown) => typeof answer === "string" && answer.trim() !== "" && answer.length <= 2000)) return undefined;
      return { type: "answerDeferredQuestion", id, answers: answers.map((answer: string) => answer.trim()) };
    }
    case "answerDeferredApproval": {
      const { id, decision, message } = raw;
      if (!isBlockId(id) || (decision !== "allow-once" && decision !== "deny")) return undefined;
      if (message === undefined) return { type: "answerDeferredApproval", id, decision };
      if (decision !== "deny" || typeof message !== "string" || message.trim() === "" || message.length > GUARD_MESSAGE_MAX) return undefined;
      return { type: "answerDeferredApproval", id, decision, message: message.trim() };
    }
    case "dequeue":
      return isBlockId(raw["blockId"]) ? { type: "dequeue", blockId: raw["blockId"] } : undefined;
    case "editQueued": {
      const { blockId, text } = raw;
      return isBlockId(blockId) && typeof text === "string" && text.trim() !== "" ? { type: "editQueued", blockId, text } : undefined;
    }
    case "messageActions":
    case "fork":
    case "rewindPreview":
    case "rewind": {
      const blockId = raw["blockId"];
      if (typeof blockId !== "string" || blockId === "" || blockId.length > MAX_BLOCK_ID_CHARS) return undefined;
      if (raw["type"] === "messageActions" || raw["type"] === "fork") return { type: raw["type"], blockId };
      if (typeof raw["fork"] !== "boolean") return undefined;
      if (raw["type"] === "rewindPreview") return { type: raw["type"], blockId, fork: raw["fork"] };
      const fingerprint = raw["fingerprint"];
      if (typeof fingerprint !== "string" || fingerprint === "" || fingerprint.length > MAX_FINGERPRINT_CHARS) return undefined;
      return { type: "rewind", blockId, fork: raw["fork"], fingerprint };
    }
    default:
      return undefined;
  }
}

function isBlockId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_BLOCK_ID_CHARS;
}

/** The id of a rejected "send", so the webview still gets its `ok: false` and gives the text back. */
export function rejectedSendId(raw: unknown): string | undefined {
  return isObject(raw) && raw["type"] === "send" && typeof raw["id"] === "string" ? raw["id"] : undefined;
}

/** Only web links leave the webview, and only through the host. */
export function isExternalLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * A local path, absolute or relative to the session's folder (a tool's own `path` argument often is), never a URI:
 * `command:`, `file:` and every other scheme cannot pass; a Windows drive (`C:\`) is a path, not a scheme.
 */
export function isLocalPath(path: string): boolean {
  if (path === "" || path.includes("\0")) return false;
  return isAbsolutePath(path) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
}

/** A local absolute path (POSIX or a Windows drive), never a URI: `command:` and other schemes cannot pass. */
export function isAbsolutePath(path: string): boolean {
  return !path.includes("\0") && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path));
}
