// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { Block } from "../../src/chat/model";
import type { WebviewMessage } from "../../src/panel/protocol";
import { diffSummary, Feed } from "../../webview/feed";

type ToolBlock = Extract<Block, { kind: "tool" }>;

let root: HTMLElement;
let posted: WebviewMessage[];
let feed: Feed;

function tool(fields: Partial<ToolBlock> & { name: string }): ToolBlock {
  return { kind: "tool", id: "t1", summary: "", args: undefined, output: "", truncated: false, state: "running", ...fields };
}

function step(id = "t1"): HTMLElement {
  return root.querySelector(`[data-block="${id}"] .step`) as HTMLElement;
}

function box(id = "t1"): HTMLElement | null {
  return root.querySelector(`[data-block="${id}"] [data-role="tool-io"]`);
}

function row(kind: "in" | "out" | "diff", id = "t1"): HTMLElement | null {
  return root.querySelector(`[data-block="${id}"] [data-io="${kind}"]`);
}

function text(kind: "in" | "out" | "diff", id = "t1"): string {
  return row(kind, id)?.querySelector(".io-text")?.textContent ?? "";
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

beforeEach(() => {
  document.body.innerHTML = '<main id="feed"></main>';
  root = document.getElementById("feed") as HTMLElement;
  posted = [];
  feed = new Feed(root, (message) => posted.push(message));
});

describe("a tool step's IN/OUT box", () => {
  it("while_running_only_IN_is_shown_and_OUT_appears_with_the_result", () => {
    const running = tool({ name: "bash", summary: "list files", input: "ls -la" });
    feed.update([running], true);
    expect(step().querySelector("summary")?.textContent).toBe("Bashlist files");
    expect(row("in")?.querySelector(".io-label")?.textContent).toBe("IN");
    expect(text("in")).toBe("ls -la");
    expect(row("out")).toBeNull();

    feed.update([{ ...running, output: "total 0", state: "ok" }], false);
    expect(row("out")?.querySelector(".io-label")?.textContent).toBe("OUT");
    expect(text("out")).toBe("total 0");
    expect(row("out")?.classList.contains("error")).toBe(false);
  });

  it("an_error_result_is_marked_as_one", () => {
    feed.update([tool({ name: "bash", input: "false", output: "exit 1", state: "error" })], false);
    expect(row("out")?.classList.contains("error")).toBe(true);
  });

  it("the_step_is_open_by_default_and_its_header_still_toggles_it", () => {
    feed.update([tool({ name: "bash", input: "ls" })], true);
    const details = step().querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(details.classList.contains("has-output")).toBe(true);
  });

  it("eval_notes_the_language", () => {
    feed.update([tool({ name: "eval", summary: "count", input: "print(1)", inputLang: "python" })], true);
    expect(row("in")?.querySelector(".io-lang")?.textContent).toBe("python");
  });

  it("long_text_is_clamped_and_a_click_on_the_box_expands_and_collapses_it", () => {
    const block = tool({ name: "bash", input: "one line", output: lines(5), state: "ok" });
    feed.update([block], false);
    expect(row("in")?.classList.contains("tall")).toBe(false);
    expect(row("out")?.classList.contains("tall")).toBe(true);
    const io = box() as HTMLElement;
    expect(io.getAttribute("aria-expanded")).toBe("false");
    (io.querySelector(".io-text") as HTMLElement).click();
    expect(io.classList.contains("open")).toBe(true);
    expect(io.getAttribute("aria-expanded")).toBe("true");

    feed.update([{ ...block, output: lines(6) }], false); // rebuilt: stays open
    expect(box()?.classList.contains("open")).toBe(true);
    (box() as HTMLElement).click();
    expect(box()?.classList.contains("open")).toBe(false);
  });

  it("the_keyboard_expands_the_box_too", () => {
    feed.update([tool({ name: "bash", input: lines(5) })], true);
    const io = box() as HTMLElement;
    expect(io.getAttribute("tabindex")).toBe("0");
    io.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(io.classList.contains("open")).toBe(true);
  });

  it("a_huge_output_shows_the_first_200_lines_and_says_how_many_are_left", () => {
    feed.update([tool({ name: "bash", input: "seq 500", output: lines(500), state: "ok" })], false);
    expect(text("out").split("\n")).toHaveLength(200);
    expect(text("out")).toContain("line 200");
    expect(text("out")).not.toContain("line 201");
    expect(row("out")?.querySelector(".io-more")?.textContent).toBe("… ещё 300 строк");
  });

  it("a_capped_output_says_so", () => {
    feed.update([tool({ name: "bash", input: "cat big", output: "x".repeat(100), truncated: true, state: "ok" })], false);
    expect(row("out")?.querySelector(".io-more")?.textContent).toBe("Вывод обрезан: показаны первые 20 000 символов.");
  });

  it("a_streamed_reply_does_not_rebuild_tool_boxes", () => {
    const steps: Block[] = [tool({ name: "bash", input: "ls", output: "a", state: "ok" }), { kind: "assistant", id: "a1", text: "x", thinking: "", streaming: true }];
    feed.update(steps, true);
    const before = box();
    feed.update([steps[0] as Block, { kind: "assistant", id: "a1", text: "xy", thinking: "", streaming: true }], true);
    expect(box()).toBe(before);
  });

  it("thinking_rows_stay_collapsed", () => {
    feed.update([{ kind: "assistant", id: "a1", text: "", thinking: "hm", streaming: false, thinkingMs: 3000 }], false);
    const details = root.querySelector('[data-block="a1"] details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Размышлял 3 с");
  });
});

describe("agent steps", () => {
  it("show_the_description_the_prompt_and_the_childs_result", () => {
    const task = tool({ name: "task", role: "deep", description: "Find usages", input: "Find all usages of X", model: "gw/m1" });
    feed.update([task], true);
    const summary = step().querySelector("summary") as HTMLElement;
    expect(summary.querySelector(".tool-name")?.textContent).toBe("Agent:");
    expect(summary.querySelector(".agent-desc")?.textContent).toBe("Find usages");
    expect(summary.querySelector(".agent-tag")?.textContent).toBe("gw/m1");
    expect(text("in")).toBe("Find all usages of X");
    expect(row("out")).toBeNull();

    feed.update([{ ...task, output: "Found 3", state: "ok", durationMs: 4000 }], false);
    expect(text("out")).toBe("Found 3");
    expect(step().querySelector(".sub")?.textContent).toBe("deep · готово за 4 с");
  });
});

describe("read steps", () => {
  it("are_one_line_with_a_file_link_and_the_lines_read", () => {
    feed.update([tool({ name: "read", file: "/repo/src/feed.ts", fromLine: 10, toLine: 49, output: "...", state: "ok" })], false);
    expect(box()).toBeNull();
    const link = step().querySelector("[data-open-file]") as HTMLAnchorElement;
    expect(link.textContent).toBe("feed.ts");
    expect(link.title).toBe("/repo/src/feed.ts");
    expect(step().querySelector("summary")?.textContent).toBe("Readfeed.ts(строки 10–49)");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); // the header does not toggle
    expect(posted).toEqual([{ type: "openFile", path: "/repo/src/feed.ts", line: 10 }]);
  });

  it("a_failed_read_shows_its_error", () => {
    feed.update([tool({ name: "read", file: "/repo/x.ts", output: "ENOENT", state: "error" })], false);
    expect(text("out")).toBe("ENOENT");
    expect(row("out")?.classList.contains("error")).toBe(true);
  });
});

describe("file edit steps", () => {
  it("show_the_file_a_summary_and_a_coloured_diff", () => {
    feed.update([tool({ name: "edit", file: "/repo/a.ts", input: " keep\n-old 1\n-old 2\n+new\n@@\n+more", added: 2, removed: 2, output: "ok", state: "ok" })], false);
    const summary = step().querySelector("summary") as HTMLElement;
    expect(summary.querySelector(".tool-name")?.textContent).toBe("Edit");
    expect(summary.querySelector("[data-open-file]")?.textContent).toBe("a.ts");
    expect(step().querySelector(".diff-stat")?.textContent).toBe("Добавлены 2 строки, удалены 2");
    const kinds = [...(row("diff")?.querySelectorAll(".dl") ?? [])].map((line) => `${line.className}|${line.textContent}`);
    expect(kinds).toEqual(["dl ctx| keep", "dl del|-old 1", "dl del|-old 2", "dl add|+new", "dl meta|@@", "dl add|+more"]);
    expect(row("diff")?.classList.contains("tall")).toBe(true);
    expect(row("out")).toBeNull(); // a successful edit's «ok» is noise
  });

  it("write_and_apply_patch_have_their_own_verbs", () => {
    feed.update(
      [tool({ id: "w", name: "write", file: "/a/n.ts", input: "+x", added: 1, removed: 0 }), tool({ id: "p", name: "apply_patch", file: "/a/m.ts", input: "*** Update File: /a/m.ts\n-a\n+b", added: 1, removed: 1 })],
      true,
    );
    expect(step("w").querySelector(".tool-name")?.textContent).toBe("Write");
    expect(step("p").querySelector(".tool-name")?.textContent).toBe("Patch");
    expect(step("w").querySelector(".diff-stat")?.textContent).toBe("Добавлена 1 строка");
  });

  it("a_failed_edit_shows_its_error_under_the_diff", () => {
    feed.update([tool({ name: "edit", file: "/a.ts", input: "-a\n+b", added: 1, removed: 1, output: "oldText not found", state: "error" })], false);
    expect(text("out")).toBe("oldText not found");
    expect(row("out")?.classList.contains("error")).toBe(true);
  });
});

describe("diffSummary", () => {
  it("agrees_in_number", () => {
    expect(diffSummary(1, 1)).toBe("Добавлена 1 строка, удалена 1");
    expect(diffSummary(5, 0)).toBe("Добавлено 5 строк");
    expect(diffSummary(0, 2)).toBe("Удалены 2 строки");
    expect(diffSummary(21, 11)).toBe("Добавлена 21 строка, удалено 11");
    expect(diffSummary(0, 0)).toBe("");
  });
});
