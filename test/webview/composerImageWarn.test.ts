// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { ModelInfo, StateMessage, WebviewMessage } from "../../src/panel/protocol";
import type { Bitmap, ImageCodec } from "../../webview/attachments";
import { Composer } from "../../webview/composer";
import { type as typeInto } from "../helpers/composer";

const codec: ImageCodec = {
  decode: async (): Promise<Bitmap> => ({ width: 10, height: 10 }),
  encode: async () => new Blob(["pixels"], { type: "image/png" }),
};

const ASTRA: ModelInfo = { provider: "gw-openai", id: "gpt-6-astra", name: "GPT 6 Astra", acceptsImages: false };
const OPUS: ModelInfo = { provider: "gw-anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", acceptsImages: true };
const DSV: ModelInfo = { provider: "gw-q", id: "dsv41", name: "DSV 41" }; // the catalog says nothing about input
const MODELS = [ASTRA, OPUS, DSV];

let app: HTMLElement;
let composer: Composer;

/** Shows a state whose selected (manual) model is the given one, with the full catalog present. */
function selectModel(model: ModelInfo | undefined): void {
  const state: Partial<ChatState> = model === undefined ? {} : { model: { provider: model.provider, id: model.id } };
  const message: StateMessage = { type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "manual" }, models: MODELS, reconnectable: true };
  composer.update(message);
}

function role(name: string): HTMLElement {
  return app.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

function send(): HTMLButtonElement {
  return role("send") as HTMLButtonElement;
}

function warn(): HTMLElement {
  return role("image-warn");
}

function type(words: string): void {
  typeInto(app.querySelector(".input") as HTMLElement, words);
}

async function attachImage(): Promise<void> {
  await composer.addFiles([new File(["pixels"], "shot.png", { type: "image/png" })]);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><footer id="composer"></footer></div>';
  app = document.getElementById("app") as HTMLElement;
  composer = new Composer(document.getElementById("composer") as HTMLElement, () => {}, { dropZone: app, codec });
});

describe("the composer's image-capability warning", () => {
  it("warns_and_blocks_the_send_when_a_text_only_model_has_an_image_attached", async () => {
    selectModel(ASTRA);
    type("посмотри");
    expect(warn().hidden).toBe(true);
    expect(send().disabled).toBe(false);

    await attachImage();
    expect(warn().hidden).toBe(false);
    expect(warn().textContent).toContain("GPT 6 Astra");
    expect(send().disabled).toBe(true); // the picture cannot be silently eaten
    expect(send().title).toBe("Модель не принимает картинки — убери вложение или смени модель");
  });

  it("clears_and_re_enables_the_send_once_the_image_is_removed", async () => {
    selectModel(ASTRA);
    type("посмотри");
    await attachImage();
    expect(warn().hidden).toBe(false);

    role("thumb-remove").click();
    expect(warn().hidden).toBe(true);
    expect(send().disabled).toBe(false);
  });

  it("clears_when_the_person_switches_to_an_image_capable_model_with_the_image_still_attached", async () => {
    selectModel(ASTRA);
    type("посмотри");
    await attachImage();
    expect(warn().hidden).toBe(false);
    expect(send().disabled).toBe(true);

    selectModel(OPUS);
    expect(warn().hidden).toBe(true);
    expect(send().disabled).toBe(false);
  });

  it("never_warns_for_a_model_whose_capability_the_catalog_does_not_state", async () => {
    selectModel(DSV);
    type("посмотри");
    await attachImage();
    expect(warn().hidden).toBe(true);
    expect(send().disabled).toBe(false);
  });

  it("leaves_a_text_only_message_to_a_text_only_model_untouched", () => {
    selectModel(ASTRA);
    type("просто текст");
    expect(warn().hidden).toBe(true);
    expect(send().disabled).toBe(false);
    expect(send().title).toBe("Отправить");
  });

  it("appears_as_soon_as_the_person_switches_TO_a_text_only_model_with_an_image_attached", async () => {
    selectModel(OPUS);
    type("посмотри");
    await attachImage();
    expect(warn().hidden).toBe(true);
    expect(send().disabled).toBe(false);

    selectModel(ASTRA);
    expect(warn().hidden).toBe(false);
    expect(send().disabled).toBe(true);
  });
});
