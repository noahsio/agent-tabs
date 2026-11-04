// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { StateMessage, WebviewMessage } from "../../src/panel/protocol";
import type { Bitmap, ImageCodec } from "../../webview/attachments";
import { Composer } from "../../webview/composer";

type Send = Extract<WebviewMessage, { type: "send" }>;

let app: HTMLElement;
let posted: WebviewMessage[];
let composer: Composer;

const codec: ImageCodec = {
  decode: async (): Promise<Bitmap> => ({ width: 10, height: 10 }),
  encode: async () => new Blob(["pixels"], { type: "image/png" }),
};

function show(state: Partial<ChatState> = {}, extra: Partial<StateMessage> = {}): void {
  composer.update({ type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "auto" }, reconnectable: true, ...extra });
}

function input(): HTMLTextAreaElement {
  return app.querySelector("textarea") as HTMLTextAreaElement;
}

function role(name: string): HTMLElement {
  return app.querySelector(`[data-role="${name}"]`) as HTMLElement;
}

function send(): HTMLButtonElement {
  return role("send") as HTMLButtonElement;
}

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

/** The bottom bar's controls in the order they are painted. */
function barRoles(): string[] {
  return [...app.querySelectorAll<HTMLElement>(".bar > *")].map((node) => node.dataset["role"] ?? node.className);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><footer id="composer"></footer></div>';
  app = document.getElementById("app") as HTMLElement;
  posted = [];
  composer = new Composer(document.getElementById("composer") as HTMLElement, (message) => posted.push(message), { dropZone: app, codec });
  show();
});

describe("the composer's send button", () => {
  it("sits_at_the_right_end_of_the_bar_before_stop_and_carries_an_arrow", () => {
    expect(barRoles().slice(-3)).toEqual(["spacer", "send", "stop"]);
    expect(send().querySelector("svg")?.getAttribute("class")).toBe("icon icon-send");
  });

  it("is_muted_while_there_is_nothing_to_send_and_live_as_soon_as_there_is", () => {
    expect(send().disabled).toBe(true);
    send().click();
    expect(posted).toEqual([]); // a muted button sends nothing

    type("привет");
    expect(send().disabled).toBe(false);

    type("   "); // whitespace is not a message
    expect(send().disabled).toBe(true);
  });

  it("an_attachment_alone_is_enough_to_send_and_a_picture_still_being_prepared_is_not", async () => {
    const waiting = composer.addFiles([new File(["pixels"], "shot.png", { type: "image/png" })]);
    expect(send().disabled).toBe(true); // still being prepared: a click would do nothing
    await waiting;
    expect(send().disabled).toBe(false);

    send().click();
    const message = posted.at(-1) as Send;
    expect(message).toMatchObject({ type: "send", text: "", mode: "auto" });
    expect(message.images).toHaveLength(1);
    expect(send().disabled).toBe(true); // the composer is empty again
  });

  it("a_click_sends_exactly_what_enter_sends", () => {
    type("сделай");
    send().click();
    const clicked = posted.at(-1) as Send;

    posted = [];
    type("сделай");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const pressed = posted.at(-1) as Send;

    expect({ ...clicked, id: "" }).toEqual({ ...pressed, id: "" });
    expect(input().value).toBe("");
  });

  it("the_mode_chip_rides_a_click_as_it_rides_enter", () => {
    composer.setMode("ulw");
    type("почини тесты");
    send().click();
    expect((posted.at(-1) as Send).text).toBe("ulw почини тесты");
  });

  it("both_buttons_show_while_a_turn_runs_and_send_then_says_it_queues", () => {
    expect(role("stop").hidden).toBe(true);
    expect(send().title).toBe("Отправить");
    expect(send().getAttribute("aria-label")).toBe("Отправить");

    show({ running: true });
    expect(role("stop").hidden).toBe(false);
    expect(send().hidden).toBe(false);
    expect(barRoles().slice(-3)).toEqual(["spacer", "send", "stop"]); // stop stays last
    expect(send().title).toBe("В очередь после текущего хода");
    expect(send().getAttribute("aria-label")).toBe("В очередь после текущего хода");

    type("ещё одно");
    send().click();
    expect(posted.at(-1)).toMatchObject({ type: "send", text: "ещё одно", mode: "auto" }); // OmO steers or queues it

    show({ running: false });
    expect(send().title).toBe("Отправить");
  });

  it("a_refused_message_coming_back_to_the_input_makes_the_button_live_again", () => {
    type("ушло");
    send().click();
    const id = (posted.at(-1) as Send).id;
    expect(send().disabled).toBe(true);

    composer.sent(id, false);
    expect(input().value).toBe("ушло");
    expect(send().disabled).toBe(false);
  });
});
