import type { LoginEvent } from "../../src/settings/accounts";
import type { FieldError, SettingsSection, SettingsView } from "../../src/settings/protocol";
import { el } from "../dom";
import { ConnectionsSection } from "./connections";
import { EnvironmentSection } from "./environment";
import { ModelsSection } from "./models";
import { SecuritySection } from "./security";
import { ToolsSection } from "./tools";

/** The modal's left column, in this order. */
export const SECTION_LABELS: Record<SettingsSection, string> = {
  connections: "Подключения",
  models: "Модели и роли",
  security: "Безопасность",
  tools: "Инструменты",
  environment: "Среда",
};

/** What a section's body gets from the modal: posting one action of its own section (the answer comes with its id). */
export type SectionContext = { act(action: Record<string, unknown>): string };

/** One section's body: rebuilt from the host's state, it posts only when one of its controls changes. */
export interface SectionView {
  readonly element: HTMLElement;
  update(state: SettingsView): void;
  /** The host's answer to one of this section's actions, with the fields it refused or its notice. */
  result?(id: string, ok: boolean, errors: readonly FieldError[], notice?: string): void;
  /** A subscription login's progress, prompt or end. */
  login?(event: LoginEvent): void;
  /** The modal was closed. */
  closed?(): void;
}

/** A section without a body of its own yet is a placeholder until its task gives it one. */
export function createSection(section: SettingsSection, context: SectionContext): SectionView {
  if (section === "connections") return new ConnectionsSection(context);
  if (section === "models") return new ModelsSection(context);
  if (section === "security") return new SecuritySection(context);
  if (section === "tools") return new ToolsSection(context);
  if (section === "environment") return new EnvironmentSection(context);
  return { element: el("p", { class: "st-placeholder" }, "Этот раздел появится в следующем обновлении."), update: () => undefined };
}
