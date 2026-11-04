import { StringDecoder } from "node:string_decoder";

export const MAX_RECORD_CHARS = 16_777_216;

/**
 * Incremental JSONL decoder. Splits on "\n" only (never U+2028/U+2029), strips a trailing "\r",
 * keeps the partial tail between pushes and looks for "\n" only in the new text.
 * A record longer than the limit is dropped up to its "\n", never buffered and never fatal; `onDrop` hears its size.
 */
export class JsonlDecoder {
  private readonly utf8 = new StringDecoder("utf8");
  private pending = "";
  /** Characters of the record being dropped so far, or undefined while not dropping. */
  private dropped: number | undefined;

  constructor(
    private readonly maxChars: number = MAX_RECORD_CHARS,
    private readonly onDrop: (chars: number) => void = () => {},
  ) {}

  push(chunk: Buffer): unknown[] {
    const parts = this.utf8.write(chunk).split("\n");
    const last = parts.pop() ?? "";
    const records: unknown[] = [];
    for (const part of parts) {
      const dropped = this.dropped;
      this.dropped = undefined;
      const rawLine = this.pending + part;
      this.pending = "";
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (dropped !== undefined || line.length > this.maxChars) {
        this.onDrop((dropped ?? 0) + line.length);
        continue;
      }
      if (line.length === 0) continue;
      records.push(JSON.parse(line) as unknown);
    }
    if (this.dropped !== undefined) this.dropped += last.length;
    else if (this.pending.length + last.length > this.maxChars) {
      this.dropped = this.pending.length + last.length;
      this.pending = "";
    } else {
      this.pending += last;
    }
    return records;
  }
}
