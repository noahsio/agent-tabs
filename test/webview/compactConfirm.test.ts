// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { WebviewMessage } from "../../src/panel/protocol";
import { CompactConfirm } from "../../webview/compactConfirm";

let posted: WebviewMessage[];
let confirm: CompactConfirm;

beforeEach(() => {
  document.body.replaceChildren();
  posted = [];
  confirm = new CompactConfirm((message) => posted.push(message));
  document.body.append(confirm.element);
});

const click = (role: string): void => (confirm.element.querySelector(`[data-role="${role}"]`) as HTMLButtonElement).click();
const escape = (): void => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

describe("CompactConfirm", () => {
  it("compacts_only_after_the_person_confirms", () => {
    expect(confirm.element.hidden).toBe(true);
    confirm.open();
    expect(confirm.element.hidden).toBe(false);
    expect(confirm.element.textContent).toContain("Сжать контекст?");
    click("compact-confirm");
    expect(posted).toEqual([{ type: "compact" }]);
    expect(confirm.element.hidden).toBe(true);
  });

  it("cancel_escape_and_the_backdrop_close_it_without_compacting", () => {
    confirm.open();
    click("compact-cancel");
    confirm.open();
    escape();
    expect(confirm.element.hidden).toBe(true);
    confirm.open();
    confirm.element.click();
    expect(confirm.element.hidden).toBe(true);
    expect(posted).toEqual([]);
  });
});
