import type { AgentRow, AgentStatus, Answer, AnsweredQuestion, Block, ChatState, Dialog, ImageRef, ModelRef, SessionActivity } from "./model";
import { providerStop, type ProviderStop, type ProviderStopKind } from "./providerStop";
import { todoCall } from "./todo";

export const TOOL_OUTPUT_LIMIT = 20_000;
const SUMMARY_LIMIT = 120;
const NOTICE_LIMIT = 2_000;

/** Journal custom messages injected by senpi for the model; never shown to the person. */
const INTERNAL_CUSTOM_TYPES = new Set([
  "environment-context",
  "senpi-task.usage",
  "senpi.todo-first-turn",
  "omo-onboarding:context",
]);

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor", "question"]);

type Json = Record<string, any>;
type ToolBlock = Extract<Block, { kind: "tool" }>;
type AssistantBlock = Extract<Block, { kind: "assistant" }>;
type UserBlock = Extract<Block, { kind: "user" }>;
type NoticeBlock = Extract<Block, { kind: "notice" }>;

/** Receives image bytes out of band; ChatState only ever keeps the ImageRef. */
export type ImageSink = (ref: ImageRef, data: string) => void;
export type Clock = () => number;

export function initialState(): ChatState {
  return { blocks: [], dialogs: [], agents: [], running: false };
}

// ---------- helpers ----------

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function capOutput(text: string): { output: string; truncated: boolean } {
  return text.length > TOOL_OUTPUT_LIMIT
    ? { output: text.slice(0, TOOL_OUTPUT_LIMIT), truncated: true }
    : { output: text, truncated: false };
}

function hasTextParts(content: unknown): boolean {
  return typeof content === "string" || (Array.isArray(content) && content.some((part) => isObject(part) && part["type"] === "text"));
}

/** Joins the text parts of a message/tool-result content (string or part array). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isObject(part) && part["type"] === "text" && typeof part["text"] === "string")
    .map((part) => part["text"] as string)
    .join("");
}

/** Splits a user message's image parts into refs (kept in state) and bytes (returned for the sink). */
function extractImages(blockId: string, content: unknown): { refs: ImageRef[]; bytes: string[] } {
  const refs: ImageRef[] = [];
  const bytes: string[] = [];
  if (!Array.isArray(content)) return { refs, bytes };
  for (const part of content) {
    if (!isObject(part) || part["type"] !== "image" || typeof part["data"] !== "string") continue;
    const ref: ImageRef = { id: `${blockId}:${refs.length}`, mimeType: asString(part["mimeType"]) ?? "image/png" };
    const name = asString(part["name"]);
    if (name) ref.name = name;
    refs.push(ref);
    bytes.push(part["data"]);
  }
  return { refs, bytes };
}

/** Live and journal paths agree on a user block id only when it comes from clientMessageId or timestamp. */
function hasStableUserId(message: Json): boolean {
  return asString(message["clientMessageId"]) !== undefined || typeof message["timestamp"] === "number";
}

/** Image refs of a user message; empty for an unstable id, whose bytes must never be sunk. */
function userImages(message: Json, id: string): { refs: ImageRef[]; bytes: string[] } {
  return hasStableUserId(message) ? extractImages(id, message["content"]) : { refs: [], bytes: [] };
}

function userBlock(message: Json, id: string, text: string, blocks: Block[]): UserBlock {
  const block: UserBlock = { kind: "user", id, text };
  if (typeof message["timestamp"] === "number") block.timestamp = message["timestamp"];
  const { refs } = userImages(message, id);
  if (refs.length > 0) block.images = refs;
  const answer = answerFromText(blocks, text);
  if (answer !== undefined) block.answer = answer;
  return block;
}

function sinkImages(message: Json, id: string, sink: ImageSink | undefined): void {
  const { refs, bytes } = userImages(message, id);
  refs.forEach((ref, index) => sink?.(ref, bytes[index] as string));
}

function firstLine(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? undefined : line.trim().slice(0, SUMMARY_LIMIT);
}

function summarize(args: unknown): string {
  if (!isObject(args)) return "";
  for (const key of ["summary", "description", "path", "file_path", "command", "pattern", "query", "url"]) {
    const value = asString(args[key]);
    if (value) return value.replace(/\s+/g, " ").slice(0, SUMMARY_LIMIT);
  }
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value) return value.replace(/\s+/g, " ").slice(0, SUMMARY_LIMIT);
  }
  return "";
}

function parseModelRef(provider: unknown, id: unknown): ModelRef | undefined {
  return typeof provider === "string" && typeof id === "string" ? { provider, id } : undefined;
}

/** `provider/model-id` where the id itself may contain slashes: split on the first one. */
function parseQualifiedModel(qualified: unknown): ModelRef | undefined {
  if (typeof qualified !== "string") return undefined;
  const slash = qualified.indexOf("/");
  return slash > 0 ? { provider: qualified.slice(0, slash), id: qualified.slice(slash + 1) } : undefined;
}

function profileAppliedModel(entry: Json): ModelRef | undefined {
  if (entry["type"] !== "custom" || entry["customType"] !== "omo-model-profile:applied") return undefined;
  return parseQualifiedModel(entry["data"]?.details?.model);
}

function upsertBlock(blocks: Block[], block: Block): Block[] {
  const index = blocks.findIndex((existing) => existing.id === block.id);
  if (index < 0) return [...blocks, block];
  const next = blocks.slice();
  next[index] = block;
  return next;
}

function updateBlock(blocks: Block[], id: string, patch: (block: Block) => Block): Block[] {
  const index = blocks.findIndex((block) => block.id === id);
  if (index < 0) return blocks;
  const next = blocks.slice();
  next[index] = patch(blocks[index] as Block);
  return next;
}

/** `new` against `old` line by line: the lines both start and end with are context, the rest removed then added. */
function lineDiff(oldText: string, newText: string): string[] {
  const before = oldText === "" ? [] : oldText.split("\n");
  const after = newText === "" ? [] : newText.split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return [
    ...before.slice(0, head).map((line) => ` ${line}`),
    ...before.slice(head, before.length - tail).map((line) => `-${line}`),
    ...after.slice(head, after.length - tail).map((line) => `+${line}`),
    ...before.slice(before.length - tail).map((line) => ` ${line}`),
  ];
}

/** An edit's changes, whichever spelling the tool used: `edits: [{ oldText, newText }]` or a single old/new pair. */
function editPairs(args: Json): { oldText: string; newText: string }[] {
  const pair = (edit: unknown): { oldText: string; newText: string } | undefined => {
    if (!isObject(edit)) return undefined;
    const oldText = asString(edit["oldText"]) ?? asString(edit["old_string"]) ?? asString(edit["oldString"]);
    const newText = asString(edit["newText"]) ?? asString(edit["new_string"]) ?? asString(edit["newString"]);
    return oldText === undefined && newText === undefined ? undefined : { oldText: oldText ?? "", newText: newText ?? "" };
  };
  const edits = Array.isArray(args["edits"]) ? args["edits"] : [args];
  return edits.flatMap((edit) => pair(edit) ?? []);
}

const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/;

type ToolView = Pick<ToolBlock, "input" | "inputLang" | "file" | "fromLine" | "toLine" | "added" | "removed">;

