// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { WebviewMessage } from "../../src/panel/protocol";
import { MessageMenu } from "../../webview/messageMenu";
import { RewindConfirm } from "../../webview/rewindConfirm";

let posted: WebviewMessage[];
let closed: number;
let confirm: RewindConfirm;
let menu: MessageMenu;

const rows = (): HTMLButtonElement[] => [...menu.element.querySelectorAll<HTMLButtonElement>("[data-row]")];
const labels = (): string[] => rows().map((row) => row.querySelector(".name")?.textContent ?? "");
const disabled = (): boolean[] => rows().map((row) => row.disabled);
const hints = (): string[] => rows().map((row) => row.querySelector(".hint")?.textContent ?? "");
const row = (role: string): HTMLButtonElement => menu.element.querySelector(`[data-role="${role}"]`) as HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = "";
  posted = [];
  closed = 0;
  confirm = new RewindConfirm((message) => posted.push(message));
  document.body.append(confirm.element);
  menu = new MessageMenu((message) => posted.push(message), confirm, () => closed++);
  document.body.append(menu.element);
});

describe("MessageMenu", () => {
  it("items_wait_for_the_host_then_show_reasons", () => {
    menu.show("c1");
    expect(posted).toEqual([{ type: "messageActions", blockId: "c1" }]);
    expect(labels()).toEqual(["Ответвить разговор отсюда", "Откатить код сюда", "Ответвить и откатить код"]);
    expect(disabled()).toEqual([true, true, true]);
    menu.answer({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: false, reason: "Снимок не сохранился" } });
    expect(disabled()).toEqual([false, true, true]);
    expect(hints()).toEqual(["", "Снимок не сохранился", "Снимок не сохранился"]);
    menu.answer({ type: "messageActions", blockId: "c1", fork: { ok: false, reason: "Дождитесь конца хода" }, rewind: { ok: true } });
    expect(disabled()).toEqual([true, false, true]);
    expect(hints()).toEqual(["Дождитесь конца хода", "", "Дождитесь конца хода"]);
  });

  it("an_answer_for_another_message_is_ignored", () => {
    menu.show("c1");
    menu.answer({ type: "messageActions", blockId: "c2", fork: { ok: true }, rewind: { ok: true } });
    expect(disabled()).toEqual([true, true, true]);
  });

  it("showing_again_resets_the_items", () => {
    menu.show("c1");
    menu.answer({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: true } });
    menu.show("c2");
    expect(disabled()).toEqual([true, true, true]);
    expect(hints()).toEqual(["", "", ""]);
  });

  it("fork_item_posts_fork_and_closes", () => {
    menu.show("c1");
    menu.answer({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: true } });
    posted.length = 0;
    row("fork").click();
    expect(posted).toEqual([{ type: "fork", blockId: "c1" }]);
    expect(closed).toBe(1);
    expect(confirm.isOpen).toBe(false);
  });

  it("rewind_item_opens_the_confirmation_and_asks_for_a_preview", () => {
    menu.show("c1");
    menu.answer({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: true } });
    posted.length = 0;
    row("rewind").click();
    expect(confirm.isOpen).toBe(true);
    expect(posted).toEqual([{ type: "rewindPreview", blockId: "c1", fork: false }]);
    expect(closed).toBe(1);
    confirm.close();
    posted.length = 0;
    row("fork-rewind").click();
    expect(posted).toEqual([{ type: "rewindPreview", blockId: "c1", fork: true }]);
  });

  it("cancelling_the_confirmation_returns_the_focus_to_the_message_button", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    menu.show("c1", anchor);
    menu.answer({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: true } });
    row("rewind").click();
    confirm.close();
    expect(document.activeElement).toBe(anchor);
  });
});
