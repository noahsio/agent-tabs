// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import type { LadderSectionView } from "../../src/settings/ladder";
import type { SettingsView } from "../../src/settings/protocol";
import { ChatView } from "../../webview/render";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

const MODELS: LadderSectionView["models"] = [
  {
    connection: "Шлюз (Anthropic API)",
    items: [
      { value: "gw-anthropic/claude-opus-5-5", label: "Opus 5.5" },
      { value: "gw-anthropic/claude-opus-5", label: "Opus 5" },
    ],
  },
  { connection: "Шлюз (OpenAI)", items: [{ value: "gw-openai/gpt-6.1-sol", label: "GPT 6.1 Sol" }] },
];

const LADDER: LadderSectionView = {
  models: MODELS,
  rungs: [
    { id: "r1", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5-5" }, on: [], label: "Opus 5.5" },
    { id: "r2", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5" }, on: ["empty", "silence", "transport"], label: "Opus 5" },
    { id: "r3", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-4-8" }, on: ["empty", "silence", "transport"], label: "claude-opus-4-8", missing: true },
    { id: "r4", action: { kind: "model", provider: "gw-openai", id: "gpt-6.1-sol" }, on: ["refusal", "empty", "silence", "transport"], label: "GPT 6.1 Sol" },
    { id: "r5", action: { kind: "ask" }, on: ["refusal", "empty", "silence", "transport"], label: "Остановиться и спросить" },
  ],
};

function role(name: string, scope: ParentNode = root): HTMLElement {
  return scope.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

function modal(): HTMLElement {
  return root.querySelector('[data-popover="settings"]') as HTMLElement;
}

function section(): HTMLElement {
  return modal().querySelector('[data-section-body="ladder"]') as HTMLElement;
}

function rows(): HTMLElement[] {
  return [...section().querySelectorAll<HTMLElement>("[data-rung]")];
}

function row(index: number): HTMLElement {
  const found = rows()[index];
  if (found === undefined) throw new Error(`no rung row ${index}`);
  return found;
}

/** How each rung reads: the action its picker shows, which is the rung's name. */
function labels(): string[] {
  return rows().map((item) => {
    const select = item.querySelector("select") as HTMLSelectElement;
    return (select.selectedOptions[0]?.textContent ?? "").trim();
  });
}

/** The failures ticked on one rung, in the order the row offers them. */
function ticked(index: number): string[] {
  return [...row(index).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .filter((box) => box.checked)
    .map((box) => (box.closest("label")?.textContent ?? "").trim());
}

function boxes(index: number): string[] {
  return [...row(index).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((box) => (box.closest("label")?.textContent ?? "").trim());
}

function tick(index: number, failure: string): void {
  const box = [...row(index).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (candidate) => (candidate.closest("label")?.textContent ?? "").trim() === failure,
  );
  if (box === undefined) throw new Error(`no «${failure}» on rung ${index}`);
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

function actions(): Record<string, unknown>[] {
  return posted.flatMap((message) => (message.type === "settingsAction" && message.section === "ladder" ? [message.action] : []));
}

function show(ladder: LadderSectionView = LADDER, extra: Partial<SettingsView> = {}): void {
  view.settings({ env: { name: "second", agentDir: "/a" }, ladder, ...extra });
}

function openSettings(): void {
  role("slash").click();
  const rowItem = [...root.querySelectorAll<HTMLElement>('[data-popover="actions"] [data-row]')].find((candidate) => candidate.textContent === "Настройки");
  rowItem?.click();
}

function nav(label: string): HTMLElement {
  const item = [...modal().querySelectorAll<HTMLElement>("[data-section]")].find((candidate) => candidate.textContent === label);
  if (item === undefined) throw new Error(`no section «${label}»`);
  return item;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  view.update({ type: "state", state: initialState(), tab: { modelMode: "auto", sessionPath: "/s/a.jsonl" }, reconnectable: true });
  openSettings();
  nav("Лесенка моделей").click();
  show();
  posted.length = 0;
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});

describe("«Лесенка моделей» in the settings modal", () => {
  it("the_modal_lists_the_section_after_the_roles", () => {
    expect([...modal().querySelectorAll<HTMLElement>("[data-section]")].map((item) => item.textContent)).toEqual([
      "Подключения",
      "Модели и роли",
      "Лесенка моделей",
      "Безопасность",
      "Инструменты",
      "Среда",
    ]);
  });

  it("every_rung_is_a_row_in_order_with_its_number_and_its_action_names_it_once", () => {
    expect(labels()).toEqual(["Opus 5.5", "Opus 5", "claude-opus-4-8", "GPT 6.1 Sol", "Остановиться и спросить"]);
    expect(rows().map((item) => (item.querySelector('[data-role="rung-number"]')?.textContent ?? "").trim())).toEqual(["1", "2", "3", "4", "5"]);
    // the picker is the name: a row never prints the same words twice
    expect(row(1).textContent?.match(/Opus 5\b/g)).toHaveLength(1);
  });

  it("each_rung_offers_the_five_failures_and_shows_the_ones_it_answers", () => {
    expect(boxes(1)).toEqual(["отказ", "отклонение", "пустой ответ", "молчание", "обрыв"]);
    expect(ticked(1)).toEqual(["пустой ответ", "молчание", "обрыв"]);
    expect(ticked(3)).toEqual(["отказ", "пустой ответ", "молчание", "обрыв"]);
  });

  it("the_first_rung_answers_nothing_and_says_why", () => {
    expect(ticked(0)).toEqual([]);
    expect(row(0).querySelectorAll('input[type="checkbox"]:not([disabled])')).toHaveLength(0);
    expect(row(0).textContent).toContain("с неё всё начинается");
  });

  it("a_failure_checkbox_posts_only_what_changed", () => {
    tick(1, "отказ");
    expect(actions()).toEqual([{ kind: "rung.on", id: "r2", failure: "refusal", on: true }]);
    tick(1, "молчание");
    expect(actions().at(-1)).toEqual({ kind: "rung.on", id: "r2", failure: "silence", on: false });
  });

  it("a_rung_the_environment_does_not_serve_is_marked", () => {
    expect(row(2).textContent).toContain("нет в этой среде");
    expect(row(1).textContent).not.toContain("нет в этой среде");
  });

  it("the_action_select_groups_the_models_by_connection_and_offers_the_two_other_actions", () => {
    const select = row(1).querySelector("select") as HTMLSelectElement;
    expect([...select.querySelectorAll("optgroup")].map((group) => group.label)).toEqual(["Шлюз (Anthropic API)", "Шлюз (OpenAI)"]);
    expect([...select.options].map((option) => option.value)).toContain("ask");
    expect([...select.options].map((option) => option.value)).toContain("text");
    expect(select.value).toBe("gw-anthropic/claude-opus-5");
    select.value = "gw-openai/gpt-6.1-sol";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions()).toEqual([{ kind: "rung.action", id: "r2", action: { kind: "model", provider: "gw-openai", id: "gpt-6.1-sol" } }]);
  });

  it("choosing_stop_and_ask_posts_that_action", () => {
    const select = row(1).querySelector("select") as HTMLSelectElement;
    select.value = "ask";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions()).toEqual([{ kind: "rung.action", id: "r2", action: { kind: "ask" } }]);
  });

  it("a_text_rung_shows_its_phrase_and_posts_an_edit_of_it", () => {
    show({
      ...LADDER,
      rungs: [LADDER.rungs[0] as never, { id: "rt", action: { kind: "text", text: "продолжи" }, on: ["silence"], label: "продолжи" }],
    });
    const field = row(1).querySelector('[data-role="rung-text"]') as HTMLInputElement;
    expect(field.value).toBe("продолжи");
    field.value = "давай дальше";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions()).toEqual([{ kind: "rung.action", id: "rt", action: { kind: "text", text: "давай дальше" } }]);
  });

  it("a_blank_phrase_is_not_posted", () => {
    show({
      ...LADDER,
      rungs: [LADDER.rungs[0] as never, { id: "rt", action: { kind: "text", text: "продолжи" }, on: ["silence"], label: "продолжи" }],
    });
    const field = row(1).querySelector('[data-role="rung-text"]') as HTMLInputElement;
    field.value = "   ";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions()).toEqual([]);
  });

  it("a_model_rung_takes_a_continuation_phrase_and_posts_it_combined", () => {
    const field = row(1).querySelector('[data-role="rung-text"]') as HTMLInputElement;
    expect(field.value).toBe(""); // a bare model rung has no phrase yet
    field.value = "продолжай";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions()).toEqual([
      { kind: "rung.action", id: "r2", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5", text: "продолжай" } },
    ]);
  });

  it("clearing_a_model_rungs_phrase_makes_it_a_bare_switch_again", () => {
    show({
      ...LADDER,
      rungs: [
        LADDER.rungs[0] as never,
        { id: "r2", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5", text: "продолжай" }, on: ["empty"], label: "Opus 5" },
      ],
    });
    const field = row(1).querySelector('[data-role="rung-text"]') as HTMLInputElement;
    expect(field.value).toBe("продолжай");
    field.value = "   ";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions()).toEqual([{ kind: "rung.action", id: "r2", action: { kind: "model", provider: "gw-anthropic", id: "claude-opus-5" } }]);
  });

  it("the_top_rung_and_the_ask_rung_have_no_continuation_field", () => {
    expect(row(0).querySelector('[data-role="rung-text"]')).toBeNull();
    expect(row(4).querySelector('[data-role="rung-text"]')).toBeNull();
  });

  it("pointing_a_text_rung_at_a_model_carries_its_phrase_onto_it", () => {
    show({
      ...LADDER,
      rungs: [LADDER.rungs[0] as never, { id: "rt", action: { kind: "text", text: "продолжи" }, on: ["silence"], label: "продолжи" }],
    });
    const select = row(1).querySelector("select") as HTMLSelectElement;
    select.value = "gw-openai/gpt-6.1-sol";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions()).toEqual([
      { kind: "rung.action", id: "rt", action: { kind: "model", provider: "gw-openai", id: "gpt-6.1-sol", text: "продолжи" } },
    ]);
  });

  it("the_arrows_move_a_rung_and_the_ends_have_none_to_offer", () => {
    role("rung-up", row(2)).click();
    expect(actions()).toEqual([{ kind: "rung.move", id: "r3", to: 1 }]);
    role("rung-down", row(2)).click();
    expect(actions().at(-1)).toEqual({ kind: "rung.move", id: "r3", to: 3 });
    expect((role("rung-up", row(0)) as HTMLButtonElement).disabled).toBe(true);
    expect((role("rung-down", row(4)) as HTMLButtonElement).disabled).toBe(true);
    // the top rung stays the top: nothing may be moved above it
    expect((role("rung-up", row(1)) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a_rung_dragged_onto_another_moves_to_its_place", () => {
    const dragged = row(3);
    expect(dragged.draggable).toBe(true);
    dragged.dispatchEvent(new Event("dragstart", { bubbles: true }));
    row(1).dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    row(1).dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(actions()).toEqual([{ kind: "rung.move", id: "r4", to: 1 }]);
  });

  it("a_drop_with_nothing_being_dragged_posts_nothing", () => {
    row(1).dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(actions()).toEqual([]);
  });

  it("a_rung_is_added_and_removed_and_the_top_one_cannot_go", () => {
    role("rung-add").click();
    expect(actions()).toEqual([{ kind: "rung.add" }]);
    role("rung-remove", row(4)).click();
    expect(actions().at(-1)).toEqual({ kind: "rung.remove", id: "r5" });
    expect(role("rung-remove", row(0))).toBeNull();
  });

  it("the_default_ladder_can_be_put_back", () => {
    role("ladder-reset").click();
    expect(actions()).toEqual([{ kind: "reset" }]);
  });

  it("the_footer_says_what_the_first_rung_is_and_that_the_threshold_is_fixed", () => {
    expect(role("ladder-note").textContent).toBe(
      "Первая ступенька — модель, с которой сессия начинает. Порог молчания — 5 минут. Лесенка идёт только для вашего сообщения. Ступенька с текстом продолжает на новой модели в любом случае; ступенька только со сменой модели повторяет сообщение — и лишь если ход ничего не успел сделать.",
    );
  });

  it("a_refused_change_puts_the_controls_back", () => {
    tick(1, "отказ");
    expect(ticked(1)).toEqual(["отказ", "пустой ответ", "молчание", "обрыв"]);
    view.settingsResult({ type: "settingsResult", id: "s1", ok: false, error: "Первая ступенька…" });
    expect(ticked(1)).toEqual(["пустой ответ", "молчание", "обрыв"]); // the file did not change: show what it says
  });
});
