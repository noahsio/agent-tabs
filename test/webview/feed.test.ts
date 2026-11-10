// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer, Block } from "../../src/chat/model";
import type { WebviewMessage } from "../../src/panel/protocol";
import { DataUrlCache, Feed, foldLabel, formatDuration, type FeedImage } from "../../webview/feed";

let root: HTMLElement;
let posted: WebviewMessage[];
let opened: { images: FeedImage[]; index: number }[];
let feed: Feed;

function at(hours: number, minutes: number, seconds = 0): number {
  return new Date(2026, 10, 3, hours, minutes, seconds).getTime();
}

function entry(id: string): HTMLElement {
  return root.querySelector(`[data-block="${id}"]`) as HTMLElement;
}

/** jsdom has no layout: give the feed a fixed geometry and a writable scrollTop. */
function layout(scrollTop: number, scrollHeight = 1000, clientHeight = 200): void {
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(root, "scrollTop", { configurable: true, writable: true, value: scrollTop });
}

beforeEach(() => {
  document.body.innerHTML = '<main id="feed"></main>';
  root = document.getElementById("feed") as HTMLElement;
  posted = [];
  opened = [];
  feed = new Feed(root, (message) => posted.push(message), { onOpenImage: (images, index) => opened.push({ images, index }) });
});

