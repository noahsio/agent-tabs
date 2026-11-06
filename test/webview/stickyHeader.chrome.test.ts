import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasChrome, openPage, type Page, type Point, waitFor, webviewPage } from "../helpers/chrome";

/** Stands in for VS Code: three sent messages, each under its own reply that is taller than the tab can show at once. */
const STUB = `
(function () {
  var reply = function (tag) { return Array.from({ length: 30 }, function (_, i) { return tag + " шаг " + (i + 1); }).join("\\n\\n"); };
  var long = Array.from({ length: 20 }, function (_, i) { return "Строка " + (i + 1); }).join("\\n");
  var blocks = [
    { kind: "user", id: "u1", text: "Сообщение один" },
    { kind: "assistant", id: "a1", text: reply("A"), thinking: "", streaming: false },
    { kind: "user", id: "u2", text: long },
    { kind: "assistant", id: "a2", text: reply("B"), thinking: "", streaming: false },
    { kind: "user", id: "u3", text: "Сообщение три" },
    { kind: "assistant", id: "a3", text: reply("C"), thinking: "", streaming: false },
  ];
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return undefined; },
      setState: function () {},
      postMessage: function (message) {
        if (message.type !== "ready") return;
        var state = { type: "state", reconnectable: true, tab: { modelMode: "auto", durableId: "id-1" }, state: { blocks: blocks, dialogs: [], agents: [], running: false } };
        setTimeout(function () { window.postMessage(JSON.stringify(state), "*"); }, 5);
      },
    };
  };
})();`;

type Shape = {
  hidden: boolean;
  text: string;
  transform: string;
  slotHeight: number;
};

/** The header's state: whether it shows, the message it mirrors, its push transform, and the slot's layout height. */
function shape(page: Page): Promise<Shape> {
  return page.evaluate<Shape>(`(() => {
    const slot = document.querySelector(".pin-slot");
    const pin = slot.querySelector('[data-role="pin"]');
    return {
      hidden: slot.hidden,
      text: pin.querySelector(".user-text").textContent,
      transform: pin.style.transform,
      slotHeight: slot.getBoundingClientRect().height,
    };
  })()`);
}

/** Lets a programmatic scroll's rAF-scheduled `updatePin` run (the handler schedules one frame; `updatePin` runs in it). */
function settle(page: Page): Promise<unknown> {
  return page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}

/** Scrolls so `id`'s bubble top lands `viewportTop` px below the feed's top edge (negative = scrolled above it). */
async function placeBubble(page: Page, id: string, viewportTop: number): Promise<void> {
  await page.evaluate(`(() => {
    const feed = document.querySelector("main.feed");
    const row = document.querySelector('[data-block="${id}"]').getBoundingClientRect();
    const target = feed.getBoundingClientRect().top + ${viewportTop};
    feed.scrollTop = feed.scrollTop + (row.top - target);
  })()`);
  await settle(page);
}

