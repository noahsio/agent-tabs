import fs from "node:fs";
import path from "node:path";
import { ENV_NAMES, resolveEnv } from "../../kit/lib/envs.mjs";
import {
  claudePluginState,
  codegraphState,
  globalInstructionsState,
  isSuperpowersSkillsEntry,
  loadConfig,
  pinnedSuperpowersRef,
  setClaudeSkill,
  setCodegraph,
  setGlobalInstructions,
  setSuperpowers,
  superpowersClaudeDirs,
  superpowersPluginVersion,
  superpowersState,
  superpowersVersion,
  updateClaudePlugin,
  updateSuperpowers,
  validateMcp,
  type ClaudePluginState,
  type SuperpowersMode,
} from "../../kit/lib/tools.mjs";
import { writeOmoFile } from "./files";
import type { EnvPaths } from "./paths";
import { DEFAULT_HIDDEN_COMMANDS } from "./protocol";
import { FieldErrors, type SettingsSectionHost } from "./service";

/** What the view shows instead of an MCP env value whose name says it is a secret; sent back, it keeps the stored one. */
export const MASK = "••••••";
/** MCP env names whose values are secrets. */
const SECRET_NAME = /API_KEY|TOKEN|SECRET/;
/** MCP args whose value is a secret: `--api-key X`, `--token=X` (the flag's last word), `NAME_KEY=X` (an env-like name). */
const SECRET_FLAG = /^--?(?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|key|token|secret|password|passwd)$/i;
const SECRET_ARG_NAME = /KEY|TOKEN|SECRET|PASSWORD/;
const SERVER_NAME = /^[A-Za-z0-9_.-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND_NAME = /^[A-Za-z0-9_:.-]+$/;
const ROLLING = { backup: "rolling" as const };

/** `args` as the view shows them (secret values masked) and the secret values in them. */
function maskArgs(args: string[]): { shown: string[]; secrets: string[] } {
  const shown: string[] = [];
  const secrets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (equals > 0 && equals < arg.length - 1 && (SECRET_FLAG.test(name) || (ENV_NAME.test(name) && SECRET_ARG_NAME.test(name)))) {
      secrets.push(arg.slice(equals + 1));
      shown.push(`${name}=${MASK}`);
      continue;
    }
    shown.push(arg);
    const next = args[index + 1];
    if (equals < 0 && SECRET_FLAG.test(arg) && next !== undefined && !next.startsWith("-")) {
      secrets.push(next);
      shown.push(MASK);
      index += 1;
    }
  }
  return { shown, secrets };
}

/** Where a masked arg sits: `--token=••••••` itself, or the flag before a lone mask. */
const maskSlot = (shown: string[], index: number): string => (shown[index] === MASK ? `${shown[index - 1] ?? ""}\0` : (shown[index] as string));

export type McpServerView = { name: string; command: string; args: string[]; env: Record<string, string> };
export type SkillFolderView = { folder: string; name: string; on: boolean };
/**
 * The superpowers fork: one clone, a `packages` entry of OmO (`mode: "package"`; `"skills"` is the legacy skills-dir
 * connection, to be migrated) and the same clone as a Claude plugin. `folder` is absent when no clone was found; `version` is the plugin's,
 * `sha` and `pinned` short shas; `claude` says per Claude environment whether the plugin is enabled there.
 */
export type SuperpowersView = {
  mode: SuperpowersMode;
  folder?: string;
  version?: string;
  sha?: string;
  pinned: string;
  skills: number;
  claude: { dir: string; label: string; plugin: ClaudePluginState }[];
};
export type ToolsView = {
  codegraph: { on: boolean };
  superpowers: SuperpowersView;
  /**
   * The Claude skills of this environment: folders of `<claudeDir>/skills` with a SKILL.md at their top. Each is on unless
   * switched off (`-<folder>` in settings.json): OmO loads every one, as Claude Code does (the kit's skills extension).
   */
  skills: SkillFolderView[];
  /** Other entries of OmO's `skills` list (not this environment's Claude skills, not superpowers): shown, not switched. */
  otherSkills: { path: string; exists: boolean }[];
  mcp: McpServerView[];
  /** Hidden «/» commands, names without «/». */
  hidden: string[];
  /** `<claudeDir>/CLAUDE.md` for OmO; `always` for the system Claude dir (OmO loads it itself). */
  instructions: { on: boolean; path: string; exists: boolean; always?: true };
};

