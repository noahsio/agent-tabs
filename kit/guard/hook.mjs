#!/usr/bin/env node
// Entry of the guard's hook (PreToolUse; SessionStart gets the sandbox note): node hook.mjs --agent-dir <dir>.
// stdin JSON -> one JSON line on stdout, always exit 0 (never 2). It fails closed: the logic (thinHook.mjs and its
// modules) is loaded inside the try, so a missing or broken module, an exception or a rejected promise anywhere prints
// a deny instead of leaving OmO with no decision.
let printed = false;

function print(result) {
  if (printed) return;
  printed = true;
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

function failClosed(error) {
  const reason = `[guard] ошибка хука защиты: ${String(error?.message ?? error).slice(0, 300)}`;
  print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);

try {
  const { hookMain } = await import("./thinHook.mjs");
  print(await hookMain(process.argv.slice(2)));
} catch (error) {
  failClosed(error);
}
