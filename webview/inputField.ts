import { el } from "./dom";

/**
 * The one character a pill takes in the field's text (U+FFFC, the object replacement character): every offset the
 * composer, the «/» menu and the history work in counts a pill as exactly one, so nothing has to know about the DOM.
 */
export const PILL = "￼";

/** A pill is this: an element with a key, which the field never looks inside. */
const PILL_SELECTOR = ".att[data-key]";
/** Defensive only — plain-text paste and our own writes never make these, but a stray one must not swallow a line break. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(["DIV", "P", "LI", "TR"]);

type Point = { node: Node; offset: number };

function isPill(node: Node): boolean {
  return node instanceof HTMLElement && node.matches(PILL_SELECTOR);
}

/**
 * Walks the field's content in document order, building its text; with `stop`, also reports where that DOM position
 * falls in the text. A pill is one PILL character, a `<br>` is a newline, and typed non-breaking spaces read as spaces.
 */
function serialize(root: Node, stop?: Point): { text: string; at: number | undefined } {
  let text = "";
  let at: number | undefined;
  const visit = (parent: Node): void => {
    const children = [...parent.childNodes];
    for (let index = 0; index < children.length; index++) {
      if (stop !== undefined && stop.node === parent && stop.offset === index) at = text.length;
      const node = children[index] as Node;
      if (node.nodeType === Node.TEXT_NODE) {
        const data = (node as Text).data.replace(/ /g, " ");
        if (stop !== undefined && stop.node === node) at = text.length + Math.min(stop.offset, data.length);
        text += data;
        continue;
      }
      if (!(node instanceof HTMLElement)) continue;
      if (isPill(node)) {
        // A selection the browser put inside a pill (a click on its picture) belongs to one of its two sides.
        if (stop !== undefined && (stop.node === node || node.contains(stop.node))) at = text.length + (stop.node === node && stop.offset === 0 ? 0 : 1);
        text += PILL;
        continue;
      }
      if (node.tagName === "BR") {
        text += "\n";
        continue;
      }
      if (BLOCK_TAGS.has(node.tagName) && text !== "" && !text.endsWith("\n")) text += "\n";
      visit(node);
    }
    if (stop !== undefined && stop.node === parent && stop.offset === children.length) at = text.length;
  };
  visit(root);
  return { text, at };
}

/** The DOM position a text offset names: inside a text node where it can be, else beside the node that holds it. */
function pointAt(root: HTMLElement, target: number): Point {
  let seen = 0;
  let last: Point = { node: root, offset: 0 };
  const visit = (parent: Node): boolean => {
    const children = [...parent.childNodes];
    for (let index = 0; index < children.length; index++) {
      const node = children[index] as Node;
      if (node.nodeType === Node.TEXT_NODE) {
        const length = (node as Text).data.length;
        if (target <= seen + length) {
          last = { node, offset: target - seen };
          return true;
        }
        seen += length;
        continue;
      }
      if (!(node instanceof HTMLElement)) continue;
      if (isPill(node) || node.tagName === "BR") {
        if (target === seen) {
          last = { node: parent, offset: index };
          return true;
        }
        seen += 1;
        last = { node: parent, offset: index + 1 };
        continue;
      }
      if (visit(node)) return true;
    }
    last = { node: parent, offset: children.length };
    return target <= seen;
  };
  visit(root);
  return last;
}

/** Text with newlines as the nodes an editable element wants: a `<br>` per break, and not one more (it would read back). */
function textNodes(text: string): Node[] {
  const nodes: Node[] = [];
  text.split("\n").forEach((line, index) => {
    if (index > 0) nodes.push(document.createElement("br"));
    if (line !== "") nodes.push(document.createTextNode(line));
  });
  return nodes;
}

/** A pause in typing this long ends one ⌘Z step: what comes after it is taken back on its own. */
const UNDO_PAUSE_MS = 1_000;

/** What an edit did, for telling where one ⌘Z step ends and the next begins. */
type EditKind = "insert" | "delete" | "other";

