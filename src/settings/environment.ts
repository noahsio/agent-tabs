import path from "node:path";
import type { EnvVar } from "../env";
import type { EnvPaths } from "./paths";
import { readQuestionTimeout, writeQuestionTimeout } from "./questionTimeout";
import { FieldErrors, type SettingsSectionHost } from "./service";

export type Folder = "agentDir" | "memoryHome" | "claudeDir";

export type EnvironmentView = {
  /** As the VS Code setting holds them (`~` kept), else the folder the window uses. */
  folders: Record<Folder, string>;
  omoVersion?: string;
  /** Why the version is unknown (OmO did not answer in time). */
  omoUnavailable?: string;
  /** The setting names other folders than the running OmO uses. */
  restartNeeded: boolean;
  restartHint: string;
  /** Minutes OmO waits on an unanswered question before the agent goes on by itself (`askUser.timeoutMinutes`). */
  questionTimeoutMinutes: number;
};

export type EnvironmentAction =
  | { kind: "folder.set"; which: Folder; path: string }
  | { kind: "restart" }
  | { kind: "questionTimeout.set"; minutes: number };

/** What OmO waits when settings.json says nothing. */
const OMO_QUESTION_TIMEOUT = 30;

export interface EnvironmentDeps {
  /** The window's folders: what the running OmO was started with. */
  paths: EnvPaths;
  /** `agentTabs.environmentVariables` read afresh (another window may have changed it). */
  readVariables: () => EnvVar[];
  writeVariables: (variables: EnvVar[]) => Promise<void>;
  /** The window's «Перезапустить OmO» (with its confirmation). */
  restartHost: () => void;
  omoVersion: () => Promise<string | undefined>;
  /** The section changed outside an action (the version arrived late): every open modal re-reads it. */
  changed: () => void;
  log: (text: string) => void;
}

export const RESTART_HINT = "Перезапустить OmO — нужно после смены папок";
const VARIABLES: Record<Folder, string> = { agentDir: "OMO_CODING_AGENT_DIR", memoryHome: "OMO_MEMORY_HOME", claudeDir: "CLAUDE_CONFIG_DIR" };
const FOLDERS = Object.keys(VARIABLES) as Folder[];
const VIEW_WAIT_MS = 1_000;
const OMO_UNAVAILABLE = "нет связи с OmO";
const TIMEOUT = Symbol("timeout");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function expandTilde(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/**
 * «Среда» on the host: the folders of `agentTabs.environmentVariables`, OmO's version and its restart. A folder change
 * reaches OmO only after a restart; the view says so while the setting and the running OmO disagree.
 */
export class EnvironmentHost implements SettingsSectionHost<EnvironmentAction> {
  readonly section = "environment" as const;
  private version: string | undefined;
  private fetching: Promise<string | undefined> | undefined;
  /** The last view gave up waiting: the answer, when it comes, re-posts the section. */
  private late = false;

  constructor(private readonly deps: EnvironmentDeps) {}

  parse(raw: Record<string, unknown>): EnvironmentAction | undefined {
    if (raw["kind"] === "restart") return { kind: "restart" };
    if (raw["kind"] === "questionTimeout.set") return typeof raw["minutes"] === "number" ? { kind: "questionTimeout.set", minutes: raw["minutes"] } : undefined;
    if (raw["kind"] !== "folder.set") return undefined;
    const { which, path: value } = raw;
    if (!(FOLDERS as unknown[]).includes(which) || typeof value !== "string" || value.trim() === "") return undefined;
    return { kind: "folder.set", which: which as Folder, path: value.trim() };
  }

  async view(): Promise<EnvironmentView> {
    const configured = this.configured();
    const running: Record<Folder, string> = { agentDir: this.deps.paths.agentDir, memoryHome: this.deps.paths.memoryHome, claudeDir: this.deps.paths.claudeDir };
    const folders = Object.fromEntries(FOLDERS.map((folder) => [folder, configured[folder] ?? running[folder]])) as Record<Folder, string>;
    const restartNeeded = FOLDERS.some((folder) => path.resolve(expandTilde(folders[folder], this.deps.paths.home)) !== path.resolve(running[folder]));
    const version = await this.versionForView();
    return {
      folders,
      ...(version !== undefined ? { omoVersion: version } : { omoUnavailable: OMO_UNAVAILABLE }),
      restartNeeded,
      restartHint: RESTART_HINT,
      questionTimeoutMinutes: readQuestionTimeout(this.deps.paths) ?? OMO_QUESTION_TIMEOUT,
    };
  }

  async perform(action: EnvironmentAction): Promise<void> {
    if (action.kind === "restart") {
      this.deps.restartHost();
      return;
    }
    if (action.kind === "questionTimeout.set") {
      try {
        writeQuestionTimeout(this.deps.paths, action.minutes);
      } catch (error) {
        const message = errorText(error);
        throw new FieldErrors(message, [{ field: "questionTimeout", message }]);
      }
      return;
    }
    if (!path.isAbsolute(action.path) && action.path !== "~" && !action.path.startsWith("~/")) {
      throw new FieldErrors("Укажите полный путь к папке (/… или ~/…)", [{ field: action.which, message: "нужен полный путь" }]);
    }
    const name = VARIABLES[action.which];
    const variables = this.deps.readVariables();
    const next = variables.some((item) => item.name === name)
      ? variables.map((item) => (item.name === name ? { name, value: action.path } : item))
      : [...variables, { name, value: action.path }];
    await this.deps.writeVariables(next);
  }

  private configured(): Partial<Record<Folder, string>> {
    const variables = this.deps.readVariables();
    const out: Partial<Record<Folder, string>> = {};
    for (const folder of FOLDERS) {
      const value = variables.find((item) => item.name === VARIABLES[folder])?.value;
      if (value !== undefined && value !== "") out[folder] = value;
    }
    return out;
  }

  /** The known version at once; the first one waits a little, and a late answer re-posts the section. */
  private async versionForView(): Promise<string | undefined> {
    if (this.version !== undefined) return this.version;
    this.fetching ??= this.deps
      .omoVersion()
      .catch((error: unknown) => {
        this.deps.log(`Версия OmO недоступна: ${errorText(error)}`);
        return undefined;
      })
      .then((version) => {
        this.fetching = undefined;
        if (version !== undefined && this.version === undefined) {
          this.version = version;
          if (this.late) this.deps.changed();
        }
        return version;
      });
    this.late = false;
    const result = await within(this.fetching, VIEW_WAIT_MS);
    if (result !== TIMEOUT) return result;
    this.late = true;
    return undefined;
  }
}
