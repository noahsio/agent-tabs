import { PILL } from "../../webview/inputField";

/** What the composer's editable input holds, read the way the field reads it: an attachment pill is one character. */
export function text(input: HTMLElement): string {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node as Text).data;
    if (!(node instanceof HTMLElement)) return "";
    if (node.matches(".att[data-key]")) return PILL;
    if (node.tagName === "BR") return "\n";
    return [...node.childNodes].map(read).join("");
  };
  return [...input.childNodes].map(read).join("");
}

/** Types into the composer the way a person does: it replaces the words and the composer hears about the change. */
export function type(input: HTMLElement, value: string): void {
  const nodes: Node[] = [];
  value.split("\n").forEach((line, index) => {
    if (index > 0) nodes.push(document.createElement("br"));
    if (line !== "") nodes.push(document.createTextNode(line));
  });
  input.replaceChildren(...nodes);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The attachment pills standing in the text, in the order they stand. */
export function pills(input: HTMLElement): HTMLElement[] {
  return [...input.querySelectorAll<HTMLElement>(".att[data-key]")];
}
