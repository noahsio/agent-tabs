import { MAX_IMAGE_CHARS } from "../src/panel/protocol";
import type { OutgoingImage } from "../src/sessions/controller";

/** Longest side, in pixels, an image may keep (Anthropic's limit once a request carries over 20 images); larger ones are scaled down. */
export const MAX_SIDE = 2000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const ACCEPTED: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const QUALITY = 0.9;
/** An image still over the per-image cap is re-encoded as jpeg at these qualities, in turn, before it is rejected. */
const JPEG_QUALITIES = [0.85, 0.7, 0.55] as const;
const CHUNK = 0x8000;

export const REASONS = {
  type: "Только картинки png/jpeg/gif/webp",
  size: "Файл больше 20 МБ",
  count: "Не больше 5 картинок в сообщении",
  tooLarge: "Картинка слишком большая даже после сжатия",
  total: "Слишком много картинок по объёму для одного сообщения",
  unreadable: "Не удалось прочитать картинку",
} as const;

export type Bitmap = { width: number; height: number; close?(): void };
/** Decoding and encoding, injected so tests run without a real canvas. */
export type ImageCodec = {
  decode(file: Blob): Promise<Bitmap>;
  /** `quality` applies to jpeg/webp; the browser's default when absent. */
  encode(bitmap: Bitmap, width: number, height: number, mimeType: string, quality?: number): Promise<Blob>;
};
/** `width`/`height`: the size that is sent (after any downscale). */
export type PreparedImage = { ok: true; image: OutgoingImage; width: number; height: number } | { ok: false; reason: string };

export const browserCodec: ImageCodec = {
  decode: (file) => createImageBitmap(file),
  encode: (bitmap, width, height, mimeType, quality = QUALITY) =>
    new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) {
        reject(new Error("no 2d context"));
        return;
      }
      context.imageSmoothingQuality = "high";
      if (mimeType === "image/jpeg") {
        context.fillStyle = "#fff"; // jpeg has no alpha: transparent pixels become white, not black
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(bitmap as ImageBitmap, 0, 0, width, height);
      canvas.toBlob((blob) => (blob === null ? reject(new Error("encode failed")) : resolve(blob)), mimeType, quality);
    }),
};

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  return btoa(binary);
}

/**
 * Checks a file and makes it sendable: longest side above 2000 px is scaled down (gif becomes a still png); one still
 * over the per-image cap is re-encoded as jpeg at falling quality, and only rejected when even that does not fit.
 */
export async function prepareImage(file: Blob, name?: string, codec: ImageCodec = browserCodec): Promise<PreparedImage> {
  if (!ACCEPTED.has(file.type)) return { ok: false, reason: REASONS.type };
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, reason: REASONS.size };
  let output: Blob = file;
  let mimeType = file.type;
  let size = { width: 0, height: 0 };
  try {
    const bitmap = await codec.decode(file);
    try {
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = longest > MAX_SIDE ? MAX_SIDE / longest : 1;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      size = { width, height };
      if (scale < 1) {
        mimeType = file.type === "image/gif" ? "image/png" : file.type;
        output = await codec.encode(bitmap, width, height, mimeType);
        if (ACCEPTED.has(output.type)) mimeType = output.type; // a canvas that cannot write webp falls back to png
      }
      for (const quality of JPEG_QUALITIES) {
        if (base64Length(output.size) <= MAX_IMAGE_CHARS) break;
        output = await codec.encode(bitmap, width, height, "image/jpeg", quality);
        mimeType = "image/jpeg";
      }
    } finally {
      bitmap.close?.();
    }
  } catch {
    return { ok: false, reason: REASONS.unreadable };
  }
  if (base64Length(output.size) > MAX_IMAGE_CHARS) return { ok: false, reason: REASONS.tooLarge };
  return { ok: true, image: { mimeType, data: await toBase64(output), ...(name !== undefined ? { name } : {}) }, ...size };
}
