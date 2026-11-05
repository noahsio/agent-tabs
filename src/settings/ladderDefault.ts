import { LADDER_VERSION, type Ladder } from "./ladderShape";

/**
 * The ladder a fresh environment starts with — the spec's own table, verbatim.
 *
 * This is the one file in the plugin that names model ids, and `test/settings/noModelList.test.ts` excludes exactly
 * it. The rule that test guards is about catalogues: the models a picker offers always come from the gateway's own
 * `/v1/models` or from OmO's `get_available_models`, never from a list shipped here. This is not a catalogue. It is
 * the first value of one editable, per-environment preference, written to `<agentDir>/agent-tabs/ladder.json` and the
 * person's from then on; a rung whose model the environment does not serve is skipped at walk time with a line in the
 * feed, so a stale id here costs a skipped step, never a broken picker.
 *
 * A refusal jumps straight to the fourth rung: the cyber ban in the person's journal came from `claude-opus-4-8` *and*
 * from `claude-opus-5-5`, so it is the provider's and not the model's, and a descent inside Anthropic would buy three
 * identical refusals in a row. Whoever wants the full descent on a refusal too ticks «отказ» on rungs 2 and 3.
 *
 * A provider **rejection** («отклонение») descends the whole ladder instead. It is one model's answer about one
 * request — the live case came from `gw-openai/gpt-6-astra` — and says nothing about the next model, so there is no
 * reason to skip the two Anthropic steps the way a provider-wide classifier ban does.
 */
export const DEFAULT_LADDER: Ladder = {
  version: LADDER_VERSION,
  rungs: [
    // The top: the model a session starts on. It answers nothing — there is nothing above it to fall back from.
    { id: "opus-5-5", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5-5" }, on: [] },
    { id: "opus-5", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5" }, on: ["rejected", "empty", "silence", "transport"] },
    { id: "opus-4-8", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-4-8" }, on: ["rejected", "empty", "silence", "transport"] },
    { id: "gpt-6-1-sol", action: { kind: "model", provider: "gw-openai", id: "gpt-6.1-sol" }, on: ["refusal", "rejected", "empty", "silence", "transport"] },
    { id: "ask", action: { kind: "ask" }, on: ["refusal", "rejected", "empty", "silence", "transport"] },
  ],
};
