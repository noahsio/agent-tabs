import { describe, expect, it } from "vitest";
import { TAB_TITLE_MAX, tabTitle } from "../../src/panel/tabTitle";

describe("tabTitle", () => {
  it("a_short_title_is_kept_as_is", () => {
    expect(tabTitle("Новая сессия")).toBe("Новая сессия");
  });

  it("a_long_title_is_cut_to_the_limit_with_an_ellipsis", () => {
    const title = tabTitle("Передача работы: координатор Example CRM (на 04.11.2026) Кто");
    expect(title.length).toBe(TAB_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Передача работы: координ")).toBe(true);
  });

  it("the_cut_never_leaves_a_trailing_space_before_the_ellipsis", () => {
    expect(tabTitle("Интерфейс omo.dev в плагине vscode и всё остальное")).not.toMatch(/\s…$/);
  });

  it("whitespace_runs_collapse_to_one_space", () => {
    expect(tabTitle("  a \n b  ")).toBe("a b");
  });

  it("a_tab_waiting_for_the_person_is_marked_before_the_cut_title", () => {
    expect(tabTitle("Push", true)).toBe("● Push");
    expect(tabTitle("Передача работы: координатор Example CRM", true)).toBe(`● ${tabTitle("Передача работы: координатор Example CRM")}`);
  });
});
