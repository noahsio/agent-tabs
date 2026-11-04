/** What a popover shows; the manager owns when it is visible and where. */
export interface PopoverContent {
  readonly element: HTMLElement;
  /** Called after the popover is shown. */
  opened?(): void;
  /** Called after it is hidden. */
  closed?(): void;
}

export type Placement = {
  anchor: HTMLElement;
  /**
   * Under the anchor against the webview's right edge (header icons), above it with left edges aligned (composer),
   * or a modal whose own stylesheet centres it over the whole tab.
   */
  side: "below" | "above" | "center";
  /** The element whose bottom (below) or top (above) edge the popover sits against; the anchor by default. */
  level?: HTMLElement;
  /** Clicks here do not count as «outside» (besides the popover and its anchor). */
  inside?: HTMLElement[];
  /** The popover takes the level element's left edge and width (the model picker over the composer). */
  stretch?: boolean;
};

/** Least room kept between a popover and the webview's edges. */
const GUTTER = 16;
const GAP = 6;

/**
 * One popover at a time inside the tab: Esc closes it and returns focus to the composer input,
 * a click outside closes it, opening another closes the first.
 */
export class Popovers {
  private current: { content: PopoverContent; placement: Placement } | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly returnFocus: () => void,
  ) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.current === undefined || event.defaultPrevented) return;
      event.preventDefault();
      this.close();
      this.returnFocus();
    });
    document.addEventListener(
      "mousedown",
      (event) => {
        const placement = this.current?.placement;
        if (placement === undefined || !(event.target instanceof Node)) return;
        const keepers = [this.current?.content.element, placement.anchor, ...(placement.inside ?? [])];
        if (!keepers.some((keeper) => keeper?.contains(event.target as Node))) this.close();
      },
      true,
    );
    window.addEventListener("resize", () => this.place());
  }

  /** Adds a popover's element to the tab, hidden. */
  register(content: PopoverContent): void {
    content.element.hidden = true;
    this.host.append(content.element);
  }

  isOpen(content: PopoverContent): boolean {
    return this.current?.content === content;
  }

  open(content: PopoverContent, placement: Placement): void {
    if (this.current?.content !== content) this.close();
    this.current = { content, placement };
    content.element.hidden = false;
    this.place();
    content.opened?.();
  }

  toggle(content: PopoverContent, placement: Placement): void {
    if (this.isOpen(content)) this.close();
    else this.open(content, placement);
  }

  close(): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    current.content.element.hidden = true;
    current.content.closed?.();
  }

  /** Keeps the popover next to its anchor and inside the webview, at least `GUTTER` from each side. */
  private place(): void {
    if (this.current === undefined) return;
    const { content, placement } = this.current;
    const style = content.element.style;
    const bounds = this.host.getBoundingClientRect();
    const anchor = placement.anchor.getBoundingClientRect();
    const level = (placement.level ?? placement.anchor).getBoundingClientRect();
    const width = content.element.offsetWidth;
    style.top = style.bottom = style.left = "";
    if (placement.side === "center") return;
    if (placement.side === "below") style.top = `${level.bottom - bounds.top + GAP}px`;
    else style.bottom = `${bounds.bottom - level.top + GAP}px`;
    if (placement.stretch === true) {
      style.left = `${level.left - bounds.left}px`;
      style.width = `${level.width}px`;
      return;
    }
    const preferred = placement.side === "below" ? bounds.width : anchor.left - bounds.left; // clamped to the right gutter below
    style.left = `${Math.max(GUTTER, Math.min(preferred, bounds.width - GUTTER - width))}px`;
  }
}
