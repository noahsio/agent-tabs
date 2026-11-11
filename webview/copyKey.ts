/** True where a copy key belongs to the field: its own selection, which VS Code's own copy already handles. */
function inField(element: Element | null): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * ⌘C (Ctrl+C) over text selected outside a field copies it at the keystroke. Left to VS Code (1.143), the key is
 * swallowed by the webview's wrapper and a `copy` comes back a moment later — and the wrapper first gives the focus
 * back to the field the person last typed in whenever the document's own focus sits on the body, as it does after a
 * drag over the feed. That focus discards the selection before the copy runs: the selection vanishes and nothing is
 * copied. Listening on the document as the event bubbles leaves a capturing handler (the picture viewer's own ⌘C) its
 * say first, and stops the key before the wrapper's listener on the window sees it.
 */
export function installCopyKey(): void {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.code !== "KeyC" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || inField(document.activeElement)) return;
    if (!document.execCommand("copy")) return; // the browser refused: VS Code's own path is still worth a try
    event.preventDefault();
    event.stopPropagation();
  });
}
