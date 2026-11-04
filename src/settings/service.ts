import { EventEmitter } from "node:events";
import { redact } from "../env";
import type { FieldError, SettingsResult, SettingsSection, SettingsState } from "./protocol";

/** One section of the modal on the host side: checks the webview's action, shows its view, applies the action. */
export interface SettingsSectionHost<A> {
  readonly section: SettingsSection;
  /** The action from the webview, checked once here; undefined refuses it. */
  parse(raw: Record<string, unknown>): A | undefined;
  /** What the webview shows; never a key or a token. */
  view(): Promise<unknown>;
  /** A returned text is a notice for the person, sent with the success. */
  perform(action: A): Promise<void | string>;
}

/** Thrown by a section when it refuses fields; its message and errors go to the modal as they are. */
export class FieldErrors extends Error {
  constructor(
    message: string,
    readonly errors: FieldError[],
  ) {
    super(message);
  }
}

const REFUSED = "Действие не распознано";
const FAILED = "Не удалось применить изменение — подробности в канале «Agent Tabs»";
const VIEW_FAILED = "Не удалось прочитать раздел — подробности в канале «Agent Tabs»";
/** Shorter strings of an action are not worth hiding (and would garble the log). */
const MIN_HIDDEN_LENGTH = 4;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every string inside an action: a key typed in the modal is one of them, and no secret list knows it. */
function actionStrings(value: unknown): string[] {
  if (typeof value === "string") return value.length >= MIN_HIDDEN_LENGTH ? [value] : [];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(actionStrings);
}

/**
 * The settings of this window's environment: one per window, shared by every tab. Emits "changed" after every
 * action that went through, so every open modal re-reads the state; "models" after a connection or role change, so
 * open tabs re-fetch their model lists. Actions may carry keys: they are never logged
 * and never part of an answer; a section's unexpected error reaches the modal as a fixed text and the log with the
 * action's strings hidden.
 */
export class SettingsService extends EventEmitter {
  private readonly hosts = new Map<SettingsSection, SettingsSectionHost<unknown>>();

  constructor(
    private readonly env: { name: string; agentDir: string },
    private readonly log: (text: string) => void,
    /** Runs once, before the first state is built (the first time anyone opens the settings). Its failure is only logged. */
    private readonly prepare?: () => Promise<void>,
  ) {
    super();
  }

  private prepared: Promise<void> | undefined;

  register(host: SettingsSectionHost<unknown>): void {
    this.hosts.set(host.section, host);
  }

  /** A section whose view fails is named in `failed`; the others still arrive. */
  async state(): Promise<SettingsState> {
    this.prepared ??= (this.prepare?.() ?? Promise.resolve()).catch((error: unknown) =>
      this.log(`Подготовка настроек не удалась: ${errorText(error)}`),
    );
    await this.prepared;
    const state: SettingsState = { env: { ...this.env } };
    for (const [section, host] of this.hosts) {
      try {
        state[section] = await host.view();
      } catch (error) {
        this.log(`Раздел настроек «${section}» недоступен: ${errorText(error)}`);
        state.failed = { ...state.failed, [section]: error instanceof FieldErrors ? error.message : VIEW_FAILED };
      }
    }
    return state;
  }

  async perform(section: SettingsSection, raw: unknown): Promise<SettingsResult> {
    const host = this.hosts.get(section);
    if (host === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: REFUSED };
    let notice: void | string;
    try {
      const action = host.parse(raw as Record<string, unknown>);
      if (action === undefined) return { ok: false, error: REFUSED };
      notice = await host.perform(action);
    } catch (error) {
      if (error instanceof FieldErrors) return { ok: false, error: error.message, errors: error.errors };
      this.log(`Настройки, раздел «${section}»: ${redact(errorText(error), actionStrings(raw))}`);
      return { ok: false, error: FAILED };
    }
    this.emit("changed");
    if (section === "connections" || section === "models") this.emit("models"); // the composers' model pickers are stale
    return typeof notice === "string" ? { ok: true, notice } : { ok: true };
  }
}
