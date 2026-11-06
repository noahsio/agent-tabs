import type { TodoCall } from "./todo";

/** Reference to an image whose bytes live outside ChatState (see the reducer `sink`). */
export type ImageRef = { id: string; mimeType: string; name?: string };

/**
 * Where a sent message is before it is part of the conversation: on its way to OmO («отправляется…»), in OmO's queue
 * waiting for the agent (`queuedId` lets it be taken back or edited; `revision` guards an edit), or — only in the webview —
 * refused («не отправлено»). A user block without a delivery is in the conversation.
 */
export type Delivery = { state: "sending" } | { state: "queued"; queuedId?: string; revision?: number } | { state: "failed" };

/**
 * One question of an `ask_user_question` as the feed shows it back, with what the person answered. `options` are the
 * rows that were on screen, descriptions included; `words` are their own words when no option says it.
 */
export type AnsweredQuestion = {
  /** OmO's `header`: the question's short name, when it had one. */
  header?: string;
  /** The question as it was asked; absent when nothing left holds it. */
  text?: string;
  options?: { label: string; description?: string; chosen: boolean }[];
  words?: string;
  /** A question of a set they left alone. */
  skipped?: boolean;
};

/**
 * An answered question of the agent's, as one card: OmO's request id (the `ask_user_question` call) and one entry per
 * question. `forkFrom` is the message whose turn asked it — where «Ответвить» from the card goes, since OmO never
 * re-asks a question it has already recorded as settled.
 */
export type Answer = { questionId: string; questions: AnsweredQuestion[]; forkFrom?: string };

export type Block =
  | { kind: "user"; id: string; text: string; delivery?: Delivery; timestamp?: number; images?: ImageRef[]; answer?: Answer }
  | {
      kind: "assistant";
      id: string;
      text: string;
      thinking: string;
      streaming: boolean;
      timestamp?: number;
      thinkingMs?: number;
      /** Arrival time of `thinking_start` while the thinking block is open. */
      thinkingStartedAt?: number;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      args: unknown;
      /**
       * What the step's box shows as its input (capped like the output): the command, the code, the prompt, compact
       * JSON — or, for a file edit, a diff whose lines start with "+", "-", " " (context) or anything else (a hunk or
       * file header). Absent when the call has none.
       */
      input?: string;
      /** The language of an `eval`'s code. */
      inputLang?: string;
      /** read / write / edit / apply_patch: the file it touched (a patch's first one). */
      file?: string;
      /** read: the lines it asked for (1-based, inclusive). */
      fromLine?: number;
      toLine?: number;
      /** write / edit / apply_patch: the lines the diff adds and removes. */
      added?: number;
      removed?: number;
      output: string;
      truncated: boolean;
      state: "running" | "ok" | "error";
      timestamp?: number;
      durationMs?: number;
      role?: string;
      model?: string;
      description?: string;
      /** A `todo` call: its op and texts (the feed draws a plan or a one-line update instead of the box). */
      todo?: TodoCall;
      /**
       * An `ask_user_question` the agent waited on (`waitForAnswer: true`): its answer card, built from the record its
       * own result carries. The feed draws that card instead of the step; without one the call shows nothing.
       */
      answer?: Answer;
    }
  | {
      kind: "notice";
      id: string;
      level: "info" | "warn" | "error";
      text: string;
      /** Someone else's words behind «Подробнее» (a provider's refusal text): never part of the line itself. */
      details?: string;
    };

export type Dialog = {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "question";
  title: string;
  /**
   * A `question` with `waitForAnswer: false`: the tool returned at once, the turn ended, and OmO holds the session on a
   * standing invitation whose answer is simply the next user message. Such a question must not lock the composer or raise
   * the running spinner — the person can answer it from its card or by sending a normal message. Absent (or true) means
   * the request blocks the turn, as every dialog but a non-blocking question does.
   */
  blocking?: boolean;
  options?: string[];
  questions?: unknown[];
  /** confirm: the line under the title. */
  message?: string;
  /** input: the field's hint. */
  placeholder?: string;
  /** editor: the text it opens with. */
  prefill?: string;
  /** When OmO settles the dialog by itself (its `timeout`): it is gone after that, answered or not. Epoch ms. */
  deadlineAt?: number;
};

export type AgentStatus = "running" | "done" | "error" | "waiting";

export type AgentRow = {
  id: string;
  /** The raw OmO task_id (for `omo.task.output` / `omo.task.cancel`); absent for DAG nodes, which have neither. */
  taskId?: string;
  label: string;
  role?: string;
  activity?: string;
  /** `provider/model_id` the task ran on (as OmO records it); a DAG node's as OmO names it. */
  model?: string;
  status: AgentStatus;
  startedAt?: number;
  endedAt?: number;
  /** Tokens the task spent, when OmO reports its run stats. */
  tokens?: number;
  /** The durable id of the session the task runs in (OmO's `child_session_id`): its guarded calls belong to this tab. */
  childSession?: string;
};

export type SessionActivity = "thinking" | "tool" | "waiting_human" | "idle";

export type ModelRef = { provider: string; id: string };

export type ChatState = {
  blocks: Block[];
  dialogs: Dialog[];
  agents: AgentRow[];
  running: boolean;
  activity?: SessionActivity;
  activityTool?: string;
  thinkingLevel?: string;
  model?: ModelRef;
  autoModel?: ModelRef;
  title?: string;
  /** Tokens in the main agent's context: from the open session's state, then each assistant reply's usage. */
  contextTokens?: number;
  /** The model's context window in tokens; absent while the host reports none (no model). */
  contextWindow?: number;
  /** False when auto-compaction is switched off; absent means on. */
  autoCompaction?: boolean;
  /** A compaction (manual or automatic) is running. */
  compacting?: boolean;
  cursor?: string;
  error?: string;
};
