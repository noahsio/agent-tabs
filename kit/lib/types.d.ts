// Types of the kit library functions the extension imports; esbuild bundles the .mjs files themselves.

declare module "*/kit/lib/files.mjs" {
  export type WriteOutcome = "unchanged" | "created" | "updated";
  export function writeIfChanged(file: string, content: string, options?: { mode?: number; dryRun?: boolean; now?: Date; backup?: "timestamped" | "rolling" }): WriteOutcome;
}

declare module "*/kit/lib/hooks.mjs" {
  type WriteOutcome = "unchanged" | "created" | "updated";
  export function writeHooksJson(
    agentDir: string,
    config: unknown,
    options: { isOwn: (command: string) => boolean; now?: Date; dryRun?: boolean; backup?: "timestamped" | "rolling" },
  ): { hooks: WriteOutcome; state: WriteOutcome };
}

declare module "*/kit/lib/envs.mjs" {
  export const ENV_NAMES: string[];
  export function resolveEnv(
    name: string,
    home: string,
  ): { name: string; home: string; agentDir: string; memoryHome: string; claudeDir: string; codegraph: string | null };
}

declare module "*/kit/lib/jsonc.mjs" {
  export function parseJsonc(text: string): unknown;
  /** Sets one value, keeping everything else byte for byte; throws when the structure is unexpected. */
  export function setJsoncPath(text: string, pathKeys: string[], value: unknown): string;
}

declare module "*/kit/lib/tools.mjs" {
  type KitEnv = { name: string; home: string; agentDir: string; memoryHome: string; claudeDir: string; codegraph: string | null };
  export const SUPERPOWERS_REF: string;
  /** The pinned ref, unless OMO_KIT_SUPERPOWERS_REF overrides it. */
  export function pinnedSuperpowersRef(): string;
  export const CURATED_SKILLS: string[];
  export function loadConfig(file: string, validate?: (value: Record<string, unknown>) => void, warn?: (message: string) => void): Record<string, unknown>;
  export function validateMcp(value: Record<string, unknown>): void;
  export function setCodegraph(
    envInfo: KitEnv,
    on: boolean,
    options?: { dryRun?: boolean; now?: Date; backup?: "timestamped" | "rolling"; codegraph?: string; hooksDir?: string },
  ): string[];
  export function codegraphState(envInfo: KitEnv): { on: boolean };
  export function globalInstructionsState(envInfo: KitEnv): { on: boolean; path: string; exists: boolean; always?: true };
  /** Throws an error with `code: "AGENTS_MD_NOT_A_LINK"` when `<agentDir>/AGENTS.md` is the person's own file. */
  export function setGlobalInstructions(envInfo: KitEnv, on: boolean, options?: { dryRun?: boolean }): string[];
  export function setSettingsEntry(
    envInfo: KitEnv,
    list: "skills" | "packages",
    entry: string,
    on: boolean,
    options?: { backup?: "timestamped" | "rolling"; now?: Date },
  ): string[];
  export function findOnPath(name: string): string | null;
  export const SUPERPOWERS_MARKETPLACE: string;
  export const SUPERPOWERS_PLUGIN: string;
  export function defaultSuperpowersDir(home: string): string;
  export function isSuperpowersClone(dir: string): boolean;
  export function isSuperpowersSkillsEntry(entry: unknown, envInfo: KitEnv): boolean;
  export type SuperpowersMode = "skills" | "package" | "off";
  export function superpowersState(envInfo: KitEnv): { mode: SuperpowersMode; dir: string | null };
  export function withSuperpowers(settings: Record<string, unknown>, dir: string, on: boolean, envInfo: KitEnv): Record<string, unknown>;
  export function setSuperpowers(envInfo: KitEnv, dir: string, on: boolean, options?: { backup?: "timestamped" | "rolling"; now?: Date }): string[];
  export function superpowersPluginVersion(dir: string): string | undefined;
  export type ClaudePluginState = "on" | "off" | "absent";
  export function claudePluginState(claudeDir: string): ClaudePluginState;
  export function superpowersClaudeDirs(home: string, current: string): string[];
  export function superpowersVersion(dir: string): Promise<string | undefined>;
  /** Rejects with `{ code: "GIT_TIMEOUT", timeoutMs }` when a git call outlives `timeoutMs` (60 s by default). */
  export function updateSuperpowers(dir: string, ref?: string, options?: { timeoutMs?: number }): Promise<string>;
  export function claudePluginInstallCommands(dir: string, claudeDir: string, home: string): string[];
  export type ClaudePluginUpdate = { claudeDir: string; outcome: "updated" | "failed" | "skipped"; detail?: string };
  export function updateClaudePlugin(claudeDirs: string[], home: string, options?: { timeoutMs?: number }): Promise<ClaudePluginUpdate[]>;
}

declare module "*/kit/sandbox/profile.mjs" {
  /** A VS Code install: the .app bundle (when known), user-data dir, the profile's settings.json, extensions dir. */
  export type VscodeInstall = { appRoot?: string; userDataDir: string; userSettings?: string; extensionsDir: string };
  export function profilePath(agentDir: string): string;
  export function hostSocketPath(agentDir: string): string;
  export function hostPidPath(agentDir: string): string;
  export function protectedHostSocketPath(agentDir: string): string;
  export function protectedHostPidPath(agentDir: string): string;
  export function lspDaemonDir(agentDir: string): string;
  /** What OmO loads as skills, extensions or packages (and the superpowers clone, whole): closed to agents. */
  export function loadedResourceDenies(home: string, agentDirs: string[]): string[];
  export function knownVscodeInstalls(home: string): VscodeInstall[];
  export function realOf(file: string): string;
  export function sourcedFiles(home: string): string[];
  export function buildProfile(spec: {
    home: string;
    agentDir: string;
    envs?: { agentDir: string; claudeDir: string }[];
    vscodes?: VscodeInstall[];
    writableDirs?: string[];
  }): string;
}

