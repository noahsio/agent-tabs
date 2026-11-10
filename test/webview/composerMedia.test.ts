// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { WebviewMessage } from "../../src/panel/protocol";
import { Composer } from "../../webview/composer";
import type { FeedImage } from "../../webview/feed";
import { PILL } from "../../webview/inputField";
import { pills } from "../helpers/composer";

type Send = Extract<WebviewMessage, { type: "send" }>;
let root: HTMLElement;
let composer: Composer;
let posted: WebviewMessage[];
let opened: { images: FeedImage[]; index: number }[];

function history(blocks: Block[]): void {
  composer.update({ type: "state", state: { ...initialState(), blocks }, tab: { modelMode: "auto" }, reconnectable: true });
}

function key(value: string): void {
  composer.input.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}

function sent(): Send {
  const message = posted.filter((message) => message.type === "send").at(-1);
  if (message?.type !== "send") throw new Error("Nothing sent");
  return message;
}

async function attach(name: string, spot: "caret" | "shelf" = "caret"): Promise<void> {
  await composer.addFiles([new File([name], name, { type: "image/png" })], spot);
}

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("footer");
  document.body.append(root);
  posted = [];
  opened = [];
  composer = new Composer(root, (message) => posted.push(message), {
    codec: { decode: async () => ({ width: 120, height: 80 }), encode: async () => new Blob() },
    onOpenImage: (images, index) => opened.push({ images, index }),
  });
  history([]);
});

afterEach(() => composer.dispose());

describe("composer media", () => {
  it("opens_inline_and_shelf_images_in_reading_order_without_removing_them", async () => {
    await attach("shelf.png", "shelf");
    composer.field.value = "text";
    composer.field.setSelectionRange(4);
    await attach("last.png");
    composer.field.setSelectionRange(0);
    await attach("first.png");
    pills(composer.input)[1]?.querySelector<HTMLElement>(".tn")?.click();
    expect(opened[0]).toEqual({
      images: ["first.png", "last.png", "shelf.png"].map((name) => ({ id: expect.any(String), dataUrl: `data:image/png;base64,${btoa(name)}` })),
      index: 1,
    });
    expect(composer.field.value).toBe(`${PILL} text ${PILL} `);
    root.querySelector<HTMLElement>('[data-role="thumb-view"]')?.click();
    expect(opened[1]?.index).toBe(2);
    pills(composer.input)[0]?.querySelector<HTMLElement>('[data-role="pill-remove"]')?.click();
    expect(opened).toHaveLength(2);
    expect(composer.field.value).toBe(`text ${PILL} `);
  });

  it("recalls_literal_markers_and_edge_pills_without_duplicating_images", async () => {
    const literal = ' typed "[картинка" and [картинка 1] ';
    composer.field.value = literal;
    composer.field.setSelectionRange(literal.length);
    await attach("end.png");
    composer.field.setSelectionRange(0);
    await attach("start.png");
    await attach("shelf.png", "shelf");
    key("Enter");
    const original = sent();
    history([{ kind: "user", id: original.id, text: original.text, images: original.images?.map((image, index) => ({ id: `image-${index}`, mimeType: image.mimeType, name: image.name })) }]);
    key("ArrowUp");
    expect(composer.field.value).toBe(`${PILL}${literal}${PILL} `);
    expect(pills(composer.input)).toHaveLength(2);
    expect(root.querySelectorAll(".thumb")).toHaveLength(1);
    original.images?.forEach((image, index) => composer.image(`image-${index}`, `data:${image.mimeType};base64,${image.data}`));
    await vi.waitFor(() => expect(root.querySelectorAll('[data-status="pending"]')).toHaveLength(0));
    key("Enter");
    expect(sent().text).toBe(original.text);
    expect(sent().images).toEqual(original.images);
  });

  it("returns_a_draft_starting_with_a_pill_and_literal_marker_after_down", async () => {
    history([{ kind: "user", id: "older", text: "older" }]);
    composer.field.value = "[картинка 1] draft";
    composer.field.setSelectionRange(0);
    await attach("draft.png");
    await attach("shelf.png", "shelf");
    composer.field.setSelectionRange(0);
    key("ArrowUp");
    composer.field.setSelectionRange(composer.field.value.length);
    key("ArrowDown");
    expect(composer.field.value).toBe(`${PILL} [картинка 1] draft`);
    expect(pills(composer.input)).toHaveLength(1);
    expect(root.querySelectorAll(".thumb")).toHaveLength(1);
  });

  it("ignores_a_late_missing_image_after_another_message_is_recalled", () => {
    history([
      { kind: "user", id: "old", text: "older" },
      { kind: "user", id: "new", text: "before [картинка 1] after", images: [{ id: "gone", mimeType: "image/png" }] },
    ]);
    key("ArrowUp");
    key("ArrowUp");
    composer.image("gone", "");
    expect(composer.field.value).toBe("older");
    expect(pills(composer.input)).toHaveLength(0);
  });
});
