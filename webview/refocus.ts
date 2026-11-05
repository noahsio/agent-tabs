/** How long after focus comes back a press still counts as the press that brought it back. */
const GRACE_MS = 300;
/** A press whose click never arrived is forgotten after this, so it cannot swallow some later click. */
const PRESS_MS = 1_000;
/** Pressed and released this far apart is a drag — a text selection — and not a click on anything. */
const DRAG_PX = 4;

/** One guard per document: the tab builds its view more than once in tests, and the listeners are the document's. */
let installed = false;

/** True while the person holds a selection: the press that ends one is not a click on what is under it. */
function selecting(): boolean {
  const selection = window.getSelection();
  return selection !== null && selection.rangeCount > 0 && !selection.isCollapsed;
}

/** True where the caret belongs: a press in text must put it there, however the window stood a moment ago. */
function takesCaret(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return true;
  // The composer's input is an editable element; a press on what stands inside it (an attachment chip) is still text.
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('[contenteditable="true"]') !== null);
}

/**
 * The click that brings an unfocused window (or an unfocused webview panel) back only focuses it: whatever sat under
 * the cursor — a tool step's header, «показать всё», ↺, an agent card, a settings row — is not activated, as macOS
 * does it everywhere else. One place for the whole tab: the press is judged here and the click that follows it is
 * swallowed before it reaches any widget.
 *
 * Focus is tracked from the window's own `blur`/`focus` and `visibilitychange` (a webview is blurred both when the
 * window goes away and when the panel does). The ordering of focus against the press differs across platforms, so a
 * press within a short grace after focus returned counts as the refocusing one too. Both latches are spent by the
 * press itself, so a second click always acts; keyboard focus and Tab never pass through here at all.
 */
export function installRefocusGuard(): void {
  if (installed) return;
  installed = true;

  // The tab is built as its panel opens, and a blur is what says otherwise: `document.hasFocus()` is false in plenty
  // of pages that do get the person's clicks (a headless one, a panel the editor has not handed the focus to yet),
  // and starting from it would eat the first click of a tab nobody ever blurred.
  let focused = true;
  let focusedAt = Number.NEGATIVE_INFINITY;
  /** Set by a blur, spent by the next press: at most one click is swallowed per time the tab loses focus. */
  let armed = false;
  /** The press whose click is to be swallowed, and where it landed. */
  let press: { x: number; y: number; at: number } | undefined;

  const lost = (): void => {
    focused = false;
    armed = true;
  };
  const regained = (): void => {
    if (focused) return;
    focused = true;
    focusedAt = Date.now();
  };
  window.addEventListener("blur", lost);
  window.addEventListener("focus", regained);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") lost();
    else regained();
  });

  /** Set once a `pointerdown` has arrived: from then on `mousedown` is that same press, already judged. */
  let pairsPointerEvents = false;

  const onPress = (event: MouseEvent | PointerEvent): void => {
    if (event.type === "pointerdown") pairsPointerEvents = true;
    else if (pairsPointerEvents) return;
    if (event.button !== 0) return; // the secondary button belongs to the editor's menu
    const now = Date.now();
    // Away: a blur we saw, or a document that says it does not hold the focus (a blur that came before this listener
    // did). And the focus must be missing or brand new — focus that came back a while ago, by keystroke or command,
    // leaves an ordinary click, whatever `hasFocus()` says about the panel (jsdom and a headless page say «no» always).
    const away = armed || !document.hasFocus();
    const refocusing = away && (!focused || now - focusedAt < GRACE_MS);
    // The press makes this document the focused one, whatever happens next: nothing swallows the click after it.
    armed = false;
    focused = true;
    focusedAt = Number.NEGATIVE_INFINITY;
    press = refocusing && !takesCaret(event.target) ? { x: event.clientX, y: event.clientY, at: now } : undefined;
  };
  document.addEventListener("pointerdown", onPress, true);
  document.addEventListener("mousedown", onPress, true);

  document.addEventListener(
    "click",
    (event) => {
      const pressed = press;
      press = undefined;
      if (pressed === undefined || event.button !== 0) return;
      if (Date.now() - pressed.at > PRESS_MS) return; // the click of some other press
      if (Math.abs(event.clientX - pressed.x) > DRAG_PX || Math.abs(event.clientY - pressed.y) > DRAG_PX) return; // a drag
      if (selecting()) return; // the gesture selected text; the feed's own handling of that stays as it is
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}
