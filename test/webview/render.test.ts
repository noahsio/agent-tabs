// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { Block, ChatState } from "../../src/chat/model";
import { initialState } from "../../src/chat/reducer";
import type { StateMessage, WebviewMessage } from "../../src/panel/protocol";
import { ChatView } from "../../webview/render";
import { text, type } from "../helpers/composer";

let root: HTMLElement;
let posted: WebviewMessage[];
let view: ChatView;

function show(state: Partial<ChatState>, extra: Partial<StateMessage> = {}): void {
  view.update({ type: "state", state: { ...initialState(), ...state }, tab: { modelMode: "auto" }, reconnectable: true, ...extra });
}

function input(): HTMLElement {
  return root.querySelector(".input") as HTMLElement;
}

function press(key: string, modifiers: { altKey?: boolean; shiftKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  input().dispatchEvent(event);
  return event;
}

function stopButton(): HTMLButtonElement {
  return root.querySelector('[data-role="stop"]') as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  posted = [];
  view = new ChatView(root, (message) => posted.push(message));
});

describe("ChatView", () => {
  it("render_escapes_html_in_markdown", () => {
    const block: Block = { kind: "assistant", id: "a1", text: "hi <script>alert(1)</script> <b>x</b>", thinking: "", streaming: false };
    show({ blocks: [block] });
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector(".feed b")).toBeNull();
    expect(root.querySelector(".feed")?.textContent).toContain("<script>alert(1)</script>");
  });

  it("render_collapses_thinking_and_opens_tool_steps_on_their_in_out_box", () => {
    show({
      blocks: [
        { kind: "assistant", id: "a1", text: "answer", thinking: "deep thought", streaming: false },
        { kind: "tool", id: "t1", name: "bash", summary: "ls -la", args: {}, input: "ls -la", output: "file.txt", truncated: false, state: "ok" },
      ],
    });
    const thinking = root.querySelector('[data-block="a1"] details') as HTMLDetailsElement;
    expect(thinking.open).toBe(false);
    expect(thinking.querySelector("summary")?.textContent).toContain("Размышления");
    const tool = root.querySelector('[data-block="t1"] details') as HTMLDetailsElement;
    expect(tool.open).toBe(true);
    expect(tool.querySelector("summary")?.textContent).toContain("Bash");
    expect(tool.querySelector("summary")?.textContent).toContain("ls -la");
    expect(tool.querySelector('[data-io="in"] .io-text')?.textContent).toBe("ls -la");
    expect(tool.querySelector('[data-io="out"] .io-text')?.textContent).toBe("file.txt");
  });

  it("re_render_keeps_a_closed_tool_step_closed", () => {
    const tool: Block = { kind: "tool", id: "t1", name: "bash", summary: "ls", args: {}, input: "ls", output: "a", truncated: false, state: "running" };
    show({ blocks: [tool] });
    (root.querySelector('[data-block="t1"] details') as HTMLDetailsElement).open = false;
    show({ blocks: [{ ...tool, output: "a\nb", state: "ok" }] });
    expect((root.querySelector('[data-block="t1"] details') as HTMLDetailsElement).open).toBe(false);
  });

  it("enter_sends_auto_alt_enter_sends_follow_up", () => {
    show({});
    type(input(), "first");
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: "send", id: expect.any(String), text: "first", mode: "auto" }]);
    expect(text(input())).toBe("");

    type(input(), "later");
    press("Enter", { altKey: true });
    expect(posted[1]).toEqual({ type: "send", id: expect.any(String), text: "later", mode: "followUp" });

    type(input(), "multi");
    expect(press("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(posted).toHaveLength(2);

    type(input(), "   ");
    press("Enter");
    expect(posted).toHaveLength(2);
  });

  it("unsent_text_returns_to_the_input", () => {
    type Send = Extract<WebviewMessage, { type: "send" }>;
    show({});
    type(input(), "lost?");
    press("Enter");
    const first = posted[0] as Send;
    expect(text(input())).toBe("");

    type(input(), "draft");
    view.sent(first.id, false);
    expect(text(input())).toBe("lost?\ndraft");

    type(input(), "ok");
    press("Enter");
    const second = posted[1] as Send;
    view.sent(second.id, true);
    view.sent(first.id, false); // already answered: nothing is given back twice
    expect(text(input())).toBe("");
  });

  describe("a message on its way", () => {
    type Send = Extract<WebviewMessage, { type: "send" }>;
    const bubble = (id: string): HTMLElement | null => root.querySelector(`[data-block="${id}"] .user-bubble`);
    const label = (id: string): string | undefined => bubble(id)?.querySelector(".queued-label")?.textContent ?? undefined;
    const sendText = (text: string): Send => {
      type(input(), text);
      press("Enter");
      return posted.at(-1) as Send;
    };

    it("shows_in_the_feed_the_moment_it_is_sent_and_the_hosts_block_replaces_it_in_place", () => {
      show({});
      const send = sendText("hello");
      expect(send.id).toMatch(/^[0-9a-f-]{36}$/); // the message's clientMessageId
      expect(label(send.id)).toBe("отправляется…");
      expect(root.querySelector(".empty")?.hasAttribute("hidden")).toBe(true);
      show({ blocks: [{ kind: "user", id: send.id, text: "hello", delivery: { state: "sending" } }] });
      view.sent(send.id, true);
      show({ blocks: [{ kind: "user", id: send.id, text: "hello", timestamp: 1 }] });
      expect(root.querySelectorAll(`[data-block="${send.id}"]`)).toHaveLength(1);
      expect(label(send.id)).toBeUndefined();
    });

    it("an_answered_send_the_host_dropped_leaves_the_feed", () => {
      show({});
      const send = sendText("/hooks list");
      view.sent(send.id, true); // a command handled it: no message
      expect(bubble(send.id)).toBeNull();
    });

    it("a_failed_send_becomes_an_error_row_gives_the_text_back_and_retry_sends_it_again_under_the_same_id", () => {
      show({});
      const send = sendText("lost?");
      view.sent(send.id, false);
      expect(label(send.id)).toBe("Не отправлено");
      expect(text(input())).toBe("lost?");
      (root.querySelector(`[data-block="${send.id}"] [data-role="retry"]`) as HTMLButtonElement).click();
      expect(posted.at(-1)).toEqual(send);
      expect(text(input())).toBe(""); // the text went out again: no second copy in the input
      expect(label(send.id)).toBe("отправляется…");
      view.sent(send.id, false);
      type(input(), "lost? and more");
      (root.querySelector(`[data-block="${send.id}"] [data-role="discard"]`) as HTMLButtonElement).click();
      expect(bubble(send.id)).toBeNull();
      expect(text(input())).toBe("lost? and more"); // what the person typed since is theirs
    });

    it("a_taken_back_message_returns_to_the_composer_and_a_late_one_says_it_was_delivered", async () => {
      show({ running: true, blocks: [{ kind: "user", id: "m1", text: "later", delivery: { state: "queued", queuedId: "q_1" } }] });
      (root.querySelector('[data-block="m1"] [data-role="dequeue"]') as HTMLButtonElement).click();
      expect(posted.at(-1)).toEqual({ type: "dequeue", blockId: "m1" });
      view.queueResult({ type: "queueResult", blockId: "m1", outcome: "delivered" });
      expect(label("m1")).toBe("уже передано агенту");
      view.draft({ type: "draft", text: "later", images: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(text(input())).toBe("later");
    });
  });

  it("stop_button_only_while_running", () => {
    show({ running: false });
    expect(stopButton().hidden).toBe(true);
    show({ running: true });
    expect(stopButton().hidden).toBe(false);
    stopButton().click();
    expect(posted).toEqual([{ type: "stop" }]);
    show({ running: false });
    expect(stopButton().hidden).toBe(true);
  });

  it("links_go_through_the_host", () => {
    show({ blocks: [{ kind: "assistant", id: "a1", text: "see [docs](https://example.com/x)", thinking: "", streaming: false }] });
    const link = root.querySelector('[data-block="a1"] a') as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: "openLink", url: "https://example.com/x" }]);
  });

  it("error_banner_offers_reconnect", () => {
    show({ error: "socket closed" });
    const banner = root.querySelector('[data-role="banner"]') as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("socket closed");
    (banner.querySelector('[data-role="reconnect"]') as HTMLButtonElement).click();
    expect(posted).toEqual([{ type: "reconnect" }]);
  });

  it("a_cleared_error_that_comes_back_shows_again", () => {
    const banner = (): HTMLElement => root.querySelector('[data-role="banner"]') as HTMLElement;
    show({ error: "socket closed" });
    (banner().querySelector('[data-role="reconnect"]') as HTMLButtonElement).click();
    expect(banner().hidden).toBe(true);
    show({});
    show({ error: "socket closed" });
    expect(banner().hidden).toBe(false);
  });

  it("banner_without_reconnect_when_not_reconnectable", () => {
    show({ error: "Не заданы переменные: GW_API_KEY" }, { reconnectable: false });
    const banner = root.querySelector('[data-role="banner"]') as HTMLElement;
    expect(banner.textContent).toContain("Не заданы переменные: GW_API_KEY");
    expect((banner.querySelector('[data-role="reconnect"]') as HTMLButtonElement).hidden).toBe(true);
  });

  it("the_current_plan_sits_over_the_composer_while_a_turn_runs", () => {
    const todo = (id: string, call: Record<string, unknown>): Block => ({ kind: "tool", id, name: "todo", summary: "", args: {}, todo: call, output: "", truncated: false, state: "ok" }) as Block;
    const strip = (): HTMLElement => root.querySelector('[data-role="todo-strip"]') as HTMLElement;
    const plan = [todo("t1", { op: "init", items: ["Собрать", "Проверить", "Ответить"] }), todo("t2", { op: "done", task: "Собрать" })];
    show({ blocks: plan, running: false });
    expect(strip().hidden).toBe(true); // only while a turn runs
    show({ blocks: plan, running: true });
    expect(strip().hidden).toBe(false);
    expect(strip().textContent).toBe("План 1/3Проверить");
    expect(strip().querySelector(".current")?.textContent).toBe("Проверить");
    show({ blocks: [...plan, todo("t3", { op: "done" })], running: true });
    expect(strip().hidden).toBe(true); // nothing open
    show({ blocks: [], running: true });
    expect(strip().hidden).toBe(true);
  });

  it("header_and_image_answers_are_wired", () => {
    const title = (): string | null | undefined => root.querySelector('[data-role="title"]')?.textContent;
    show({});
    expect(title()).toBe("Новая сессия");
    show({ blocks: [{ kind: "user", id: "u0", text: "  почему\nтак?  " }] });
    expect(title()).toBe("почему так?"); // until OmO titles the session after its first turn
    show({}, { tab: { modelMode: "auto", title: "Из вкладки", durableId: "d1" } });
    expect(title()).toBe("Из вкладки");
    show({ title: "Кэш каталога" }, { tab: { modelMode: "auto", title: "Из вкладки", durableId: "d1" } });
    expect(title()).toBe("Кэш каталога");
    (root.querySelector('[data-role="pin"]') as HTMLButtonElement).click();
    expect(posted).toEqual([{ type: "pin", durableId: "d1", pinned: true }]);

    show({ blocks: [{ kind: "user", id: "u1", text: "x", images: [{ id: "u1:0", mimeType: "image/png" }] }] });
    expect(posted[1]).toEqual({ type: "getImage", id: "u1:0" });
    view.image("u1:0", "data:image/png;base64,AAAA");
    expect(root.querySelector('[data-image="u1:0"] img')?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("composer_pills_and_lightbox_are_wired", () => {
    show(
      { agents: [{ id: "task:1", label: "explore", status: "running" }], autoModel: { provider: "gw-anthropic", id: "claude-opus-5-5" }, thinkingLevel: "xhigh" },
      { models: [{ provider: "gw-anthropic", id: "claude-opus-5-5", name: "Opus 5.5" }] },
    );
    expect(root.querySelector('[data-role="model"]')).toBeNull();
    expect(root.querySelector('[data-role="status"]')).toBeNull();
    const agentsPill = root.querySelector('[data-role="agents-pill"]') as HTMLButtonElement;
    const modelPill = root.querySelector('[data-role="model-pill"]') as HTMLButtonElement;
    expect(agentsPill.textContent).toBe("1 агент работает");
    expect(modelPill.textContent).toContain("Auto · Opus 5.5");
    const shown = (): (string | undefined)[] => [...root.querySelectorAll<HTMLElement>("[data-popover]")].filter((pop) => !pop.hidden).map((pop) => pop.dataset["popover"]);
    agentsPill.click();
    expect(shown()).toEqual(["agents"]);
    modelPill.click();
    expect(shown()).toEqual(["model"]);
    (root.querySelector('[data-role="slash"]') as HTMLButtonElement).click();
    expect(shown()).toEqual(["actions"]); // the «/» button's actions; the command list opens on a typed «/»
    (root.querySelector('[data-role="slash"]') as HTMLButtonElement).click();
    expect(shown()).toEqual([]);

    show({ blocks: [{ kind: "user", id: "u1", text: "x", images: [{ id: "u1:0", mimeType: "image/png" }] }] });
    (root.querySelector('[data-image="u1:0"]') as HTMLButtonElement).click();
    const lightbox = root.querySelector(".lightbox") as HTMLElement;
    expect(lightbox.hidden).toBe(false);
    expect(lightbox.textContent).toContain("Нет превью");
    view.image("u1:0", "data:image/png;base64,AAAA");
    expect(lightbox.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(root.querySelector('[data-role="drop"]')).not.toBeNull();
  });

  it("drops_are_ignored_while_the_lightbox_is_open", async () => {
    const files = (type: string): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["x"], "x.png", { type: "image/png" })], types: ["Files"], dropEffect: "none" } });
      return event;
    };
    const overlay = root.querySelector('[data-role="drop"]') as HTMLElement;
    show({ blocks: [{ kind: "user", id: "u1", text: "x", images: [{ id: "u1:0", mimeType: "image/png" }] }] });
    (root.querySelector('[data-image="u1:0"]') as HTMLButtonElement).click();
    root.dispatchEvent(files("dragenter"));
    expect(overlay.hidden).toBe(true);
    const drop = files("drop");
    root.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true); // the webview must not navigate to the file
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelectorAll(".thumb")).toHaveLength(0);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    root.dispatchEvent(files("dragenter"));
    expect(overlay.hidden).toBe(false);
  });

  it("unchanged_blocks_are_not_re_rendered", () => {
    const first: Block = { kind: "user", id: "u1", text: "hello" };
    show({ blocks: [first] });
    const element = root.querySelector('[data-block="u1"]');
    show({ blocks: [first, { kind: "assistant", id: "a1", text: "hi", thinking: "", streaming: true }] });
    expect(root.querySelector('[data-block="u1"]')).toBe(element);
  });

  it("a_delta_re_renders_only_the_changed_block", () => {
    const user: Block = { kind: "user", id: "u1", text: "hello" };
    const reply: Block = { kind: "assistant", id: "a1", text: "hi", thinking: "", streaming: true };
    view.update(JSON.parse(JSON.stringify({ type: "state", state: { ...initialState(), blocks: [user, reply], running: true }, tab: { modelMode: "auto" }, reconnectable: true })));
    const userElement = root.querySelector('[data-block="u1"]');
    view.delta({ type: "delta", changed: [{ ...reply, text: "hi there" }], removed: [], state: { dialogs: [], agents: [], running: true }, tab: { modelMode: "auto" }, reconnectable: true });
    expect(root.querySelector('[data-block="u1"]')).toBe(userElement);
    expect(root.querySelector('[data-block="a1"]')?.textContent).toContain("hi there");
    view.delta({ type: "delta", changed: [], removed: ["a1"], order: ["u1"], state: { dialogs: [], agents: [], running: false }, tab: { modelMode: "auto" }, reconnectable: true });
    expect(root.querySelector('[data-block="a1"]')).toBeNull();
  });

  it("a_full_state_with_equal_blocks_keeps_their_elements", () => {
    const blocks: Block[] = [
      { kind: "user", id: "u1", text: "hello" },
      { kind: "tool", id: "t1", name: "read", summary: "a.ts", args: undefined, output: "x".repeat(20_000), truncated: false, state: "ok" },
    ];
    const state = (): StateMessage => JSON.parse(JSON.stringify({ type: "state", state: { ...initialState(), blocks }, tab: { modelMode: "auto" }, reconnectable: true }));
    view.update(state());
    const elements = [...root.querySelectorAll("[data-block]")];
    view.update(state()); // e.g. after «ready»: new objects, same content
    expect([...root.querySelectorAll("[data-block]")]).toEqual(elements);
    expect([...root.querySelectorAll("[data-block]")].every((element, index) => element === elements[index])).toBe(true);
  });

  it("a_delta_before_any_state_asks_for_the_whole_state", () => {
    view.delta({ type: "delta", changed: [], removed: [], state: { dialogs: [], agents: [], running: false }, tab: { modelMode: "auto" }, reconnectable: true });
    expect(posted).toEqual([{ type: "ready" }]);
  });

  it("draft_message_prefills_the_composer", async () => {
    view.draft({ type: "draft", text: "Fix", images: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(text(input())).toBe("Fix");
  });

  it("the_actions_button_opens_the_menu_which_asks_the_host_and_shows_its_answer", () => {
    show({ blocks: [{ kind: "user", id: "c1", text: "hi" }] });
    (root.querySelector('[data-block="c1"] [data-role="message-actions"]') as HTMLButtonElement).click();
    expect(posted).toEqual([{ type: "messageActions", blockId: "c1" }]);
    const menu = root.querySelector('[data-popover="message-actions"]') as HTMLElement;
    expect(menu.hidden).toBe(false);
    view.messageActions({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: false, reason: "Снимок не сохранился" } });
    expect((menu.querySelector('[data-role="fork"]') as HTMLButtonElement).disabled).toBe(false);
    (menu.querySelector('[data-role="fork"]') as HTMLButtonElement).click();
    expect(posted.at(-1)).toEqual({ type: "fork", blockId: "c1" });
    expect(menu.hidden).toBe(true);
  });

  it("rewind_preview_and_result_reach_the_confirmation", () => {
    show({ blocks: [{ kind: "user", id: "c1", text: "hi" }] });
    (root.querySelector('[data-block="c1"] [data-role="message-actions"]') as HTMLButtonElement).click();
    view.messageActions({ type: "messageActions", blockId: "c1", fork: { ok: true }, rewind: { ok: true } });
    (root.querySelector('[data-popover="message-actions"] [data-role="rewind"]') as HTMLButtonElement).click();
    expect(posted.at(-1)).toEqual({ type: "rewindPreview", blockId: "c1", fork: false });
    const modal = root.querySelector('[data-role="rewind-confirm-dialog"]') as HTMLElement;
    expect(modal.hidden).toBe(false);
    view.rewindPreview({ type: "rewindPreview", blockId: "c1", fork: false, excerpt: "hi", ok: true, fingerprint: "fp", items: [{ path: "a.txt", action: "restore", changed: "no" }] });
    (modal.querySelector('[data-role="rewind-confirm"]') as HTMLButtonElement).click();
    expect(posted.at(-1)).toEqual({ type: "rewind", blockId: "c1", fork: false, fingerprint: "fp" });
    view.rewound({ type: "rewound", blockId: "c1", ok: true, count: 1 });
    expect(modal.hidden).toBe(true);
  });
});
