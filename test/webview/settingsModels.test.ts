// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import type { RolesView } from "../../src/settings/roles";
import { ChatView } from "../../webview/render";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

const ENV = { name: "second", agentDir: "/a" };

const view1: RolesView = {
  rows: [
    { id: "main", title: "Главный агент", detail: "ведёт сессию", hint: "model_profile", model: "gw-x/m1", reasoning: "xhigh" },
    { id: "explore", title: "Разведка кода", detail: "быстро находит", hint: "explore, librarian", model: "mixed", reasoning: "medium" },
    { id: "writing", title: "Тексты", detail: "документация", hint: "writing", model: "gone/model", reasoning: "low" },
    { id: "quick", title: "Быстрые задачи", detail: "мелкие правки", hint: "quick, unspecified-low" },
    {
      id: "memory",
      title: "Память",
      detail: "разбирает ошибки",
      hint: "memory.reflection",
      model: "quick",
      categories: [
        { value: "quick", label: "Быстрые задачи — m2 (quick)" },
        { value: "writing", label: "Тексты — gone/model (writing)" },
      ],
    },
  ],
  models: [
    { connection: "Шлюз (Anthropic API)", items: [{ value: "gw-x/m1", label: "m1" }, { value: "gw-x/m2", label: "m2" }] },
    { connection: "ChatGPT", items: [{ value: "chatgpt-sub/c1", label: "C One" }] },
  ],
};

function section(): HTMLElement {
  return root.querySelector('[data-section-body="models"]') as HTMLElement;
}
function rowEl(id: string): HTMLElement {
  return section().querySelector(`[data-role-row="${id}"]`) as HTMLElement;
}
function selectOf(id: string): HTMLSelectElement {
  return rowEl(id).querySelector('[data-field="model"]') as HTMLSelectElement;
}
function power(id: string): HTMLButtonElement[] {
  return [...rowEl(id).querySelectorAll<HTMLButtonElement>("[data-reasoning]")];
}
function lastAction(): Record<string, unknown> | undefined {
  return posted.flatMap((message) => (message.type === "settingsAction" ? [{ ...message.action, section: message.section }] : [])).at(-1);
}
function show(models: RolesView): void {
  view.settings({ env: ENV, models });
}
function optionTexts(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.textContent ?? "");
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
  view.update({ type: "state", state: initialState(), tab: { modelMode: "auto", sessionPath: "/s/a.jsonl", durableId: "d1" }, reconnectable: true });
  view.openSettings("models");
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
});

describe("«Модели и роли»", () => {
  it("options_are_grouped_by_connection", () => {
    show(view1);
    const groups = [...selectOf("main").querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual(["Шлюз (Anthropic API)", "ChatGPT"]);
    expect(selectOf("main").value).toBe("gw-x/m1");
  });

  it("the_technical_names_are_the_tooltip_of_the_role", () => {
    show(view1);
    expect(rowEl("explore").querySelector("b")?.getAttribute("title")).toBe("explore, librarian");
    expect(rowEl("explore").textContent).toContain("быстро находит");
  });

  it("picking_a_model_posts_only_the_model_and_a_power_only_the_power", () => {
    show(view1);
    selectOf("quick").value = "chatgpt-sub/c1";
    selectOf("quick").dispatchEvent(new Event("change", { bubbles: true }));
    expect(lastAction()).toEqual({ section: "models", kind: "role.set", id: "quick", model: "chatgpt-sub/c1" });
    power("explore")[3]?.click();
    expect(lastAction()).toEqual({ section: "models", kind: "role.set", id: "explore", reasoning: "xhigh" });
  });

  it("the_power_control_marks_the_current_level_and_the_active_one_posts_nothing", () => {
    show(view1);
    expect(power("main").map((item) => item.textContent)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(power("main").map((item) => item.classList.contains("on"))).toEqual([false, false, false, true]);
    const before = posted.length;
    power("main")[3]?.click();
    expect(posted.length).toBe(before);
  });

  it("a_level_the_control_does_not_offer_is_shown_selected_in_its_place", () => {
    show({ ...view1, rows: [{ id: "main", title: "Главный агент", detail: "", hint: "model_profile", model: "gw-x/m1", reasoning: "minimal" }] });
    expect(power("main").map((item) => item.textContent)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(power("main").map((item) => item.classList.contains("on"))).toEqual([true, false, false, false, false]);
    const before = posted.length;
    power("main")[0]?.click();
    expect(posted.length).toBe(before);
  });

  it("a_model_that_does_not_think_shows_no_power", () => {
    show({
      ...view1,
      rows: [{ id: "quick", title: "Быстрые задачи", detail: "", hint: "quick", model: "gw-x/m2", noReasoning: true }],
      models: [{ connection: "Шлюз", items: [{ value: "gw-x/m2", label: "m2", reasoning: false }] }],
    });
    expect(power("quick")).toEqual([]);
    expect(rowEl("quick").textContent).toContain("модель не думает");
  });

  it("a_model_outside_the_connections_still_shows_marked", () => {
    show(view1);
    expect(selectOf("writing").value).toBe("gone/model");
    expect(optionTexts(selectOf("writing"))).toContain("gone/model — нет в подключениях");
  });

  it("mixed_keys_show_a_placeholder_that_posts_nothing", () => {
    show(view1);
    expect(optionTexts(selectOf("explore"))[0]).toBe("разные модели");
    expect(selectOf("explore").value).toBe("mixed");
    const before = posted.length;
    selectOf("explore").dispatchEvent(new Event("change", { bubbles: true }));
    expect(posted.length).toBe(before);
  });

  it("an_unset_role_asks_for_a_model", () => {
    show(view1);
    expect(optionTexts(selectOf("quick"))[0]).toBe("не задана");
  });

  it("a_profile_is_shown_as_such_and_has_no_power", () => {
    show({ ...view1, rows: [{ id: "main", title: "Главный агент", detail: "", hint: "model_profile", profile: "work" }] });
    expect(optionTexts(selectOf("main"))[0]).toBe("профиль work");
    expect(power("main")).toEqual([]);
  });

  it("memory_picks_a_category_and_has_no_power", () => {
    show(view1);
    expect(optionTexts(selectOf("memory"))).toEqual(["Быстрые задачи — m2 (quick)", "Тексты — gone/model (writing)"]);
    expect(power("memory")).toEqual([]);
    selectOf("memory").value = "writing";
    selectOf("memory").dispatchEvent(new Event("change", { bubbles: true }));
    expect(lastAction()).toEqual({ section: "models", kind: "role.set", id: "memory", model: "writing" });
  });

  it("a_refusal_puts_the_controls_back_to_what_the_file_says", () => {
    show(view1);
    selectOf("quick").value = "gw-x/m2";
    selectOf("quick").dispatchEvent(new Event("change", { bubbles: true }));
    const sent = posted.filter((message) => message.type === "settingsAction").at(-1);
    if (sent?.type !== "settingsAction") throw new Error("nothing sent");
    view.settingsResult({ type: "settingsResult", id: sent.id, ok: false, error: "нет" });
    expect(selectOf("quick").value).toBe("");
  });

  it("the_footer_and_an_unreachable_omo_are_said", () => {
    show({ ...view1, omoUnavailable: "нет связи с OmO" });
    expect(section().textContent).toContain("Список моделей — из всех подключений. Меняется для новых сессий; в открытой сессии модель главного агента выбирается в строке ввода.");
    expect(section().textContent).toContain("нет связи с OmO");
  });
});