/** What a call's box shows, derived from its args once, on the host: the args themselves never reach the webview. */
function toolView(name: string, args: unknown): ToolView {
  if (args === undefined) return {};
  if (!isObject(args)) return { input: JSON.stringify(args) };
  const file = asString(args["path"]) ?? asString(args["file_path"]);
  const diff = (lines: string[], path: string | undefined): ToolView => ({
    input: lines.join("\n"),
    ...(path ? { file: path } : {}),
    added: lines.filter((line) => line.startsWith("+")).length,
    removed: lines.filter((line) => line.startsWith("-")).length,
  });
  switch (name) {
    case "bash":
    case "monitor": {
      const command = asString(args["command"]);
      return command === undefined ? { input: JSON.stringify(args) } : { input: command };
    }
    case "eval": {
      const language = asString(args["language"]);
      return { input: asString(args["code"]) ?? "", ...(language ? { inputLang: language } : {}) };
    }
    case "task": {
      const prompt = (task: unknown): string | undefined =>
        isObject(task) ? asString(task["prompt"]) || asString(task["description"]) || asString(task["task_summary"]) : undefined;
      const prompts = Array.isArray(args["tasks"]) ? args["tasks"].flatMap((task) => prompt(task) ?? []) : [prompt(args) ?? ""];
      return { input: prompts.join("\n\n") };
    }
    case "read": {
      const offset = typeof args["offset"] === "number" ? args["offset"] : undefined;
      const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
      const from = offset ?? (limit !== undefined ? 1 : undefined);
      return {
        ...(file ? { file } : {}),
        ...(from !== undefined ? { fromLine: from } : {}),
        ...(from !== undefined && limit !== undefined ? { toLine: from + limit - 1 } : {}),
      };
    }
    case "write": {
      const content = (asString(args["content"]) ?? "").replace(/\n$/, "");
      return diff(content === "" ? [] : content.split("\n").map((line) => `+${line}`), file);
    }
    case "edit":
      return diff(
        editPairs(args).flatMap((edit, index) => [...(index > 0 ? ["@@"] : []), ...lineDiff(edit.oldText, edit.newText)]),
        file,
      );
    case "apply_patch": {
      const patch = asString(args["input"]) ?? asString(args["patch"]) ?? "";
      const lines = patch.split("\n").filter((line) => line !== "*** Begin Patch" && line !== "*** End Patch" && line !== "");
      const first = lines.map((line) => PATCH_FILE.exec(line)?.[1]).find((path) => path !== undefined);
      return diff(lines, first?.trim());
    }
    case "todo":
      return todoCall(args) !== undefined ? {} : { input: JSON.stringify(args) }; // a known call is drawn from `todo` (toolBlock)
    case ASK_TOOL:
      return {}; // the questions are shown as the answer card, never as the call's JSON
    default:
      return { input: JSON.stringify(args) };
  }
}

function toolBlock(id: string, name: string, args: unknown, timestamp?: number): ToolBlock {
  const block: ToolBlock = { kind: "tool", id, name, summary: summarize(args), args, output: "", truncated: false, state: "running" };
  const view = toolView(name, args);
  if (view.input === "") delete view.input; // nothing to show: no IN row
  else if (view.input !== undefined) view.input = capOutput(view.input).output;
  Object.assign(block, view);
  if (timestamp !== undefined) block.timestamp = timestamp;
  if (name === "todo") {
    const call = todoCall(args);
    if (call !== undefined) block.todo = call;
  }
  if (name === "task" && isObject(args)) {
    const role = asString(args["category"]) ?? asString(args["subagent_type"]);
    const description = firstLine(args["description"]) ?? firstLine(args["prompt"]);
    if (role) block.role = role;
    if (description) block.description = description;
  }
  return block;
}

/** `provider/model_id` from one of OmO's model records (`{ provider, model_id | id, display, … }`) or an already qualified string. */
function modelRecord(value: unknown): string | undefined {
  if (!isObject(value)) return asString(value);
  const provider = asString(value["provider"]);
  const id = asString(value["model_id"]) ?? asString(value["id"]);
  return provider && id ? `${provider}/${id}` : undefined;
}

/** A record's display (or name): only for a task with no qualified model anywhere. */
function modelLabel(value: unknown): string | undefined {
  return isObject(value) ? (asString(value["display"]) ?? asString(value["name"])) : undefined;
}

/**
 * The model a task ran on, as `provider/model_id`, from its record: the observed `effective_model` first, then the
 * planned `resolved_model` and `model`; failing all, a record's display. Never guessed from config.
 */
function taskModel(record: Json): string | undefined {
  const records = [record["effective_model"], record["resolved_model"], record["model"]];
  return records.map(modelRecord).find(Boolean) ?? records.map(modelLabel).find(Boolean);
}

/** The model a subagent ran on, from a task result's details. */
function taskResultModel(payload: unknown): string | undefined {
  const details = isObject(payload) ? payload["details"] : undefined;
  return isObject(details) ? taskModel(details) : undefined;
}

function assistantId(message: Json, fallbackIndex: number): string {
  return typeof message["timestamp"] === "number" ? `a:${message["timestamp"]}` : `a:${fallbackIndex}`;
}

function userId(message: Json, fallbackIndex: number): string {
  const clientMessageId = asString(message["clientMessageId"]);
  if (clientMessageId) return clientMessageId;
  return typeof message["timestamp"] === "number" ? `u:${message["timestamp"]}` : `u:${fallbackIndex}`;
}

function lastStreamingAssistant(blocks: Block[]): AssistantBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index] as Block;
    if (block.kind === "assistant" && block.streaming) return block;
  }
  return undefined;
}

function notice(id: string, level: "info" | "warn" | "error", text: string, details?: string): NoticeBlock {
  const block: NoticeBlock = { kind: "notice", id, level, text: text.slice(0, NOTICE_LIMIT) };
  if (details !== undefined && details !== "") block.details = details.slice(0, NOTICE_LIMIT);
  return block;
}

/**
 * Appends a notice unless it only repeats the one already at the end: an identical consecutive line — same text and
 * level — is noise (a reopen storm, OmO re-sending the same reflection notify) and shows once. A notice carrying new
 * words, even under an id already seen, still replaces its own in place through `upsertBlock`.
 */
function appendNotice(blocks: Block[], block: NoticeBlock): Block[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind === "notice" && last.level === block.level && last.text === block.text) return blocks;
  return upsertBlock(blocks, block);
}

// ---------- answered questions ----------

/**
 * OmO's own tool for asking the person. It records an answer two ways, and the feed shows one card either way: with
 * `waitForAnswer: true` the call's own result carries the questions and the answers, and with `waitForAnswer: false`
 * the answer arrives as a user message of protocol text («[Answer to question …]») whose questions are only in the
 * call's arguments. Neither wording is ever shown: the card is built from them.
 */
const ASK_TOOL = "ask_user_question";
const ANSWER_HEAD = /^\[Answer to question (\S+)\]\s*/;
const UNANSWERED = /^Unanswered:\s*/;
/** How long an answer's own words may be before the card cuts them (the card collapses long ones as a message does). */
const WORDS_LIMIT = 4_000;

/** One question as it was asked. */
type Asked = { header?: string; text?: string; options: { label: string; description?: string }[] };
/** What OmO recorded as the answer to one question. */
type Given = { header?: string; answer: string };

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `questions` of an `ask_user_question` payload: its call arguments, or the record its result keeps of them. */
function askedQuestions(payload: unknown): Asked[] {
  const list = isObject(payload) && Array.isArray(payload["questions"]) ? payload["questions"] : [];
  return list.filter(isObject).map((question) => {
    const options = (Array.isArray(question["options"]) ? question["options"] : []).flatMap((option) => {
      const label = typeof option === "string" ? option : isObject(option) ? asString(option["label"]) : undefined;
      if (label === undefined || label === "") return [];
      const description = isObject(option) ? asString(option["description"]) : undefined;
      return [{ label, ...(description !== undefined && description.trim() !== "" ? { description } : {}) }];
    });
    const header = asString(question["header"]);
    const text = asString(question["question"]);
    return { ...(header ? { header } : {}), ...(text ? { text } : {}), options };
  });
}

/**
 * The answer text OmO writes for `waitForAnswer: false`: a header line, then one line per question — `Запись: Хватит
 * живой записи`, `Unanswered: Координаты`, or a `(see […] below)` placeholder whose words are appended as their own
 * sections. The placeholders go, the sections give those questions their words.
 */
function parseAnswerText(text: string): { questionId: string; given: Given[]; unanswered: string[] } | undefined {
  const head = ANSWER_HEAD.exec(text);
  if (head?.[1] === undefined) return undefined;
  const questionId = head[1];
  const id = escapeRe(questionId);
  const body = text
    .slice(head[0].length)
    .replace(new RegExp(`\\(see \\[The user's answer to [\\s\\S]*? for question ${id}\\] below\\)`, "g"), "");
  const [lines = "", ...sections] = body.split(new RegExp(`\\[The user's answer to ([\\s\\S]*?) for question ${id}\\]`));
  const words = new Map<string, string>();
  for (let at = 0; at + 1 < sections.length; at += 2) words.set((sections[at] as string).trim(), (sections[at + 1] as string).trim());
  const given: Given[] = [];
  const unanswered: string[] = [];
  for (const line of lines.split("\n").map((candidate) => candidate.trim())) {
    if (line === "") continue;
    if (UNANSWERED.test(line)) {
      unanswered.push(...line.replace(UNANSWERED, "").split(",").map((name) => name.trim()).filter((name) => name !== ""));
      continue;
    }
    // «<вопрос>: <ответ>», on the first colon; a placeholder removed above leaves the header alone with its colon
    const named = /^(.+?):(?:\s+([\s\S]*))?$/.exec(line);
    const header = named?.[1];
    const said = (named?.[2] ?? "").trim();
    const answer = header === undefined ? line : said === "" ? (words.get(header) ?? "") : said;
    given.push({ ...(header !== undefined ? { header } : {}), answer });
  }
  // a question answered only in their own words leaves an empty line and a section of its own
  for (const [header, said] of words) if (!given.some((entry) => entry.header === header)) given.push({ header, answer: said });
  return { questionId, given, unanswered };
}

