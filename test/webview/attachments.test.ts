// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_CHARS } from "../../src/panel/protocol";
import { prepareImage, type Bitmap, type ImageCodec } from "../../webview/attachments";

type Encoded = { width: number; height: number; mimeType: string; quality?: number };

/** Bytes whose base64 is just over the per-image cap. */
const OVERSIZE = "a".repeat((MAX_IMAGE_CHARS / 4) * 3 + 3);

/** A codec that reports a fixed size and encodes to the given bytes (or per call), recording each encode. */
function fakeCodec(width: number, height: number, output: string | ((encoded: Encoded) => string) = "small"): ImageCodec & { encoded: Encoded[]; decoded: number } {
  const codec = {
    encoded: [] as Encoded[],
    decoded: 0,
    decode: async (): Promise<Bitmap> => {
      codec.decoded += 1;
      return { width, height };
    },
    encode: async (_bitmap: Bitmap, outWidth: number, outHeight: number, mimeType: string, quality?: number): Promise<Blob> => {
      const encoded: Encoded = { width: outWidth, height: outHeight, mimeType, ...(quality !== undefined ? { quality } : {}) };
      codec.encoded.push(encoded);
      return new Blob([typeof output === "string" ? output : output(encoded)], { type: mimeType });
    },
  };
  return codec;
}

function file(bytes: string, type: string, name = "shot.png"): File {
  return new File([bytes], name, { type });
}

describe("prepareImage", () => {
  it("downscales_large_image_before_send", async () => {
    const codec = fakeCodec(4096, 3072);
    const result = await prepareImage(file("huge-retina-bytes", "image/png"), "shot.png", codec);
    expect(codec.encoded).toEqual([{ width: 2000, height: 1500, mimeType: "image/png" }]);
    expect(result).toEqual({ ok: true, image: { mimeType: "image/png", data: btoa("small"), name: "shot.png" }, width: 2000, height: 1500 }); // the size sent

    const tall = fakeCodec(1000, 5000);
    await prepareImage(file("x", "image/jpeg"), undefined, tall);
    expect(tall.encoded).toEqual([{ width: 400, height: 2000, mimeType: "image/jpeg" }]);

    const gif = fakeCodec(3000, 3000);
    const still = await prepareImage(file("x", "image/gif"), "anim.gif", gif);
    expect(gif.encoded[0]?.mimeType).toBe("image/png");
    expect(still).toEqual({ ok: true, image: { mimeType: "image/png", data: btoa("small"), name: "anim.gif" }, width: 2000, height: 2000 });
  });

  it("small_image_is_sent_as_is", async () => {
    const codec = fakeCodec(800, 600);
    const result = await prepareImage(file("original", "image/webp"), undefined, codec);
    expect(codec.encoded).toEqual([]);
    expect(result).toEqual({ ok: true, image: { mimeType: "image/webp", data: btoa("original") }, width: 800, height: 600 });
  });

  it("rejects_non_image_with_reason", async () => {
    const codec = fakeCodec(100, 100);
    expect(await prepareImage(file("%PDF", "application/pdf", "doc.pdf"), "doc.pdf", codec)).toEqual({ ok: false, reason: "Только картинки png/jpeg/gif/webp" });
    expect(await prepareImage(file("x", "image/heic"), undefined, codec)).toEqual({ ok: false, reason: "Только картинки png/jpeg/gif/webp" });
    expect(codec.decoded).toBe(0);
  });

  it("rejects_source_over_20_mb", async () => {
    const codec = fakeCodec(100, 100);
    const big = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: "image/png" });
    expect(await prepareImage(big, undefined, codec)).toEqual({ ok: false, reason: "Файл больше 20 МБ" });
    expect(codec.decoded).toBe(0);
  });

  it("oversize_image_is_reencoded_as_jpeg_before_it_is_rejected", async () => {
    // A 1800 px screenshot whose png is over the per-image cap: same size, jpeg, falling quality until it fits.
    const codec = fakeCodec(1800, 1200, (encoded) => (encoded.quality !== undefined && encoded.quality <= 0.7 ? "fits" : OVERSIZE));
    const result = await prepareImage(file(OVERSIZE, "image/png"), "shot.png", codec);
    expect(codec.encoded).toEqual([
      { width: 1800, height: 1200, mimeType: "image/jpeg", quality: 0.85 },
      { width: 1800, height: 1200, mimeType: "image/jpeg", quality: 0.7 },
    ]);
    expect(result).toEqual({ ok: true, image: { mimeType: "image/jpeg", data: btoa("fits"), name: "shot.png" }, width: 1800, height: 1200 });
  });

  it("rejects_image_still_too_big_after_every_jpeg_quality", async () => {
    const codec = fakeCodec(4000, 4000, OVERSIZE);
    const result = await prepareImage(file("x", "image/png"), undefined, codec);
    expect(codec.encoded.map((encoded) => [encoded.width, encoded.mimeType, encoded.quality])).toEqual([
      [2000, "image/png", undefined],
      [2000, "image/jpeg", 0.85],
      [2000, "image/jpeg", 0.7],
      [2000, "image/jpeg", 0.55],
    ]);
    expect(result).toEqual({ ok: false, reason: "Картинка слишком большая даже после сжатия" });
  });

  it("unreadable_image_has_a_reason", async () => {
    const codec: ImageCodec = {
      decode: async () => {
        throw new Error("broken");
      },
      encode: async () => new Blob(),
    };
    expect(await prepareImage(file("garbage", "image/png"), undefined, codec)).toEqual({ ok: false, reason: "Не удалось прочитать картинку" });
  });
});
