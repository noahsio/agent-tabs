import { browserCodec } from "./attachments";
import { button, el } from "./dom";

export type LightboxImage = { id: string; dataUrl?: string };
export type LightboxOptions = {
  /** Puts the picture on the clipboard; injected in tests. */
  copyImage?: (dataUrl: string) => Promise<void>;
};

const HINT = "←/→ листать · Esc закрыть · ⌘C копировать";

/** The clipboard takes only png from a page, so other formats are re-encoded first. */
async function copyToClipboard(dataUrl: string): Promise<void> {
  const comma = dataUrl.indexOf(",");
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(";"));
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  let blob = new Blob([bytes], { type: mimeType });
  if (mimeType !== "image/png") {
    const bitmap = await browserCodec.decode(blob);
    try {
      blob = await browserCodec.encode(bitmap, bitmap.width, bitmap.height, "image/png");
    } finally {
      bitmap.close?.();
    }
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/** Full-window picture viewer: ←/→ step through the message's pictures, Esc closes, ⌘C copies. */
export class Lightbox {
  readonly element: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly close: HTMLButtonElement;
  private readonly copyImage: (dataUrl: string) => Promise<void>;
  private readonly onKey = (event: KeyboardEvent): void => this.onKeyDown(event);
  private images: LightboxImage[] = [];
  private index = 0;
  private returnFocus: HTMLElement | null = null;

  constructor(options: LightboxOptions = {}) {
    this.copyImage = options.copyImage ?? copyToClipboard;
    this.stage = el("div", { class: "lightbox-stage" });
    this.caption = el("div", { class: "cap", "data-role": "lightbox-caption" });
    this.prev = button("‹", { class: "nav prev", "data-role": "lightbox-prev", "aria-label": "Предыдущая картинка" }, () => this.show(this.index - 1));
    this.next = button("›", { class: "nav next", "data-role": "lightbox-next", "aria-label": "Следующая картинка" }, () => this.show(this.index + 1));
    this.close = button("✕", { class: "close", "data-role": "lightbox-close", "aria-label": "Закрыть" }, () => this.hide());
    this.element = el("div", { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": "Просмотр картинки" }, this.close, this.prev, this.stage, this.caption, this.next);
    this.element.hidden = true;
    this.element.addEventListener("click", (event) => {
      if (event.target === this.element) this.hide(); // the backdrop, not the picture or a button
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open(images: LightboxImage[], index: number): void {
    if (images.length === 0) return;
    this.images = images.map((image) => ({ ...image }));
    if (this.element.hidden) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener("keydown", this.onKey, true);
      this.element.hidden = false;
    }
    this.show(index);
    this.close.focus();
  }

  /** Bytes that arrived after the viewer opened (the host's answer to `getImage`). */
  image(id: string, dataUrl: string): void {
    const image = this.images.find((candidate) => candidate.id === id);
    if (image === undefined || dataUrl === "") return;
    image.dataUrl = dataUrl;
    if (!this.element.hidden && this.images[this.index] === image) this.show(this.index);
  }

  private show(index: number): void {
    this.index = Math.min(Math.max(index, 0), this.images.length - 1);
    const dataUrl = this.images[this.index]?.dataUrl;
    this.stage.replaceChildren(dataUrl !== undefined ? el("img", { src: dataUrl, alt: "" }) : el("div", { class: "lightbox-missing" }, "Нет превью"));
    this.caption.textContent = `${this.index + 1} / ${this.images.length} · ${HINT}`;
    this.prev.disabled = this.index === 0;
    this.next.disabled = this.index === this.images.length - 1;
  }

  private hide(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    document.removeEventListener("keydown", this.onKey, true);
    this.stage.replaceChildren();
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    const copy = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c";
    if (event.key !== "Escape" && event.key !== "ArrowLeft" && event.key !== "ArrowRight" && !copy) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") this.hide();
    else if (event.key === "ArrowLeft") this.show(this.index - 1);
    else if (event.key === "ArrowRight") this.show(this.index + 1);
    else {
      const dataUrl = this.images[this.index]?.dataUrl;
      if (dataUrl !== undefined) this.copyImage(dataUrl).catch(() => undefined); // no clipboard access: nothing to tell
    }
  }
}