/** The question `given` answers: the one with its header, else the one in its place. */
function askedFor(asked: Asked[], given: Given, index: number): Asked | undefined {
  if (asked.length === 1) return asked[0];
  const named = given.header === undefined ? undefined : asked.find((question) => question.header === given.header);
  return named ?? asked[index];
}

/** The option rows of one answered question: every option that was on screen, the ones they picked marked. */
function answeredOptions(asked: Asked, answer: string): { options?: AnsweredQuestion["options"]; words?: string } {
  const parts = answer.split(", ").map((part) => part.trim());
  const options = asked.options.map((option) => ({ ...option, chosen: answer === option.label || parts.includes(option.label) }));
  const own = parts.filter((part) => part !== "" && !asked.options.some((option) => option.label === part)).join(", ");
  const words = options.some((option) => option.chosen) ? own : answer;
  return {
    ...(options.length > 0 ? { options } : {}),
    ...(words !== "" ? { words: words.slice(0, WORDS_LIMIT) } : {}),
  };
}

/** The card: one entry per question asked (or, when none is left to read, per answer the text carries). */
function buildAnswer(questionId: string, asked: Asked[], given: Given[], unanswered: string[], forkFrom: string | undefined): Answer {
  const used = new Set<Asked>();
  const answered: AnsweredQuestion[] = given.map((entry, index) => {
    const question = askedFor(asked, entry, index);
    if (question !== undefined) used.add(question);
    return {
      // the question's own short name when it is still there to read; else whatever the answer text named it
      ...(question?.header !== undefined ? { header: question.header } : entry.header !== undefined ? { header: entry.header } : {}),
      ...(question?.text !== undefined ? { text: question.text } : {}),
      ...(question === undefined ? { words: entry.answer.slice(0, WORDS_LIMIT) } : answeredOptions(question, entry.answer)),
    };
  });
  const left: AnsweredQuestion[] = asked
    .filter((question) => !used.has(question) && (unanswered.length === 0 || question.header === undefined || unanswered.includes(question.header)))
    .map((question) => ({
      ...(question.header !== undefined ? { header: question.header } : {}),
      ...(question.text !== undefined ? { text: question.text } : {}),
      ...(question.options.length > 0 ? { options: question.options.map((option) => ({ ...option, chosen: false })) } : {}),
      skipped: true,
    }));
  return { questionId, questions: [...answered, ...left], ...(forkFrom !== undefined ? { forkFrom } : {}) };
}

/**
 * Where «Ответвить» from the card goes: the message whose turn asked the question. OmO records a settled question in
 * the journal before it writes the answer, so a session cut at the answer is opened with the question already closed —
 * it is never asked again. Going back to the message that led to it is the one point from which it can be.
 */
function forkTarget(blocks: Block[], questionId: string): string | undefined {
  const at = blocks.findIndex((block) => block.id === questionId);
  const before = at < 0 ? blocks : blocks.slice(0, at);
  return before.filter((block) => block.kind === "user" && block.delivery === undefined && block.answer === undefined).at(-1)?.id;
}

/** The card for an answer that came as a user message: its questions are the call's own arguments. */
function answerFromText(blocks: Block[], text: string): Answer | undefined {
  const parsed = parseAnswerText(text);
  if (parsed === undefined) return undefined;
  const call = blocks.find((block) => block.id === parsed.questionId);
  const asked = askedQuestions(call?.kind === "tool" ? call.args : undefined);
  return buildAnswer(parsed.questionId, asked, parsed.given, parsed.unanswered, forkTarget(blocks, parsed.questionId));
}

/** The card for an `ask_user_question` the agent waited on: its result records both the questions and the answers. */
function answerFromResult(blocks: Block[], questionId: string, payload: unknown): Answer | undefined {
  const details = isObject(payload) ? payload["details"] : undefined;
  if (!isObject(details) || details["status"] !== "answered") return undefined;
  const asked = askedQuestions(details);
  const answers = isObject(details["answers"]) ? details["answers"] : {};
  const unanswered = (Array.isArray(details["unanswered"]) ? details["unanswered"] : []).flatMap((name) => asString(name) ?? []);
  const named = (question: Asked): string | undefined => asString(answers[question.text ?? ""]) ?? asString(answers[question.header ?? ""]);
  const given = asked.flatMap((question, index) => {
    const answer = named(question) ?? asString(Object.values(answers)[index]);
    if (answer === undefined || answer === "") return [];
    return [{ ...(question.header !== undefined ? { header: question.header } : {}), answer }];
  });
  return buildAnswer(questionId, asked, given, unanswered, forkTarget(blocks, questionId));
}

// ---------- live frames ----------

function onMessageStart(s: ChatState, frame: Json, sink: ImageSink | undefined): ChatState {
  const message = frame["message"];
  if (!isObject(message)) return s;
  if (message["role"] === "assistant") {
    const id = assistantId(message, s.blocks.length);
    const existing = s.blocks.find((block) => block.id === id);
    // The journal holds only completed messages, so a start for a known id replays the whole message:
    // reopen it empty and let the deltas (and message_end) rebuild it exactly once.
    if (existing?.kind === "assistant") {
      return { ...s, blocks: updateBlock(s.blocks, id, () => ({ ...existing, text: "", thinking: "", streaming: true })) };
    }
    if (existing) return s;
    const block: AssistantBlock = { kind: "assistant", id, text: "", thinking: "", streaming: true };
    if (typeof message["timestamp"] === "number") block.timestamp = message["timestamp"];
    return { ...s, blocks: [...s.blocks, block] };
  }
  if (message["role"] === "user") {
    const text = contentText(message["content"]);
    const id = userId(message, s.blocks.length);
    // An undelivered block (ours by id, another client's queued one by text) gives way to the real message at its real position.
    const existing = s.blocks.find((block) => block.id === id);
    const pending = existing?.kind === "user" && existing.delivery !== undefined ? s.blocks.filter((block) => block !== existing) : s.blocks;
    const withoutQueued = removeQueuedByText(pending, text);
    if (withoutQueued.some((block) => block.id === id)) return { ...s, blocks: withoutQueued };
    sinkImages(message, id, sink);
    const block = userBlock(message, id, text, withoutQueued);
    // A resend keeps suppressing the old id after it is delivered, so a late restored-queue frame can never re-list it.
    if (existing?.kind === "user" && existing.supersedes !== undefined) block.supersedes = existing.supersedes;
    return { ...s, blocks: [...withoutQueued, block] };
  }
  return s; // custom/toolResult are not chat bubbles
}

/** Ids of queued messages known only from a queue frame (another client's, sent without a clientMessageId). */
const FOREIGN_QUEUED = "queued:";

/** Like the feed's chips: only the first marker for an attached picture is an image, all others are literal text. */
function withoutImageMarkers(text: string, imageCount: number): string {
  const used = new Set<number>();
  return text.replace(/\[картинка (\d+)\]/g, (marker: string, digits: string): string => {
    const index = Number(digits);
    if (index < 1 || index > imageCount || used.has(index)) return marker;
    used.add(index);
    return "";
  }).trim();
}

function removeQueuedByText(blocks: Block[], text: string): Block[] {
  const index = blocks.findIndex((block) => block.kind === "user" && block.id.startsWith(FOREIGN_QUEUED) && block.text === text);
  return index < 0 ? blocks : [...blocks.slice(0, index), ...blocks.slice(index + 1)];
}

