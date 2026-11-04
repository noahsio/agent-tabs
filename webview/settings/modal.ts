import type { HostMessage } from "../../src/panel/protocol";
import type { LoginEvent } from "../../src/settings/accounts";
import { SETTINGS_SECTIONS, type SettingsSection, type SettingsState } from "../../src/settings/protocol";
import { button, el, type Post } from "../dom";
import type { PopoverContent } from "../popover";
import { SECTION_LABELS, createSection, type SectionView } from "./sections";

export type SettingsModalHost = {
  /** Shows the modal over the tab (closing any other popover). */
  show: () => void;
  /** Hides it and gives the focus back to the input. */
  hide: () => void;
};

type SettingsResultMessage = Extract<HostMessage, { type: "settingsResult" }>;

const FOOTER = "Изменения сохраняются сразу · файлы OmO, а не настройки VS Code";

/**
 * «Настройки»: a modal over the tab with the sections on the left, the chosen one's title and ✕ on top and the
 * footer note below. Opening asks the host for the state; after that it posts only when a section's control changes.
 */
export class SettingsModal implements PopoverContent {
  readonly element: HTMLElement;
  private readonly title: HTMLElement;
  private readonly env: HTMLElement;
  private readonly error: HTMLElement;
  /** Why there is nothing to edit: no environment, or the chosen section could not be read. */
  private readonly notice: HTMLElement;
  private unavailable: string | undefined;
  private failed: Partial<Record<SettingsSection, string>> = {};
  private readonly navItems = new Map<SettingsSection, HTMLButtonElement>();
  private readonly views = new Map<SettingsSection, SectionView>();
  private active: SettingsSection = "connections";
  private actions = 0;

  constructor(
    private readonly post: Post,
    private readonly host: SettingsModalHost,
  ) {
    const nav = el("nav", { class: "st-nav", "aria-label": "Разделы настроек" }, el("h1", {}, "Настройки"));
    const bodies = el("div", { class: "st-body" });
    this.error = el("div", { class: "st-error", role: "alert", "data-role": "settings-error" });
    this.error.hidden = true;
    this.notice = el("div", { class: "st-notice", role: "status", "data-role": "settings-notice" });
    this.notice.hidden = true;
    bodies.append(this.error, this.notice);
    for (const section of SETTINGS_SECTIONS) {
      const item = button(SECTION_LABELS[section], { class: "st-item", "data-section": section }, () => this.select(section));
      this.navItems.set(section, item);
      nav.append(item);
      const view = createSection(section, { act: (action) => this.act(section, action) });
      view.element.dataset["sectionBody"] = section;
      this.views.set(section, view);
      bodies.append(view.element);
    }
    this.env = el("div", { class: "st-env", "data-role": "settings-env" });
    this.env.hidden = true;
    nav.append(this.env);

    this.title = el("h2", { "data-role": "settings-title" });
    const cross = button("✕", { class: "icon-btn st-close", "data-role": "settings-close", title: "Закрыть", "aria-label": "Закрыть" }, () => this.close());
    const main = el(
      "div",
      { class: "st-main" },
      el("div", { class: "st-head" }, this.title, cross),
      bodies,
      el("div", { class: "st-foot" }, el("span", { "data-role": "settings-footer" }, FOOTER)),
    );
    this.element = el(
      "div",
      { class: "settings-backdrop", "data-popover": "settings", role: "dialog", "aria-modal": "true", "aria-label": "Настройки" },
      el("div", { class: "settings" }, nav, main),
    );
    this.select(this.active);
  }

  /** `firstRun`: opened by the host because nothing is connected yet. */
  open(section: SettingsSection, firstRun: boolean = false): void {
    this.select(section);
    if (firstRun) this.element.dataset["firstRun"] = "true";
    else delete this.element.dataset["firstRun"];
    this.error.hidden = true;
    this.host.show();
    this.post({ type: "settingsGet" });
  }

  close(): void {
    this.host.hide();
  }

  opened(): void {
    this.navItems.get(this.active)?.focus();
  }

  /** Hidden by ✕, Esc or another popover: a login still running is cancelled. */
  closed(): void {
    for (const view of this.views.values()) view.closed?.();
  }

  login(event: LoginEvent): void {
    for (const view of this.views.values()) view.login?.(event);
  }

  update(state: SettingsState): void {
    if ("unavailable" in state) {
      this.unavailable = state.unavailable;
      this.failed = {};
      this.env.hidden = true;
    } else {
      this.unavailable = undefined;
      this.failed = state.failed ?? {};
      this.env.replaceChildren("Среда этого окна:", el("br"), el("b", {}, state.env.name), ` · ${state.env.agentDir}`);
      this.env.hidden = false;
      for (const view of this.views.values()) view.update(state);
    }
    this.select(this.active);
  }

  /** The host's answer to an action: a refusal shows its reason until the next action goes through. */
  result(message: SettingsResultMessage): void {
    this.error.textContent = message.ok ? "" : (message.error ?? "Не удалось сохранить");
    this.error.hidden = message.ok;
    for (const view of this.views.values()) view.result?.(message.id, message.ok, message.errors ?? [], message.notice);
  }

  private select(section: SettingsSection): void {
    this.active = section;
    this.title.textContent = SECTION_LABELS[section];
    for (const [id, item] of this.navItems) {
      item.classList.toggle("on", id === section);
      if (id === section) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    const reason = this.unavailable ?? this.failed[section];
    this.notice.textContent = reason ?? "";
    this.notice.hidden = reason === undefined;
    for (const [id, view] of this.views) view.element.hidden = id !== section || reason !== undefined;
  }

  private act(section: SettingsSection, action: Record<string, unknown>): string {
    const id = `s${++this.actions}`;
    this.post({ type: "settingsAction", id, section, action });
    return id;
  }
}
