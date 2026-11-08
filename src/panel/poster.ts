import { redact } from "../env";
import { diffState } from "./delta";
import type { HostMessage, StateMessage } from "./protocol";

export const POST_INTERVAL_MS = 50;

/**
 * On the host's own structures (see `structuralObjects`), string values under these keys are identifiers or
 * protocol words, never shown as text, and are posted as is: `sessionPath` restores the tab (it lives under the
 * agent dir, itself a configured value, so a "secret"), ids and model refs must round-trip to the host, and enum
 * words keep the webview's switches working. Inside free-form payloads (questions) every string is redacted; tool args are not posted.
 */
const VERBATIM_KEYS: ReadonlySet<string> = new Set([
  "sessionPath",
  "id",
  "dialogId",
  "uiRequestId",
  "provider",
  "type",
  "kind",
  "state",
  "level",
  "method",
  "modelMode",
  "queuedId",
  "outcome",
  "status",
  "durableId",
  "taskId",
  "source",
  "syntax",
  // The settings modal names the window's environment by its agent dir.
  "agentDir",
  "blockId",
  // an answer card's way back to the message whose turn asked the question: the webview posts it back as a blockId
  "forkFrom",
  "fingerprint",
  "action",
  "changed",
]);

/**
 * The single exit from host to webview: serializes and redacts every displayed string value (never the JSON
 * text, so literal-looking secrets like "true" or "2000" cannot break it). State is posted at most once per
 * POST_INTERVAL_MS, always the latest: in full the first time (and after `reset`), then as a delta against the last
 * state posted. Other messages go at once, after any state still waiting: a reply never overtakes the state it follows.
 */
export class StatePoster {
  private pending: StateMessage | undefined;
  /** The state the webview has, by reference: deltas are taken against it. */
  private lastPosted: StateMessage | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastPostAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly post: (json: string) => void,
    private readonly secrets: readonly string[],
  ) {}

  push(message: StateMessage): void {
    if (this.disposed) return;
    this.pending = message;
    if (this.timer !== undefined) return;
    const wait = this.lastPostAt + POST_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  /** The next state goes out in full: the webview (re)loaded or the session re-opened. */
  reset(): void {
    this.lastPosted = undefined;
  }

  /** Unthrottled, for replies that must not be coalesced away. */
  send(message: HostMessage): void {
    if (this.disposed) return;
    if (this.pending !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.flush();
    }
    this.post(this.serialize(message));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private flush(): void {
    const message = this.pending;
    this.pending = undefined;
    if (message === undefined || this.disposed) return;
    this.lastPostAt = Date.now();
    const previous = this.lastPosted;
    this.lastPosted = message;
    this.post(this.serialize(previous === undefined ? message : diffState(previous, message)));
  }

  private serialize(message: HostMessage): string {
    const structural = structuralObjects(message);
    const secrets = this.secrets;
    // protocol words, like the enums above, and block ids (as under the verbatim key "id")
    const verbatimLists = new Set<unknown>(
      message.type === "state" ? [message.thinkingLevels] : message.type === "delta" ? [message.thinkingLevels, message.removed, message.order] : [],
    );
    return JSON.stringify(message, function (this: unknown, key: string, value: unknown): unknown {
      if (key === "dataUrl" && message.type === "image" && this === message) return value; // image bytes: the one unredacted payload
      if ((key === "data" || key === "mimeType") && message.type === "draft" && message.images.includes(this as never)) return value; // draft image bytes
      if (key === "args" && structural.has(this as object)) return undefined; // tool args are never rendered and can be whole files
      if (typeof value !== "string") return value;
      if (verbatimLists.has(this)) return value;
      return structural.has(this as object) && VERBATIM_KEYS.has(key) ? value : redact(value, secrets);
    });
  }
}

/** The objects the host itself builds; anything reachable only through other objects is free-form. */
function structuralObjects(message: HostMessage): Set<object> {
  const objects = new Set<object>([message]);
  if (message.type === "sessions" || message.type === "deferred") {
    for (const item of message.items) objects.add(item);
    if (message.type === "deferred") for (const entry of message.deliveries ?? []) objects.add(entry);
    return objects;
  }
  if (message.type === "guardRequest") {
    objects.add(message.request); // its id is answered back; command, reasons and the decider's words are free text
    return objects;
  }
  if (message.type === "settings") {
    objects.add(message.state); // a section's own view is free-form
    if ("env" in message.state) objects.add(message.state.env);
    return objects;
  }
  if (message.type === "rewindPreview") {
    if (message.ok) for (const item of message.items) objects.add(item);
    return objects;
  }
  if (message.type === "messageActions") {
    objects.add(message.fork).add(message.rewind);
    return objects;
  }
  if (message.type !== "state" && message.type !== "delta") return objects;
  const { state, tab, models, commands } = message;
  for (const command of commands ?? []) objects.add(command);
  objects.add(tab);
  objects.add(state);
  for (const block of message.type === "state" ? message.state.blocks : message.changed) {
    objects.add(block);
    if (block.kind === "user" && block.delivery !== undefined) objects.add(block.delivery);
    // the answer card's ids must round-trip; its questions, options and the person's words are free text below it
    if ((block.kind === "user" || block.kind === "tool") && block.answer !== undefined) objects.add(block.answer);
  }
  for (const dialog of state.dialogs) objects.add(dialog);
  for (const agent of state.agents) objects.add(agent);
  for (const model of [state.model, state.autoModel, ...(models ?? [])]) if (model !== undefined) objects.add(model);
  return objects;
}
