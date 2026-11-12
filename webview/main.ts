import type { HostMessage, PersistedState, WebviewMessage } from "../src/panel/protocol";
import { parseDeferredHostMessage } from "../src/panel/protocol";
import { ChatView } from "./render";
import "./style.css";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
};

const vscode = acquireVsCodeApi();
const saved = vscode.getState();
let tab: PersistedState["tab"] | undefined = saved?.tab;
/** The unsent text in the input: kept in the webview's state, so a window reload gives it back. */
let draft = typeof saved?.draft === "string" ? saved.draft : "";

function persist(): void {
  if (tab !== undefined) vscode.setState({ tab, ...(draft !== "" ? { draft } : {}) }); // what the serializer restores after a reload
}

const view = new ChatView(
  document.getElementById("app") as HTMLElement,
  (message) => vscode.postMessage(message),
  (text) => {
    draft = text;
    persist();
  },
);
view.restoreDraft(draft);

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (typeof event.data !== "string") return;
  let message: HostMessage;
  try {
    message = JSON.parse(event.data) as HostMessage;
  } catch {
    return; // one bad message must not stop the tab from updating
  }
  if (message === null || typeof message !== "object") return;
  if (message.type === "deferred" || message.type === "deferredResult") {
    const parsed = parseDeferredHostMessage(message);
    if (parsed?.type === "deferred") view.deferred(parsed);
    else if (parsed?.type === "deferredResult") view.deferredResult(parsed);
    return;
  }
  switch (message.type) {
    case "answerResult":
      view.answerResult(message.dialogId, message.outcome);
      return;
    case "sent":
      view.sent(message.id, message.ok);
      return;
    case "image":
      view.image(message.id, message.dataUrl);
      return;
    case "queueResult":
      view.queueResult(message);
      return;
    case "renamed":
      view.renamed(message.ok, message.reason);
      return;
    case "sessions":
      view.sessions(message.items);
      return;
    case "settings":
      view.settings(message.state);
      return;
    case "settingsResult":
      view.settingsResult(message);
      return;
    case "settingsLogin":
      view.settingsLogin(message.event);
      return;
    case "openSettings":
      view.openSettings(message.section, message.firstRun === true);
      return;
    case "agentDetails":
      view.agentDetails(message);
      return;
    case "guardRequest":
      view.guardRequest(message.request, message.elsewhere === true, message.owner);
      return;
    case "guardResolved":
      view.guardResolved(message.id, message.decision, message.by, message.message);
      return;
    case "guardClosed":
      view.guardClosed(message.id);
      return;
    case "guardAnswerFailed":
      view.guardAnswerFailed(message.id, message.error);
      return;
    case "guardStep":
      view.guardStep(message);
      return;
    case "coordination":
      view.coordination(message.lines);
      return;
    case "guardSilent":
      view.guardSilent(message.silent);
      return;
    case "messageActions":
      view.messageActions(message);
      return;
    case "rewindPreview":
      view.rewindPreview(message);
      return;
    case "rewound":
      view.rewound(message);
      return;
    case "draft":
      view.draft(message);
      return;
    case "unwedged":
      view.unwedged(message);
      return;
    case "ladder":
      view.ladder(message);
      return;
    case "reconnecting":
      view.reconnecting(message);
      return;
    case "state":
      tab = message.tab;
      persist();
      view.update(message);
      return;
    case "delta":
      tab = message.tab;
      persist();
      view.delta(message);
      return;
  }
});

vscode.postMessage({ type: "ready" });
