import type { SettingsView } from "../../src/settings/protocol";
import type { McpServerView, SuperpowersView, ToolsView } from "../../src/settings/tools";
import { breakable, button, el } from "../dom";
import type { SectionContext, SectionView } from "./sections";

const SYSTEM_CLAUDE_MD = "~/.claude/CLAUDE.md";
const ALWAYS_NOTE = `OmO всегда загружает ${SYSTEM_CLAUDE_MD}: выключить его можно только вместе со всеми правилами (PI_RULES_DISABLED=1).`;
const SECOND_NOTE = `Системный ${SYSTEM_CLAUDE_MD} OmO загружает всегда, независимо от этого выключателя.`;

function pluralSkills(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  const word = ones === 1 && tens !== 11 ? "навык" : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? "навыка" : "навыков";
  return `${count} ${word}`;
}

/** Where Claude has the fork's plugin enabled, in one line. */
function claudeLine(claude: SuperpowersView["claude"]): string {
  const on = claude.filter((env) => env.plugin === "on");
  if (on.length === 0) return `в Claude: ${claude.some((env) => env.plugin === "off") ? "выключен" : "не установлен"}`;
  if (on.length < claude.length) return `в Claude: только в ${on.map((env) => env.label).join(", ")}`;
  return `в Claude: включён ${claude.length === 2 ? "в обеих средах" : claude.length === 1 ? `в ${on[0]?.label ?? ""}` : "во всех средах"}`;
}

/** A switch: it shows what the file says; a click posts the opposite and waits for the host's state. */
function toggle(id: string, label: string, on: boolean, onFlip: (next: boolean) => void): HTMLButtonElement {
  const control = button("", { class: "st-switch", role: "switch", "aria-checked": String(on), "aria-label": label, "data-toggle": id }, () => onFlip(!on));
  return control;
}

function small(label: string, attributes: Record<string, string>, onClick: () => void): HTMLButtonElement {
  return button(label, { class: "secondary st-sm", ...attributes }, onClick);
}

function card(...children: (Node | string)[]): HTMLElement {
  return el("div", { class: "st-card" }, el("div", { class: "st-row" }, ...children));
}

function text(title: string, detail: Node | string, titleClass = "st-t"): HTMLElement {
  return el("div", { class: "st-grow" }, el("div", { class: titleClass }, title), el("div", { class: "st-s" }, detail));
}

/** `NAME=value` per line. */
function envLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

function parseEnv(lines: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of lines.split("\n")) {
    const cut = line.indexOf("=");
    if (line.trim() === "" || cut <= 0) continue;
    env[line.slice(0, cut).trim()] = line.slice(cut + 1);
  }
  return env;
}

/** One argument per line; empty lines are not arguments. */
const argLines = (value: string): string[] => value.split("\n").filter((line) => line.trim() !== "");

/** How a command line reads: an argument with spaces in quotes. */
const quotedArg = (arg: string): string => (/\s/.test(arg) || arg === "" ? JSON.stringify(arg) : arg);

/**
 * «Инструменты» after the mockup: CodeGraph, «Навыки» (the superpowers fork first, then this environment's Claude skills),
 * MCP servers with their form, the hidden «/» commands and «Глобальные инструкции». Lists are rebuilt from every state;
 * the MCP form and the hidden-list editor survive updates while open.
 */
export class ToolsSection implements SectionView {
  readonly element: HTMLElement;
  private readonly codegraph: HTMLElement;
  private readonly skills: HTMLElement;
  private readonly servers: HTMLElement;
  private readonly hiddenSummary: HTMLElement;
  private readonly instructions: HTMLElement;
  private readonly form: HTMLElement;
  private readonly formTitle: HTMLElement;
  private readonly mcpName: HTMLInputElement;
  private readonly mcpCommand: HTMLInputElement;
  private readonly mcpArgs: HTMLTextAreaElement;
  private readonly mcpEnv: HTMLTextAreaElement;
  private readonly hiddenEditor: HTMLElement;
  private readonly hiddenLines: HTMLTextAreaElement;
  private last: ToolsView | undefined;
  /** The form's save or the hidden list's save in flight: a success closes what posted it. */
  private saving: { id: string; close: HTMLElement } | undefined;

