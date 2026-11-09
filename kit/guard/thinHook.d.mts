export type HookOptions = {
  agentDir: string;
  home?: string;
  connectTimeoutMs?: number;
  budgetMs?: number;
};
export type HookOutput = {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};
export function runThinHook(
  rawInput: { hook_event_name: "SessionStart"; session_id: string; cwd: string; source: string },
  options: HookOptions,
): Promise<{ hookSpecificOutput: { hookEventName: string; additionalContext: string; permissionDecision?: undefined } }>;
export function runThinHook(rawInput: unknown, options: HookOptions): Promise<HookOutput>;
export function hookMain(argv: string[]): Promise<HookOutput>;