describe("Feed", () => {
  it("timestamps_grouped_by_minute", () => {
    feed.update(
      [
        { kind: "user", id: "u1", text: "hi", timestamp: at(20, 10) },
        { kind: "assistant", id: "a1", text: "a", thinking: "", streaming: false, timestamp: at(20, 10, 40) },
        { kind: "tool", id: "t1", name: "read", summary: "x", args: {}, output: "", truncated: false, state: "ok", timestamp: at(20, 11, 5) },
        { kind: "notice", id: "n1", level: "info", text: "note" },
        { kind: "assistant", id: "a2", text: "b", thinking: "", streaming: false, timestamp: at(20, 11, 30) },
      ],
      false,
    );
    const stamp = (id: string): string | undefined => entry(id).querySelector(".ts")?.textContent ?? undefined;
    expect(stamp("u1")).toBe("20:10");
    expect(stamp("a1")).toBeUndefined();
    expect(stamp("t1")).toBe("20:11");
    expect(stamp("n1")).toBeUndefined();
    expect(stamp("a2")).toBeUndefined();
  });

  it("a_pending_assistant_does_not_swallow_the_minute", () => {
    feed.update(
      [
        { kind: "user", id: "u1", text: "hi", timestamp: at(20, 10) },
        { kind: "assistant", id: "a1", text: "", thinking: "", streaming: true, timestamp: at(20, 11) },
        { kind: "tool", id: "t1", name: "read", summary: "x", args: {}, output: "", truncated: false, state: "running", timestamp: at(20, 11, 10) },
      ],
      true,
    );
    expect(entry("a1").querySelector(".ts")).toBeNull();
    expect(entry("t1").querySelector(".ts")?.textContent).toBe("20:11");
  });

  it("steps_have_state_classes", () => {
    const tool = (id: string, state: "running" | "ok" | "error", name = "bash"): Block => ({ kind: "tool", id, name, summary: "ls", args: {}, output: "", truncated: false, state });
    feed.update([tool("t1", "ok"), tool("t2", "running"), tool("t3", "error"), { kind: "notice", id: "n1", level: "info", text: "служебное" }], true);
    const step = (id: string): Element => entry(id).querySelector(".step") as Element;
    expect(step("t1").classList.contains("ok")).toBe(true);
    expect(step("t2").classList.contains("running")).toBe(true);
    expect(step("t3").classList.contains("error")).toBe(true);
    expect(step("n1").classList.contains("muted")).toBe(true);
    expect(entry("t1").querySelector(".tool-name")?.textContent).toBe("Bash");
    expect(entry("t1").querySelector(".mono")?.textContent).toBe("ls");
    feed.update([tool("t4", "ok", "ast_grep_search")], false);
    expect(entry("t4").querySelector(".tool-name")?.textContent).toBe("ast_grep_search");
  });

  it("a_notice_keeps_someone_else_s_words_behind_подробнее", () => {
    const provider = "This request triggered cyber-related safeguards. … visit our help center: https://support.claude.com/en/articles/14604842";
    const refusal: Block = { kind: "notice", id: "n1", level: "warn", text: "Модель отказалась отвечать на этот запрос — смените модель для этой сессии", details: provider };
    const plain: Block = { kind: "notice", id: "n2", level: "info", text: "без подробностей" };
    feed.update([refusal, plain], true);
    const details = entry("n1").querySelector("details.notice-details") as HTMLDetailsElement;
    expect(details.open).toBe(false); // the English words are folded away, not in the line
    expect(details.querySelector("summary")?.textContent).toBe("Подробнее");
    expect(details.querySelector("pre")?.textContent).toBe(provider);
    expect(entry("n1").querySelector(".step.notice.warn")?.firstChild?.textContent).toBe(refusal.kind === "notice" ? refusal.text : "");
    expect(entry("n2").querySelector("details")).toBeNull();

    details.open = true;
    feed.update([refusal, plain, { kind: "notice", id: "n3", level: "info", text: "ещё" }], true);
    expect((entry("n1").querySelector("details.notice-details") as HTMLDetailsElement).open).toBe(true);
  });

  it("task_row_shows_role_and_model", () => {
    feed.update(
      [
        {
          kind: "tool",
          id: "t1",
          name: "task",
          summary: "Найти, где пустой ответ ноды перезаписывает кэш",
          args: {},
          output: "",
          truncated: false,
          state: "ok",
          role: "explore",
          model: "Opus 5.5",
          description: "Найти, где пустой ответ ноды перезаписывает кэш",
          durationMs: 125_000,
        },
      ],
      false,
    );
    const row = entry("t1");
    expect(row.querySelector(".tool-name")?.textContent).toBe("Agent:");
    expect(row.querySelector(".agent-desc")?.textContent).toBe("Найти, где пустой ответ ноды перезаписывает кэш");
    expect(row.querySelector(".agent-tag")?.textContent).toBe("Opus 5.5");
    expect(row.querySelector(".sub")?.textContent).toBe("explore · готово за 2 мин");
  });

  it("thinking_row_collapsed_with_duration", () => {
    feed.update([{ kind: "assistant", id: "a1", text: "ответ", thinking: "долгая мысль", streaming: false, thinkingMs: 4_200 }], false);
    const thinking = entry("a1").querySelector("details.thinking") as HTMLDetailsElement;
    expect(thinking.open).toBe(false);
    expect(thinking.closest(".step")?.classList.contains("muted")).toBe(true);
    expect(thinking.querySelector("summary")?.textContent).toBe("Размышлял 4 с");
    expect(thinking.textContent).toContain("долгая мысль");
  });

  it("indicator_verb_follows_activity", () => {
    const indicator = (): HTMLElement => root.querySelector('[data-role="indicator"]') as HTMLElement;
    feed.update([], true, { activity: "thinking" });
    expect(indicator().hidden).toBe(false);
    expect(indicator().textContent).toBe("Думаю…");
    feed.update([], true, { activity: "tool", tool: "Bash" });
    expect(indicator().textContent).toBe("Выполняю Bash…");
    feed.update([], true, { activity: "tool", tool: "task" });
    expect(indicator().textContent).toBe("Выполняю задачу…");
    feed.update([], true, { activity: "tool", tool: "Task" });
    expect(indicator().textContent).toBe("Выполняю задачу…");
    feed.update([], true, { activity: "waiting_human" });
    expect(indicator().textContent).toBe("Жду ответа…");
    feed.update([], false, { activity: "idle" });
    expect(indicator().hidden).toBe(true);
  });

  describe("thinking in progress", () => {
    const indicator = (): HTMLElement => root.querySelector('[data-role="indicator"]') as HTMLElement;
    const liveLabel = (): string => (root.querySelector('[data-role="thinking-live"]') as HTMLElement).textContent ?? "";
    const seconds = (label: string): number => Number(label.match(/(\d+)/)?.[1] ?? "0");
    const thinkingBlock = (startedAt: number): Block => ({ kind: "assistant", id: "a1", text: "", thinking: "мысль", streaming: true, thinkingStartedAt: startedAt });
    const tool = (id: string, state: "running" | "ok"): Block => ({ kind: "tool", id, name: "bash", summary: "ls", args: {}, output: "", truncated: false, state });

    afterEach(() => vi.useRealTimers());

    it("shows_only_the_step_not_the_bottom_indicator_while_thinking", () => {
      feed.update([thinkingBlock(Date.now())], true, { activity: "thinking" });
      expect(indicator().hidden).toBe(true); // the bottom «Думаю…» is suppressed
      expect((root.querySelector("details.thinking summary") as HTMLElement).textContent).toContain("Размышляю");
    });

    it("ticks_the_seconds_while_thinking", () => {
      vi.useFakeTimers();
      feed.update([thinkingBlock(Date.now())], true, { activity: "thinking" });
      const before = seconds(liveLabel());
      vi.advanceTimersByTime(5_000);
      expect(seconds(liveLabel())).toBeGreaterThan(before);
    });

    it("becomes_the_finished_label_and_the_bottom_indicator_returns_for_a_tool", () => {
      feed.update([thinkingBlock(Date.now())], true, { activity: "thinking" });
      feed.update(
        [{ kind: "assistant", id: "a1", text: "", thinking: "мысль", streaming: true, thinkingMs: 5_200 }, tool("t1", "running")],
        true,
        { activity: "tool", tool: "Bash" },
      );
      expect((root.querySelector("details.thinking summary") as HTMLElement).textContent).toBe("Размышлял 5 с");
      expect(indicator().hidden).toBe(false);
      expect(indicator().textContent).toBe("Выполняю Bash…");
    });

    it("clears_the_interval_when_thinking_ends_and_never_ticks_after", () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      feed.update([thinkingBlock(Date.now())], true, { activity: "thinking" });
      feed.update([{ kind: "assistant", id: "a1", text: "", thinking: "мысль", streaming: true, thinkingMs: 5_200 }, tool("t1", "running")], true, { activity: "tool", tool: "Bash" });
      expect(clearSpy).toHaveBeenCalled();
      const finished = (root.querySelector("details.thinking summary") as HTMLElement).textContent;
      vi.advanceTimersByTime(5_000);
      expect((root.querySelector("details.thinking summary") as HTMLElement).textContent).toBe(finished); // no stray tick
    });

    it("clears_the_interval_on_dispose", () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      feed.update([thinkingBlock(Date.now())], true, { activity: "thinking" });
      const label = liveLabel();
      feed.dispose();
      expect(clearSpy).toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(liveLabel()).toBe(label); // the label is frozen: no interval survives dispose
    });
  });

  it("keeps_scroll_when_user_scrolled_up", () => {
    const first: Block = { kind: "assistant", id: "a1", text: "one", thinking: "", streaming: true };
    layout(300);
    feed.update([first], true);
    expect(root.scrollTop).toBe(300);

    layout(800); // at the bottom: the feed follows new content
    feed.update([{ ...first, text: "one two" }], true);
    expect(root.scrollTop).toBe(1000);
  });

  it("user_images_are_requested_once_and_open_on_click", () => {
    const user: Block = { kind: "user", id: "u1", text: "смотри", images: [{ id: "u1:0", mimeType: "image/png" }, { id: "u1:1", mimeType: "image/png" }] };
    feed.update([user], false);
    feed.update([user, { kind: "assistant", id: "a1", text: "ок", thinking: "", streaming: false }], false);
    expect(posted).toEqual([
      { type: "getImage", id: "u1:0" },
      { type: "getImage", id: "u1:1" },
    ]);
    feed.image("u1:0", "data:image/png;base64,AAAA");
    feed.image("u1:1", "");
    const tiles = [...entry("u1").querySelectorAll<HTMLElement>(".uimg")];
    expect(tiles[0]?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(tiles[1]?.classList.contains("missing")).toBe(true);
    tiles[1]?.click();
    expect(opened).toEqual([{ images: [{ id: "u1:0", dataUrl: "data:image/png;base64,AAAA" }, { id: "u1:1" }], index: 1 }]);
  });

  it("a_labelled_picture_stands_in_the_line_of_the_message_where_it_was_put", () => {
    const user: Block = {
      kind: "user",
      id: "u1",
      text: "вот тут ошибка [картинка 1] а на втором экране [картинка 2] всё нормально",
      images: [
        { id: "u1:0", mimeType: "image/png", name: "screen1.png" },
        { id: "u1:1", mimeType: "image/png", name: "screen2.png" },
      ],
    };
    feed.update([user], false);
    const bubble = entry("u1").querySelector(".user-bubble") as HTMLElement;
    expect(bubble.querySelector(".uimgs")).toBeNull(); // both have a place in the text: no row above it
    const body = bubble.querySelector(".user-text") as HTMLElement;
    expect(body.textContent).toBe("вот тут ошибка screen1.png а на втором экране screen2.png всё нормально");
    const chips = [...body.querySelectorAll<HTMLElement>(".uimg.att")];
    expect(chips.map((chip) => chip.dataset["image"])).toEqual(["u1:0", "u1:1"]);
    expect(chips[0]?.querySelector('[data-role="image-size"]')).toBeNull(); // the line has no room for a size

    feed.image("u1:0", "data:image/png;base64,AAAA");
    chips[1]?.click();
    expect(opened).toEqual([{ images: [{ id: "u1:0", dataUrl: "data:image/png;base64,AAAA" }, { id: "u1:1" }], index: 1 }]);
  });

  it("a_picture_the_text_has_no_label_for_keeps_the_row_above_the_message", () => {
    const user: Block = {
      kind: "user",
      id: "u1",
      text: "смотри [картинка 1] и ещё [картинка 7]",
      images: [
        { id: "u1:0", mimeType: "image/png", name: "inline.png" },
        { id: "u1:1", mimeType: "image/png", name: "loose.png" },
      ],
    };
    feed.update([user], false);
    const bubble = entry("u1").querySelector(".user-bubble") as HTMLElement;
    const shelf = [...(bubble.querySelector(".uimgs") as HTMLElement).querySelectorAll('[data-role="image-name"]')];
    expect(shelf.map((name) => name.textContent)).toEqual(["loose.png"]);
    const body = bubble.querySelector(".user-text") as HTMLElement;
    expect([...body.querySelectorAll(".att")].map((chip) => (chip as HTMLElement).dataset["image"])).toEqual(["u1:0"]);
    expect(body.textContent).toBe("смотри inline.png и ещё [картинка 7]"); // a label with nothing behind it stays text
  });

  it("sent_images_show_as_chips_with_name_and_size_above_the_text", () => {
    const user: Block = { kind: "user", id: "u1", text: "вот", images: [{ id: "u1:0", mimeType: "image/png", name: "shot.png" }, { id: "u1:1", mimeType: "image/png" }] };
    feed.update([user], false);
    const bubble = entry("u1").querySelector(".user-bubble") as HTMLElement;
    expect([...bubble.children].filter((child) => !child.matches("button.icon-btn")).map((child) => child.className)).toEqual(["uimgs", "user-text"]);
    const names = (): (string | null | undefined)[] => [...entry("u1").querySelectorAll(".uimg")].map((tile) => tile.querySelector('[data-role="image-name"]')?.textContent);
    expect(names()).toEqual(["shot.png", "image.png"]);
    expect(entry("u1").querySelector('[data-role="image-size"]')?.textContent).toBe(""); // known once the picture loads

    feed.image("u1:0", "data:image/png;base64,AAAA");
    const tile = entry("u1").querySelector(".uimg") as HTMLElement;
    const img = tile.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 1464 });
    Object.defineProperty(img, "naturalHeight", { value: 838 });
    img.dispatchEvent(new Event("load"));
    expect(tile.querySelector('[data-role="image-size"]')?.textContent).toBe("1464×838");
    expect(names()).toEqual(["shot.png", "image.png"]);
  });

  it("the_data_url_cache_keeps_60_images_and_an_evicted_one_is_fetched_again_on_open", () => {
    const blocks: Block[] = Array.from({ length: 13 }, (_, blockIndex) => ({
      kind: "user",
      id: `u${blockIndex}`,
      text: "x",
      images: Array.from({ length: 5 }, (_, index) => ({ id: `u${blockIndex}:${index}`, mimeType: "image/png" })),
    }));
    feed.update(blocks, false);
    expect(posted).toHaveLength(65);
    for (const block of blocks) for (const image of block.kind === "user" ? (block.images ?? []) : []) feed.image(image.id, `data:image/png;base64,${image.id}`);
    posted.length = 0;

    (entry("u0").querySelector(".uimg") as HTMLElement).click(); // the oldest five were evicted
    expect(opened.at(-1)?.images.every((image) => image.dataUrl === undefined)).toBe(true);
    expect(posted).toEqual(Array.from({ length: 5 }, (_, index) => ({ type: "getImage", id: `u0:${index}` })));
    (entry("u12").querySelector(".uimg") as HTMLElement).click();
    expect(opened.at(-1)?.images[0]).toEqual({ id: "u12:0", dataUrl: "data:image/png;base64,u12:0" });
    expect(posted).toHaveLength(5); // nothing to fetch for cached ones
  });
});