  constructor(private readonly context: SectionContext) {
    this.codegraph = el("div");
    this.skills = el("div");
    this.servers = el("div");
    this.instructions = el("div");

    this.formTitle = el("div", { class: "st-t" });
    this.mcpName = el("input", { class: "st-mono", "data-field": "mcp-name", placeholder: "github", spellcheck: "false" });
    this.mcpCommand = el("input", { class: "st-mono", "data-field": "mcp-command", placeholder: "npx", spellcheck: "false" });
    this.mcpArgs = el("textarea", { class: "st-mono st-lines", "data-field": "mcp-args", rows: "3", placeholder: "-y\n@modelcontextprotocol/server-github", spellcheck: "false" });
    this.mcpEnv = el("textarea", { class: "st-mono st-lines", "data-field": "mcp-env", rows: "3", placeholder: "GITHUB_TOKEN=…", spellcheck: "false" });
    const field = (label: string, control: HTMLElement): HTMLElement => el("div", { class: "st-field" }, el("label", {}, label), control);
    this.form = el(
      "div",
      { class: "st-card st-form", "data-role": "mcp-form" },
      this.formTitle,
      el(
        "div",
        { class: "st-fields" },
        field("Название", this.mcpName),
        field("Команда", this.mcpCommand),
        field("Аргументы", this.mcpArgs),
        field("Переменные", this.mcpEnv),
      ),
      el("p", { class: "st-s st-hint" }, "Аргументы — по одному в строке, пробелы внутри строки остаются частью аргумента. Переменные — по одной в строке: ИМЯ=значение. Скрытые значения (••••••) остаются прежними."),
      el(
        "div",
        { class: "st-row st-actions" },
        button("Сохранить", { class: "st-sm", "data-action": "mcp.save" }, () => this.saveServer()),
        small("Отмена", { "data-action": "mcp.cancel" }, () => (this.form.hidden = true)),
      ),
    );
    this.form.hidden = true;

    this.hiddenSummary = el("span", { "data-role": "hidden-summary" });
    this.hiddenLines = el("textarea", { class: "st-mono st-lines", "data-field": "hidden", rows: "6", spellcheck: "false", "aria-label": "Скрытые команды" });
    this.hiddenEditor = el(
      "div",
      { class: "st-card st-form" },
      el("div", { class: "st-s" }, "Одна строка — одна команда. Эти команды OmO не показываются в меню «/»."),
      this.hiddenLines,
      el(
        "div",
        { class: "st-row st-actions" },
        button("Сохранить", { class: "st-sm", "data-action": "hidden.save" }, () => this.saveHidden()),
        small("Отмена", { "data-action": "hidden.cancel" }, () => (this.hiddenEditor.hidden = true)),
      ),
    );
    this.hiddenEditor.hidden = true;

    this.element = el(
      "div",
      { class: "st-tools" },
      el("h3", { class: "st-h3" }, "CodeGraph"),
      this.codegraph,
      el("h3", { class: "st-h3" }, "Навыки"),
      this.skills,
      el("h3", { class: "st-h3" }, "MCP-серверы"),
      this.servers,
      small("+ Добавить MCP-сервер", { "data-action": "mcp.add" }, () => this.openForm(undefined)),
      this.form,
      el("h3", { class: "st-h3" }, "Меню «/»"),
      el(
        "p",
        { class: "st-s" },
        "Скрытые команды OmO: ",
        this.hiddenSummary,
        " ",
        button("изменить список", { class: "link", "data-action": "hidden.edit" }, () => this.openHidden()),
      ),
      this.hiddenEditor,
      el("h3", { class: "st-h3" }, "Глобальные инструкции"),
      this.instructions,
    );
  }

  update(state: SettingsView): void {
    const view = state.tools as ToolsView | undefined;
    if (view === undefined) return;
    this.last = view;
    this.render(view);
  }

  result(id: string, ok: boolean): void {
    if (ok && this.saving?.id === id) this.saving.close.hidden = true;
    if (this.saving?.id === id) this.saving = undefined;
    if (!ok && this.last !== undefined) this.render(this.last); // the files did not change: show what they say
  }

  private render(view: ToolsView): void {
    this.codegraph.replaceChildren(
      card(
        text("Индекс кода в каждом проекте", "создаётся при открытии сессии · подсказки к каждому сообщению · инструмент codegraph_explore"),
        el("span", { class: `st-badge ${view.codegraph.on ? "ok" : ""}`.trim() }, view.codegraph.on ? "● подключён" : "выключен"),
        toggle("codegraph", "CodeGraph", view.codegraph.on, (on) => this.context.act({ kind: "codegraph.set", on })),
      ),
    );

    const skillNames = view.skills.map((skill) =>
      el(
        "div",
        { class: "st-skill" },
        el("span", { class: "st-mono", title: skill.folder }, skill.name),
        toggle(`skill:${skill.folder}`, `Навык ${skill.name}`, skill.on, (on) => this.context.act({ kind: "skills.set", folder: skill.folder, on })),
      ),
    );
    const others = view.otherSkills.map((other) => el("div", { class: "st-s st-mono" }, ...breakable(other.path), other.exists ? "" : " · нет папки"));
    this.skills.replaceChildren(
      el("div", { class: "st-card" }, el("div", { class: "st-skills" }, this.superpowersRow(view.superpowers), ...skillNames)),
      ...(others.length > 0
        ? [el("div", { class: "st-card", "data-role": "other-skills" }, el("div", { class: "st-t" }, "Другие пути навыков"), el("p", { class: "st-s" }, "OmO загружает и эти папки; включаются и выключаются в settings.json."), ...others)]
        : []),
    );

    this.servers.replaceChildren(...view.mcp.map((server) => this.serverCard(server)));
    if (view.mcp.length === 0) this.servers.append(el("p", { class: "st-s" }, "MCP-серверов пока нет."));

    this.hiddenSummary.textContent = view.hidden.length > 0 ? view.hidden.map((name) => `/${name}`).join(", ") : "нет";

    const info = view.instructions;
    const pathLine = el("span", {}, el("span", { class: "st-mono st-url" }, ...breakable(info.path)), info.exists ? "" : " · файла ещё нет");
    const instructionsToggle = toggle("instructions", "Использовать CLAUDE.md этой среды", info.on, (on) => this.context.act({ kind: "instructions.set", on }));
    instructionsToggle.disabled = info.always === true;
    this.instructions.replaceChildren(
      el(
        "div",
        { class: "st-card" },
        el(
          "div",
          { class: "st-row" },
          text("Использовать CLAUDE.md этой среды", pathLine),
          el("div", { class: "st-btns" }, small("Открыть в редакторе", { "data-action": "instructions.open" }, () => this.context.act({ kind: "instructions.open" })), instructionsToggle),
        ),
        el("p", { class: "st-s st-hint" }, info.always === true ? ALWAYS_NOTE : SECOND_NOTE),
      ),
    );
  }

