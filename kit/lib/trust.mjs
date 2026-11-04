// OmO 5.1.59 hooks-state.json trust hashes. Byte-compatible with the spike script /tmp/omo-spike/trust-hooks.mjs.
import { createHash } from "node:crypto";

const sha = (value) => createHash("sha256").update(value).digest("hex");

const canon = (value) =>
  Array.isArray(value)
    ? value.map(canon)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canon(value[key])]),
        )
      : value;

export const sourceKeyHash = (scope, sourcePath) => sha([scope, sourcePath, "", ""].join("\x00")).slice(0, 12);

export const hookId = (skh, event, groupIndex, handlerIndex) => `hk_${skh}_${event}_${groupIndex}_${handlerIndex}`;

export function trustedHash({ event, handler, matcher, skh }) {
  const hook = {
    async: false,
    command: handler.command,
    commandWindows: handler.commandWindows,
    platformCommand: handler.command,
    statusMessage: handler.statusMessage,
    timeout: handler.timeout ?? 600,
    type: "command",
  };
  return "sha256:" + sha(JSON.stringify(canon({ event, hook, matcher, sourceKeyHash: skh })));
}

/**
 * Update the hooks-state object for `config` (a parsed hooks.json at `sourcePath`). Trust ids are positional
 * (`hk_<skh>_<event>_<group>_<handler>`), so a hook that moved (another group removed before it) takes its old record
 * to its new id when event, trusted hash and command are exactly the same; a changed command is never carried.
 * Handlers that satisfy `isOwn(command)` are (re-)trusted; records of this source whose id no longer names a hook,
 * whose hook moved, or that were made for another command than the one now at their id are dropped; every other record
 * (another source, a disabled or user-made one for the hook in place) stays, and foreign hooks are never trusted here. Unchanged records are reused, so reruns are byte-stable.
 */
export function buildHooksState(config, sourcePath, previousState = {}, now = new Date().toISOString(), { isOwn = () => true, scope = "global" } = {}) {
  const skh = sourceKeyHash(scope, sourcePath);
  const previous = previousState.hooks ?? {};
  const current = [];
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    (Array.isArray(groups) ? groups : []).forEach((group, groupIndex) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).forEach((handler, handlerIndex) => {
        if (typeof handler?.command !== "string") return;
        const id = hookId(skh, event, groupIndex, handlerIndex);
        current.push({ id, event, handler, own: isOwn(handler.command), hash: trustedHash({ event, handler, matcher: group.matcher, skh }), matcher: group.matcher });
      }),
    );
  }
  const same = (record, hook) => record?.trustedHash === hook.hash && record.commandPreview === hook.handler.command;
  const exact = new Set(current.filter((hook) => same(previous[hook.id], hook)).map((hook) => hook.id));
  // A record not matching its own position may belong to a hook that moved: same event, same hash, same command.
  const claimed = new Map();
  for (const hook of current) {
    if (exact.has(hook.id)) continue;
    const from = Object.keys(previous).find(
      (id) =>
        !exact.has(id) &&
        ![...claimed.values()].includes(id) &&
        id.startsWith(`hk_${skh}_${hook.event}_`) &&
        previous[id]?.sourcePath === sourcePath &&
        same(previous[id], hook),
    );
    if (from !== undefined) claimed.set(hook.id, from);
  }
  const movedAway = new Set(claimed.values());
  const hooks = { ...previous };
  const commandAt = new Map(current.map((hook) => [hook.id, hook.handler.command]));
  for (const [id, record] of Object.entries(previous)) {
    if (record?.sourcePath !== sourcePath || exact.has(id)) continue;
    // gone, moved elsewhere, or made for another command than the one now at its id
    if (!commandAt.has(id) || movedAway.has(id) || record.commandPreview !== commandAt.get(id)) delete hooks[id];
  }
  for (const hook of current) {
    const from = claimed.get(hook.id);
    if (from !== undefined) {
      hooks[hook.id] = previous[from];
      continue;
    }
    if (!hook.own || exact.has(hook.id)) continue;
    const old = movedAway.has(hook.id) ? undefined : previous[hook.id];
    hooks[hook.id] = {
      enabled: old?.enabled !== false,
      trustedHash: hook.hash,
      scope,
      sourcePath,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      commandPreview: hook.handler.command,
      updatedAt: now,
    };
  }
  return { ...previousState, version: 1, hooks };
}
