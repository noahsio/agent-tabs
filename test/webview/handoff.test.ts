// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { Feed } from "../../webview/feed";
import { splitHandoff } from "../../webview/handoff";

let root: HTMLElement;
let feed: Feed;

beforeEach(() => {
  document.body.innerHTML = '<main id="feed"></main>';
  root = document.getElementById("feed") as HTMLElement;
  feed = new Feed(root, () => undefined);
});

function show(text: string, streaming = false): HTMLElement {
  feed.update([{ kind: "assistant", id: "a1", text, thinking: "", streaming, timestamp: 0 }], true);
  return root.querySelector(".markdown") as HTMLElement;
}

function rows(body: HTMLElement): string[][] {
  return [...body.querySelectorAll(".handoff-row")].map((row) => [row.querySelector(".handoff-label")?.textContent ?? "", (row.querySelector(".handoff-value")?.textContent ?? "").trim()]);
}

describe("hand-off card", () => {
  it("one_line_shape", () => {
    const body = show("Done.\n\nAsk: fix the tab - wanted: it stays open. For you: it works now. Now: none. Next: ship it.\n\nBye.");
    expect(rows(body)).toEqual([
      ["Запрос", "fix the tabнужно: it stays open."],
      ["Для тебя", "it works now."],
      ["Дальше", "ship it."],
    ]);
    expect(body.textContent).not.toContain("Ask:");
    expect(body.querySelector(".handoff-wanted")?.textContent).toBe("нужно: it stays open.");
    expect(body.firstElementChild?.tagName).toBe("P");
    expect(body.lastElementChild?.textContent).toBe("Bye.");
    expect(body.querySelectorAll("p")[0]?.textContent).toBe("Done.");
  });

  it("multi_line_shape", () => {
    const body = show("Ask: fix it\nFor you: fixed\nNow: testing\nNext: commit");
    expect(rows(body).map(([label]) => label)).toEqual(["Запрос", "Для тебя", "Сейчас", "Дальше"]);
  });

  it("bullets_under_for_you_stay_in_its_row", () => {
    const body = show("Ask: x - wanted: y.\nFor you: three things:\n- one\n- two\nNow: a. Next: b.");
    const value = body.querySelectorAll(".handoff-row")[1]?.querySelector(".handoff-value") as HTMLElement;
    expect([...value.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["one", "two"]);
    expect(rows(body)).toHaveLength(4);
  });

  it("fenced_block_is_not_parsed", () => {
    const text = "```\nAsk: x\nFor you: y\nNow: a\nNext: b\n```";
    expect(splitHandoff(text)).toBeUndefined();
    expect(show(text).querySelector(".handoff")).toBeNull();
    expect(splitHandoff("```\n\nAsk: x. For you: y. Now: a. Next: b.\n\n```")).toBeUndefined();
  });

  it("none_rows_are_omitted", () => {
    const body = show("Ask: x. For you: ok. Now: none. Next: none.");
    expect(rows(body).map(([label]) => label)).toEqual(["Запрос", "Для тебя"]);
    expect(rows(show("Ask: x. For you: ok. Now: нет. Next: Нет.")).map(([label]) => label)).toEqual(["Запрос", "Для тебя"]);
  });

  it("message_without_block_is_unchanged", () => {
    const text = "Hello\n\nAsk me anything.\n\n- a\n- b";
    expect(splitHandoff(text)).toBeUndefined();
    expect(show(text).innerHTML).toBe("<p>Hello</p>\n<p>Ask me anything.</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n");
  });

  it("streaming_is_not_parsed", () => {
    const text = "Ask: x. For you: y. Now: a. Next: b.";
    expect(show(text, true).querySelector(".handoff")).toBeNull();
    expect(show(text, false).querySelector(".handoff")).not.toBeNull();
  });

  it("model_html_stays_text", () => {
    const body = show("Ask: <img src=x onerror=alert(1)>. For you: <b>y</b>. Now: a. Next: b.");
    expect(body.querySelector("img, b")).toBeNull();
  });
});