function onMessageUpdate(s: ChatState, frame: Json, now: Clock): ChatState {
  const event = frame["assistantMessageEvent"];
  if (!isObject(event)) return s;
  const type = event["type"];
  if (type === "toolcall_end") {
    const call = event["toolCall"];
    if (!isObject(call) || typeof call["id"] !== "string") return s;
    if (s.blocks.some((block) => block.id === call["id"])) return s;
    return { ...s, blocks: [...s.blocks, toolBlock(call["id"], asString(call["name"]) ?? "tool", call["arguments"], now())] };
  }
  if (type === "thinking_start" || type === "thinking_end") return onThinkingBoundary(s, type, now());
  const delta = asString(event["delta"]);
  if (!delta || (type !== "text_delta" && type !== "thinking_delta")) return s;
  const target = lastStreamingAssistant(s.blocks);
  const field = type === "text_delta" ? "text" : "thinking";
  if (!target) {
    let index = s.blocks.length;
    while (s.blocks.some((block) => block.id === `a:${index}`)) index += 1;
    const block: AssistantBlock = {
      kind: "assistant",
      id: `a:${index}`,
      text: "",
      thinking: "",
      streaming: true,
      [field]: delta,
    };
    return { ...s, blocks: [...s.blocks, block] };
  }
  return { ...s, blocks: updateBlock(s.blocks, target.id, (block) => ({ ...(block as AssistantBlock), [field]: (block as AssistantBlock)[field] + delta })) };
}

function onThinkingBoundary(s: ChatState, type: "thinking_start" | "thinking_end", at: number): ChatState {
  const target = lastStreamingAssistant(s.blocks);
  if (!target) return s;
  if (type === "thinking_start") {
    return { ...s, blocks: updateBlock(s.blocks, target.id, () => ({ ...target, thinkingStartedAt: at })) };
  }
  if (target.thinkingStartedAt === undefined) return s;
  const { thinkingStartedAt, ...rest } = target;
  const thinkingMs = (target.thinkingMs ?? 0) + Math.max(0, at - thinkingStartedAt);
  return { ...s, blocks: updateBlock(s.blocks, target.id, () => ({ ...rest, thinkingMs })) };
}

/** What a reply's usage puts in the context: its total, else the sum of its parts (as OmO counts it). */
function usageTokens(usage: unknown): number | undefined {
  if (!isObject(usage)) return undefined;
  const count = (key: string): number => (typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : 0);
  const total = count("totalTokens") || count("input") + count("output") + count("cacheRead") + count("cacheWrite");
  return total > 0 ? total : undefined;
}

/**
 * The two ways a provider says it will not answer, and the one thing that helps after either: switch the model. The
 * provider's own words go behind «Подробнее», never into the line — they are English, and one ban has three
 * different wordings across the person's journals.
 *
 * A **refusal** is a classifier's: the model answered nothing and a typed marker says why. OmO has already retried it
 * once itself, and a repeat only buys the same answer at the same price.
 *
 * A **rejection** is the provider's: it began a response and ended it with an error having produced nothing. It
 * carries no typed marker at all — `gw-openai` sends one plain English sentence — so before `providerStop` saw it,
 * that sentence went to the red banner at the top of the tab, which is where errors about *us* belong.
 */
const STOP_TEXT: Record<ProviderStopKind, string> = {
  refusal: "Модель отказалась отвечать на этот запрос — смените модель для этой сессии",
  rejected: "Провайдер отклонил запрос — смените модель для этой сессии",
};

/** One quiet Russian line, and the turn over: the composer is usable and nothing waits for a reply. */
function refused(s: ChatState, id: string, stop: ProviderStop): ChatState {
  const blocks = upsertBlock(s.blocks, notice(`refusal:${id}`, "warn", STOP_TEXT[stop.kind], stop.detail));
  return withActivity({ ...s, blocks }, false, "idle", undefined);
}

function onMessageEnd(s: ChatState, frame: Json): ChatState {
  const message = frame["message"];
  if (!isObject(message) || message["role"] !== "assistant") return s;
  const id = assistantId(message, s.blocks.length - 1);
  let target = s.blocks.find((block) => block.id === id && block.kind === "assistant") as AssistantBlock | undefined;
  target ??= lastStreamingAssistant(s.blocks);
  const text = contentText(message["content"]);
  const thinking = assistantThinking(message["content"]);
  const stop = providerStop(message);
  const errorMessage = stop === undefined && message["stopReason"] === "error" ? asString(message["errorMessage"]) : undefined;
  const contextTokens = usageTokens(message["usage"]);
  const withUsage: ChatState = contextTokens === undefined || contextTokens === s.contextTokens ? s : { ...s, contextTokens };
  const next: ChatState =
    errorMessage ? { ...withUsage, error: errorMessage } : stop !== undefined ? refused(withUsage, id, stop) : withUsage;
  if (!target) {
    if (!text && !thinking) return next;
    const block: AssistantBlock = { kind: "assistant", id, text, thinking, streaming: false };
    if (typeof message["timestamp"] === "number") block.timestamp = message["timestamp"];
    return { ...next, blocks: [...next.blocks, block] };
  }
  const finalText = text || target.text;
  const finalThinking = thinking || target.thinking;
  // A tool-only assistant message carries no prose; do not leave an empty bubble.
  if (!finalText && !finalThinking) return { ...next, blocks: next.blocks.filter((block) => block.id !== target.id) };
  return {
    ...next,
    blocks: updateBlock(next.blocks, target.id, () => {
      const { thinkingStartedAt: _open, ...settled } = target;
      return { ...settled, text: finalText, thinking: finalThinking, streaming: false };
    }),
  };
}

function assistantThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isObject(part) && part["type"] === "thinking" && typeof part["thinking"] === "string")
    .map((part) => part["thinking"] as string)
    .join("");
}

function onToolStart(s: ChatState, frame: Json, now: Clock): ChatState {
  const id = asString(frame["toolCallId"]);
  if (!id) return s;
  const name = asString(frame["toolName"]) ?? "tool";
  const existing = s.blocks.find((block) => block.id === id);
  const block: ToolBlock = {
    ...toolBlock(id, name, frame["args"], existing?.kind === "tool" ? existing.timestamp ?? now() : now()),
    ...(existing?.kind === "tool" ? { output: existing.output, truncated: existing.truncated } : {}),
  };
  return { ...s, blocks: upsertBlock(s.blocks, block) };
}

function onToolOutput(s: ChatState, frame: Json, final: boolean, now: Clock): ChatState {
  const id = asString(frame["toolCallId"]);
  if (!id) return s;
  const payload = final ? frame["result"] : frame["partialResult"];
  const content = isObject(payload) ? payload["content"] : undefined;
  const base = s.blocks.find((block) => block.id === id);
  const seed: ToolBlock = base?.kind === "tool" ? base : toolBlock(id, asString(frame["toolName"]) ?? "tool", frame["args"]);
  // A payload without text parts must not wipe the output already collected.
  const { output, truncated } = hasTextParts(content) ? capOutput(contentText(content)) : { output: seed.output, truncated: seed.truncated };
  const state: ToolBlock["state"] = final ? (frame["isError"] === true ? "error" : "ok") : "running";
  const next: ToolBlock = { ...seed, output, truncated, state };
  if (final) {
    if (seed.timestamp !== undefined) next.durationMs = Math.max(0, now() - seed.timestamp);
    const model = seed.name === "task" ? taskResultModel(payload) : undefined;
    if (model) next.model = model;
    const answer = seed.name === ASK_TOOL ? answerFromResult(s.blocks, id, payload) : undefined;
    if (answer !== undefined) next.answer = answer;
  }
  return { ...s, blocks: upsertBlock(s.blocks, next) };
}

/**
 * OmO's queue, in its order. A listed message is shown queued: in place when its block exists (ours, by
 * clientMessageId), appended otherwise. One of ours that left the queue waits as sending for its message_start;
 * another client's goes.
 */
