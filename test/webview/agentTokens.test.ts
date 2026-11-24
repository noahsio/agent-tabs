import { describe, expect, it } from "vitest";
import type { AgentRow } from "../../src/chat/model";
import { tokensText, tokensTooltip } from "../../webview/agentMap";

const agent = (over: Partial<AgentRow>): AgentRow => ({ id: "a", label: "a", status: "done", ...over });

describe("agent token texts", () => {
  it("say_millions_as_millions", () => {
    expect(tokensText(850)).toBe("850 токенов");
    expect(tokensText(289_656)).toBe("289,7 тыс. токенов");
    expect(tokensText(59_565_310)).toBe("59,6 млн токенов");
  });

  it("explain_omos_total_in_the_tooltip", () => {
    expect(tokensTooltip(agent({ tokens: 59_565_310, turns: 205, contextTokens: 289_656, outputTokens: 185_795 }))).toBe(
      "205 вызовов модели; в среднем 289,7 тыс. токенов в контексте на вызов; написано 185,8 тыс. токенов; всего прочитано 59,6 млн токенов: каждый вызов заново читает весь контекст",
    );
    expect(tokensTooltip(agent({ tokens: 1500 }))).toBeUndefined();
  });
});
