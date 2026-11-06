// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { applyFrame, initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";

const STOP_WAIT_MS = 8_000;

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

function show(state: ChatState): void {
  view.update({ type: "state", state, tab: { modelMode: "auto", durableId: "s1" }, reconnectable: true });
}

const composerBox = (): HTMLElement => root.querySelector(".composer-box") as HTMLElement;
const sendButton = (): HTMLButtonElement => root.querySelector('[data-role="send"]') as HTMLButtonElement;
/** The «Стоп» the person can actually reach now: the dock's when the panel is up, the composer's otherwise. */
const stopButton = (): HTMLButtonElement | null => root.querySelector('[data-role="ask-stop"]') ?? root.querySelector('[data-role="stop"]:not([hidden])');
const autoUnwedges = (): WebviewMessage[] => posted.filter((message) => message.type === "unwedge" && message.auto === true);

function life(lifecycle: object): ChatState {
  return applyFrame(initialState(), { type: "session_lifecycle", lifecycle });
}

/** A `question` human wait, with the `ask-user` background wait that marks the non-blocking shape. */
const question = (requestId: string) => ({ kind: "question", requestId, revision: 1 });

/**
 * The states OmO can leave a tab in that the person might call "stuck". For each, the invariant is the same: the tab is
 * never permanently locked — either the composer is already usable, or «Стоп» frees it within the bounded window.
 */
const PARKED: { name: string; state: ChatState; locked: boolean }[] = [
  {
    name: "a turn genuinely running (silent provider)",
    state: { ...initialState(), running: true, activity: "thinking" },
    locked: true,
  },
  {
    name: "a blocking question (waitForAnswer:true)",
    state: {
      ...life({ state: "waiting_human", runId: "r1", waitingOn: { children: 0, background: [], human: [question("r1")] } }),
      dialogs: [{ id: "q", method: "question", title: "Which color?", questions: [{ id: "a", question: "Which color?", options: [{ label: "red" }] }] }],
    },
    locked: true,
  },
  {
    name: "a non-blocking question (waitForAnswer:false)",
    state: {
      ...life({ state: "waiting_human", runId: "r1", waitingOn: { children: 0, background: [{ source: "ask-user", activeCount: 1 }], human: [question("r1")] } }),
      dialogs: [{ id: "q", method: "question", title: "Which color?", blocking: false, questions: [{ id: "a", question: "Which color?", options: [{ label: "red" }] }] }],
    },
    locked: false,
  },
  { name: "a goal OmO stopped (goal_blocked)", state: life({ state: "waiting_human", runId: "r1", waitingOn: { children: 0, background: [], human: [{ kind: "goal_blocked", requestId: "g1", revision: 1 }] } }), locked: false },
  { name: "a stalled run", state: life({ state: "waiting_human", runId: "r1", waitingOn: { children: 0, background: [], human: [{ kind: "stalled", requestId: "s1", revision: 1 }] } }), locked: false },
  {
    name: "a provider refusal after tools",
    state: applyFrame({ ...initialState(), running: true }, {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", rawStopReason: "refusal", errorMessage: "This request triggered cyber-related safeguards." },
    }),
    locked: false,
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  show(initialState());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Stop always frees the tab, from any parked state", () => {
  for (const { name, state, locked } of PARKED) {
    it(`${name}: the tab is never permanently locked`, () => {
      show(state);

      if (!locked) {
        // The turn ended (or never locked us): the composer is on screen and takes a message right now — no Stop needed.
        expect(state.running, name).toBe(false);
        expect(composerBox().hidden, name).toBe(false);
        return;
      }

      // The turn runs: the composer is either hidden behind a modal panel or locked to its queue placeholder. Either way
      // the on-screen «Стоп» must free the tab — abort, and if that does not end it within the bound, the restart fires.
      const stop = stopButton();
      expect(stop, name).not.toBeNull();
      (stop as HTMLButtonElement).click();
      expect(posted.some((message) => message.type === "stop"), name).toBe(true);

      expect(autoUnwedges(), name).toEqual([]);
      vi.advanceTimersByTime(STOP_WAIT_MS);
      expect(autoUnwedges(), `${name}: bounded restart after abort went unanswered`).toEqual([{ type: "unwedge", auto: true }]);
    });
  }
});
