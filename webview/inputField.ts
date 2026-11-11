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

/**
 * The composer's input: an editable element whose text may carry pills (image attachments standing in the line where
 * they were put). Everything outside works in offsets of `value`, where a pill is one character — the DOM stays in here.
 */
export class TextField {
  readonly element: HTMLElement;

  constructor(attributes: Record<string, string> = {}) {
    this.element = el("div", { ...attributes, contenteditable: "true", role: "textbox", "aria-multiline": "true" });
    this.refresh();
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