function onQueueUpdate(s: ChatState, frame: Json): ChatState {
  const ordered: unknown[] = Array.isArray(frame["ordered"]) ? frame["ordered"] : [];
  // A message a resend already superseded must never come back from a restored queue under its old id.
  const superseded = new Set(s.blocks.flatMap((block) => (block.kind === "user" && block.supersedes !== undefined ? [block.supersedes] : [])));
  const listed = new Map<string, UserBlock>();
  for (const item of ordered) {
    if (!isObject(item) || typeof item["text"] !== "string") continue;
    const queuedId = asString(item["queuedId"]);
    const clientMessageId = asString(item["clientMessageId"]);
    let id = clientMessageId ?? `${FOREIGN_QUEUED}${queuedId ?? listed.size}`;
    if (clientMessageId === undefined) {
      // Never let text override an explicit ID, or guess between two identical messages.
      const matches = s.blocks.filter((block): block is UserBlock =>
        block.kind === "user" && block.delivery !== undefined && !block.id.startsWith(FOREIGN_QUEUED) &&
        !listed.has(block.id) && (block.images?.length ?? 0) > 0 &&
        ((queuedId !== undefined && block.delivery.state === "queued" && block.delivery.queuedId === queuedId) ||
          withoutImageMarkers(block.text, block.images?.length ?? 0) === withoutImageMarkers(item["text"], block.images?.length ?? 0)),
      );
      if (matches.length === 1) id = (matches[0] as UserBlock).id;
    }
    if (superseded.has(id)) continue;
    const revision = typeof item["revision"] === "number" ? { revision: item["revision"] } : {};
    const answer = answerFromText(s.blocks, item["text"]); // an answer waiting in the queue is already a card, never its protocol text
    listed.set(id, {
      kind: "user",
      id,
      text: item["text"],
      delivery: { state: "queued", ...(queuedId !== undefined ? { queuedId } : {}), ...revision },
      ...(answer !== undefined ? { answer } : {}),
    });
  }
  const blocks: Block[] = [];
  for (const block of s.blocks) {
    const queued = listed.get(block.id);
    listed.delete(block.id);
    if (block.kind !== "user" || block.delivery === undefined) blocks.push(block);
    else if (queued !== undefined) blocks.push({ ...block, text: queued.text, delivery: queued.delivery });
    else if (!block.id.startsWith(FOREIGN_QUEUED)) blocks.push(block.delivery.state === "queued" ? { ...block, delivery: { state: "sending" } } : block);
  }
  return { ...s, blocks: [...blocks, ...listed.values()] };
}

/**
 * A message just sent: shown at once, as sending; a resend of the same id replaces its old undelivered block.
 * `supersedes` is set when the message is a resend under a new id (a liveness recovery): the earlier undelivered
 * bubble for the same message leaves the feed here, so the person never sees it both delivered and queued.
 */
export function addOutgoing(s: ChatState, message: { id: string; text: string; images?: ImageRef[]; supersedes?: string }): ChatState {
  const existing = s.blocks.find((block) => block.id === message.id);
  if (existing !== undefined && (existing.kind !== "user" || existing.delivery === undefined)) return s;
  const block: UserBlock = { kind: "user", id: message.id, text: message.text, delivery: { state: "sending" } };
  if (message.images !== undefined && message.images.length > 0) block.images = message.images;
  if (message.supersedes !== undefined) block.supersedes = message.supersedes;
  const matches = (message.images?.length ?? 0) === 0 ? [] : s.blocks.filter((other): other is UserBlock =>
    other.kind === "user" && other.id.startsWith(FOREIGN_QUEUED) && other.delivery?.state === "queued" &&
    withoutImageMarkers(other.text, message.images?.length ?? 0) === withoutImageMarkers(message.text, message.images?.length ?? 0),
  );
  const queued = matches.length === 1 ? matches[0] : undefined;
  if (queued?.delivery?.state === "queued") {
    block.text = queued.text;
    block.delivery = queued.delivery;
  }
  const superseded = (other: Block): boolean =>
    message.supersedes !== undefined && other.kind === "user" && other.id === message.supersedes && other.delivery !== undefined;
  return { ...s, blocks: [...s.blocks.filter((other) => other !== existing && other !== queued && !superseded(other)), block] };
}

/** Takes back a message that never reached the conversation (refused, handled by a command, or dequeued). */
export function dropOutgoing(s: ChatState, id: string): ChatState {
  const index = s.blocks.findIndex((block) => block.id === id && block.kind === "user" && block.delivery !== undefined);
  return index < 0 ? s : { ...s, blocks: [...s.blocks.slice(0, index), ...s.blocks.slice(index + 1)] };
}

/** A queued message's text after a successful edit, before the queue frame confirms it. */
export function reviseQueued(s: ChatState, id: string, text: string, revision?: number): ChatState {
  return {
    ...s,
    blocks: updateBlock(s.blocks, id, (block) =>
      block.kind === "user" && block.delivery?.state === "queued"
        ? { ...block, text, delivery: { ...block.delivery, ...(revision !== undefined ? { revision } : {}) } }
        : block,
    ),
  };
}

function onAgentEnd(s: ChatState, frame: Json): ChatState {
  if (frame["aborted"] !== true) return s;
  // A clean turn end carries no `aborted`, so this line never greets an ordinary finish. An abort OmO labels `"system"`
  // (compaction, a deadline, its own liveness machinery) is not the person's «Стоп»: `SessionController.observeLiveness`
  // tells that story honestly — the turn was abandoned, or the context is being compacted — so the bare line is wrong here.
  if (frame["abortSource"] === "system") return s;
  const id = `aborted:${asString(frame["clientMessageId"]) ?? s.blocks.length}`;
  return { ...s, blocks: upsertBlock(s.blocks, notice(id, "info", "Ход остановлен")) };
}

/** The turn is over: nothing streams, and a message still "sending" will not arrive in it (a queued one waits for the next). */
function onAgentSettled(s: ChatState): ChatState {
  const blocks = s.blocks
    .filter((block) => !(block.kind === "user" && block.delivery?.state === "sending"))
    .map((block) => (block.kind === "assistant" && block.streaming ? { ...block, streaming: false } : block));
  return { ...s, blocks, running: false };
}

/**
 * Whether OmO's lifecycle describes a turn that is still going. `lastStop` names the run OmO stopped: when that is
 * this very run, the turn is over however `state` still reads. OmO leaves exactly that behind twice — a turn whose
 * model request errored out gets `turn_end`/`agent_end` and no `agent_settled`, and a session reopened after a park
 * reports the state its last turn was left in — so without this the tab would wait for an end frame that never comes.
 * Undefined means the lifecycle says nothing either way (an unknown state or no lifecycle).
 */
export function lifecycleRunning(lifecycle: unknown): boolean | undefined {
  if (!isObject(lifecycle)) return undefined;
  // 5.1.59 emits these only after the turn ends; runActive is not part of its wire snapshot.
  if (lifecycle["state"] === "waiting_background" || lifecycle["state"] === "waiting_children") return false;
  const runId = lifecycle["runId"];
  const stopped = isObject(lifecycle["lastStop"]) ? lifecycle["lastStop"]["runId"] : undefined;
  if (lifecycle["state"] === "done" || (typeof runId === "string" && runId === stopped)) return false;
  if (lifecycle["state"] === "waiting_human") return !(attentionOnly(lifecycle) || standingQuestion(lifecycle));
  return lifecycle["state"] === "running" ? true : undefined;
}

/**
 * A non-blocking question (`request_user_input` / `ask_user_question` with `waitForAnswer: false`): the tool returned at
 * once and the turn ended, but OmO keeps the session on `waiting_human` with a `question` wait — a standing invitation
 * whose answer is the next user message. OmO marks it apart from a blocking question (whose turn is genuinely running) by
 * carrying an `ask-user` wait in `waitingOn.background` (measured live, 5.1.59; a blocking question has none). Treating it
 * as running is the trap this fixes: the composer would lock to a queue that never drains and the silence watch would
 * offer «Снять зависание» for a turn that correctly ended.
 */
function standingQuestion(lifecycle: Json): boolean {
  const waiting = lifecycle["waitingOn"];
  const background = isObject(waiting) && Array.isArray(waiting["background"]) ? waiting["background"] : [];
  return background.some((wait) => isObject(wait) && wait["source"] === "ask-user");
}

/**
 * The human waits OmO raises out of the session's own state instead of out of a question put to the person: a goal it
 * stopped, a run it calls stalled, a run something interrupted. OmO turns ANY human wait into `waiting_human`, so
 * without telling these apart a goal OmO stopped would read as a turn waiting for an answer nobody will ever be
 * asked for — and the tab would wait on it forever while every message the person sends only queues.
 */
const ATTENTION_KINDS = new Set(["goal_blocked", "goal_paused", "stalled", "interrupted_run"]);

/**
 * A reply that ended by asking the person something: OmO ends the turn and raises a `question` wait of its own, keyed
 * `question:<runId>:<n>` (5.1.64; its other synthetic waits are keyed the same way). No tool call is blocked on it — the
 * answer is simply the next user message. A question a tool call is blocked on carries that call's id instead
 * (`toolu_…`, `call_…|fc_…`). Seen live (2026-11-11): read as a running turn, the tab sent the person's next message as
 * a steer, OmO queued it for a tool boundary that never came, and every «Стоп» / «Снять зависание» brought it back.
 */
function turnEndQuestion(wait: Json): boolean {
  return wait["kind"] === "question" && typeof wait["requestId"] === "string" && wait["requestId"].startsWith("question:");
}