describe("DataUrlCache", () => {
  it("evicts_the_least_recently_used_by_count_and_by_characters", () => {
    const cache = new DataUrlCache(3, 10);
    expect(cache.set("a", "1234")).toEqual([]);
    expect(cache.set("b", "1234")).toEqual([]);
    expect(cache.get("a")).toBe("1234"); // touch: b is the oldest now
    expect(cache.set("c", "1234")).toEqual(["b"]); // 12 characters > 10
    expect(cache.set("d", "")).toEqual([]);
    expect(cache.set("e", "")).toEqual(["a"]); // 4 entries > 3
    expect(cache.has("c") && cache.has("d") && cache.has("e")).toBe(true);
  });
});

describe("long sent messages", () => {
  /** jsdom has no layout: a message's text is 20 px per line, times `wrap` (a narrower tab wraps more). */
  let wrap = 1;
  /** Layout reads of a message's height, and a hook to see when they happen. */
  let reads = 0;
  let onRead: (() => void) | undefined;
  const lines = (count: number): string => Array.from({ length: count }, (_, index) => `строка ${index + 1}`).join("\n");
  const bubble = (id: string): HTMLElement => entry(id).querySelector(".user-bubble") as HTMLElement;
  const toggle = (id: string): HTMLElement | null => bubble(id).querySelector('[data-role="message-toggle"]');

  beforeEach(() => {
    wrap = 1;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        if (!this.classList.contains("user-text")) return 0;
        if (this.isConnected) reads++; // earlier tests' feeds still listen to resize, on detached elements
        onRead?.();
        return (this.textContent ?? "").split("\n").length * 20 * wrap;
      },
    });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  it("a_long_message_collapses_and_toggles_with_the_control_in_the_corner_a_short_one_has_none", () => {
    feed.update([{ kind: "user", id: "u1", text: lines(30) }, { kind: "user", id: "u2", text: lines(3) }], false);
    expect(bubble("u1").classList.contains("collapsed")).toBe(true);
    const control = toggle("u1") as HTMLElement;
    expect(control.textContent).toBe("Показать полностью");
    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(toggle("u2")).toBeNull();
    expect(bubble("u2").classList.contains("collapsed")).toBe(false);

    control.click();
    expect(bubble("u1").classList.contains("collapsed")).toBe(false);
    expect(toggle("u1")?.textContent).toBe("Свернуть");
    expect(toggle("u1")?.getAttribute("aria-expanded")).toBe("true");
    expect(bubble("u1").lastElementChild).toBe(toggle("u1")); // the bubble's bottom corner (placed by .message-toggle)

    toggle("u1")?.click();
    expect(bubble("u1").classList.contains("collapsed")).toBe(true);
    expect(toggle("u1")?.textContent).toBe("Показать полностью");
  });

  it("folds_a_message_over_the_few_line_trigger_but_leaves_a_shorter_one_open", () => {
    feed.update([{ kind: "user", id: "u1", text: lines(7) }, { kind: "user", id: "u2", text: lines(5) }], false);
    expect(bubble("u1").classList.contains("collapsed")).toBe(true); // seven lines: over the trigger, folded
    expect(bubble("u2").classList.contains("collapsed")).toBe(false); // five lines: still shown whole
    expect(toggle("u2")).toBeNull();
  });

  it("the_choice_is_kept_per_message_across_feed_updates", () => {
    const long: Block = { kind: "user", id: "u1", text: lines(30), delivery: { state: "queued", queuedId: "q_1" } };
    const other: Block = { kind: "user", id: "u2", text: lines(30) };
    feed.update([long, other], true);
    toggle("u1")?.click();
    feed.update([long, other, { kind: "assistant", id: "a1", text: "ок", thinking: "", streaming: true }], true); // streaming goes on
    expect(bubble("u1").classList.contains("collapsed")).toBe(false);
    expect(bubble("u2").classList.contains("collapsed")).toBe(true);
    feed.update([{ kind: "user", id: "u1", text: lines(30) }, other], false); // the queued message was sent: its element is rebuilt
    expect(bubble("u1").classList.contains("collapsed")).toBe(false);
    expect(toggle("u1")?.textContent).toBe("Свернуть");
  });

  const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  it("a_resize_measures_again_once_per_frame", async () => {
    feed.update([{ kind: "user", id: "u1", text: lines(5) }], false);
    expect(toggle("u1")).toBeNull();
    wrap = 2; // the tab got narrower: twice the lines
    reads = 0;
    for (let count = 0; count < 5; count++) window.dispatchEvent(new Event("resize"));
    expect(bubble("u1").classList.contains("collapsed")).toBe(false); // not before the next frame
    await frame();
    expect(reads).toBe(1); // five resize events, one measure
    expect(bubble("u1").classList.contains("collapsed")).toBe(true);
    expect(toggle("u1")?.hidden).toBe(false);
    wrap = 1;
    window.dispatchEvent(new Event("resize"));
    await frame();
    expect(bubble("u1").classList.contains("collapsed")).toBe(false);
    expect(toggle("u1") === null || toggle("u1")?.hidden === true).toBe(true);
  });

  it("all_bubbles_are_measured_before_any_is_changed", () => {
    const order: string[] = [];
    const toggleClass = DOMTokenList.prototype.toggle;
    onRead = (): void => void order.push("read");
    DOMTokenList.prototype.toggle = function (this: DOMTokenList, ...args: Parameters<DOMTokenList["toggle"]>): boolean {
      order.push("write");
      return toggleClass.apply(this, args);
    };
    try {
      feed.update([1, 2, 3].map((index) => ({ kind: "user" as const, id: `u${index}`, text: lines(30) })), false);
    } finally {
      DOMTokenList.prototype.toggle = toggleClass;
      onRead = undefined;
    }
    const firstWrite = order.indexOf("write");
    expect(order.filter((step) => step === "read")).toHaveLength(3);
    expect(order.lastIndexOf("read")).toBeLessThan(firstWrite); // no layout read after a class change
  });

  it("a_hidden_feed_measures_nothing_and_tries_again_on_the_next_update", () => {
    const user: Block = { kind: "user", id: "u1", text: lines(30) };
    wrap = 0; // display:none: no layout, scrollHeight 0
    feed.update([user], false);
    expect(bubble("u1").classList.contains("collapsed")).toBe(false);
    wrap = 1;
    feed.update([user], false);
    expect(bubble("u1").classList.contains("collapsed")).toBe(true);
  });

  it("user_messages_get_an_actions_button_queued_ones_do_not", () => {
    const actions: [string, HTMLElement][] = [];
    feed = new Feed(root, (message) => posted.push(message), { onMessageActions: (blockId, anchor) => actions.push([blockId, anchor]) });
    feed.update(
      [
        { kind: "user", id: "c1", text: "hi" },
        { kind: "user", id: "q1", text: "later", delivery: { state: "queued", queuedId: "q_1" } },
        { kind: "assistant", id: "a1", text: "ok", thinking: "", streaming: false },
      ],
      false,
    );
    const actionsButton = entry("c1").querySelector('[data-role="message-actions"]') as HTMLButtonElement;
    expect(actionsButton).not.toBeNull();
    expect(actionsButton.getAttribute("title")).toBe("Ответвить или откатить");
    expect(actionsButton.getAttribute("aria-label")).toBe("Ответвить или откатить");
    expect(entry("q1").querySelector('[data-role="message-actions"]')).toBeNull();
    expect(entry("a1").querySelector('[data-role="message-actions"]')).toBeNull();
    actionsButton.click();
    expect(actions).toEqual([["c1", actionsButton]]);
  });

  describe("a message on its way", () => {
    const label = (id: string): string | undefined => entry(id)?.querySelector(".queued-label")?.textContent ?? undefined;
    const action = (id: string, role: string): HTMLButtonElement | null => entry(id)?.querySelector(`[data-role="${role}"]`) ?? null;
    const reply: Block = { kind: "assistant", id: "a1", text: "ok", thinking: "", streaming: true };

    it("sending_shows_muted_after_everything_the_agent_did_without_actions", () => {
      feed.update([{ kind: "user", id: "m1", text: "hi", delivery: { state: "sending" } }, reply], true);
      expect([...root.querySelectorAll("[data-block]")].map((element) => element.getAttribute("data-block"))).toEqual(["a1", "m1"]);
      expect(label("m1")).toBe("отправляется…");
      expect(entry("m1").querySelector(".user-bubble")?.classList.contains("sending")).toBe(true);
      expect(action("m1", "message-actions")).toBeNull();
      expect(action("m1", "dequeue")).toBeNull();
    });

    it("the_real_message_takes_the_same_place_once", () => {
      feed.update([{ kind: "user", id: "m1", text: "hi", delivery: { state: "sending" } }], false);
      feed.update([{ kind: "user", id: "m1", text: "hi" }, reply], true);
      expect(root.querySelectorAll('[data-block="m1"]')).toHaveLength(1);
      expect(label("m1")).toBeUndefined();
      expect(action("m1", "message-actions")).not.toBeNull();
    });

    it("a_resend_that_superseded_a_queued_bubble_shows_once_delivered_never_also_queued", () => {
      // The reducer leaves only the resend's delivered block (it carries `supersedes`); the feed must render it as a
      // plain, delivered message — no queued label, no «Отозвать»/«Изменить» — so the person sees the message once.
      feed.update([{ kind: "user", id: "m-new", text: "что происходит?", supersedes: "m-old" }, reply], true);
      expect(root.querySelectorAll(".user-bubble")).toHaveLength(1);
      expect(label("m-new")).toBeUndefined();
      expect(entry("m-new").querySelector(".user-bubble")?.classList.contains("queued")).toBe(false);
      expect(action("m-new", "dequeue")).toBeNull();
      expect(action("m-new", "edit-queued")).toBeNull();
      expect(action("m-new", "message-actions")).not.toBeNull(); // it is a real conversation message
    });

    it("queued_offers_take_back_which_asks_the_host_once", () => {
      feed.update([{ kind: "user", id: "m1", text: "later", delivery: { state: "queued", queuedId: "q_1" } }], true);
      expect(label("m1")).toBe("в очереди — ждёт агента");
      action("m1", "dequeue")?.click();
      expect(posted).toEqual([{ type: "dequeue", blockId: "m1" }]);
      expect(action("m1", "dequeue")?.disabled).toBe(true);
      expect(action("m1", "edit-queued")?.disabled).toBe(true);
      feed.queueResult("m1", "failed");
      expect(action("m1", "dequeue")?.disabled).toBe(false);
    });

    it("one_already_handed_to_the_agent_says_so_briefly_and_becomes_the_normal_message", () => {
      vi.useFakeTimers();
      try {
        feed.update([{ kind: "user", id: "m1", text: "later", delivery: { state: "queued", queuedId: "q_1" } }], true);
        action("m1", "dequeue")?.click();
        feed.queueResult("m1", "delivered");
        expect(label("m1")).toBe("уже передано агенту");
        expect(action("m1", "dequeue")).toBeNull();
        feed.update([{ kind: "user", id: "m1", text: "later" }], true);
        expect(label("m1")).toBe("уже передано агенту");
        vi.advanceTimersByTime(3_000);
        expect(label("m1")).toBeUndefined();
        expect(action("m1", "message-actions")).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("edit_opens_an_inline_editor_enter_saves_and_escape_cancels", () => {
      const queued: Block = { kind: "user", id: "m1", text: "old", delivery: { state: "queued", queuedId: "q_1" } };
      feed.update([queued, reply], true);
      action("m1", "edit-queued")?.click();
      const field = (): HTMLTextAreaElement => entry("m1").querySelector('[data-role="queued-edit"]') as HTMLTextAreaElement;
      expect(field().value).toBe("old");
      expect(document.activeElement).toBe(field());
      field().value = "new";
      field().dispatchEvent(new Event("input"));
      feed.update([queued, { ...reply, text: "ok, more" } as Block], true); // the agent streams on: the edit survives
      expect(field().value).toBe("new");
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(field()).toBeNull();
      expect(posted).toEqual([]);

      action("m1", "edit-queued")?.click();
      field().value = "   ";
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(posted).toEqual([]); // an empty text is not an edit
      field().value = "newer";
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(posted).toEqual([{ type: "editQueued", blockId: "m1", text: "newer" }]);
      expect(field()).toBeNull();
    });

    it("no_rewind_button_while_queued_or_not_sent", () => {
      feed.update(
        [
          { kind: "user", id: "m1", text: "later", delivery: { state: "queued", queuedId: "q_1" } },
          { kind: "user", id: "m2", text: "hi", delivery: { state: "failed" } },
        ],
        true,
      );
      expect(action("m1", "message-actions")).toBeNull();
      expect(action("m2", "message-actions")).toBeNull();
    });

    it("a_guard_row_meanwhile_lands_after_the_agents_work_not_after_a_waiting_message", () => {
      feed.update([{ kind: "user", id: "c1", text: "go" }, reply, { kind: "user", id: "m1", text: "later", delivery: { state: "queued", queuedId: "q_1" } }], true);
      const step = document.createElement("div");
      step.dataset["step"] = "g1";
      feed.addGuardRow("g1", step);
      const order = [...root.querySelectorAll(".entry")].map((element) => element.getAttribute("data-block") ?? element.querySelector<HTMLElement>("[data-step]")?.dataset["step"]);
      expect(order).toEqual(["c1", "a1", "g1", "m1"]);
      feed.update([{ kind: "user", id: "c1", text: "go" }, reply, { kind: "user", id: "m1", text: "later" }], false); // the queued one is delivered
      const after = [...root.querySelectorAll(".entry")].map((element) => element.getAttribute("data-block") ?? element.querySelector<HTMLElement>("[data-step]")?.dataset["step"]);
      expect(after).toEqual(["c1", "a1", "g1", "m1"]);
    });

    it("failed_shows_an_error_row_with_retry_and_remove", () => {
      const retried: string[] = [];
      const discarded: string[] = [];
      feed = new Feed(root, (message) => posted.push(message), { onRetry: (id) => retried.push(id), onDiscard: (id) => discarded.push(id) });
      feed.update([{ kind: "user", id: "m1", text: "hi", delivery: { state: "failed" } }], true);
      expect(label("m1")).toBe("Не отправлено");
      expect(entry("m1").querySelector(".user-bubble")?.classList.contains("failed")).toBe(true);
      action("m1", "retry")?.click();
      action("m1", "discard")?.click();
      expect([retried, discarded]).toEqual([["m1"], ["m1"]]);
    });
  });
});

describe("Feed · todo steps", () => {
  const todo = (id: string, call: Record<string, unknown>, state: "running" | "ok" | "error" = "ok", output = "Ask: x\nNow: y\nNext: none"): Block =>
    ({ kind: "tool", id, name: "todo", summary: "", args: {}, todo: call, output, truncated: false, state }) as Block;
  const items = (id: string): string[] => [...entry(id).querySelectorAll<HTMLElement>("[data-todo-item]")].map((item) => `${item.dataset["status"]}:${item.textContent}`);

  it("init_is_a_plan_checklist_without_a_box_or_its_output", () => {
    feed.update([todo("t1", { op: "init", list: [{ phase: "P", items: ["Собрать", "Проверить"] }] })], false);
    const step = entry("t1");
    expect(step.querySelector('[data-role="tool-io"]')).toBeNull();
    expect(step.textContent).not.toContain("Now:");
    expect(step.querySelector(".todo-head")?.textContent).toBe("План");
    expect(items("t1")).toEqual(["in_progress:☐Собрать", "pending:☐Проверить"]);
    expect(step.querySelector('[data-status="in_progress"]')?.classList.contains("current")).toBe(true);
  });

  it("a_long_plan_shows_five_and_the_rest_behind_ещё_N", () => {
    feed.update([todo("t1", { op: "init", items: ["1", "2", "3", "4", "5", "6", "7"] })], false);
    expect(items("t1")).toHaveLength(7);
    const more = entry("t1").querySelector<HTMLDetailsElement>("details.todo-more");
    expect(more?.querySelector("summary")?.textContent).toBe("ещё 2");
    expect(more?.querySelectorAll("[data-todo-item]")).toHaveLength(2);
  });

  it("updates_are_one_muted_line_each", () => {
    feed.update(
      [
        todo("t1", { op: "init", items: ["Собрать", "Проверить", "Лишнее"] }),
        todo("t2", { op: "done", task: "Собрать" }),
        todo("t3", { op: "start", task: "Проверить" }),
        todo("t4", { op: "drop", task: "Лишнее" }),
        todo("t5", { op: "done", phase: "Сборка" }),
        todo("t6", { op: "append", items: ["Ещё", "И ещё"] }),
        todo("t7", { op: "rm", task: "Ещё" }),
      ],
      false,
    );
    const line = (id: string): string => entry(id).querySelector(".todo-mark")?.textContent ?? "";
    expect(["t2", "t3", "t4", "t5", "t6", "t7"].map(line)).toEqual(["✓ Собрать", "→ Проверить", "✕ Лишнее", "✓ Сборка", "+ Ещё, И ещё", "− Ещё"]);
    expect(entry("t2").querySelector(".todo-mark")?.classList.contains("muted")).toBe(true);
    for (const id of ["t2", "t3", "t4"]) expect(entry(id).querySelector('[data-role="tool-io"]')).toBeNull();
  });

  it("view_shows_the_list_as_it_stands_then", () => {
    feed.update([todo("t1", { op: "init", items: ["A", "B"] }), todo("t2", { op: "done", task: "A" }), todo("t3", { op: "view" })], false);
    expect(items("t3")).toEqual(["completed:☑A", "in_progress:☐B"]);
    expect(items("t1")).toEqual(["in_progress:☐A", "pending:☐B"]); // the plan as it was made
  });

  it("a_failed_todo_call_keeps_the_ordinary_step_with_its_error", () => {
    feed.update([todo("t1", { op: "done", task: "nope" }, "error", 'Task "nope" not found')], false);
    expect(entry("t1").querySelector(".todo-mark")).toBeNull();
    expect(entry("t1").textContent).toContain('Task "nope" not found');
  });
});

describe("selecting text in the feed", () => {
  /** Selects `text` inside the first node of `element` that holds it, as a person's drag would. */
  function select(element: Element, text: string): void {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null && !(node.textContent ?? "").includes(text)) node = walker.nextNode();
    if (node === null) throw new Error(`no node holds ${text}`);
    const start = (node.textContent as string).indexOf(text);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clear(): void {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange")); // jsdom never fires it itself
  }

  const streaming = (text: string): Block => ({ kind: "assistant", id: "a1", text, thinking: "", streaming: true });

  it.each(["web", "file"])("contextmenu_selects_the_%s_link_without_opening_it", (kind) => {
    feed.update([
      streaming("Смотри [страницу](https://example.com/a)"),
      { kind: "tool", id: "t1", name: "read", file: "src/main.ts", summary: "src/main.ts", args: {}, output: "", truncated: false, state: "ok" },
    ], false);
    const link = root.querySelector<HTMLElement>(kind === "web" ? ".markdown a" : "[data-open-file]") as HTMLElement;
    clear();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    link.dispatchEvent(event);
    expect(window.getSelection()?.toString()).toBe(link.textContent);
    expect(event.defaultPrevented).toBe(false);
    expect(posted).toEqual([]);
  });

  it.each(["inside", "across", "elsewhere"])("contextmenu_preserves_a_selection_%s_the_link", (where) => {
    feed.update([streaming("Смотри https://example.com/a дальше")], false);
    const link = entry("a1").querySelector("a") as HTMLAnchorElement;
    if (where === "inside") select(link, "example.com");
    else if (where === "elsewhere") select(entry("a1"), "Смотри");
    else {
      const range = document.createRange();
      range.selectNodeContents(link.parentNode as Node);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    const selection = window.getSelection() as Selection;
    const before = selection.getRangeAt(0).cloneRange();
    const selected = selection.toString();
    link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    expect(selection.toString()).toBe(selected);
    expect(selection.getRangeAt(0).startContainer).toBe(before.startContainer);
    expect(selection.getRangeAt(0).startOffset).toBe(before.startOffset);
    expect(selection.getRangeAt(0).endContainer).toBe(before.endContainer);
    expect(selection.getRangeAt(0).endOffset).toBe(before.endOffset);
  });

  it("a_block_whose_text_is_being_selected_keeps_its_nodes_until_the_selection_lets_go", () => {
    feed.update([streaming("Смотри https://example.com/a")], true);
    const before = entry("a1");
    const link = before.querySelector("a") as HTMLAnchorElement;
    select(link, "https://example.com/a");

    feed.update([streaming("Смотри https://example.com/a и ещё")], true); // the next streaming delta
    expect(entry("a1")).toBe(before); // the very same element: the selection is still there
    expect(window.getSelection()?.toString()).toBe("https://example.com/a");

    clear(); // the person let go
    expect(entry("a1")).not.toBe(before);
    expect(entry("a1").textContent).toContain("и ещё");
  });

  it("a_selection_across_several_blocks_holds_every_block_it_runs_through", () => {
    const answer: Block = { kind: "assistant", id: "a0", text: "начало", thinking: "", streaming: false };
    const step: Block = { kind: "tool", id: "t1", name: "bash", summary: "ls", args: {}, output: "итог", truncated: false, state: "ok" };
    feed.update([answer, step, streaming("конец")], true);
    const held = [entry("a0"), entry("t1"), entry("a1")];
    const range = document.createRange();
    range.setStart(entry("a0"), 0);
    range.setEnd(entry("a1"), entry("a1").childNodes.length);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);

    feed.update([answer, { ...step, output: "итог 2" }, streaming("конец и ещё")], true);
    expect([entry("a0"), entry("t1"), entry("a1")]).toEqual(held); // the step in the middle stays put too
    expect(window.getSelection()?.toString()).toContain("итог");
  });

  it("an_untouched_block_still_follows_its_own_changes", () => {
    feed.update([{ kind: "assistant", id: "a0", text: "раньше", thinking: "", streaming: false }, streaming("один")], true);
    select(entry("a0"), "раньше");
    feed.update([{ kind: "assistant", id: "a0", text: "раньше", thinking: "", streaming: false }, streaming("один два")], true);
    expect(entry("a1").textContent).toContain("один два"); // only the selected block waits
    expect(window.getSelection()?.toString()).toBe("раньше");
  });

  it("the_secondary_button_opens_the_menu_and_acts_on_nothing", () => {
    feed.update([{ kind: "assistant", id: "a1", text: "Смотри https://example.com/a", thinking: "", streaming: false }], false);
    const link = entry("a1").querySelector("a") as HTMLAnchorElement;
    select(link, "https://example.com/a");
    let prevented: boolean | undefined;
    document.addEventListener(
      "click",
      (event) => {
        prevented = event.defaultPrevented;
        event.preventDefault(); // jsdom would follow the href; no browser dispatches a click for the right button
      },
      { once: true },
    );
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 2 }));
    expect(prevented).toBe(false); // the editor's own copy needs the event's default
    expect(posted).toEqual([]);
  });

  it("a_click_that_ends_a_selection_in_a_link_does_not_open_it", () => {
    feed.update([{ kind: "assistant", id: "a1", text: "Смотри https://example.com/a", thinking: "", streaming: false }], false);
    const link = entry("a1").querySelector("a") as HTMLAnchorElement;
    select(link, "example.com");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toEqual([]);

    clear(); // a plain click still opens it
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toEqual([{ type: "openLink", url: "https://example.com/a" }]);
  });

  it("a_link_click_is_not_blocked_by_a_selection_somewhere_else", () => {
    feed.update(
      [
        { kind: "assistant", id: "a0", text: "раньше", thinking: "", streaming: false },
        { kind: "assistant", id: "a1", text: "Смотри https://example.com/a", thinking: "", streaming: false },
      ],
      false,
    );
    select(entry("a0"), "раньше"); // Chrome keeps such a selection across a click on a link
    (entry("a1").querySelector("a") as HTMLAnchorElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toEqual([{ type: "openLink", url: "https://example.com/a" }]);
  });

  it("a_box_opens_on_a_click_unless_the_selection_is_in_it", () => {
    feed.update([{ kind: "tool", id: "t1", name: "bash", summary: "ls", args: {}, output: "итог", truncated: false, state: "ok" }], false);
    const box = entry("t1").querySelector('[data-role="tool-io"]') as HTMLElement;
    select(box, "итог");
    box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(box.classList.contains("open")).toBe(false);

    select(entry("t1").querySelector(".tool-name") as Element, "Bash"); // a selection outside the box is not its business
    box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(box.classList.contains("open")).toBe(true);
  });
});

