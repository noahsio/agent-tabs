/** The settings modal's sections, in the order the modal lists them. */
export const SETTINGS_SECTIONS = ["connections", "models", "security", "tools", "environment"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** A field the host refused, with the line for multi-line fields (rules). */
export type FieldError = { field: string; line?: number; message: string };

/**
 * What the modal shows: this window's environment and each registered section's own view; `failed` names the
 * sections whose view could not be read (their slot is absent). Without an environment there is only the reason.
 */
export type SettingsState = SettingsView | { unavailable: string };

export type SettingsView = { env: { name: string; agentDir: string }; failed?: Partial<Record<SettingsSection, string>> } & Partial<Record<SettingsSection, unknown>>;

/** The one reason shown while the window has no OmO environment. */
export const SETTINGS_UNAVAILABLE = "Настройки недоступны: среда OmO не задана (agentTabs.environmentVariables)";

/** `notice`: what an accepted action wants the person to know (e.g. how many lines an import took). */
export type SettingsResult = { ok: true; notice?: string } | { ok: false; error: string; errors?: FieldError[] };

export function isSettingsSection(value: unknown): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly unknown[]).includes(value);
}

/** The power levels of a role (the `reasoning` of omo.jsonc). */
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];
/** Every level OmO knows for a model pin's `:<level>` suffix; the grid offers only `REASONING_LEVELS` but shows any of these. */
export const KNOWN_LEVELS = ["off", "minimal", ...REASONING_LEVELS, "max"] as const;

/**
 * The «/» menu's hidden OmO commands until the person edits the list («Инструменты», `<agentDir>/agent-tabs/ui.json`):
 * TUI-only, or covered elsewhere in Agent Tabs (the model popover sets reasoning). get_commands names without «/».
 */
export const DEFAULT_HIDDEN_COMMANDS: readonly string[] = [
  "tui",
  "keybindings",
  "help",
  "hooks",
  "history",
  "fast",
  "websearch",
  "ttsr",
  "nested-agents",
  "rules",
  "reload-rules",
  "ir",
  "lookat",
  "fallback",
  "reasoning",
  "efforts",
];
