import type { Block } from "../chat/model";
import type { StateDelta, StateMessage } from "./protocol";

/**
 * What changed from `previous` (the last state posted) to `next`, by reference: the reducer keeps an unchanged block's
 * object, so a block is sent only when its object differs. Lists (`models`, `commands`, `thinkingLevels`,
 * `hiddenCommands`) likewise.
 */
export function diffState(previous: StateMessage, next: StateMessage): StateDelta {
  const before = previous.state.blocks;
  const after = next.state.blocks;
  const old = new Map<string, Block>(before.map((block) => [block.id, block]));
  const ids = new Set(after.map((block) => block.id));
  const sameOrder = before.length === after.length && after.every((block, index) => before[index]?.id === block.id);
  const { blocks: _blocks, ...state } = next.state;
  return {
    type: "delta",
    changed: after.filter((block) => old.get(block.id) !== block),
    removed: before.filter((block) => !ids.has(block.id)).map((block) => block.id),
    ...(sameOrder ? {} : { order: after.map((block) => block.id) }),
    state,
    tab: next.tab,
    reconnectable: next.reconnectable,
    ...(next.models !== undefined && next.models !== previous.models ? { models: next.models } : {}),
    ...(next.commands !== undefined && next.commands !== previous.commands ? { commands: next.commands } : {}),
    ...(next.thinkingLevels !== undefined && next.thinkingLevels !== previous.thinkingLevels ? { thinkingLevels: next.thinkingLevels } : {}),
    ...(next.hiddenCommands !== undefined && next.hiddenCommands !== previous.hiddenCommands ? { hiddenCommands: next.hiddenCommands } : {}),
    ...(next.focusView === true ? { focusView: true as const } : {}),
  };
}

/** The webview's side of `diffState`: the full state again, unchanged blocks being the very objects of `base`. */
export function applyDelta(base: StateMessage, delta: StateDelta): StateMessage {
  const byId = new Map<string, Block>(base.state.blocks.map((block) => [block.id, block]));
  for (const id of delta.removed) byId.delete(id);
  for (const block of delta.changed) byId.set(block.id, block);
  const order = delta.order ?? base.state.blocks.map((block) => block.id);
  const blocks = order.map((id) => byId.get(id)).filter((block): block is Block => block !== undefined);
  const models = delta.models ?? base.models;
  const commands = delta.commands ?? base.commands;
  const thinkingLevels = delta.thinkingLevels ?? base.thinkingLevels;
  const hiddenCommands = delta.hiddenCommands ?? base.hiddenCommands;
  return {
    type: "state",
    state: { ...delta.state, blocks },
    tab: delta.tab,
    reconnectable: delta.reconnectable,
    ...(models !== undefined ? { models } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(thinkingLevels !== undefined ? { thinkingLevels } : {}),
    ...(hiddenCommands !== undefined ? { hiddenCommands } : {}),
    ...(delta.focusView === true ? { focusView: true as const } : {}),
  };
}