/**
 * True when every one of the lifecycle's human waits is one of those or a turn-end question (and there is at least
 * one): nothing is being asked by a running turn, so none is running. A host that reports no `waitingOn` says nothing
 * either way and keeps `waiting_human`.
 */
function attentionOnly(lifecycle: Json): boolean {
  const waiting = lifecycle["waitingOn"];
  const human = isObject(waiting) && Array.isArray(waiting["human"]) ? waiting["human"] : [];
  return human.length > 0 && human.every((wait) => isObject(wait) && (ATTENTION_KINDS.has(String(wait["kind"])) || turnEndQuestion(wait)));
}

/**
 * OmO's own words, in English, when a session it resumed still has a stopped goal: over RPC it does not offer the
 * TUI's «Resume goal?» choice, it only says this once and leaves the goal where it is. `SessionController` resumes
 * the goal itself and says what happened in Russian, so this line never reaches the feed. Returns the goal's status.
 */
export function stoppedGoalNotice(frame: unknown): string | undefined {
  if (!isObject(frame) || frame["type"] !== "extension_ui_request" || frame["method"] !== "notify") return undefined;
  return /^Goal remains (blocked|paused) after session resume\b/.exec(asString(frame["message"]) ?? "")?.[1];
}

/** OmO's goal card — what a `/goal …` command answers with (`Goal active\nObjective: …`). */
export function goalCardNotice(frame: unknown): boolean {
  if (!isObject(frame) || frame["type"] !== "extension_ui_request" || frame["method"] !== "notify") return false;
  return /^Goal (active|paused|blocked|complete)\n/.test(asString(frame["message"]) ?? "");
}

/** The lifecycle's own word on the turn, applied to a state: the verb it names, or the turn's end. */
export function applyLifecycle(s: ChatState, lifecycle: unknown): ChatState {
  if (isObject(lifecycle) && isObject(lifecycle["waitingOn"])) {
    const waitingOn = lifecycle["waitingOn"];
    const sources = (Array.isArray(waitingOn["background"]) ? waitingOn["background"] : [])
      .filter((source): source is Json => isObject(source) && source["source"] !== "ask-user" && typeof source["activeCount"] === "number" && source["activeCount"] > 0);
    const count = (typeof waitingOn["children"] === "number" ? waitingOn["children"] : 0) +
      sources.reduce((total, source) => total + source["activeCount"], 0);
    const background = count > 0 ? { count, sources: sources.map((source) => String(source["source"])) } : undefined;
    if (JSON.stringify(background) !== JSON.stringify(s.background)) s = { ...s, background };
  }
  const running = lifecycleRunning(lifecycle);
  if (running === false) return withActivity(s, false, "idle", undefined);
  if (running === undefined || !isObject(lifecycle)) return s;
  if (lifecycle["state"] === "waiting_human") return withActivity(s, true, "waiting_human", undefined);
  const live = lifecycle["activity"];
  const kind = isObject(live) ? live["kind"] : undefined;
  const tool = kind === "tool" ? asString(live?.["toolName"]) : undefined;
  const activity = kind === "tool" ? "tool" : kind === "model" ? "thinking" : undefined;
  return withActivity(s, true, activity, tool);
}

function withActivity(s: ChatState, running: boolean, activity: SessionActivity | undefined, tool: string | undefined): ChatState {
  if (s.running === running && s.activity === activity && s.activityTool === tool) return s;
  return { ...s, running, activity, activityTool: tool };
}

function onThinkingLevel(s: ChatState, level: unknown): ChatState {
  return typeof level !== "string" || level === s.thinkingLevel ? s : { ...s, thinkingLevel: level };
}

function onModelChanged(s: ChatState, frame: Json): ChatState {
  const model = isObject(frame["model"]) ? parseModelRef(frame["model"]["provider"], frame["model"]["id"]) : undefined;
  if (!model) return s;
  const withLevel = onThinkingLevel(s, frame["thinkingLevel"]);
  return frame["origin"]?.source === "extension" ? { ...withLevel, model, autoModel: model } : { ...withLevel, model };
}

function onEntryAppended(s: ChatState, frame: Json): ChatState {
  const entry = frame["entry"];
  if (!isObject(entry)) return s;
  const cursor = asString(entry["id"]) ?? s.cursor;
  const autoModel = profileAppliedModel(entry) ?? s.autoModel;
  const settled = settlementOf(entry);
  const base = settled === undefined ? s : settleQuestions(s, [settled]);
  const leveled = entry["type"] === "thinking_level_change" ? onThinkingLevel(base, entry["thinkingLevel"]) : base;
  return cursor === s.cursor && autoModel === s.autoModel ? leveled : { ...leveled, cursor, autoModel };
}

/**
 * OmO's config-watcher chatter («Hot-reloading: …/models.json», «Hot-reloaded: …»): housekeeping about files the person
 * never asked about. Dropped only at info level — a warning or error about the same file still shows.
 */
const HOUSEKEEPING = /^(hot-)?reload(ing|ed)?\b/i;

/** OmO 5.1.59, in English, whenever a session whose goal ran many automatic continuations is opened again. */
const SUPPRESSED_CONTINUATION = /^Goal auto-continuation suppressed for this resumed session \((\d+) historical continuations?\)/;
const SUPPRESSED_NOTICE_ID = "goal-continuation-suppressed";

function onUiRequest(s: ChatState, frame: Json): ChatState {
  const method = frame["method"];
  const id = asString(frame["id"]);
  if (method === "notify") {
    const text = asString(frame["message"]);
    if (!id || !text) return s;
    if (stoppedGoalNotice(frame) !== undefined) return s; // handled, in Russian, by the controller
    const suppressed = SUPPRESSED_CONTINUATION.exec(text.trim());
    if (suppressed !== null) {
      // said on every reopen (the idle sweep parks every 30 min): one line, in Russian, moved to the end
      const line = `Цель не продолжается сама после переоткрытия сессии (автопродолжений уже ${suppressed[1]}) — продолжится с вашим следующим сообщением`;
      return { ...s, blocks: [...s.blocks.filter((block) => block.id !== SUPPRESSED_NOTICE_ID), notice(SUPPRESSED_NOTICE_ID, "info", line)] };
    }
    const type = frame["notifyType"];
    const level = type === "error" ? "error" : type === "warning" || type === "warn" ? "warn" : "info";
    if (level === "info" && HOUSEKEEPING.test(text.trim())) return s;
    return { ...s, blocks: appendNotice(s.blocks, notice(`notify:${id}`, level, text)) };
  }
  if (!id || typeof method !== "string" || !DIALOG_METHODS.has(method)) return s;
  if (s.dialogs.some((dialog) => dialog.id === id)) return s;
  const requestIds = questionRequestIds(frame);
  if (method === "question" && requestIds.some((requestId) => s.settledQuestions?.includes(requestId) === true)) return s;
  const dialog: Dialog = { id, method: method as Dialog["method"], title: dialogTitle(frame) };
  if (method === "question" && requestIds.length > 0) dialog.requestIds = requestIds;
  // A `question` the agent did not wait on (`waitForAnswer: false`) is a standing invitation, not a turn to block on.
  if (method === "question" && frame["waitForAnswer"] === false) dialog.blocking = false;
  if (Array.isArray(frame["options"])) dialog.options = frame["options"].filter((option): option is string => typeof option === "string");
  if (Array.isArray(frame["questions"])) dialog.questions = frame["questions"];
  for (const key of ["message", "placeholder", "prefill"] as const) {
    const text = asString(frame[key]);
    if (text !== undefined && (key !== "message" || method === "confirm")) dialog[key] = text;
  }
  const deadline = dialogDeadline(frame);
  if (deadline !== undefined) dialog.deadlineAt = deadline;
  return { ...s, dialogs: [...s.dialogs, dialog] };
}

/** OmO's own deadline for a dialog (`deadlineAtMs`), else now + its `timeout`; none for a dialog that waits forever. */
function dialogDeadline(frame: Json): number | undefined {
  const at = frame["deadlineAtMs"];
  if (typeof at === "number" && Number.isFinite(at)) return at;
  const timeout = frame["timeout"];
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? Date.now() + timeout : undefined;
}

function dialogTitle(frame: Json): string {
  const title = asString(frame["title"]);
  if (title) return title;
  if (frame["method"] === "question" && Array.isArray(frame["questions"])) {
    const first = frame["questions"][0];
    if (isObject(first)) return asString(first["question"]) ?? asString(first["header"]) ?? "Вопрос";
    return "Вопрос";
  }
  return asString(frame["message"]) ?? asString(frame["placeholder"]) ?? "";
}

