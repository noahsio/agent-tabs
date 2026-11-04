// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { WebviewMessage } from "../../src/panel/protocol";
import type { RewindItem } from "../../src/rewind/plan";
import { RewindConfirm } from "../../webview/rewindConfirm";

let posted: WebviewMessage[];
let confirm: RewindConfirm;
let focusedBack: number;

const text = (selector: string): string => confirm.element.querySelector(selector)?.textContent ?? "";
const groupHeadings = (): string[] => [...confirm.element.querySelectorAll("[data-group] h3")].map((heading) => heading.textContent ?? "");
const rowText = (path: string): string => confirm.element.querySelector(`[data-path="${path}"]`)?.textContent ?? "";
const buttons = (): string[] => [...confirm.element.querySelectorAll(".rc-actions button")].map((button) => button.textContent ?? "");
const confirmButton = (): HTMLButtonElement => confirm.element.querySelector('[data-role="rewind-confirm"]') as HTMLButtonElement;
const cancelButton = (): HTMLButtonElement => confirm.element.querySelector('[data-role="rewind-cancel"]') as HTMLButtonElement;

function preview(fields: { items: RewindItem[] }): void {
  confirm.preview({ type: "rewindPreview", blockId: "c1", fork: false, excerpt: "Fix the bug", ok: true, items: fields.items, fingerprint: "fp" });
}

beforeEach(() => {
  document.body.innerHTML = "";
  posted = [];
  focusedBack = 0;
  confirm = new RewindConfirm((message) => posted.push(message));
  document.body.append(confirm.element);
});

describe("RewindConfirm", () => {
  it("shows_only_the_buttons_until_the_preview_arrives", () => {
    confirm.open("c1", false);
    expect(confirm.isOpen).toBe(true);
    expect(confirm.element.getAttribute("role")).toBe("dialog");
    expect(confirm.element.getAttribute("aria-modal")).toBe("true");
    expect(buttons()).toEqual(["Откатить", "Отмена"]);
    expect(confirmButton().disabled).toBe(true);
    expect(groupHeadings()).toEqual([]);
  });

  it("groups_files_and_marks_overwrites", () => {
    confirm.open("c1", false);
    preview({
      items: [
        { path: "a.txt", action: "restore", changed: "yes" },
        { path: "new.txt", action: "delete", changed: "unknown" },
        { path: "dist/x", action: "skip", reason: "не откатить: файл игнорируется git", changed: "no" },
        { path: "b.txt", action: "restore", changed: "no" },
      ],
    });
    expect(text('[data-role="rewind-title"]')).toBe("Откатить код к сообщению «Fix the bug»?");
    expect(groupHeadings()).toEqual(["вернётся", "будет удалён", "не откатить"]);
    expect(rowText("a.txt")).toContain("изменён после агента — откат затрёт эти изменения");
    expect(rowText("new.txt")).toContain("не проверено");
    expect(rowText("dist/x")).toContain("не откатить: файл игнорируется git");
    expect(rowText("b.txt")).toBe("b.txt");
    expect(buttons()).toEqual(["Откатить", "Отмена"]);
    expect(confirmButton().disabled).toBe(false);
  });

  it("a_preview_for_another_message_is_ignored", () => {
    confirm.open("c1", false);
    confirm.preview({ type: "rewindPreview", blockId: "c2", fork: false, excerpt: "x", ok: true, fingerprint: "fp", items: [{ path: "a", action: "restore", changed: "no" }] });
    expect(confirmButton().disabled).toBe(true);
  });

  it("cancel_posts_nothing_and_closes", () => {
    confirm.open("c1", false, () => focusedBack++);
    preview({ items: [{ path: "a.txt", action: "restore", changed: "no" }] });
    cancelButton().click();
    expect(posted).toEqual([]);
    expect(confirm.isOpen).toBe(false);
    expect(focusedBack).toBe(1);
    confirm.open("c1", false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(confirm.isOpen).toBe(false);
    confirm.open("c1", false);
    confirm.element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(confirm.isOpen).toBe(false);
    expect(posted).toEqual([]);
  });

  it("confirm_posts_rewind_with_the_fork_flag", () => {
    confirm.open("c1", true);
    confirm.preview({ type: "rewindPreview", blockId: "c1", fork: true, excerpt: "x", ok: true, fingerprint: "fp", items: [{ path: "a.txt", action: "restore", changed: "no" }] });
    confirmButton().click();
    expect(posted).toEqual([{ type: "rewind", blockId: "c1", fork: true, fingerprint: "fp" }]);
    expect(confirmButton().disabled).toBe(true);
    confirm.rewound({ type: "rewound", blockId: "c1", ok: true, count: 1 });
    expect(confirm.isOpen).toBe(false);
  });

  it("failed_rewind_shows_the_reason_and_keeps_the_modal", () => {
    confirm.open("c1", false);
    preview({ items: [{ path: "a.txt", action: "restore", changed: "no" }] });
    confirmButton().click();
    confirm.rewound({ type: "rewound", blockId: "c1", ok: false, reason: "x" });
    expect(confirm.isOpen).toBe(true);
    expect(text(".error")).toBe("x");
    expect(confirmButton().disabled).toBe(false);
  });

  it("nothing_to_rewind_says_so", () => {
    confirm.open("c1", false);
    preview({ items: [] });
    expect(confirm.element.textContent).toContain("Агент не менял файлы после этого сообщения");
    expect(confirmButton().disabled).toBe(true);
    confirm.open("c1", true);
    confirm.preview({ type: "rewindPreview", blockId: "c1", fork: true, excerpt: "x", ok: true, fingerprint: "fp", items: [{ path: "d", action: "skip", reason: "не откатить: вне проекта", changed: "no" }] });
    expect(confirmButton().disabled).toBe(false); // the fork still happens
  });

  it("a_failed_preview_shows_its_reason_and_cannot_be_confirmed", () => {
    confirm.open("c1", false);
    confirm.preview({ type: "rewindPreview", blockId: "c1", fork: false, excerpt: "", ok: false, reason: "Дождитесь конца хода" });
    expect(text(".error")).toBe("Дождитесь конца хода");
    expect(confirmButton().disabled).toBe(true);
  });

  it("a_changed_plan_comes_back_as_a_new_preview_with_the_note_and_is_confirmed_by_its_new_fingerprint", () => {
    confirm.open("c1", false);
    preview({ items: [{ path: "a.txt", action: "restore", changed: "no" }] });
    confirmButton().click();
    confirm.preview({ type: "rewindPreview", blockId: "c1", fork: false, excerpt: "Fix the bug", ok: true, fingerprint: "fp2", items: [{ path: "a.txt", action: "restore", changed: "yes" }] });
    confirm.rewound({ type: "rewound", blockId: "c1", ok: false, reason: "Файлы изменились — проверьте список ещё раз" });
    expect(confirm.isOpen).toBe(true);
    expect(text(".error")).toBe("Файлы изменились — проверьте список ещё раз");
    expect(rowText("a.txt")).toContain("изменён после агента");
    confirmButton().click();
    expect(posted).toEqual([
      { type: "rewind", blockId: "c1", fork: false, fingerprint: "fp" },
      { type: "rewind", blockId: "c1", fork: false, fingerprint: "fp2" },
    ]);
  });

  it("tab_stays_inside_the_confirmation", () => {
    confirm.open("c1", false);
    preview({ items: [{ path: "a.txt", action: "restore", changed: "no" }] });
    cancelButton().focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(confirmButton());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(cancelButton());
  });
});