  /** The fork: the first row of «Навыки», its plugin badge, where Claude has it, «обновить» and the same switch. */
  private superpowersRow(sp: SuperpowersView): HTMLElement {
    const installed = sp.folder !== undefined;
    const headline = el("div", { class: "st-headline" }, el("span", { class: "st-mono", title: installed ? `${sp.folder ?? ""} · ${pluralSkills(sp.skills)}` : "" }, "superpowers"));
    if (installed) {
      headline.append(
        el("span", { class: "st-badge" }, ["плагин", sp.version ?? "?", sp.sha ?? "?"].join(" · ")),
        button("обновить", { class: "link", "data-action": "superpowers.update" }, () => this.context.act({ kind: "superpowers.update" })),
      );
    }
    const notes = installed ? [claudeLine(sp.claude)] : ["не установлен — запустите kit/setup-omo.mjs"];
    if (installed && sp.sha !== undefined && sp.sha !== sp.pinned) notes.push(`закреплена ${sp.pinned}`);
    const detail = el("div", { class: "st-s", "data-role": "superpowers-claude" }, notes.join(" · "));
    const warning = (note: string, action: string, label: string): HTMLElement =>
      el("div", { class: "st-s st-warn" }, `${note} · `, button(label, { class: "link", "data-action": action }, () => this.context.act({ kind: "superpowers.set", on: true })));
    const warnings = sp.mode === "skills" ? [warning("подключён как папка навыков", "superpowers.migrate", "перевести в пакет")] : [];
    const control = toggle("superpowers", "superpowers", sp.mode !== "off", (on) => this.context.act({ kind: "superpowers.set", on }));
    control.disabled = !installed;
    return el("div", { class: "st-skill", "data-role": "superpowers" }, el("div", { class: "st-grow" }, headline, detail, ...warnings), control);
  }

  private serverCard(server: McpServerView): HTMLElement {
    const remove = small("Удалить", { "data-action": "mcp.remove" }, () => {
      if (remove.dataset["confirm"] === "true") {
        this.context.act({ kind: "mcp.remove", name: server.name });
        return;
      }
      remove.dataset["confirm"] = "true";
      remove.textContent = "Точно удалить?";
      remove.classList.add("st-danger");
    });
    const line = [server.command, ...server.args.map(quotedArg)].join(" ");
    const vars = Object.keys(server.env);
    const detail = vars.length > 0 ? `${line} · ${vars.join(", ")}` : line;
    const row = card(text(server.name, detail, "st-t st-mono"), el("div", { class: "st-btns" }, small("Изменить", { "data-action": "mcp.edit" }, () => this.openForm(server)), remove));
    row.dataset["mcp"] = server.name;
    row.querySelector(".st-s")?.classList.add("st-mono");
    return row;
  }

  private openForm(server: McpServerView | undefined): void {
    this.formTitle.textContent = server === undefined ? "Новый MCP-сервер" : `MCP-сервер ${server.name}`;
    this.mcpName.value = server?.name ?? "";
    this.mcpName.readOnly = server !== undefined;
    this.mcpCommand.value = server?.command ?? "";
    this.mcpArgs.value = server?.args.join("\n") ?? "";
    this.mcpEnv.value = server === undefined ? "" : envLines(server.env);
    this.form.hidden = false;
    (server === undefined ? this.mcpName : this.mcpCommand).focus();
  }

  private saveServer(): void {
    const id = this.context.act({
      kind: "mcp.save",
      name: this.mcpName.value.trim(),
      command: this.mcpCommand.value.trim(),
      args: argLines(this.mcpArgs.value),
      env: parseEnv(this.mcpEnv.value),
    });
    this.saving = { id, close: this.form };
  }

  private openHidden(): void {
    this.hiddenLines.value = (this.last?.hidden ?? []).map((name) => `/${name}`).join("\n");
    this.hiddenEditor.hidden = false;
    this.hiddenLines.focus();
  }

  private saveHidden(): void {
    const commands = this.hiddenLines.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    this.saving = { id: this.context.act({ kind: "hidden.set", commands }), close: this.hiddenEditor };
  }
}