export type ToolsAction =
  | { kind: "codegraph.set"; on: boolean }
  | { kind: "skills.set"; folder: string; on: boolean }
  | { kind: "superpowers.set"; on: boolean }
  | { kind: "superpowers.update" }
  | { kind: "mcp.save"; name: string; command: string; args: string[]; env: Record<string, string> }
  | { kind: "mcp.remove"; name: string }
  | { kind: "hidden.set"; commands: string[] }
  | { kind: "instructions.set"; on: boolean }
  | { kind: "instructions.open" };

export interface ToolsDeps {
  paths: EnvPaths;
  /** Joins the live redaction set: secret MCP values (stored or typed) go here before anything can log or post them. */
  addSecret: (value: string) => void;
  /** Opens a file in the editor. */
  openFile: (file: string) => Promise<void>;
  /** The hidden «/» list changed: every tab's next state carries it. */
  hiddenChanged: (list: string[]) => void;
  log: (text: string) => void;
  /** How long one git call of «обновить» may take; 60 s by default. */
  gitTimeoutMs?: number;
}

type KitEnv = ReturnType<typeof resolveEnv>;

const NOT_INSTALLED = "superpowers не установлен — запустите kit/setup-omo.mjs";
const NOT_PARSEABLE = (file: string): string => `Файл ${file} не разобрать; он не изменён — исправьте его вручную`;
const ALWAYS_ON = "OmO всегда загружает ~/.claude/CLAUDE.md — выключить его можно только вместе со всеми правилами (PI_RULES_DISABLED=1)";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const uiJson = (paths: EnvPaths): string => path.join(paths.pluginDir, "ui.json");

function readUi(paths: EnvPaths): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(uiJson(paths), "utf8"));
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

/** The hidden «/» commands of this environment: `<agentDir>/agent-tabs/ui.json` `hiddenCommands`, else the built-in list. */
export function readHiddenCommands(paths: EnvPaths): string[] {
  const list = readUi(paths)["hiddenCommands"];
  return isStringList(list) ? list : [...DEFAULT_HIDDEN_COMMANDS];
}

/** The kit's view of this window's environment: its paths, and its CodeGraph binary when it is a kit environment. */
function kitEnv(paths: EnvPaths): KitEnv {
  const known = ENV_NAMES.find((name) => resolveEnv(name, paths.home).agentDir === paths.agentDir);
  return {
    name: known ?? "custom",
    home: paths.home,
    agentDir: paths.agentDir,
    memoryHome: paths.memoryHome,
    claudeDir: paths.claudeDir,
    codegraph: known === undefined ? null : resolveEnv(known, paths.home).codegraph,
  };
}

/** The kit's errors, in the modal's words; anything else goes to the log as it is. */
function translated(error: unknown, paths: EnvPaths): never {
  const message = errorText(error);
  if ((error as { code?: unknown }).code === "AGENTS_MD_NOT_A_LINK") {
    throw new FieldErrors(`${path.join(paths.agentDir, "AGENTS.md")} — ваш собственный файл (или ссылка на другой файл); он не изменён. Переименуйте его, чтобы включить`, []);
  }
  const cannotUse = /^cannot use (.+?): /.exec(message);
  if (cannotUse !== null) throw new FieldErrors(NOT_PARSEABLE(path.basename(cannotUse[1] as string)), []);
  if (message.startsWith("the kit is not installed")) throw new FieldErrors("Комплект не установлен — запустите kit/setup-omo.mjs", []);
  if (message.startsWith("codegraph not found")) throw new FieldErrors("CodeGraph не найден в PATH — установите его", []);
  if (message.startsWith("node not found")) throw new FieldErrors("Node.js не найден в PATH — нужен хуку CodeGraph", []);
  throw error;
}

