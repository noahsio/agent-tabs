import type { WebviewMessage } from "../src/panel/protocol";
import { icon } from "./icons";

export type Post = (message: WebviewMessage) => void;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

export function button(content: Node | string, attributes: Record<string, string>, onClick: () => void): HTMLButtonElement {
  const element = el("button", { type: "button", ...attributes }, content);
  element.addEventListener("click", onClick);
  return element;
}

const COPY_LABEL = "Копировать";
const COPIED_LABEL = "Скопировано";
/** How long a copy control shows its tick before it is a copy control again. */
const COPIED_MS = 1_400;

/**
 * Puts `text` on the clipboard. `navigator.clipboard` where the webview may use it, else a hidden field and the
 * editing command, which works from inside a click; the person's own selection is put back either way.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // no clipboard permission (or no API at all): the old path below
  }
  const field = el("textarea", { class: "copy-sink", "aria-hidden": "true" });
  field.value = text;
  document.body.append(field);
  const selection = window.getSelection();
  const kept = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
  try {
    field.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    if (kept !== undefined) {
      selection?.removeAllRanges();
      selection?.addRange(kept);
    }
  }
}

/**
 * A small copy control, shown on hover (CSS). `text` is read at the click, so a growing box copies what it holds then;
 * a copy that went through shows a tick for a moment.
 */
export function copyButton(text: () => string): HTMLButtonElement {
  const control = button(icon("copy"), { class: "icon-btn copy-btn", "data-role": "copy", title: COPY_LABEL, "aria-label": COPY_LABEL }, () => {
    void copyText(text()).then((ok) => {
      if (!ok) return; // nothing to tell: the clipboard is the editor's, not ours
      control.classList.add("copied");
      control.title = COPIED_LABEL;
      control.setAttribute("aria-label", COPIED_LABEL);
      control.replaceChildren(icon("check"));
      setTimeout(() => {
        control.classList.remove("copied");
        control.title = COPY_LABEL;
        control.setAttribute("aria-label", COPY_LABEL);
        control.replaceChildren(icon("copy"));
      }, COPIED_MS);
    });
  });
  return control;
}

/** A path or URL as text with a line-break opportunity after every «/», so a long one wraps at its separators. */
export function breakable(text: string): (Node | string)[] {
  return text.split("/").flatMap((part, index, parts) => (index < parts.length - 1 ? [`${part}/`, document.createElement("wbr")] : [part]));
}