describe("copy buttons", () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void written.push(text) } });
  });

  function copy(id: string, index = 0): HTMLButtonElement {
    return [...entry(id).querySelectorAll<HTMLButtonElement>('[data-role="copy"]')][index] as HTMLButtonElement;
  }

  it("a_code_block_gets_one_that_copies_the_code_alone", async () => {
    feed.update([{ kind: "assistant", id: "a1", text: "Вот:\n\n```sh\nls -la\ncd /tmp\n```\n", thinking: "", streaming: false }], false);
    const button = copy("a1");
    expect(button.title).toBe("Копировать");
    button.click();
    await Promise.resolve();
    expect(written).toEqual(["ls -la\ncd /tmp\n"]);
  });

  it("an_output_box_gets_one_that_copies_the_whole_text_not_the_shown_part", async () => {
    const output = Array.from({ length: 300 }, (_, index) => `строка ${index + 1}`).join("\n");
    feed.update([{ kind: "tool", id: "t1", name: "bash", summary: "ls", args: {}, input: "ls -la", output, truncated: false, state: "ok" }], false);
    expect(copy("t1", 0).closest('[data-io="in"]')).not.toBeNull();
    copy("t1", 1).click();
    await Promise.resolve();
    expect(written).toEqual([output]);
    expect((entry("t1").querySelector(".io-text") as HTMLElement).textContent).not.toContain("строка 300"); // the box still shows its first lines
  });

  it("a_click_on_one_neither_opens_the_box_nor_leaves_the_tick_behind", async () => {
    vi.useFakeTimers();
    feed.update([{ kind: "tool", id: "t1", name: "bash", summary: "ls", args: {}, output: "итог", truncated: false, state: "ok" }], false);
    const box = entry("t1").querySelector('[data-role="tool-io"]') as HTMLElement;
    const button = copy("t1");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(box.classList.contains("open")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(button.classList.contains("copied")).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(button.classList.contains("copied")).toBe(false);
    expect(written).toEqual(["итог"]);
    vi.useRealTimers();
  });
});