function replaceAgents(s: ChatState, prefix: string, rows: AgentRow[]): ChatState {
  const others = s.agents.filter((row) => !row.id.startsWith(prefix));
  if (rows.length === 0 && others.length === s.agents.length) return s;
  return { ...s, agents: [...others, ...rows] };
}

const TASK_STATUS: Record<string, AgentStatus> = {
  running: "running",
  completed: "done",
  error: "error",
  cancelled: "error",
  interrupted: "error",
  lost: "error",
  pending: "waiting",
  paused: "waiting",
};
const DAG_STATE: Record<string, AgentStatus> = {
  running: "running",
  completed: "done",
  done: "done",
  failed: "error",
  error: "error",
  cancelled: "error",
};

function agentStatus(table: Record<string, AgentStatus>, raw: unknown): AgentStatus {
  return (typeof raw === "string" ? table[raw] : undefined) ?? "waiting";
}

/** An OmO task's status as an agent row shows it. */
export function taskStatus(raw: unknown): AgentStatus {
  return agentStatus(TASK_STATUS, raw);
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The agent row for one OmO task record: an `omo.task.updated` / `omo.task.list` item, a spawn result or a completion. */
function taskRow(task: Json): AgentRow | undefined {
  if (typeof task["task_id"] !== "string") return undefined;
  const row: AgentRow = {
    id: `task:${task["task_id"]}`,
    taskId: task["task_id"],
    label: asString(task["name"]) || asString(task["task_summary"]) || task["task_id"],
    status: taskStatus(task["status"]),
  };
  const model = taskModel(task);
  if (model) row.model = model;
  const role = asString(task["category"]) || asString(task["agent_type"]);
  if (role) row.role = role;
  const progress = isObject(task["live_progress"]) ? task["live_progress"] : undefined;
  const activity = asString(progress?.["activity"]);
  if (activity) row.activity = activity;
  const startedAt = typeof progress?.["started_at"] === "number" ? progress["started_at"] : parseTime(task["created_at"]);
  if (startedAt !== undefined) row.startedAt = startedAt;
  const endedAt = row.status === "done" || row.status === "error" ? parseTime(task["updated_at"]) : undefined;
  if (endedAt !== undefined) row.endedAt = endedAt;
  const tokens = isObject(task["run_stats"]) ? task["run_stats"]["total_tokens"] : undefined;
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) row.tokens = tokens;
  const childSession = asString(task["child_session_id"]);
  if (childSession) row.childSession = childSession;
  return row;
}

/** Each row replaces the one with its id in place, or joins the list; rows it does not mention stay. */
function mergeAgents(agents: AgentRow[], rows: AgentRow[]): AgentRow[] {
  const next = [...agents];
  for (const row of rows) {
    const index = next.findIndex((existing) => existing.id === row.id);
    if (index < 0) next.push(row);
    else next[index] = row;
  }
  return next;
}

/**
 * OmO's snapshot of the session's tasks (`omo.task.updated`, or the `omo.task.list` answer) merged into the rows: a
 * finished task stays for the session even when OmO no longer lists it. A complete snapshot holds every task OmO still
 * tracks, so a row it leaves out that was running or waiting was lost (OmO's own term; shown as an error).
 */
function onTaskSnapshot(s: ChatState, data: Json): ChatState {
  if (!Array.isArray(data["tasks"])) return s;
  const rows = data["tasks"].flatMap((task) => (isObject(task) ? (taskRow(task) ?? []) : []));
  const complete = !(typeof data["truncated_tasks"] === "number" && data["truncated_tasks"] > 0);
  const listed = new Set(rows.map((row) => row.id));
  const agents = s.agents.map((row) =>
    complete && row.id.startsWith("task:") && !listed.has(row.id) && (row.status === "running" || row.status === "waiting")
      ? { ...row, status: "error" as const }
      : row,
  );
  return { ...s, agents: mergeAgents(agents, rows) };
}

/** The `omo.task.list` answer; a failure (`{ kind, reason }`) or anything without a task list leaves the rows as they are. */
export function applyTaskList(s: ChatState, data: unknown): ChatState {
  return isObject(data) ? onTaskSnapshot(s, data) : s;
}

function onDagUpdated(s: ChatState, data: Json): ChatState {
  const runs: unknown[] = Array.isArray(data["runs"]) ? data["runs"] : [];
  const rows: AgentRow[] = [];
  for (const run of runs) {
    if (!isObject(run) || !Array.isArray(run["nodes"])) continue;
    const runId = asString(run["run_id"]) ?? "";
    for (const node of run["nodes"]) {
      if (!isObject(node) || typeof node["id"] !== "string") continue;
      const row: AgentRow = {
        id: `dag:${runId}:${node["id"]}`,
        label: asString(node["label"]) ?? node["id"],
        status: agentStatus(DAG_STATE, node["state"]),
      };
      const model = asString(node["model"]);
      if (model) row.model = model;
      rows.push(row);
    }
  }
  return replaceAgents(s, "dag:", rows);
}

function onExtensionEvent(s: ChatState, frame: Json): ChatState {
  const data = frame["data"];
  if (!isObject(data)) return s;
  if (frame["name"] === "omo.task.updated") return onTaskSnapshot(s, data);
  if (frame["name"] === "omo.dag.updated") return onDagUpdated(s, data);
  return s;
}

export function applyFrame(s: ChatState, frame: any, sink?: ImageSink, now: Clock = Date.now): ChatState {
  if (!isObject(frame)) return s;
  switch (frame["type"]) {
    case "message_start":
      return onMessageStart(s, frame, sink);
    case "message_update":
      return onMessageUpdate(s, frame, now);
    case "message_end":
      return onMessageEnd(s, frame);
    case "tool_execution_start":
      return onToolStart(s, frame, now);
    case "tool_execution_update":
      return onToolOutput(s, frame, false, now);
    case "tool_execution_end":
      return onToolOutput(s, frame, true, now);
    case "queue_update":
      return onQueueUpdate(s, frame);
    case "agent_start":
      return s.running && s.error === undefined ? s : { ...s, running: true, error: undefined };
    case "agent_end":
      return onAgentEnd(s, frame);
    case "agent_settled":
      return onAgentSettled(s);
    case "compaction_start":
      return s.compacting === true ? s : { ...s, compacting: true };
    case "compaction_end": {
      // A finished compaction leaves the old count meaningless until the next reply reports fresh usage.
      const { contextTokens: _stale, ...rest } = s;
      return { ...(frame["aborted"] === true ? s : rest), compacting: false };
    }
    case "session_lifecycle":
      return applyLifecycle(s, frame["lifecycle"]);
    case "model_changed":
      return onModelChanged(s, frame);
    case "session_info_changed": {
      const title = asString(frame["name"]);
      return title === undefined || title === s.title ? s : { ...s, title };
    }
    case "entry_appended":
      return onEntryAppended(s, frame);
    case "extension_ui_request":
      return onUiRequest(s, frame);
    case "question_updated": {
      const id = asString(frame["id"]);
      const at = frame["deadlineAtMs"];
      if (!id || typeof at !== "number" || !s.dialogs.some((dialog) => dialog.id === id)) return s;
      return { ...s, dialogs: s.dialogs.map((dialog) => (dialog.id === id ? { ...dialog, deadlineAt: at } : dialog)) };
    }
    case "question_resolved": {
      const id = asString(frame["id"]);
      const settled = settleQuestions(s, questionRequestIds(frame));
      return id && settled.dialogs.some((dialog) => dialog.id === id) ? resolveDialog(settled, id) : settled;
    }
    case "extension_event":
      return onExtensionEvent(s, frame);
    default:
      return s;
  }
}

/** A question frame's own ids — `requestId` and `toolCallId` — either of which OmO's settlement may name. */
function questionRequestIds(frame: Json): string[] {
  return [...new Set([asString(frame["requestId"]), asString(frame["toolCallId"])].filter((id): id is string => id !== undefined && id !== ""))];
}

const SETTLED_QUESTIONS_KEPT = 300;

/** OmO settled these questions: their cards go, and no later listing of them brings one back. */
function settleQuestions(s: ChatState, requestIds: string[]): ChatState {
  if (requestIds.length === 0) return s;
  const known = s.settledQuestions ?? [];
  const added = requestIds.filter((id) => !known.includes(id));
  const dialogs = s.dialogs.filter((dialog) => !dialog.requestIds?.some((id) => requestIds.includes(id)));
  if (added.length === 0 && dialogs.length === s.dialogs.length) return s;
  return { ...s, dialogs, settledQuestions: [...known, ...added].slice(-SETTLED_QUESTIONS_KEPT) };
}

