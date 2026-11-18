import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { ChatState } from "../chat/model";
import { applyEntries, initialState } from "../chat/reducer";

/** How much of a long journal the first read takes: the recent turns, never a whole multi-hundred-megabyte history. */
export const FOLLOW_TAIL_BYTES = 4_000_000;

/**
 * A session's journal read from disk and kept up to date as it grows: what a tab shows while another copy of the host
 * holds the session and no client can reach that copy. The entries are the same records `get_entries` returns (the
 * journal minus its header), so the feed is built by the same reducer.
 */
export class JournalFollower {
  state: ChatState = initialState();
  private offset: number | undefined;
  private decoder = new StringDecoder("utf8");
  private partial = "";

  constructor(
    readonly file: string,
    private readonly tailBytes = FOLLOW_TAIL_BYTES,
  ) {}

  /** True once the journal has been read at least once: a file that cannot be read shows nothing. */
  get loaded(): boolean {
    return this.offset !== undefined;
  }

  /** Reads what was appended since the last call; true when the feed changed. */
  async update(): Promise<boolean> {
    const size = (await stat(this.file)).size;
    let skipFirst = false;
    if (this.offset === undefined || size < this.offset) {
      this.state = initialState();
      this.decoder = new StringDecoder("utf8");
      this.partial = "";
      this.offset = Math.max(0, size - this.tailBytes);
      skipFirst = this.offset > 0; // started mid-file: the first line is torn
    }
    if (size === this.offset) return false;
    const buffer = Buffer.alloc(size - this.offset);
    const handle = await open(this.file, "r");
    try {
      await handle.read(buffer, 0, buffer.length, this.offset);
    } finally {
      await handle.close();
    }
    this.offset = size;
    const lines = (this.partial + this.decoder.write(buffer)).split("\n");
    this.partial = lines.pop() ?? "";
    if (skipFirst) lines.shift();
    const entries: unknown[] = [];
    for (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line);
        if (typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type !== "session") entries.push(entry);
      } catch {
        // a complete line that is not JSON will not become JSON later
      }
    }
    if (entries.length === 0) return false;
    this.state = applyEntries(this.state, entries);
    return true;
  }
}
