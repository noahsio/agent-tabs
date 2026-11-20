import { describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { onTabClosed, stillWorking, type TabCloseDeps } from "../../src/panel/tabClose";

function session(state: Pick<ChatState, "running" | "background">, closed = true) {
  const calls: string[] = [];
  return {
    calls,
    controller: {
      state: { blocks: [], dialogs: [], agents: [], ...state } as ChatState,
      close: async () => {
        calls.push("close");
        return closed;
      },
      release: async () => {
        calls.push("release");
      },
    },
  };
}

function deps(over: Partial<TabCloseDeps> = {}): TabCloseDeps & { asked: string[] } {
  const asked: string[] = [];
  return { delayMs: 0, shuttingDown: () => false, ask: async (question) => (asked.push(question), true), asked, ...over };
}

describe("onTabClosed", () => {
  it("closes_an_idle_session_without_asking", async () => {
    const { controller, calls } = session({ running: false });
    const d = deps();
    await onTabClosed(controller, "Тема", d);
    expect(calls).toEqual(["close"]);
    expect(d.asked).toEqual([]);
  });

  it("asks_while_a_turn_or_background_work_runs_and_closes_only_on_yes", async () => {
    const busy = { running: true, background: { count: 2, sources: ["terminal-monitors"] } };
    const yes = session(busy);
    const asking = deps();
    await onTabClosed(yes.controller, "Тема", asking);
    expect(asking.asked[0]).toContain("ход агента, фоновых процессов: 2");
    expect(yes.calls).toEqual(["close"]);

    const no = session(busy);
    await onTabClosed(no.controller, "Тема", deps({ ask: async () => false }));
    expect(no.calls).toEqual(["release"]);
  });

  it("only_lets_go_when_the_extension_shuts_down_meanwhile", async () => {
    const { controller, calls } = session({ running: false });
    await onTabClosed(controller, "Тема", deps({ shuttingDown: () => true }));
    expect(calls).toEqual(["release"]);
  });
});

describe("stillWorking", () => {
  it("names_what_still_runs", () => {
    expect(stillWorking({ running: false })).toBeUndefined();
    expect(stillWorking({ running: false, background: { count: 4, sources: [] } })).toBe("фоновых процессов: 4");
  });
});
