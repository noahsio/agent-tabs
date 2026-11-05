// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRow, ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { StateMessage, WebviewMessage } from "../../src/panel/protocol";
import type { Bitmap, ImageCodec } from "../../webview/attachments";
import { Composer } from "../../webview/composer";
import type { FeedImage } from "../../webview/feed";
import { pills, text, type } from "../helpers/composer";

type Send = Extract<WebviewMessage, { type: "send" }>;

let app: HTMLElement;
let posted: WebviewMessage[];
let opened: { images: FeedImage[]; index: number }[];
let calls: string[];
let composer: Composer;

const codec: ImageCodec = {
  decode: async (): Promise<Bitmap> => ({ width: 100, height: 100 }),
  encode: async () => new Blob(["never"], { type: "image/png" }),
};

function show(state: Partial<ChatState> = {}, extra: Partial<StateMessage> = {}): void {
  composer.update({ type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "auto" }, reconnectable: true, ...extra });
}

function input(): HTMLElement {
  return app.querySelector(".input") as HTMLElement;
}

function role(name: string): HTMLElement {
  return app.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

function thumbs(): HTMLElement[] {
  return [...app.querySelectorAll<HTMLElement>(".thumb")];
}

function png(name: string, bytes = name): File {
  return new File([bytes], name, { type: "image/png" });
}

/** jsdom has no DataTransfer: give a plain event the fields the composer reads. */
function withFiles(type: string, files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"], dropEffect: "none" } });
  return event;
}

/** A paste as Chromium reports it: files plus the clipboard's string flavours. */
function pasteOf(files: File[], strings: Record<string, string> = {}): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  const types = [...Object.keys(strings), ...(files.length > 0 ? ["Files"] : [])];
  Object.defineProperty(event, "clipboardData", { value: { files, types, getData: (type: string) => strings[type] ?? "" } });
  return event;
}

function press(key: string, modifiers: { altKey?: boolean; shiftKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  input().dispatchEvent(event);
  return event;
}

async function settled(count: number): Promise<void> {
  await vi.waitFor(() => expect(app.querySelectorAll('.thumb:not([data-status="pending"])')).toHaveLength(count));
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><footer id="composer"></footer></div>';
  app = document.getElementById("app") as HTMLElement;
  posted = [];
  opened = [];
  calls = [];
  composer = new Composer(document.getElementById("composer") as HTMLElement, (message) => posted.push(message), {
    dropZone: app,
    codec,
    onAgents: () => calls.push("agents"),
    onModel: () => calls.push("model"),
    onSlash: () => calls.push("slash"),
    onOpenImage: (images, index) => opened.push({ images, index }),
  });
  app.append(composer.overlay);
  show();
});

