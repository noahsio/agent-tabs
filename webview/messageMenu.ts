import type { Availability, MessageActionsMessage } from "../src/panel/protocol";
import { el, type Post } from "./dom";
import type { PopoverContent } from "./popover";
import type { RewindConfirm } from "./rewindConfirm";

type Item = { role: "fork" | "rewind" | "fork-rewind"; label: string };

const ITEMS: Item[] = [
  { role: "fork", label: "Ответвить разговор отсюда" },
  { role: "rewind", label: "Откатить код сюда" },
  { role: "fork-rewind", label: "Ответвить и откатить код" },
];

/**
 * The ↺ menu of one sent message. Every item stays disabled until the host says what is possible for that message;
 * a disabled one shows why under its label.
 */
export class MessageMenu implements PopoverContent {
  readonly element: HTMLElement;
  private readonly rows = new Map<Item["role"], { row: HTMLButtonElement; hint: HTMLElement }>();
  private blockId: string | undefined;
  /** The message's ↺ button: the focus goes back there when the confirmation closes. */
  private anchor: HTMLElement | undefined;

  constructor(
    private readonly post: Post,
    private readonly confirm: RewindConfirm,
    private readonly done: () => void,
  ) {
    const list = el("div", { class: "pop-list", role: "menu", "aria-label": "Ответвить или откатить" });
    for (const item of ITEMS) {
      const hint = el("span", { class: "desc wrap hint" });
      const row = el(
        "button",
        { type: "button", class: "mrow", "data-row": "", "data-role": item.role, role: "menuitem" },
        el("span", { class: "mtext" }, el("span", { class: "name" }, item.label), hint),
      );
      row.addEventListener("click", () => this.choose(item.role));
      this.rows.set(item.role, { row, hint });
      list.append(row);
    }
    list.addEventListener("keydown", (event) => this.onKey(event));
    this.element = el("div", { class: "pop pop-message-actions", "data-popover": "message-actions" }, list);
  }

  /** For one message: everything disabled until its answer arrives; asks the host. */
  show(blockId: string, anchor?: HTMLElement): void {
    this.blockId = blockId;
    this.anchor = anchor;
    for (const { row, hint } of this.rows.values()) {
      row.disabled = true;
      hint.textContent = "";
    }
    this.post({ type: "messageActions", blockId });
  }

  /** The host's answer; one for another message is dropped. */
  answer(message: MessageActionsMessage): void {
    if (message.blockId !== this.blockId) return;
    const both: Availability = message.rewind.ok ? message.fork : message.rewind;
    this.set("fork", message.fork);
    this.set("rewind", message.rewind);
    this.set("fork-rewind", both);
    [...this.rows.values()].find(({ row }) => !row.disabled)?.row.focus();
  }

  private set(role: Item["role"], availability: Availability): void {
    const entry = this.rows.get(role);
    if (entry === undefined) return;
    entry.row.disabled = !availability.ok;
    entry.hint.textContent = availability.ok ? "" : availability.reason;
  }

  private choose(role: Item["role"]): void {
    const blockId = this.blockId;
    if (blockId === undefined) return;
    this.done();
    if (role === "fork") {
      this.post({ type: "fork", blockId });
      return;
    }
    const fork = role === "fork-rewind";
    const anchor = this.anchor;
    this.confirm.open(blockId, fork, () => anchor?.focus());
    this.post({ type: "rewindPreview", blockId, fork });
  }

  /** ↑/↓ move between the enabled rows. */
  private onKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...this.rows.values()].map(({ row }) => row).filter((row) => !row.disabled);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }
}