function editKind(inputType: string): EditKind {
  return inputType.startsWith("insert") ? "insert" : inputType.startsWith("delete") ? "delete" : "other";
}

/**
 * The composer's input: an editable element whose text may carry pills (image attachments standing in the line where
 * they were put). Everything outside works in offsets of `value`, where a pill is one character — the DOM stays in here.
 */
export class TextField {
  readonly element: HTMLElement;
  /** The last edit the person made by typing; undefined after a paste or an undo, so the next one starts a step. */
  private lastEdit: { kind: EditKind; at: number; endedWithSpace: boolean } | undefined;

  constructor(attributes: Record<string, string> = {}) {
    this.element = el("div", { ...attributes, contenteditable: "true", role: "textbox", "aria-multiline": "true" });
    this.element.addEventListener("beforeinput", (event) => this.splitUndo(event));
    this.refresh();
  }

  /**
   * Smart undo, as in the editor: the browser keeps everything typed in one go as a single step, so one ⌘Z took back a
   * whole message. A step now ends where a new word starts, at a line break, at a pause, and where typing turns into
   * deleting or back; a paste is a step of its own (see `pasteText`).
   */
  private splitUndo(event: InputEvent): void {
    const kind = editKind(event.inputType);
    const data = event.data ?? "";
    const now = Date.now();
    const last = this.lastEdit;
    const split =
      last === undefined ||
      kind !== last.kind ||
      now - last.at > UNDO_PAUSE_MS ||
      event.inputType === "insertLineBreak" ||
      event.inputType === "insertParagraph" ||
      (event.inputType === "insertText" && last.endedWithSpace && /^\S/.test(data));
    if (split) this.closeTyping();
    this.lastEdit = kind === "other" ? undefined : { kind, at: now, endedWithSpace: /\s$/.test(data) };
  }