describe("Composer", () => {
  it("paste_image_adds_thumbnail", async () => {
    const paste = pasteOf([png("image.png", "pixels")]);
    input().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await settled(1);
    const thumb = thumbs()[0] as HTMLElement;
    expect(thumb.dataset["status"]).toBe("ready");
    expect(thumb.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${btoa("pixels")}`);
    expect(thumb.querySelector('[data-role="thumb-name"]')?.textContent).toBe("image.png");
    expect(thumb.querySelector('[data-role="thumb-size"]')?.textContent).toBe("100×100"); // the size that will be sent

    (thumb.querySelector('[data-role="thumb-view"]') as HTMLButtonElement).click();
    expect(opened).toEqual([{ images: [{ id: expect.any(String), dataUrl: `data:image/png;base64,${btoa("pixels")}` }], index: 0 }]);

    (thumb.querySelector('[data-role="thumb-remove"]') as HTMLButtonElement).click();
    expect(thumbs()).toHaveLength(0);
  });

  it("images_over_the_per_message_total_are_marked_and_not_sent", async () => {
    const big = (name: string): File => png(name, "a".repeat(3_400_000)); // 4 533 336 base64 chars each
    await composer.addFiles([big("1.png"), big("2.png"), big("3.png")]);
    expect(thumbs().map((thumb) => thumb.dataset["status"])).toEqual(["ready", "ready", "error"]);
    expect(thumbs()[2]?.getAttribute("title")).toBe("Слишком много картинок по объёму для одного сообщения");
    expect(role("attach-notes").textContent).toContain("3.png — Слишком много картинок по объёму для одного сообщения");

    type(input(), "смотри");
    press("Enter");
    const send = posted.at(-1) as Send;
    expect(send.images).toHaveLength(2);
    expect(send.images?.reduce((total, image) => total + image.data.length, 0)).toBeLessThanOrEqual(12_000_000);
  });

  it("removing_an_image_frees_room_for_one_marked_over_the_total", async () => {
    const big = (name: string): File => png(name, "a".repeat(3_400_000));
    await composer.addFiles([big("1.png"), big("2.png"), big("3.png")]);
    (thumbs()[0]?.querySelector('[data-role="thumb-remove"]') as HTMLButtonElement).click();
    expect(thumbs().map((thumb) => thumb.dataset["status"])).toEqual(["ready", "ready"]);
  });

  it("office_paste_with_text_and_a_file_puts_the_text_in_plain", () => {
    const paste = pasteOf([new File(["emf"], "image.emf", { type: "application/octet-stream" })], { "text/plain": "ячейка" });
    input().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true); // the field is editable: its own paste would bring the markup in
    expect(text(input())).toBe("ячейка");
    expect(thumbs()).toHaveLength(0);

    const onlyAFile = pasteOf([new File(["%PDF"], "doc.pdf", { type: "application/pdf" })]);
    input().dispatchEvent(onlyAFile);
    expect(onlyAFile.defaultPrevented).toBe(false); // nothing to put in: the file is not a picture
    expect(thumbs()).toHaveLength(0);
  });

  it("a_paste_of_files_without_pictures_says_only_pictures_for_a_moment", () => {
    vi.useFakeTimers();
    try {
      input().dispatchEvent(pasteOf([new File(["%PDF"], "doc.pdf", { type: "application/pdf" })]));
      expect(role("attach-notice").hidden).toBe(false);
      expect(role("attach-notice").textContent).toBe("Можно прикладывать только картинки");
      expect(thumbs()).toHaveLength(0);
      vi.advanceTimersByTime(3_000);
      expect(role("attach-notice").hidden).toBe(true);

      input().dispatchEvent(pasteOf([new File(["emf"], "x.emf", { type: "application/x-emf" })], { "text/plain": "ячейка" })); // text wins, no notice
      expect(role("attach-notice").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paste_with_picture_and_text_keeps_only_the_text", async () => {
    // An office copy of cells carries a PNG of them too: the text wins.
    const paste = pasteOf([png("chart.png"), new File(["emf"], "chart.emf", { type: "application/x-emf" })], { "text/plain": "A1\tB1" });
    input().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(text(input())).toBe("A1\tB1"); // the words, not the picture of them
    expect(thumbs()).toHaveLength(0);

    // The caret is in the words that just landed, so the picture goes there as a pill.
    const blankText = pasteOf([png("shot.png")], { "text/plain": " \n" });
    input().dispatchEvent(blankText);
    expect(blankText.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(pills(input())[0]?.dataset["status"]).toBe("ready"));
    expect(pills(input()).map((pill) => pill.textContent)).toEqual([expect.stringContaining("shot.png")]);
    expect(thumbs()).toHaveLength(0);
  });

  it("a_rich_fragment_lands_as_plain_text", () => {
    const paste = pasteOf([], { "text/plain": "просто текст", "text/html": "<b style='color:red'>просто</b> текст" });
    input().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(text(input())).toBe("просто текст");
    expect(input().querySelector("b")).toBeNull(); // the markup never reaches the field
    expect(thumbs()).toHaveLength(0);
  });

  it("an_unnamed_picture_is_called_image_png_and_an_error_chip_has_no_size", async () => {
    input().dispatchEvent(pasteOf([new File(["pixels"], "", { type: "image/png" })]));
    await settled(1);
    expect(thumbs()[0]?.querySelector('[data-role="thumb-name"]')?.textContent).toBe("image.png");
    await composer.addFiles([new File(["%PDF"], "doc.pdf", { type: "application/pdf" })]);
    const error = thumbs()[1] as HTMLElement;
    expect(error.dataset["status"]).toBe("error");
    expect(error.querySelector('[data-role="thumb-size"]')).toBeNull();
    expect(error.querySelector('[data-role="thumb-view"]')).toBeNull();
    expect(error.querySelector('[data-role="thumb-remove"]')).not.toBeNull();
  });

  it("rejected_file_shows_its_reason_and_is_not_sent", async () => {
    await composer.addFiles([new File(["%PDF"], "doc.pdf", { type: "application/pdf" }), png("ok.png")]);
    const [bad] = thumbs();
    expect(bad?.dataset["status"]).toBe("error");
    expect(role("attach-notes").textContent).toContain("doc.pdf — Только картинки png/jpeg/gif/webp");
    type(input(), "смотри");
    press("Enter");
    expect((posted[0] as Send).images).toEqual([{ mimeType: "image/png", data: btoa("ok.png"), name: "ok.png" }]);
  });

  it("rejects_sixth_image", async () => {
    await composer.addFiles([1, 2, 3, 4, 5, 6].map((index) => png(`${index}.png`)));
    const statuses = thumbs().map((thumb) => thumb.dataset["status"]);
    expect(statuses).toEqual(["ready", "ready", "ready", "ready", "ready", "error"]);
    expect(role("attach-notes").textContent).toContain("6.png — Не больше 5 картинок в сообщении");

    (thumbs()[0]?.querySelector('[data-role="thumb-remove"]') as HTMLButtonElement).click();
    await composer.addFiles([png("7.png")]);
    expect(thumbs().filter((thumb) => thumb.dataset["status"] === "ready")).toHaveLength(5);
  });

  it("drop_overlay_shows_and_hides", async () => {
    const overlay = composer.overlay;
    expect(overlay.hidden).toBe(true);
    expect(overlay.textContent).toBe("Отпустите, чтобы приложить картинку");
    const enter = withFiles("dragenter", []);
    app.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(overlay.hidden).toBe(false);
    input().dispatchEvent(withFiles("dragenter", [])); // moving over a child
    app.dispatchEvent(withFiles("dragleave", []));
    expect(overlay.hidden).toBe(false);
    app.dispatchEvent(withFiles("dragleave", []));
    expect(overlay.hidden).toBe(true);

    app.dispatchEvent(withFiles("dragenter", []));
    const over = withFiles("dragover", []);
    app.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = withFiles("drop", [png("dropped.png")]);
    app.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(overlay.hidden).toBe(true);
    await settled(1);
    expect(thumbs()[0]?.textContent).toContain("dropped.png");
  });

  it("plus_opens_the_file_picker", async () => {
    const picker = app.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker.hidden).toBe(true);
    expect(picker.accept).toBe("image/*");
    expect(picker.multiple).toBe(true);
    const clicked = vi.fn();
    picker.addEventListener("click", clicked);
    role("attach").click();
    expect(clicked).toHaveBeenCalledOnce();
    Object.defineProperty(picker, "files", { configurable: true, value: [png("picked.png")] });
    picker.dispatchEvent(new Event("change"));
    await settled(1);
    expect(thumbs()[0]?.textContent).toContain("picked.png");
  });

  it("send_includes_images_and_clears_after_ack", async () => {
    await composer.addFiles([png("a.png"), png("b.png")]);
    type(input(), "вот что вижу");
    press("Enter");
    const first = posted[0] as Send;
    expect(first).toEqual({
      type: "send",
      id: expect.any(String),
      text: "вот что вижу",
      mode: "auto",
      images: [
        { mimeType: "image/png", data: btoa("a.png"), name: "a.png" },
        { mimeType: "image/png", data: btoa("b.png"), name: "b.png" },
      ],
    });
    expect(text(input())).toBe("");
    expect(thumbs()).toHaveLength(0);

    composer.sent(first.id, true);
    expect(text(input())).toBe("");
    expect(thumbs()).toHaveLength(0);

    await composer.addFiles([png("c.png")]);
    type(input(), "ещё");
    press("Enter", { altKey: true });
    const second = posted[1] as Send;
    expect(second.mode).toBe("followUp");
    await composer.addFiles([png("draft.png")]);
    type(input(), "черновик");
    composer.sent(second.id, false); // not sent: text and picture come back, before the new draft
    expect(text(input())).toBe("ещё\nчерновик");
    expect(thumbs().map((thumb) => thumb.textContent)).toEqual([expect.stringContaining("c.png"), expect.stringContaining("draft.png")]);
  });

  it("image_only_message_sends", async () => {
    await composer.addFiles([png("only.png")]);
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: "send", id: expect.any(String), text: "", mode: "auto", images: [{ mimeType: "image/png", data: btoa("only.png"), name: "only.png" }] }]);
    expect(thumbs()).toHaveLength(0);
    press("Enter"); // nothing left to send
    expect(posted).toHaveLength(1);
  });

  it("enter_waits_for_images_still_being_prepared", async () => {
    let finish: (bitmap: Bitmap) => void = () => undefined;
    composer = new Composer(document.getElementById("composer") as HTMLElement, (message) => posted.push(message), {
      codec: { decode: () => new Promise<Bitmap>((resolve) => (finish = resolve)), encode: codec.encode },
    });
    const adding = composer.addFiles([png("slow.png")]);
    type(input(), "x");
    press("Enter");
    expect(posted).toEqual([]);
    expect(thumbs()[0]?.dataset["status"]).toBe("pending");
    finish({ width: 10, height: 10 });
    await adding;
    press("Enter");
    expect((posted[0] as Send).images).toHaveLength(1);
  });

  it("stop_only_while_running", () => {
    show({ running: false });
    expect(role("stop").hidden).toBe(true);
    expect(input().dataset["placeholder"]).toBe("Сообщение агенту (вставь картинку ⌘V или перетащи)");
    show({ running: true });
    expect(role("stop").hidden).toBe(false);
    expect(input().dataset["placeholder"]).toBe("В очередь ещё сообщение…");
    role("stop").click();
    expect(posted).toEqual([{ type: "stop" }]);
    show({ running: false });
    expect(role("stop").hidden).toBe(true);
  });

  it("agents_pill_counts_running_agents", () => {
    const agents = (count: number, status: AgentRow["status"] = "running"): AgentRow[] =>
      Array.from({ length: count }, (_, index) => ({ id: `task:${index}`, label: "x", status }));
    const pill = (): string | null => role("agents-pill").textContent;
    show({ agents: [] });
    expect(pill()).toBe("0 агентов");
    show({ agents: [...agents(1), ...agents(3, "done")] });
    expect(pill()).toBe("1 агент работает");
    show({ agents: agents(2) });
    expect(pill()).toBe("2 агента работают");
    show({ agents: agents(5) });
    expect(pill()).toBe("5 агентов работают");
    show({ agents: agents(11) });
    expect(pill()).toBe("11 агентов работают");
    show({ agents: agents(21) });
    expect(pill()).toBe("21 агент работает");
    show({ agents: agents(3, "done") });
    expect(pill()).toBe("0 агентов");
  });

  it("model_pill_shows_mode_model_and_level", () => {
    /** Label and thinking level, joined the way the pill lays them out (the gap is CSS). */
    const pill = (): string => [...role("model-pill").children].filter((part) => !(part as HTMLElement).hidden).map((part) => part.textContent).join(" ");
    const opus = { provider: "gw-anthropic", id: "claude-opus-5-5" };
    const models = [
      { ...opus, name: "Opus 5.5" },
      { provider: "gw-openai", id: "gpt-6-astra", name: "GPT 6 Astra" },
    ];
    show({ autoModel: opus, model: opus, thinkingLevel: "xhigh" }, { models });
    expect(pill()).toBe("Auto · Opus 5.5 xhigh");
    expect(role("model-pill").querySelector(".w")?.textContent).toBe("xhigh");
    show({ autoModel: opus, model: { provider: "gw-openai", id: "gpt-6-astra" }, thinkingLevel: "high" }, { models, tab: { modelMode: "manual" } });
    expect(pill()).toBe("GPT 6 Astra high");
    show({ model: { provider: "other", id: "local-llm" } }, { models, tab: { modelMode: "manual" } });
    expect(pill()).toBe("local-llm");
    show({}, { models: [] });
    expect(pill()).toBe("Auto");
  });

  it("toolbar_buttons_call_back", () => {
    role("slash").click();
    role("agents-pill").click();
    role("model-pill").click();
    expect(calls).toEqual(["slash", "agents", "model"]);
  });

  const sends = (): Send[] => posted.filter((message): message is Send => message.type === "send");
  const sentTexts = (): string[] => sends().map((message) => message.text);
  const typeAndSend = (text: string): void => {
    type(input(), text);
    press("Enter");
  };

  it("a_sticky_mode_prefixes_every_prose_message_until_turned_off", () => {
    composer.setMode("ulw");
    typeAndSend("a");
    typeAndSend("b");
    expect(sentTexts()).toEqual(["ulw a", "ulw b"]);
    expect(role("mode-chip").hidden).toBe(false);
    expect(role("mode-chip").textContent).toContain("✕");
    role("mode-chip").click();
    expect(posted).toContainEqual({ type: "setMode", mode: null });
    typeAndSend("c");
    expect(sentTexts().at(-1)).toBe("c");
  });

  it("commands_and_image_only_messages_are_not_prefixed_and_the_mode_stays", async () => {
    composer.setMode("mass ulw");
    typeAndSend("/compact");
    await composer.addFiles([png("only.png")]);
    await settled(1);
    press("Enter");
    expect(sentTexts()).toEqual(["/compact", ""]);
    expect(composer.mode).toBe("mass ulw");
  });

  it("the_mode_is_restored_from_the_tab_state", () => {
    show({}, { tab: { modelMode: "auto", stickyMode: "mass ulw" } });
    expect(role("mode-chip").textContent).toContain("Команда агентов");
    typeAndSend("x");
    expect(sentTexts().at(-1)).toBe("mass ulw x");
    show({}, { tab: { modelMode: "auto" } });
    expect(role("mode-chip").hidden).toBe(true);
  });

  it("a_stale_state_in_flight_does_not_undo_a_fresh_toggle_until_the_host_echoes_it", () => {
    composer.setMode("ulw");
    show({}, { tab: { modelMode: "auto" } }); // sent before the host saw the toggle
    expect(role("mode-chip").hidden).toBe(false);
    typeAndSend("a");
    expect(sentTexts().at(-1)).toBe("ulw a");
    show({}, { tab: { modelMode: "auto", stickyMode: "ulw" } }); // the echo
    show({}, { tab: { modelMode: "auto" } }); // now the host's word is final
    expect(role("mode-chip").hidden).toBe(true);
  });

  it("disposing_drops_the_pending_toggle_so_the_host_state_rules_again", () => {
    composer.setMode("ulw");
    composer.dispose();
    show({}, { tab: { modelMode: "auto" } });
    expect(role("mode-chip").hidden).toBe(true);
  });

  it("a_refused_send_gives_back_the_unprefixed_text_and_the_mode_stays", () => {
    composer.setMode("mass ulw");
    typeAndSend("почини кэш");
    const send = posted.at(-1) as Send;
    expect(send.text).toBe("mass ulw почини кэш");
    composer.sent(send.id, false);
    expect(text(input())).toBe("почини кэш");
    expect(composer.mode).toBe("mass ulw");
    expect(role("mode-chip").hidden).toBe(false);
  });

  it("retrying_a_refused_message_resends_it_and_the_sticky_mode_stays_on", () => {
    composer.setMode("ulw");
    typeAndSend("a");
    const send = posted.at(-1) as Send;
    composer.sent(send.id, false);
    expect(composer.retry(send.id)).toBe(true);
    expect(posted.at(-1)).toEqual(send);
    expect(posted.filter((message) => message.type === "setMode")).toEqual([{ type: "setMode", mode: "ulw" }]);
    expect(composer.mode).toBe("ulw");
    expect(text(input())).toBe("");
  });

  it("enter_keys_and_ime_keep_current_behaviour", () => {
    type(input(), "multi");
    expect(press("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    const composing = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
    input().dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    type(input(), "   ");
    press("Enter");
    expect(posted).toEqual([]);
  });

  describe("history recall", () => {
    const HISTORY: Partial<ChatState> = {
      blocks: [
        { kind: "user", id: "u1", text: "первое" },
        { kind: "assistant", id: "a1", text: "ответ", thinking: "", streaming: false },
        { kind: "user", id: "u2", text: "", images: [{ id: "u2:0", mimeType: "image/png" }] },
        { kind: "user", id: "u3", text: "второе\nв две строки" },
      ],
    };

    function caret(position: number): void {
      composer.field.setSelectionRange(position, position);
    }

    function typeInto(value: string): void {
      type(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    }

    it("up_brings_a_message_back_with_its_pills_in_place_and_its_pictures_attached", async () => {
      show({
        blocks: [
          {
            kind: "user",
            id: "u9",
            text: "вот тут ошибка [картинка 1] а дальше [картинка 2]",
            images: [
              { id: "u9:0", mimeType: "image/png", name: "screen1.png" },
              { id: "u9:1", mimeType: "image/png", name: "screen2.png" },
            ],
          },
        ],
      });
      press("ArrowUp");
      expect(text(input())).toBe("вот тут ошибка \uFFFC а дальше \uFFFC"); // the labels are pills again, not words
      expect(pills(input()).map((pill) => pill.querySelector('[data-role="pill-name"]')?.textContent)).toEqual(["screen1.png", "screen2.png"]);
      expect(pills(input()).map((pill) => pill.dataset["status"])).toEqual(["pending", "pending"]);
      expect(posted.filter((message) => message.type === "getImage")).toEqual([
        { type: "getImage", id: "u9:0" },
        { type: "getImage", id: "u9:1" },
      ]);

      composer.image("u9:0", `data:image/png;base64,${btoa("one")}`);
      composer.image("u9:1", `data:image/png;base64,${btoa("two")}`);
      await vi.waitFor(() => expect(pills(input()).map((pill) => pill.dataset["status"])).toEqual(["ready", "ready"]));

      press("Enter"); // ready to go out again, exactly as it went the first time
      const again = posted.filter((message) => message.type === "send").at(-1) as Send;
      expect(again.text).toBe("вот тут ошибка [картинка 1] а дальше [картинка 2]");
      expect(again.images).toEqual([
        { mimeType: "image/png", data: btoa("one"), name: "screen1.png" },
        { mimeType: "image/png", data: btoa("two"), name: "screen2.png" },
      ]);
    });

    it("a_picture_the_host_no_longer_has_is_marked_where_it_stood", async () => {
      show({ blocks: [{ kind: "user", id: "u9", text: "было так [картинка 1]", images: [{ id: "u9:0", mimeType: "image/png", name: "gone.png" }] }] });
      press("ArrowUp");
      composer.image("u9:0", "");
      await vi.waitFor(() => expect(pills(input())[0]?.dataset["status"]).toBe("error"));
      expect(role("attach-notes").textContent).toContain("gone.png — Картинки больше нет");
      press("Enter");
      const again = posted.filter((message) => message.type === "send").at(-1) as Send;
      expect(again.text).toBe("было так "); // no label for a picture that is not there
      expect(again.images).toBeUndefined();
    });

    it("up_on_an_empty_input_walks_back_through_this_sessions_messages_and_down_returns", () => {
      show(HISTORY);
      expect(press("ArrowUp").defaultPrevented).toBe(true);
      expect(text(input())).toBe("второе\nв две строки"); // newest first; an image-only message has no text to recall
      expect(composer.field.selectionStart).toBe(0); // the next ↑ goes on at once
      expect(press("ArrowUp").defaultPrevented).toBe(true);
      expect(text(input())).toBe("первое");
      expect(press("ArrowUp").defaultPrevented).toBe(false); // nothing older
      expect(text(input())).toBe("первое");

      caret(text(input()).length);
      expect(press("ArrowDown").defaultPrevented).toBe(true);
      expect(text(input())).toBe("второе\nв две строки");
      expect(composer.field.selectionStart).toBe(text(input()).length); // the next ↓ goes on at once
      expect(press("ArrowDown").defaultPrevented).toBe(true);
      expect(text(input())).toBe("");
      expect(press("ArrowDown").defaultPrevented).toBe(false); // past the newest: the keys are the browser's again
    });

    it("the_unsent_draft_comes_back_past_the_newest", () => {
      show(HISTORY);
      typeInto("черновик");
      caret(0);
      press("ArrowUp");
      expect(text(input())).toBe("второе\nв две строки");
      caret(text(input()).length);
      press("ArrowDown");
      expect(text(input())).toBe("черновик");
    });

    it("arrows_inside_the_text_move_the_caret_as_usual", () => {
      show(HISTORY);
      typeInto("строка один\nстрока два");
      caret(3);
      expect(press("ArrowUp").defaultPrevented).toBe(false); // not at the start
      caret(text(input()).length);
      expect(press("ArrowDown").defaultPrevented).toBe(false); // at the end, but nothing recalled
      composer.field.setSelectionRange(0, 4);
      expect(press("ArrowUp").defaultPrevented).toBe(false); // a selection is not a caret
      expect(text(input())).toBe("строка один\nстрока два");
    });

    it("editing_a_recalled_message_makes_it_the_draft", () => {
      show(HISTORY);
      press("ArrowUp");
      typeInto("второе, поправленное");
      caret(text(input()).length);
      expect(press("ArrowDown").defaultPrevented).toBe(false);
      expect(text(input())).toBe("второе, поправленное");
    });

    it("streaming_leaves_the_history_alone_and_a_new_message_joins_it", () => {
      show(HISTORY);
      press("ArrowUp");
      const blocks = HISTORY.blocks ?? [];
      show({ blocks: [...blocks, { kind: "assistant", id: "a2", text: "стримится…", thinking: "", streaming: true }] }); // a delta mid-recall
      expect(press("ArrowUp").defaultPrevented).toBe(true);
      expect(text(input())).toBe("первое"); // still stepping through the same list

      show({ blocks: [...blocks, { kind: "user", id: "u4", text: "третье" }] });
      typeInto("");
      press("ArrowUp");
      expect(text(input())).toBe("третье");
      show({ blocks: [...blocks.slice(0, 3), { kind: "user", id: "u3", text: "второе, исправленное" }, { kind: "user", id: "u4", text: "третье" }] });
      caret(0);
      press("ArrowUp");
      expect(text(input())).toBe("второе, исправленное"); // a changed text is picked up too
    });

    it("a_popover_that_owns_the_keys_gets_them_first", () => {
      document.body.innerHTML = '<div id="app"><footer id="composer"></footer></div>';
      app = document.getElementById("app") as HTMLElement;
      composer = new Composer(document.getElementById("composer") as HTMLElement, (message) => posted.push(message), { onInputKey: (event) => event.key === "ArrowUp" });
      show(HISTORY);
      press("ArrowUp");
      expect(text(input())).toBe("");
    });
  });

  it("prefill_puts_text_and_images_into_the_composer", async () => {
    await composer.prefill("Fix", [{ mimeType: "image/png", data: btoa("pixels") }]);
    await settled(1);
    expect(text(input())).toBe("Fix");
    expect(thumbs().map((thumb) => thumb.dataset["status"])).toEqual(["ready"]);
    type(input(), "typed");
    await composer.prefill("Again", []);
    expect(text(input())).toBe("Again\ntyped");
  });

  describe("pictures in the line of text", () => {
    /** Puts the caret in the field, where a person's click would. */
    function caret(position: number): void {
      composer.field.setSelectionRange(position, position);
    }

    /** Attaches pictures at the caret and waits for them to be ready. */
    async function attach(...names: string[]): Promise<void> {
      await composer.addFiles(names.map((name) => png(name)), "caret");
    }

    function sent(): Send {
      return posted.filter((message) => message.type === "send").at(-1) as Send;
    }

    it("a_pasted_picture_stands_where_the_caret_was_with_the_words_on_both_sides", async () => {
      type(input(), "вот тут ошибка  а на втором экране");
      caret("вот тут ошибка ".length);
      input().dispatchEvent(pasteOf([png("screen1.png")]));
      await vi.waitFor(() => expect(pills(input())[0]?.dataset["status"]).toBe("ready"));

      const pill = pills(input())[0] as HTMLElement;
      expect(pill.getAttribute("contenteditable")).toBe("false");
      expect(pill.querySelector('[data-role="pill-name"]')?.textContent).toBe("screen1.png");
      expect(pill.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${btoa("screen1.png")}`);
      expect(text(input())).toBe("вот тут ошибка \uFFFC а на втором экране");
      expect(thumbs()).toHaveLength(0); // it has a place now: the shelf stays out of it
    });

    it("several_files_at_once_stand_in_the_order_they_came", async () => {
      type(input(), "раз два");
      caret("раз ".length);
      await attach("a.png", "b.png", "c.png");
      expect(pills(input()).map((pill) => pill.querySelector('[data-role="pill-name"]')?.textContent)).toEqual(["a.png", "b.png", "c.png"]);
      expect(text(input())).toBe("раз \uFFFC\uFFFC\uFFFCдва");
    });

    it("the_message_carries_a_label_where_each_pill_stands_and_the_pictures_in_that_order", async () => {
      type(input(), "вот тут ошибка  а на втором экране  всё нормально");
      caret("вот тут ошибка ".length);
      await attach("screen1.png");
      caret("вот тут ошибка \uFFFC а на втором экране ".length);
      await attach("screen2.png");
      press("Enter");

      expect(sent().text).toBe("вот тут ошибка [картинка 1] а на втором экране [картинка 2] всё нормально");
      expect(sent().images?.map((image) => image.name)).toEqual(["screen1.png", "screen2.png"]);
      expect(text(input())).toBe(""); // the field is empty again, pills and all
      expect(pills(input())).toHaveLength(0);
    });

    it("numbering_follows_the_text_not_the_order_they_were_attached", async () => {
      type(input(), "конец");
      caret("конец".length);
      await attach("last.png"); // attached first, but it stands last
      caret(0);
      await attach("first.png");
      press("Enter");
      expect(sent().text).toBe("[картинка 1]конец[картинка 2]");
      expect(sent().images?.map((image) => image.name)).toEqual(["first.png", "last.png"]);
    });

    it("a_picture_with_no_place_in_the_text_goes_last_and_gets_no_label", async () => {
      type(input(), "смотри ");
      caret("смотри ".length);
      await attach("inline.png");
      await composer.addFiles([png("shelf.png")]); // «+»: no caret to aim at
      expect(thumbs().map((thumb) => thumb.querySelector('[data-role="thumb-name"]')?.textContent)).toEqual(["shelf.png"]);
      press("Enter");
      expect(sent().text).toBe("смотри [картинка 1]");
      expect(sent().images?.map((image) => image.name)).toEqual(["inline.png", "shelf.png"]);
    });

    it("a_pill_still_being_prepared_holds_its_place_and_keeps_the_message_in", async () => {
      let finish: (bitmap: Bitmap) => void = () => undefined;
      composer = new Composer(document.getElementById("composer") as HTMLElement, (message) => posted.push(message), {
        codec: { decode: () => new Promise<Bitmap>((resolve) => (finish = resolve)), encode: codec.encode },
      });
      type(input(), "вот тут ошибка ");
      caret("вот тут ошибка ".length);
      const adding = composer.addFiles([png("screen3-4k.png")], "caret");
      expect(pills(input())[0]?.dataset["status"]).toBe("pending");
      expect(role("attach-notes").textContent).toContain("screen3-4k.png — готовлю картинку…");
      press("Enter");
      expect(posted.filter((message) => message.type === "send")).toEqual([]);

      finish({ width: 10, height: 10 });
      await adding;
      expect(pills(input())[0]?.dataset["status"]).toBe("ready");
      expect(role("attach-notes").hidden).toBe(true);
    });

    it("a_refused_file_keeps_its_pill_in_place_marked_and_leaves_no_label", async () => {
      type(input(), "вот тут ошибка  а разбор рядом");
      caret("вот тут ошибка ".length);
      await composer.addFiles([new File(["%PDF"], "notes.pdf", { type: "application/pdf" })], "caret");
      const pill = pills(input())[0] as HTMLElement;
      expect(pill.dataset["status"]).toBe("error");
      expect(pill.title).toBe("Только картинки png/jpeg/gif/webp");
      expect(role("attach-notes").textContent).toContain("notes.pdf — Только картинки png/jpeg/gif/webp");
      expect(text(input())).toBe("вот тут ошибка \uFFFC а разбор рядом");

      press("Enter");
      expect(sent().text).toBe("вот тут ошибка  а разбор рядом"); // no label: there is no picture behind it
      expect(sent().images).toBeUndefined();
    });

    it("backspace_right_after_a_pill_eats_the_whole_pill", async () => {
      type(input(), "до после");
      caret("до ".length);
      await attach("x.png");
      expect(text(input())).toBe("до \uFFFCпосле");

      caret("до \uFFFC".length);
      expect(press("Backspace").defaultPrevented).toBe(true);
      expect(text(input())).toBe("до после");
      expect(pills(input())).toHaveLength(0);
      expect(press("Backspace").defaultPrevented).toBe(false); // an ordinary letter is the editor's own business
    });

    it("the_cross_on_a_pill_takes_it_out_and_leaves_the_text", async () => {
      type(input(), "до после");
      caret("до ".length);
      await attach("x.png");
      (pills(input())[0]?.querySelector('[data-role="pill-remove"]') as HTMLElement).click();
      expect(text(input())).toBe("до после");
      expect(pills(input())).toHaveLength(0);
      press("Enter");
      expect(sent().images).toBeUndefined();
    });

    it("a_pill_deleted_by_hand_takes_its_picture_with_it", async () => {
      type(input(), "раз ");
      caret("раз ".length);
      await attach("x.png");
      (pills(input())[0] as HTMLElement).remove();
      input().dispatchEvent(new Event("input", { bubbles: true }));
      press("Enter");
      expect(sent().images).toBeUndefined();
      expect(sent().text).toBe("раз ");
    });

    it("the_sixth_picture_in_the_line_is_marked_like_the_sixth_on_the_shelf", async () => {
      caret(0);
      await attach("1.png", "2.png", "3.png", "4.png", "5.png", "6.png");
      expect(pills(input()).map((pill) => pill.dataset["status"])).toEqual(["ready", "ready", "ready", "ready", "ready", "error"]);
      expect(role("attach-notes").textContent).toContain("6.png — Не больше 5 картинок в сообщении");
      press("Enter");
      expect(sent().images).toHaveLength(5);
      expect(sent().text).toBe("[картинка 1][картинка 2][картинка 3][картинка 4][картинка 5]");
    });

    it("the_prompt_shows_until_there_is_a_word_or_a_pill", async () => {
      expect(input().hasAttribute("data-empty")).toBe(true);
      caret(0);
      await attach("only.png");
      expect(input().hasAttribute("data-empty")).toBe(false); // a lone pill is content

      (pills(input())[0]?.querySelector('[data-role="pill-remove"]') as HTMLElement).click();
      expect(input().hasAttribute("data-empty")).toBe(true);
    });

    it("carrying_a_file_over_the_input_marks_the_gap_it_will_fall_into", async () => {
      type(input(), "вот тут ошибка  а на втором экране");
      const spot = (input().firstChild as Text).splitText("вот тут ошибка ".length); // jsdom has no layout: name the point
      const position = { offsetNode: spot, offset: 0 };
      Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: () => position });
      // jsdom has no layout: the mark needs a rectangle to be placed against.
      Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 120, top: 30, bottom: 49 }) });
      try {
        app.dispatchEvent(withFiles("dragenter", []));
        expect(composer.overlay.hidden).toBe(false); // over the tab, but not over the words yet

        input().dispatchEvent(withFiles("dragover", []));
        expect(composer.overlay.hidden).toBe(true); // no veil over the text: the person is aiming at it
        expect(role("drop-caret").hidden).toBe(false);
        expect(role("drop-hint").hidden).toBe(false);
        expect(role("drop-hint").textContent).toBe("Отпустите — картинка встанет сюда");

        input().dispatchEvent(withFiles("drop", [png("screen2.png")]));
        expect(role("drop-caret").hidden).toBe(true);
        await vi.waitFor(() => expect(pills(input())[0]?.dataset["status"]).toBe("ready"));
        expect(text(input())).toBe("вот тут ошибка \uFFFC а на втором экране");
      } finally {
        Reflect.deleteProperty(document, "caretPositionFromPoint");
        Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
    });

    it("a_file_dropped_on_the_input_lands_in_the_text_and_one_dropped_elsewhere_on_the_shelf", async () => {
      type(input(), "сюда ");
      caret("сюда ".length);
      input().dispatchEvent(withFiles("drop", [png("aimed.png")]));
      await vi.waitFor(() => expect(pills(input())[0]?.dataset["status"]).toBe("ready"));
      expect(text(input())).toBe("сюда \uFFFC");

      app.dispatchEvent(withFiles("drop", [png("loose.png")]));
      await settled(1);
      expect(thumbs().map((thumb) => thumb.querySelector('[data-role="thumb-name"]')?.textContent)).toEqual(["loose.png"]);
    });
  });

  describe("context ring", () => {
    const ring = (): HTMLButtonElement => role("context-ring") as HTMLButtonElement;
    const tip = (): string => ring().querySelector('[data-role="context-tip"]')?.textContent ?? "";
    const WINDOW = 216_384; // threshold = 200 000 with the default 16 384 reserve

    it("no_context_window_hides_the_ring", () => {
      show({ contextTokens: 5000 });
      expect(ring().hidden).toBe(true);
    });

    it("fill_is_the_share_used_of_the_auto_compact_threshold", () => {
      show({ contextWindow: WINDOW, contextTokens: 50_000 });
      expect(ring().hidden).toBe(false);
      expect(ring().dataset["level"]).toBe("ok");
      expect(ring().dataset["fill"]).toBe("25");
      expect(tip()).toContain("Осталось 75% контекста до автосжатия.");
      expect(tip()).toContain("Нажмите, чтобы сжать сейчас.");
    });

    it("warning_at_30_percent_left_and_error_at_10", () => {
      show({ contextWindow: WINDOW, contextTokens: 140_000 }); // 30% left
      expect(ring().dataset["level"]).toBe("warn");
      show({ contextWindow: WINDOW, contextTokens: 138_000 });
      expect(ring().dataset["level"]).toBe("ok");
      show({ contextWindow: WINDOW, contextTokens: 180_000 }); // 10% left
      expect(ring().dataset["level"]).toBe("crit");
      show({ contextWindow: WINDOW, contextTokens: 250_000 }); // past the threshold
      expect(ring().dataset["level"]).toBe("crit");
      expect(ring().dataset["fill"]).toBe("100");
      expect(tip()).toContain("Осталось 0% контекста до автосжатия.");
    });

    it("unknown_tokens_after_compaction_show_an_empty_ring_and_the_recount_hint", () => {
      show({ contextWindow: WINDOW });
      expect(ring().hidden).toBe(false);
      expect(ring().dataset["level"]).toBe("unknown");
      expect(ring().dataset["fill"]).toBe("0");
      expect(tip()).toContain("Контекст пересчитается после следующего ответа");
    });

    it("disabled_auto_compaction_counts_against_the_whole_window_and_drops_the_suffix", () => {
      show({ contextWindow: 200_000, contextTokens: 100_000, autoCompaction: false });
      expect(tip()).toContain("Осталось 50% контекста.");
      expect(tip()).not.toContain("до автосжатия");
    });

    it("click_posts_compact_and_shows_busy_until_the_host_reports_it_done", () => {
      show({ contextWindow: WINDOW, contextTokens: 50_000 });
      ring().click();
      expect(posted).toEqual([{ type: "compact" }]);
      show({ contextWindow: WINDOW, contextTokens: 50_000, compacting: true });
      expect(ring().dataset["level"]).toBe("busy");
      expect(ring().disabled).toBe(true);
      expect(tip()).toContain("Сжимаю контекст");
      ring().click();
      expect(posted).toHaveLength(1);
      show({ contextWindow: WINDOW });
      expect(ring().disabled).toBe(false);
    });

    it("no_compact_while_the_agent_is_running", () => {
      show({ contextWindow: WINDOW, contextTokens: 50_000, running: true });
      expect(ring().disabled).toBe(true);
      ring().click();
      expect(posted).toEqual([]);
    });
  });
});