declare module "*/kit/guard/lifecycle.mjs" {
  type Paths = { agentDir: string; home: string };
  type Group = { hooks: { type: string; command: string; timeout?: number }[] };
  /** Copies `source` (kit/guard) to ~/.omo/kit/<hash>/guard; returns that dir. */
  export function installGuardFiles(home: string, source: string): string;
  /** Where installGuardFiles puts `source`; writes nothing. */
  export function guardFilesDir(home: string, source: string): string;
  /** Every kit guard handler in hooks.json; throws when hooks.json cannot be used. */
  export function guardHandlers(paths: Paths): { event: string; command: string; timeout?: number }[];
  export function guardHookEntry(spec: { node: string; kitDir: string; agentDir: string }): Group;
  /** Adds or removes our group under PreToolUse and SessionStart; returns the files written. */
  export function setGuardHook(paths: Paths, on: boolean, entry: Group): string[];
  /** Events whose groups hold a kit guard handler; throws when hooks.json cannot be used. */
  export function guardHookEvents(paths: Paths): string[];
  export function servicePaths(agentDir: string): { dir: string; hookSock: string; adminSock: string; lock: string; rules: string; cache: string };
  export function socketAlive(file: string): Promise<boolean>;
  /** The rules.json text to write before the service starts, or undefined to keep the file as it is. */
  export function rulesToWrite(rulesFile: string, source: string): string | undefined;
}

declare module "*/kit/guard/sockets.mjs" {
  import type { Socket } from "node:net";
  export function servicePaths(agentDir: string): { dir: string; hookSock: string; adminSock: string; lock: string; rules: string; cache: string };
  export function writeLine(socket: Socket, value: unknown): void;
  /** Calls `onMessage` with every parsed line (undefined: not JSON). */
  export function readLines(socket: Socket, onMessage: (message: unknown) => void): void;
  /** One request, the first reply line; rejects when the socket is absent, closes without a reply or times out. */
  export function request(file: string, message: unknown, timeoutMs?: number): Promise<unknown>;
  /** True while a decision service may own rules.json: a socket answers or its lock is fresh (starting). */
  export function serviceMayRun(agentDir: string): Promise<boolean>;
  /** The most bytes a unix socket path may hold (macOS); a longer one cannot be bound at all. */
  export const MAX_SOCKET_PATH: number;
}

declare module "*/kit/guard/rules.mjs" {
  export const GROUP_IDS: string[];
  export const DECIDER_MODES: string[];
  export const WAIT_SECONDS: number[];
  /** Every problem of a v2 rules object; [] when valid. */
  export function validateRules(rules: unknown): { field: string; line?: number; message: string }[];
  /** True for a user-added «always allow» (whitelist) entry, not a built-in one. */
  export function isUserAllow(entry: unknown): boolean;
  /** A v2 `allow` whitelist entry for `scope` (a glob over the normalized command). */
  export function makeWhitelistEntry(options: { scope: string; session?: string; now?: () => number; id?: string }): {
    id: string;
    label: string;
    pattern: string;
    denyIf: string[];
    user: true;
    scope: string;
    addedAt: string;
    session?: string;
  };
  export const WHITELIST_ID_PREFIX: string;
  export function globPattern(glob: string): string;
}

declare module "*/kit/guard/rulesText.mjs" {
  type LineError = { line: number; message: string };
  export function parseLines(text: string, kind: "glob"): { values: string[]; errors: LineError[] };
  export function parseLines(text: string, kind: "ip"): { values: { cidr: string; note?: string }[]; errors: LineError[] };
  export function formatIpLines(entries: { cidr: string; note?: string }[]): string;
  export function importClaudeDeny(settingsJson: unknown): { lines: string[]; skipped: number };
}

declare module "*/kit/guard/telegram.mjs" {
  type TelegramConfig = { token: string; chatId: string; userId?: string };
  /** The supervisor's tg.env (~/.claude/skills/supervisor/tg.env). */
  export const DEFAULT_TG_ENV: string;
  /** `<agentDir>/keys/telegram.key`. */
  export function telegramKeyFile(agentDir: string): string;
  /** The key file's token with the rules' chat; without a key file, tg.env; null when incomplete. */
  export function resolveTelegramConfig(options: { keyFile: string; tgEnvPath: string; human: { telegramChat?: string; telegramUser?: string } }): TelegramConfig | null;
  export function loadTelegramConfig(file?: string): TelegramConfig | null;
  /** The most recent private chat that wrote to the bot, from a getUpdates result. */
  export function latestPrivateChat(updates: unknown): { chatId: string; userId: string } | undefined;
  /** POSTs a Bot API method (≤ 10 s); a thrown error comes back as `{ ok: false, error: <its name> }`. */
  export function httpTransport(
    token: string,
    fetchFn?: (url: string, init?: RequestInit) => Promise<Response>,
  ): (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown> | undefined>;
}