/**
 * An answered question in the feed: the card, not OmO's protocol text. Both of OmO's records reach the same card —
 * the answer's own user message (`waitForAnswer: false`) and the call's result (`waitForAnswer: true`).
 */
describe("an answered question", () => {
  const ID = "toolu_01DcM9tun78v1vtux7rZDVRz";
  const RAW = `[Answer to question ${ID}]\nКэш: Только на диске\nКлюч: (see [The user's answer to Ключ for question ${ID}] below)[The user's answer to Ключ for question ${ID}]не понимаю что это`;
  const ANSWER: Answer = {
    questionId: ID,
    forkFrom: "c1",
    questions: [
      {
        header: "Кэш",
        text: "Как хранить кэш каталога?",
        options: [
          { label: "TTL и запасной кэш", description: "Кэш с временем жизни и запасным слоем", chosen: false },
          { label: "Только на диске", description: "Кэш хранится в файлах на диске", chosen: true },
          { label: "Без кэша", chosen: false },
        ],
      },
    ],
  };
  const answerBlock = (answer: Answer, text = RAW): Block => ({ kind: "user", id: "u2", text, answer });
  const prompt: Block = { kind: "user", id: "c1", text: "почини каталог" };
  const card = (id: string): HTMLElement => entry(id).querySelector(".answer") as HTMLElement;
  const options = (id: string): [string, string | undefined, boolean][] =>
    [...entry(id).querySelectorAll(".answer .opt")].map((row) => [
      (row.querySelector(".lbl")?.childNodes[0]?.textContent ?? "").trim(),
      row.querySelector(".desc")?.textContent ?? undefined,
      row.classList.contains("chosen"),
    ]);

  it("the_card_shows_the_question_its_options_and_their_descriptions", () => {
    feed.update([prompt, answerBlock(ANSWER)], false);
    expect(card("u2").querySelector(".answer-title")?.textContent).toBe("Вопрос агента");
    expect(card("u2").querySelector(".tool")?.textContent).toBe("Кэш");
    expect(card("u2").querySelector(".question-text")?.textContent).toBe("Как хранить кэш каталога?");
    expect(options("u2")).toEqual([
      ["TTL и запасной кэш", "Кэш с временем жизни и запасным слоем", false],
      ["Только на диске", "Кэш хранится в файлах на диске", true],
      ["Без кэша", undefined, false],
    ]);
    expect(entry("u2").querySelectorAll(".answer .box.on")).toHaveLength(1);
  });

  it("omos_own_wording_never_reaches_the_feed", () => {
    feed.update([prompt, answerBlock(ANSWER)], false);
    const shown = entry("u2").textContent ?? "";
    expect(shown).not.toContain("Answer to question");
    expect(shown).not.toContain("The user's answer to");
    expect(shown).not.toContain(ID);
    expect(entry("u2").querySelector(".user-bubble")?.classList.contains("answered")).toBe(true);
  });

  it("their_own_words_show_as_the_answer_and_a_question_left_alone_says_so", () => {
    const answer: Answer = {
      questionId: ID,
      questions: [
        { header: "Ключ", text: "Какой ключ использовать?", options: [{ label: "age", chosen: false }], words: "не понимаю что это" },
        { header: "Кэш", text: "Как хранить кэш каталога?", options: [{ label: "Без кэша", chosen: false }], skipped: true },
      ],
    };
    feed.update([prompt, answerBlock(answer)], false);
    expect(card("u2").querySelector(".answer-title")?.textContent).toBe("Вопросы агента");
    expect([...card("u2").querySelectorAll(".answer-name")].map((name) => name.textContent)).toEqual(["Ключ", "Кэш"]);
    expect(card("u2").querySelector(".answer-words")?.textContent).toBe("не понимаю что это");
    expect([...card("u2").querySelectorAll(".answer-q.skipped .answer-note")].map((note) => note.textContent)).toEqual(["Не ответили"]);
  });

  it("an_answer_whose_question_is_gone_says_so_instead_of_showing_the_protocol", () => {
    feed.update([prompt, answerBlock({ questionId: ID, questions: [{ header: "age ключ", words: "не понимаю что это" }] })], false);
    expect(card("u2").querySelector(".answer-words")?.textContent).toBe("не понимаю что это");
    expect(card("u2").querySelector(".answer-note")?.textContent).toBe("Вопрос не сохранился");
    expect(entry("u2").textContent).not.toContain("Answer to question");
  });

  it("a_question_the_agent_waited_on_shows_the_same_card_in_place_of_its_step", () => {
    const waited: Block = {
      kind: "tool",
      id: ID,
      name: "ask_user_question",
      summary: "",
      args: {},
      output: `Кэш: Только на диске`,
      truncated: false,
      state: "ok",
      answer: ANSWER,
    };
    feed.update([prompt, waited], false);
    expect(entry(ID).classList.contains("user")).toBe(true);
    expect(card(ID).querySelector(".question-text")?.textContent).toBe("Как хранить кэш каталога?");
    expect(entry(ID).querySelector(".tool-details")).toBeNull();
    expect(entry(ID).textContent).not.toContain("Ask_user_question");
  });

  it("a_question_still_open_shows_nothing_in_the_feed", () => {
    feed.update([prompt, { kind: "tool", id: ID, name: "ask_user_question", summary: "", args: {}, output: "", truncated: false, state: "running" }], true);
    expect(entry(ID).textContent).toBe("");
  });

  it("the_cards_fork_menu_goes_back_to_the_message_whose_turn_asked", () => {
    const actions: [string, HTMLElement][] = [];
    feed = new Feed(root, (message) => posted.push(message), { onMessageActions: (blockId, anchor) => actions.push([blockId, anchor]) });
    feed.update([prompt, answerBlock(ANSWER)], false);
    const button = entry("u2").querySelector('[data-role="message-actions"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute("title")).toBe("Ответвить или откатить");
    button.click();
    expect(actions).toEqual([["c1", button]]); // the prompt, not the answer: OmO never re-asks a question it settled
  });

  it("a_card_with_nowhere_honest_to_fork_to_offers_no_menu", () => {
    feed.update([answerBlock({ questionId: ID, questions: ANSWER.questions })], false);
    expect(entry("u2").querySelector('[data-role="message-actions"]')).toBeNull();
  });

  it("an_answer_waiting_in_the_queue_is_the_card_with_its_queue_label", () => {
    feed.update([prompt, { ...(answerBlock(ANSWER) as Extract<Block, { kind: "user" }>), delivery: { state: "queued", queuedId: "q_1" } }], true);
    expect(card("u2")).not.toBeNull();
    expect(entry("u2").querySelector(".queued-label")?.textContent).toBe("в очереди — ждёт агента");
    expect(entry("u2").textContent).not.toContain("Answer to question");
  });
});


describe("turn sections for the sticky sent bubbles", () => {
  const reply: Block = { kind: "assistant", id: "a1", text: "ок", thinking: "", streaming: false };
  const reply2: Block = { kind: "assistant", id: "a2", text: "ещё", thinking: "", streaming: false };
  const turns = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".timeline > .turn")];
  const idsIn = (turn: HTMLElement): (string | undefined)[] =>
    [...turn.children].filter((row) => !row.matches(".stick-sentinel")).map((row) => (row as HTMLElement).dataset["block"]);

  it("each_sent_message_opens_a_turn_that_holds_the_output_under_it", () => {
    feed.update(
      [
        { kind: "user", id: "u1", text: "первый" },
        reply,
        { kind: "user", id: "u2", text: "второй" },
        reply2,
      ],
      false,
    );
    const sections = turns();
    expect(sections).toHaveLength(2);
    expect(idsIn(sections[0] as HTMLElement)).toEqual(["u1", "a1"]); // the sent bubble and the reply that followed it
    expect(idsIn(sections[1] as HTMLElement)).toEqual(["u2", "a2"]);
  });

  it("only_a_sent_message_is_a_sticky_head", () => {
    feed.update(
      [
        { kind: "user", id: "u1", text: "первый" },
        reply,
        { kind: "user", id: "u2", text: "в очереди", delivery: { state: "queued", queuedId: "q1" } },
      ],
      true,
    );
    expect(entry("u1").classList.contains("head")).toBe(true);
    expect(entry("u2").classList.contains("head")).toBe(false); // not with the agent yet: it never heads a turn
    // The queued message, not being a head, rides inside the previous turn rather than opening one of its own.
    expect(turns()).toHaveLength(1);
    // The sent head carries both corner controls: the fork menu for its place, the go-to-place for while it is stuck.
    expect(entry("u1").querySelector('[data-role="message-actions"]')).not.toBeNull();
    expect(entry("u1").querySelector('[data-role="goto-place"]')).not.toBeNull();
    expect(entry("u2").querySelector('[data-role="goto-place"]')).toBeNull(); // a queued message has no corner controls
  });

  it("output_before_the_first_sent_message_rides_a_lead_turn", () => {
    feed.update([reply, { kind: "user", id: "u1", text: "первый" }, reply2], false);
    const sections = turns();
    expect(sections).toHaveLength(2);
    expect(idsIn(sections[0] as HTMLElement)).toEqual(["a1"]); // before any sent message: a head-less lead section
    expect(idsIn(sections[1] as HTMLElement)).toEqual(["u1", "a2"]);
  });

  it("reuses_the_cached_entry_and_turn_across_a_streaming_re_render", () => {
    const streaming: Block = { kind: "assistant", id: "a1", text: "раз", thinking: "", streaming: true };
    feed.update([{ kind: "user", id: "u1", text: "первый" }, streaming], false);
    const head = entry("u1");
    const section = head.parentElement;
    feed.update([{ kind: "user", id: "u1", text: "первый" }, { ...streaming, text: "раз два" }], false); // the agent streamed on
    expect(entry("u1")).toBe(head); // the same sticky bubble element, never rebuilt — nothing jumps
    expect(entry("u1").parentElement).toBe(section); // and still in the same turn wrapper
  });
});