/** `file` with the home dir as `~`. */
const tildify = (file: string, home: string): string => (file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);

/** The skill folders of `dir`: its folders (or links to one) with a SKILL.md at their top. */
const skillFoldersOf = (dir: string): string[] => childFolders(dir).filter((folder) => fs.existsSync(path.join(folder, "SKILL.md")));

function childFolders(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(path.join(dir, entry.name)).isDirectory()))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * «Инструменты» on the host: CodeGraph, skills and the superpowers fork, MCP servers, the hidden «/» commands and
 * the global instructions. Every OmO file goes through the kit (`kit/lib/tools.mjs`) or `writeOmoFile`, with one
 * rolling backup; secret MCP values never leave the host.
 */
export class ToolsHost implements SettingsSectionHost<ToolsAction> {
  readonly section = "tools" as const;

  constructor(private readonly deps: ToolsDeps) {}

  parse(raw: Record<string, unknown>): ToolsAction | undefined {
    switch (raw["kind"]) {
      case "codegraph.set":
      case "instructions.set":
      case "superpowers.set":
        return typeof raw["on"] === "boolean" ? { kind: raw["kind"], on: raw["on"] } : undefined;
      case "skills.set":
        return typeof raw["folder"] === "string" && raw["folder"] !== "" && typeof raw["on"] === "boolean"
          ? { kind: "skills.set", folder: raw["folder"], on: raw["on"] }
          : undefined;
      case "superpowers.update":
      case "instructions.open":
        return { kind: raw["kind"] };
      case "mcp.remove":
        return typeof raw["name"] === "string" && SERVER_NAME.test(raw["name"]) ? { kind: "mcp.remove", name: raw["name"] } : undefined;
      case "mcp.save":
        return this.parseServer(raw);
      case "hidden.set": {
        const commands = raw["commands"];
        if (!isStringList(commands)) return undefined;
        const names = [...new Set(commands.map((item) => item.trim().replace(/^\//, "")).filter((item) => item !== ""))];
        return names.every((name) => COMMAND_NAME.test(name)) ? { kind: "hidden.set", commands: names } : undefined;
      }
      default:
        return undefined;
    }
  }

  async view(): Promise<ToolsView> {
    const env = kitEnv(this.deps.paths);
    const enabledSkills = this.enabledSkills();
    const ownSkills = skillFoldersOf(path.join(this.deps.paths.claudeDir, "skills"));
    const offSkills = ownSkills.filter((item) => enabledSkills.includes(`-${item}`));
    const instructions = this.guard(() => globalInstructionsState(env));
    return {
      codegraph: this.guard(() => codegraphState(env)),
      superpowers: await this.superpowers(env),
      skills: ownSkills.map((item) => ({ folder: item, name: path.basename(item), on: !offSkills.includes(item) })),
      otherSkills: enabledSkills
        .filter((item) => !ownSkills.includes(item) && !offSkills.some((off) => item === `-${off}`) && !isSuperpowersSkillsEntry(item, env))
        .map((item) => ({ path: item, exists: fs.existsSync(item) })),
      mcp: this.servers(),
      hidden: readHiddenCommands(this.deps.paths),
      instructions: { on: instructions.on, path: instructions.path, exists: instructions.exists, ...(instructions.always === true ? { always: true as const } : {}) },
    };
  }

  private async superpowers(env: KitEnv): Promise<SuperpowersView> {
    const state = this.guard(() => superpowersState(env));
    const claude = superpowersClaudeDirs(env.home, env.claudeDir).map((dir) => ({ dir, label: tildify(dir, env.home), plugin: claudePluginState(dir) }));
    const base = { mode: state.mode, pinned: pinnedSuperpowersRef().slice(0, 7), claude };
    if (state.dir === null) return { ...base, skills: 0 };
    const sha = await superpowersVersion(state.dir).catch((error: unknown) => {
      this.deps.log(`Версия superpowers не прочитана: ${errorText(error)}`);
      return undefined;
    });
    const version = superpowersPluginVersion(state.dir);
    return {
      ...base,
      folder: state.dir,
      ...(version !== undefined ? { version } : {}),
      ...(sha !== undefined ? { sha } : {}),
      skills: skillFoldersOf(path.join(state.dir, "skills")).length,
    };
  }

  async perform(action: ToolsAction): Promise<void> {
    const { paths } = this.deps;
    const env = kitEnv(paths);
    switch (action.kind) {
      case "codegraph.set":
        this.guard(() => setCodegraph(env, action.on, ROLLING));
        return;
      case "skills.set":
        if (!skillFoldersOf(path.join(paths.claudeDir, "skills")).includes(action.folder)) throw new FieldErrors("Такой папки навыков нет — откройте настройки заново", []);
        this.guard(() => setClaudeSkill(env, action.folder, action.on, ROLLING));
        return;
      case "superpowers.set": {
        const dir = this.guard(() => superpowersState(env)).dir;
        if (dir === null) throw new FieldErrors(NOT_INSTALLED, []);
        this.guard(() => setSuperpowers(env, dir, action.on, ROLLING));
        return;
      }
      case "superpowers.update":
        await this.updateSuperpowers(env);
        return;
      case "mcp.save":
        this.saveServer(action);
        return;
      case "mcp.remove": {
        const config = this.mcpConfig();
        const servers = isObject(config["mcpServers"]) ? { ...config["mcpServers"] } : {};
        if (!(action.name in servers)) return;
        delete servers[action.name];
        writeOmoFile(paths.mcpJson, JSON.stringify({ ...config, mcpServers: servers }, null, 2) + "\n", ROLLING);
        return;
      }
      case "hidden.set":
        writeOmoFile(uiJson(paths), JSON.stringify({ ...readUi(paths), hiddenCommands: action.commands }, null, 2) + "\n", ROLLING);
        this.deps.hiddenChanged(action.commands);
        return;
      case "instructions.set":
        if (!action.on && globalInstructionsState(env).always === true) throw new FieldErrors(ALWAYS_ON, []);
        this.guard(() => setGlobalInstructions(env, action.on));
        return;
      case "instructions.open":
        await this.deps.openFile(globalInstructionsState(env).path);
        return;
    }
  }

  private guard<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      return translated(error, this.deps.paths);
    }
  }

  private settings(): Record<string, unknown> {
    return this.guard(() => loadConfig(path.join(this.deps.paths.agentDir, "settings.json"), undefined, this.deps.log));
  }

  private enabledSkills(): string[] {
    const skills = this.settings()["skills"];
    return isStringList(skills) ? skills : [];
  }

  /** «обновить»: the clone to the pinned ref, then the Claude plugin in every Claude environment that has it installed. */
  private async updateSuperpowers(env: KitEnv): Promise<void> {
    const dir = this.guard(() => superpowersState(env)).dir;
    if (dir === null || (await superpowersVersion(dir).catch(() => undefined)) === undefined) throw new FieldErrors(NOT_INSTALLED, []);
    let version: string;
    try {
      version = await updateSuperpowers(dir, undefined, this.deps.gitTimeoutMs !== undefined ? { timeoutMs: this.deps.gitTimeoutMs } : {});
      this.deps.log(`superpowers обновлён до ${version}`);
    } catch (error) {
      this.deps.log(`superpowers не обновлён: ${errorText(error)}`);
      const timeout = error as { code?: unknown; timeoutMs?: unknown };
      if (timeout.code === "GIT_TIMEOUT" && typeof timeout.timeoutMs === "number") {
        throw new FieldErrors(`Не удалось обновить superpowers: git не ответил за ${Math.round(timeout.timeoutMs / 1000)} с — проверьте сеть`, []);
      }
      throw new FieldErrors("Не удалось обновить superpowers — подробности в канале «Agent Tabs»", []);
    }
    const failed: string[] = [];
    for (const result of await updateClaudePlugin(superpowersClaudeDirs(env.home, env.claudeDir), env.home)) {
      const label = tildify(result.claudeDir, env.home);
      if (result.outcome === "updated") this.deps.log(`Claude-плагин superpowers обновлён в ${label}`);
      else if (result.outcome === "skipped") this.deps.log(`claude не найден в PATH — Claude-плагин superpowers в ${label} не обновлён`);
      else {
        this.deps.log(`Claude-плагин superpowers в ${label} не обновлён: ${result.detail ?? ""}`);
        failed.push(label);
      }
    }
    if (failed.length > 0) throw new FieldErrors(`superpowers обновлён до ${version}, но Claude-плагин не обновлён в ${failed.join(", ")} — подробности в канале «Agent Tabs»`, []);
  }

  private mcpConfig(): Record<string, unknown> {
    return this.guard(() => loadConfig(this.deps.paths.mcpJson, validateMcp, this.deps.log));
  }

  private servers(): McpServerView[] {
    const servers = this.mcpConfig()["mcpServers"];
    if (!isObject(servers)) return [];
    return Object.entries(servers).map(([name, server]) => {
      const entry = isObject(server) ? server : {};
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(isObject(entry["env"]) ? entry["env"] : {})) {
        const text = String(value);
        if (SECRET_NAME.test(key)) this.deps.addSecret(text);
        env[key] = SECRET_NAME.test(key) ? MASK : text;
      }
      const args = maskArgs(isStringList(entry["args"]) ? entry["args"] : []);
      for (const secret of args.secrets) this.deps.addSecret(secret);
      return {
        name,
        command: typeof entry["command"] === "string" ? entry["command"] : "",
        args: args.shown,
        env,
      };
    });
  }

  private parseServer(raw: Record<string, unknown>): ToolsAction | undefined {
    const { name, command, args, env } = raw;
    if (typeof name !== "string" || !SERVER_NAME.test(name)) return undefined;
    if (typeof command !== "string" || command.trim() === "" || !isStringList(args) || !isObject(env)) return undefined;
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_NAME.test(key) || typeof value !== "string") return undefined;
      if (SECRET_NAME.test(key) && value !== MASK) this.deps.addSecret(value); // before anything can log or post it
      vars[key] = value;
    }
    for (const secret of maskArgs(args).secrets) if (!secret.includes(MASK)) this.deps.addSecret(secret); // typed ones, before any log
    return { kind: "mcp.save", name, command: command.trim(), args, env: vars };
  }

  /** Other fields of the server (type, timeout, …) stay; a masked value keeps the stored one. */
  private saveServer(action: Extract<ToolsAction, { kind: "mcp.save" }>): void {
    const config = this.mcpConfig();
    const servers = isObject(config["mcpServers"]) ? config["mcpServers"] : {};
    const existing = isObject(servers[action.name]) ? (servers[action.name] as Record<string, unknown>) : {};
    const stored = isObject(existing["env"]) ? existing["env"] : {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(action.env)) {
      if (value !== MASK) env[key] = value;
      else if (typeof stored[key] === "string") env[key] = stored[key];
      else throw new FieldErrors(`Введите значение ${key}`, [{ field: `env.${key}`, message: "Введите значение" }]);
    }
    const storedArgs = isStringList(existing["args"]) ? existing["args"] : [];
    const storedShown = maskArgs(storedArgs).shown;
    const kept = new Map(storedShown.flatMap((arg, index) => (arg.includes(MASK) ? [[maskSlot(storedShown, index), storedArgs[index] as string] as const] : [])));
    const args = action.args.map((arg, index) => {
      if (!arg.includes(MASK)) return arg;
      const stored = kept.get(maskSlot(action.args, index));
      if (stored === undefined) throw new FieldErrors(`Введите значение аргумента ${index + 1}`, [{ field: "args", message: "Введите значение" }]);
      return stored;
    });
    const { env: _old, ...rest } = existing;
    const server = { ...rest, command: action.command, args, ...(Object.keys(env).length > 0 ? { env } : {}) };
    const next = { ...config, mcpServers: { ...servers, [action.name]: server } };
    writeOmoFile(this.deps.paths.mcpJson, JSON.stringify(next, null, 2) + "\n", { ...ROLLING, mode: 0o600 });
  }
}
