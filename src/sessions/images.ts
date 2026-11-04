import type { ImageRef } from "../chat/model";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

type Stored = { mimeType: string; data: string };

/** Image bytes kept outside ChatState: least-recently-used eviction once the total size passes the cap. */
export class ImageStore {
  private readonly items = new Map<string, Stored>();
  private total = 0;

  constructor(private readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

  put(ref: ImageRef, data: string): void {
    this.remove(ref.id);
    this.items.set(ref.id, { mimeType: ref.mimeType, data });
    this.total += data.length;
    for (const [id, stored] of this.items) {
      if (this.total <= this.maxBytes || id === ref.id) break;
      this.items.delete(id);
      this.total -= stored.data.length;
    }
  }

  /** How many images are held. */
  get size(): number {
    return this.items.size;
  }

  /** Forgets every image whose id starts with `prefix` (one tab's scope). */
  dropScope(prefix: string): void {
    for (const id of [...this.items.keys()]) if (id.startsWith(prefix)) this.remove(id);
  }

  get(id: string): Stored | undefined {
    const stored = this.items.get(id);
    if (stored === undefined) return undefined;
    this.items.delete(id); // re-insert: most recently used goes last
    this.items.set(id, stored);
    return stored;
  }

  clear(): void {
    this.items.clear();
    this.total = 0;
  }

  private remove(id: string): void {
    const stored = this.items.get(id);
    if (stored === undefined) return;
    this.items.delete(id);
    this.total -= stored.data.length;
  }
}

/** The one store of this extension host: every tab keeps its images here, each under its own scope. */
export const sharedImages = new ImageStore();