describe.skipIf(!hasChrome)("the sticky header of sent messages (headless Chrome)", () => {
  let page: Page;
  const SHOTS = "/tmp/agent-tabs-shots/sticky";

  beforeAll(async () => {
    page = await openPage(await webviewPage(STUB));
    await waitFor(page, `document.querySelector('[data-block="a3"]') !== null`);
    await waitFor(page, `document.querySelector(".pin-slot")?.hidden === false`);
  }, 30_000);

  afterAll(() => page?.close());

  it("at_the_bottom_the_latest_sent_message_heads_the_view", async () => {
    const header = await shape(page);
    expect(header.hidden).toBe(false);
    expect(header.text).toBe("Сообщение три"); // the latest, matching the single-pin behaviour it replaces
    expect(header.transform).toBe(""); // nothing crossing: the copy rests
  });

  it("a_message_still_in_view_never_heads_the_view", async () => {
    await placeBubble(page, "u3", 80); // u3 fully below the top edge, on screen
    expect((await shape(page)).text).not.toBe("Сообщение три"); // not copied into the header while it is visible
  });

  it("a_message_straddling_the_top_edge_is_in_transition_not_the_header", async () => {
    await placeBubble(page, "u2", -8); // u2 crossing the edge; its tall real bubble is what the person sees, rising
    const header = await shape(page);
    expect(header.hidden).toBe(false);
    expect(header.text).toBe("Сообщение один"); // u1 (the last message wholly past) heads the view
    expect(header.text).not.toContain("Строка"); // u2 is not duplicated into the header while it is visible
    expect(header.transform).toMatch(/^translateY\(-\d/); // the arriving bubble pushes the copy up and out
    expect(header.slotHeight).toBe(0); // and takes none of the feed's height

    // No doubling: u2's text shows once, as its own real bubble crossing the edge — never also as the header copy.
    const u2Copies = await page.evaluate<number>(
      `Array.from(document.querySelectorAll(".user-text")).filter((node) => (node.textContent ?? "").startsWith("Строка 1")).length`,
    );
    expect(u2Copies).toBe(1);
    // The handoff: the copy of u1 pushed up (a sliver), the tall u2 reading right below it as it rises — two in a row.
    await page.screenshot(`${SHOTS}/push-handoff.png`);
  });

  it("the_header_swaps_to_an_earlier_message_as_the_scroll_climbs", async () => {
    await placeBubble(page, "u3", 80); // u3 back on screen, u2 the latest one wholly past
    expect((await shape(page)).text).toContain("Строка 1");
    await page.screenshot(`${SHOTS}/header-single.png`); // one message, resting, mid-feed

    await placeBubble(page, "u2", -24); // scrolled up: u2 crossing, u1 now the latest wholly past
    expect((await shape(page)).text).toBe("Сообщение один"); // swapped to the earlier message
  });

  it("agent_and_tool_output_never_become_the_header", async () => {
    for (const viewportTop of [-24, 80, -200]) {
      await placeBubble(page, "u2", viewportTop);
      const header = await shape(page);
      if (!header.hidden) expect(header.text).toMatch(/^(Сообщение один|Сообщение три|Строка 1)/); // only a sent message, never a reply step
    }
  });

  it("at_the_very_top_no_message_heads_the_view", async () => {
    await page.evaluate(`document.querySelector("main.feed").scrollTop = 0`);
    await settle(page);
    expect((await shape(page)).hidden).toBe(true); // above the first sent message, nothing heads the view
  });

  it("the_jump_control_targets_the_message_the_header_mirrors_now", async () => {
    await placeBubble(page, "u3", -24); // header mirrors u2
    expect((await shape(page)).text).toContain("Строка 1");
    const jump = await page.evaluate<Point>(
      `(() => { const r = document.querySelector('[data-role="pin-jump"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await page.click(jump);
    // The smooth scroll settles with u2 — the message the header mirrored — back in view, not u1 or u3.
    await waitFor(
      page,
      `(() => { const r = document.querySelector('[data-block="u2"]').getBoundingClientRect(); const f = document.querySelector("main.feed").getBoundingClientRect(); return r.top >= f.top && r.top <= f.bottom; })()`,
    );
    const where = await page.evaluate<{ u2: number; feedTop: number; feedBottom: number }>(`(() => {
      const r = document.querySelector('[data-block="u2"]').getBoundingClientRect();
      const f = document.querySelector("main.feed").getBoundingClientRect();
      return { u2: r.top, feedTop: f.top, feedBottom: f.bottom };
    })()`);
    expect(where.u2).toBeGreaterThanOrEqual(where.feedTop - 1);
    expect(where.u2).toBeLessThanOrEqual(where.feedBottom);
  });

  it("opening_the_stuck_header_reaches_the_whole_message_without_moving_the_feed", async () => {
    await placeBubble(page, "u3", -24); // header mirrors the long u2, collapsed
    await waitFor(page, `document.querySelector('[data-role="pin-toggle"]').textContent === "Показать полностью"`);
    const before = await page.evaluate<{ scroll: number; textHeight: number }>(
      `(() => { const t = document.querySelector('[data-role="pin"] .user-text'); return { scroll: document.querySelector("main.feed").scrollTop, textHeight: t.clientHeight }; })()`,
    );
    const toggle = await page.evaluate<Point>(
      `(() => { const r = document.querySelector('[data-role="pin-toggle"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await page.click(toggle);
    await waitFor(page, `document.querySelector('[data-role="pin-toggle"]').textContent === "Свернуть"`);
    const after = await page.evaluate<{ scroll: number; textHeight: number }>(
      `(() => { const t = document.querySelector('[data-role="pin"] .user-text'); return { scroll: document.querySelector("main.feed").scrollTop, textHeight: t.clientHeight }; })()`,
    );
    expect(after.scroll).toBe(before.scroll); // opening it reads in place: the feed does not move
    expect(after.textHeight).toBeGreaterThan(before.textHeight); // and the whole message is reachable
  });
});