  /**
   * Ends the step the browser is gathering typing into: setting the selection again (to where it already is) closes it,
   * so whatever comes next is a step of its own.
   */
  private closeTyping(): void {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  get value(): string {
    return serialize(this.element).text;
  }

  /**
   * Replaces the content. Each PILL in the new text takes the next pill the field already holds, in order, so a caller
   * that rewrites the text around them (the «/» menu, a recalled message) never rebuilds a picture.
   */
  set value(next: string) {
    const pills = this.pills();
    let taken = 0;
    const nodes: Node[] = [];
    for (const part of next.split(PILL)) {
      if (nodes.length > 0) {
        const pill = pills[taken++];
        if (pill !== undefined) nodes.push(pill);
      }
      nodes.push(...textNodes(part));
    }
    this.element.replaceChildren(...nodes);
    this.refresh();
  }

  get placeholder(): string {
    return this.element.dataset["placeholder"] ?? "";
  }

  set placeholder(text: string) {
    this.element.dataset["placeholder"] = text;
  }

  /** The pills it holds, in the order they stand in the text. */
  pills(): HTMLElement[] {
    return [...this.element.querySelectorAll<HTMLElement>(PILL_SELECTOR)];
  }

  pill(key: string): HTMLElement | undefined {
    return this.pills().find((node) => node.dataset["key"] === key);
  }

  /** True when it was there to remove. */
  removePill(key: string): boolean {
    const node = this.pill(key);
    if (node === undefined) return false;
    node.remove();
    this.refresh();
    return true;
  }

  focus(): void {
    this.element.focus();
  }

  blur(): void {
    this.element.blur();
  }

  /** True while the person's caret (or selection) is in this field. */
  hasCaret(): boolean {
    const range = this.range();
    return range !== undefined && this.element.contains(range.commonAncestorContainer);
  }

  get selectionStart(): number {
    const range = this.range();
    if (range === undefined || !this.element.contains(range.commonAncestorContainer)) return this.value.length;
    return serialize(this.element, { node: range.startContainer, offset: range.startOffset }).at ?? 0;
  }

  get selectionEnd(): number {
    const range = this.range();
    if (range === undefined || !this.element.contains(range.commonAncestorContainer)) return this.value.length;
    return serialize(this.element, { node: range.endContainer, offset: range.endOffset }).at ?? 0;
  }

  setSelectionRange(start: number, end: number = start): void {
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    const from = pointAt(this.element, start);
    const to = pointAt(this.element, end);
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Plain text at the caret (over the selection, if any), the way a paste of a rich fragment must land. */
  insertText(text: string): void {
    if (this.edit("insertText", text)) return;
    this.insertNodes(textNodes(text));
  }

  /**
   * Pasted text at the caret, undoable like typing. VS Code pastes into a webview with `execCommand("paste")`, and the
   * browser refuses an editing command run from inside another one: written by hand instead, the paste skipped the undo
   * stack and ⌘Z could not take it back. So a refused one goes in with the editor's own command as soon as VS Code's
   * command is over (the microtask runs once the script that called it has returned). `done` runs once it is in.
   * The typing before it and after it are closed off, so ⌘Z takes back the paste alone, as a native paste does.
   */
  pasteText(text: string, done: () => void): void {
    const insert = (): boolean => {
      this.closeTyping();
      const inserted = this.edit("insertText", text);
      if (inserted) this.closeTyping();
      this.lastEdit = undefined;
      return inserted;
    };
    if (insert()) return done();
    if (document.activeElement !== this.element || typeof document.execCommand !== "function") {
      this.insertNodes(textNodes(text));
      return done();
    }
    queueMicrotask(() => {
      if (!insert()) this.insertNodes(textNodes(text));
      done();
    });
  }

  /** One pill at the caret; the caret ends up just past it, ready for the next word. */
  insertNode(node: Element): void {
    if (this.edit("insertHTML", node.outerHTML)) return;
    this.insertNodes([node]);
  }

  insertNodes(nodes: Node[]): void {
    if (nodes.length === 0) return;
    const range = this.caretRange();
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    const last = nodes[nodes.length - 1] as Node;
    range.insertNode(fragment);
    const selection = window.getSelection();
    if (selection !== null) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      selection.removeAllRanges();
      selection.addRange(after);
    }
    this.refresh();
  }

  /**
   * Re-reads what it holds: the placeholder shows only while there is neither text nor a pill. Marked by an attribute
   * of its own, not a class named `empty` — the feed's own hint already owns that class, margins and all.
   */
  refresh(): void {
    // Erasing everything typed leaves the browser's own `<br>` behind (it holds the line open), which reads as a newline
    // and kept the placeholder away; a line the person breaks takes two of them, so a lone one is never theirs.
    if (this.element.childNodes.length === 1 && this.element.firstChild instanceof HTMLBRElement) this.element.replaceChildren();
    this.element.toggleAttribute("data-empty", this.value === "");
  }

  /**
   * The browser's own editing command, so what is put in joins the editor's undo stack — a direct DOM change does not,
   * and the person's ⌘Z would then step over it. False when there is no such command (jsdom) or the field is not where
   * the editing is happening: `insertNodes` then does it by hand.
   */
  private edit(command: "insertText" | "insertHTML", value: string): boolean {
    if (document.activeElement !== this.element) return false;
    const run = (document as Document & { execCommand?: (command: string, ui: boolean, value: string) => boolean }).execCommand;
    let done = false;
    try {
      done = run?.call(document, command, false, value) === true;
    } catch {
      return false;
    }
    if (done) this.refresh();
    return done;
  }

  private range(): Range | undefined {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) return undefined;
    return selection.getRangeAt(0);
  }

  /** Where an insertion goes: the live caret when it is in here, otherwise the very end. */
  private caretRange(): Range {
    const range = this.range();
    if (range !== undefined && this.element.contains(range.commonAncestorContainer)) return range;
    const end = document.createRange();
    end.selectNodeContents(this.element);
    end.collapse(false);
    return end;
  }
}