/** The journal's record that OmO settled a question (answered, timed out, cancelled): its request id. */
function settlementOf(entry: Json): string | undefined {
  if (entry["customType"] !== "ask-user:settlement") return undefined;
  const data = entry["data"];
  return isObject(data) ? asString(data["requestId"]) : undefined;
}

export function resolveDialog(s: ChatState, id: string): ChatState {
  return s.dialogs.some((dialog) => dialog.id === id) ? { ...s, dialogs: s.dialogs.filter((dialog) => dialog.id !== id) } : s;
}

// ---------- journal ----------

function entryBlocks(entry: Json, fallbackIndex: number, blocks: Block[]): Block[] {
  if (entry["type"] === "custom_message") {
    const customType = asString(entry["customType"]);
    const text = contentText(entry["content"]);
    if (entry["display"] !== true || !text || (customType && INTERNAL_CUSTOM_TYPES.has(customType))) return [];
    return [notice(`entry:${asString(entry["id"]) ?? fallbackIndex}`, "info", text)];
  }
  if (entry["type"] !== "message" || !isObject(entry["message"])) return [];
  const message = entry["message"];
  switch (message["role"]) {
    case "user": {
      const text = contentText(message["content"]);
      const id = userId(message, fallbackIndex);
      const block = userBlock(message, id, text, blocks);
      return text || block.images ? [block] : [];
    }
    case "assistant": {
      const content: unknown[] = Array.isArray(message["content"]) ? message["content"] : [];
      const text = contentText(content);
      const thinking = assistantThinking(content);
      const blocks: Block[] = [];
      const stop = providerStop(message);
      // Same id as the live path, so a reload shows the one line again and a catch-up does not add a second.
      if (stop !== undefined) blocks.push(notice(`refusal:${assistantId(message, fallbackIndex)}`, "warn", STOP_TEXT[stop.kind], stop.detail));
      if (text || thinking) {
        const block: AssistantBlock = { kind: "assistant", id: assistantId(message, fallbackIndex), text, thinking, streaming: false };
        if (typeof message["timestamp"] === "number") block.timestamp = message["timestamp"];
        blocks.push(block);
      }
      for (const part of content) {
        if (isObject(part) && part["type"] === "toolCall" && typeof part["id"] === "string") {
          blocks.push(toolBlock(part["id"], asString(part["name"]) ?? "tool", part["arguments"]));
        }
      }
      return blocks;
    }
    default:
      return [];
  }
}

function applyToolResult(blocks: Block[], message: Json): Block[] {
  const id = asString(message["toolCallId"]);
  if (!id) return blocks;
  const { output, truncated } = capOutput(contentText(message["content"]));
  const state: ToolBlock["state"] = message["isError"] === true ? "error" : "ok";
  const existing = blocks.find((block) => block.id === id);
  const seed: ToolBlock = existing?.kind === "tool" ? existing : toolBlock(id, asString(message["toolName"]) ?? "tool", undefined);
  const next: ToolBlock = { ...seed, output, truncated, state };
  const model = seed.name === "task" ? taskResultModel(message) : undefined;
  if (model) next.model = model;
  const answer = seed.name === ASK_TOOL ? answerFromResult(blocks, id, message) : undefined;
  if (answer !== undefined) next.answer = answer;
  return upsertBlock(blocks, next);
}

/** The tasks a `task` call started, as its result reported them then: rows only for tasks the tab does not show yet. */
function spawnedAgents(s: ChatState, message: Json): ChatState {
  const details = message["details"];
  if (message["toolName"] !== "task" || !isObject(details)) return s;
  const records: unknown[] = Array.isArray(details["items"]) ? details["items"] : [details];
  const rows = records.flatMap((record) => {
    const row = isObject(record) ? taskRow(record) : undefined;
    if (row === undefined || s.agents.some((existing) => existing.id === row.id)) return [];
    if (row.startedAt === undefined && typeof message["timestamp"] === "number") row.startedAt = message["timestamp"];
    return [row];
  });
  return rows.length === 0 ? s : { ...s, agents: mergeAgents(s.agents, rows) };
}

/** The task records of a completion notice: `senpi-task.completion`, alone or carried by an `omo-senpi:wake`. */
function completionRecords(customType: unknown, details: unknown): Json[] {
  if (customType === "senpi-task.completion") return Array.isArray(details) ? details.filter(isObject) : [];
  if (customType !== "omo-senpi:wake") return [];
  const carried: unknown = Array.isArray(details) ? details : isObject(details) ? (details["producerDetails"] ?? details["items"]) : undefined;
  return Array.isArray(carried) ? carried.flatMap((item) => (isObject(item) ? completionRecords(item["customType"], item["details"]) : [])) : [];
}

/** A journaled completion: the task's final state, ended when the notice was written. */
function finishedAgents(s: ChatState, entry: Json): ChatState {
  const rows = completionRecords(entry["customType"], entry["details"]).flatMap((record) => {
    const row = taskRow(record);
    if (row === undefined) return [];
    const { activity: _stale, ...shown } = s.agents.find((existing) => existing.id === row.id) ?? {};
    const endedAt = row.status === "done" || row.status === "error" ? (row.endedAt ?? parseTime(entry["timestamp"])) : undefined;
    return [{ ...shown, ...row, ...(endedAt !== undefined ? { endedAt } : {}) }];
  });
  return rows.length === 0 ? s : { ...s, agents: mergeAgents(s.agents, rows) };
}

/**
 * Merges journal entries into the state by block id, so a full history load on an
 * empty state is a rebuild and a catch-up after `since` does not duplicate live blocks.
 */
export function applyEntries(s: ChatState, entries: any[], sink?: ImageSink): ChatState {
  let next = s;
  entries.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const message = entry["message"];
    if (entry["type"] === "message" && isObject(message) && message["role"] === "toolResult") {
      next = spawnedAgents({ ...next, blocks: applyToolResult(next.blocks, message) }, message);
    } else {
      if (entry["type"] === "custom_message") next = finishedAgents(next, entry);
      let blocks = next.blocks;
      for (const block of entryBlocks(entry, index, blocks)) {
        const existing = blocks.find((candidate) => candidate.id === block.id);
        if (existing?.kind === "user" && existing.delivery !== undefined && block.kind === "user") {
          // the journal has the message we showed as undelivered: it is in the conversation now
          if (block.images && isObject(entry["message"])) sinkImages(entry["message"], block.id, sink);
          // a resend keeps suppressing the old id it replaced, even after another reopen delivers it from the journal
          blocks = upsertBlock(blocks, existing.supersedes !== undefined ? { ...block, supersedes: existing.supersedes } : block);
          continue;
        }
        if (existing?.kind === "user" && block.kind === "user") {
          // A re-delivered user message only contributes images the block does not have yet, each sunk once.
          if (!existing.images && block.images && isObject(entry["message"])) {
            sinkImages(entry["message"], block.id, sink);
            blocks = updateBlock(blocks, block.id, () => ({ ...existing, images: block.images }));
          }
          continue;
        }
        if (!existing && block.kind === "user" && isObject(entry["message"])) sinkImages(entry["message"], block.id, sink);
        if (block.kind === "notice") {
          blocks = appendNotice(blocks, block); // consecutive identical journal notices collapse too
          continue;
        }
        // Never regress a tool block that already carries a result.
        blocks = existing?.kind === "tool" && block.kind === "tool" ? blocks : upsertBlock(blocks, block);
      }
      next = { ...next, blocks };
    }
    if (entry["type"] === "thinking_level_change") next = onThinkingLevel(next, entry["thinkingLevel"]);
    const settled = settlementOf(entry);
    if (settled !== undefined) next = settleQuestions(next, [settled]);
    if (entry["type"] === "model_change") {
      const model = parseModelRef(entry["provider"], entry["modelId"]);
      if (model) next = { ...next, model };
    } else if (entry["type"] === "session_info" && typeof entry["name"] === "string") {
      next = { ...next, title: entry["name"] };
    }
    const autoModel = profileAppliedModel(entry);
    if (autoModel) next = { ...next, autoModel };
  });
  const last = entries[entries.length - 1];
  const cursor = isObject(last) ? asString(last["id"]) : undefined;
  return cursor ? { ...next, cursor } : next;
}
