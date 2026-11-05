// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { PILL, TextField } from "../../webview/inputField";

let field: TextField;

function pill(key: string, label: string): HTMLElement {
  const node = document.createElement("span");
  node.className = "att";
  node.dataset["key"] = key;
  node.setAttribute("contenteditable", "false");
  node.textContent = label;
  return node;
}

/** Puts the caret in the field at a text offset, as a click would. */
function caret(at: number): void {
  field.setSelectionRange(at, at);
}

beforeEach(() => {
  document.body.innerHTML = "";
  field = new TextField({ class: "input", "aria-label": "Сообщение агенту" });
  document.body.append(field.element);
});

describe("the composer's text field", () => {
  it("is_an_editable_element_that_starts_empty", () => {
    expect(field.element.isContentEditable || field.element.getAttribute("contenteditable")).toBeTruthy();
    expect(field.value).toBe("");
    expect(field.element.hasAttribute("data-empty")).toBe(true);
  });

  it("reads_back_the_plain_text_it_was_given", () => {
    field.value = "вот тут ошибка";
    expect(field.element.textContent).toBe("вот тут ошибка");
    expect(field.value).toBe("вот тут ошибка");
    expect(field.element.hasAttribute("data-empty")).toBe(false);
  });

  it("keeps_line_breaks_through_a_write_and_a_read", () => {
    field.value = "первая\nвторая\n\nчетвёртая";
    expect(field.value).toBe("первая\nвторая\n\nчетвёртая");
    expect(field.element.querySelectorAll("br").length).toBeGreaterThanOrEqual(3);
  });

  it("counts_a_pill_as_one_character_in_the_text", () => {
    field.value = "вот тут ошибка ";
    caret(field.value.length);
    field.insertNode(pill("1", "screen1.png"));
    field.insertText(" а на втором экране");
    expect(field.value).toBe(`вот тут ошибка ${PILL} а на втором экране`);
    expect(field.pills().map((node) => node.dataset["key"])).toEqual(["1"]);
  });

  it("puts_a_pill_where_the_caret_is_and_leaves_the_text_on_both_sides", () => {
    field.value = "слева справа";
    caret("слева ".length);
    field.insertNode(pill("7", "x.png"));
    expect(field.value).toBe(`слева ${PILL}справа`);
    expect(field.selectionStart).toBe("слева ".length + 1); // after the pill it just put there
  });

  it("puts_several_pills_in_the_order_they_were_given", () => {
    field.value = "раз два";
    caret("раз ".length);
    for (const key of ["a", "b", "c"]) field.insertNode(pill(key, `${key}.png`));
    expect(field.value).toBe(`раз ${PILL}${PILL}${PILL}два`);
    expect(field.pills().map((node) => node.dataset["key"])).toEqual(["a", "b", "c"]);
  });

  it("drops_the_selected_text_when_something_is_inserted_over_it", () => {
    field.value = "убери это слово";
    field.setSelectionRange("убери ".length, "убери это".length);
    field.insertText("то");
    expect(field.value).toBe("убери то слово");
  });

  it("keeps_the_pills_when_the_whole_value_is_rewritten_around_them", () => {
    field.value = "раз";
    caret(3);
    field.insertNode(pill("k", "k.png"));
    const node = field.pills()[0] as HTMLElement;

    field.value = `ulw раз${PILL} хвост`;
    expect(field.pills()[0]).toBe(node); // the same element, not a copy: its picture is not reloaded
    expect(field.value).toBe(`ulw раз${PILL} хвост`);
  });

  it("forgets_a_pill_the_new_value_left_out", () => {
    field.value = "раз";
    caret(3);
    field.insertNode(pill("k", "k.png"));
    field.value = "раз без картинки";
    expect(field.pills()).toHaveLength(0);
    expect(field.value).toBe("раз без картинки");
  });

  it("removes_one_pill_by_key_and_leaves_the_text_alone", () => {
    field.value = "до  после";
    caret("до ".length);
    field.insertNode(pill("gone", "g.png"));
    expect(field.removePill("gone")).toBe(true);
    expect(field.value).toBe("до  после");
    expect(field.removePill("gone")).toBe(false);
  });

  it("reports_the_caret_as_an_offset_in_its_own_text", () => {
    field.value = "раз два три";
    field.setSelectionRange(4, 7);
    expect(field.selectionStart).toBe(4);
    expect(field.selectionEnd).toBe(7);
  });

  it("puts_the_caret_past_a_pill_when_asked_for_the_offset_after_it", () => {
    field.value = "раз ";
    caret(4);
    field.insertNode(pill("p", "p.png"));
    field.insertText(" два");
    field.setSelectionRange(5, 5); // right after the pill
    expect(field.selectionStart).toBe(5);
    expect(field.value.slice(field.selectionStart)).toBe(" два");
  });

  it("shows_the_placeholder_only_while_it_holds_nothing_at_all", () => {
    field.placeholder = "Сообщение агенту";
    expect(field.element.dataset["placeholder"]).toBe("Сообщение агенту");
    expect(field.element.hasAttribute("data-empty")).toBe(true);

    caret(0);
    field.insertNode(pill("only", "only.png"));
    expect(field.element.hasAttribute("data-empty")).toBe(false); // a lone pill is content

    field.removePill("only");
    field.refresh();
    expect(field.element.hasAttribute("data-empty")).toBe(true);
  });

  it("tells_a_caret_inside_itself_from_one_somewhere_else", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    caret(0);
    expect(field.hasCaret()).toBe(true);

    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(field.hasCaret()).toBe(false);
  });
});