describe("focus view", () => {
  const tool = (id: string, state: "running" | "ok" | "error", name = "bash"): Block => ({ kind: "tool", id, name, summary: "ls", args: {}, output: "", truncated: false, state });
  const thought = (id: string, extra: Partial<Extract<Block, { kind: "assistant" }>> = {}): Block => ({ kind: "assistant", id, text: "", thinking: "план", streaming: false, ...extra });
  const turn: Block[] = [
    { kind: "user", id: "u1", text: "почини" },
    thought("a1", { thinkingMs: 4_000 }),
    tool("t1", "ok"),
    tool("t2", "error"),
    { kind: "assistant", id: "a2", text: "Готово", thinking: "проверю", streaming: false, thinkingMs: 2_000 },
    { kind: "user", id: "u2", text: "ещё" },
    tool("t3", "running"),
  ];
  /** The timeline's rows in order: a block by its id, a folded run as fold:<first id>. */
  const order = (): string[] =>
    [...root.querySelectorAll<HTMLElement>(".entry")].map((row) => (row.dataset["fold"] !== undefined ? `fold:${row.dataset["fold"]}` : (row.dataset["block"] ?? "?")));
  const fold = (key: string): HTMLButtonElement => root.querySelector(`[data-fold="${key}"] [data-role="fold"]`) as HTMLButtonElement;

  it("folds_each_run_of_steps_and_keeps_the_messages_and_answers", () => {
    feed.setFocus(true);
    feed.update(turn, true, { activity: "tool", tool: "bash" });
    expect(order()).toEqual(["u1", "fold:a1", "a2", "u2", "fold:t3"]);
    expect(fold("a1").textContent).toBe("2 действия · 1 с ошибкой▸");
    expect(root.querySelector('[data-fold="a1"] .step')?.classList.contains("error")).toBe(true);
    expect(root.querySelector('[data-fold="t3"] .step')?.classList.contains("running")).toBe(true);
    expect(entry("a2").textContent).toContain("Готово");
    expect(entry("a2").querySelector("details.thinking")).toBeNull(); // an answer shows without its thinking
    expect((root.querySelector('[data-role="indicator"]') as HTMLElement).hidden).toBe(false); // the live line still names the tool
  });

  it("a_folded_run_opens_and_closes_in_place", () => {
    feed.setFocus(true);
    feed.update(turn, false);
    fold("a1").click();
    expect(order()).toEqual(["u1", "fold:a1", "a1", "t1", "t2", "a2", "u2", "fold:t3"]);
    expect(fold("a1").getAttribute("aria-expanded")).toBe("true");
    feed.update([...turn.slice(0, 6), tool("t3", "ok")], false); // a new state keeps it open
    expect(order()).toContain("t1");
    fold("a1").click();
    expect(order()).toEqual(["u1", "fold:a1", "a2", "u2", "fold:t3"]);
  });

  it("switching_off_shows_every_step_again", () => {
    feed.setFocus(true);
    feed.update(turn, false);
    feed.setFocus(false);
    expect(order()).toEqual(["u1", "a1", "t1", "t2", "a2", "u2", "t3"]);
    expect(entry("a2").querySelector("details.thinking")).not.toBeNull();
  });

  it("an_approval_after_a_step_is_never_folded_away", () => {
    feed.setFocus(true);
    feed.update(turn.slice(0, 4), true);
    feed.addGuardRow("g1", document.createElement("div"), "t1");
    const rows = [...root.querySelectorAll<HTMLElement>(".entry")].map((row) => (row.classList.contains("guard-entry") ? "guard" : (row.dataset["fold"] ?? row.dataset["block"])));
    expect(rows).toEqual(["u1", "a1", "guard", "t2"]); // the run ends at the approval; the next step starts its own
  });

  it("thinking_folded_away_leaves_the_bottom_line_to_say_it", () => {
    feed.setFocus(true);
    feed.update([{ kind: "user", id: "u1", text: "x" }, thought("a1", { thinkingStartedAt: Date.now() })], true, { activity: "thinking" });
    expect(fold("a1").textContent).toBe("Размышляю…▸");
    expect((root.querySelector('[data-role="indicator"]') as HTMLElement).hidden).toBe(false);
  });

  it("fold_label_names_actions_thinking_or_steps", () => {
    expect(foldLabel([tool("t", "ok")])).toBe("1 действие");
    expect(foldLabel([tool("t", "ok"), tool("u", "ok"), tool("v", "ok"), tool("w", "ok"), tool("x", "ok")])).toBe("5 действий");
    expect(foldLabel([thought("a", { thinkingMs: 4_000 }), thought("b", { thinkingMs: 3_000 })])).toBe(`Размышлял ${formatDuration(7_000)}`);
    expect(foldLabel([thought("a")])).toBe("Размышления");
    const todo: Block = { kind: "tool", id: "td", name: "todo", summary: "", args: {}, output: "", truncated: false, state: "ok", todo: { op: "done", task: "x" } } as Block;
    expect(foldLabel([todo, thought("a")])).toBe("2 шага");
  });
});
