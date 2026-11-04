import { describe, expect, it, vi } from "vitest";
import { PanelRegistry, revealOrOpen } from "../../src/panel/registry";

type FakePanel = { reveal: () => void };

function fakePanel(): FakePanel {
  return { reveal: vi.fn() };
}

describe("PanelRegistry", () => {
  it("open_existing_session_focuses_tab", async () => {
    const registry = new PanelRegistry<FakePanel>();
    const existing = fakePanel();
    registry.add("/s/a.jsonl", existing);
    const attach = vi.fn(async () => fakePanel());

    const result = await revealOrOpen(registry, "/s/a.jsonl", attach);

    expect(result).toBe(existing);
    expect(existing.reveal).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
  });

  it("opens_a_session_that_is_not_open_yet", async () => {
    const registry = new PanelRegistry<FakePanel>();
    const opened = fakePanel();
    const attach = vi.fn(async () => opened);

    expect(await revealOrOpen(registry, "/s/b.jsonl", attach)).toBe(opened);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("remove_and_rename_move_the_key", () => {
    const registry = new PanelRegistry<FakePanel>();
    const panel = fakePanel();
    registry.add("/s/old.jsonl", panel);

    registry.rename("/s/old.jsonl", "/s/new.jsonl");
    expect(registry.get("/s/old.jsonl")).toBeUndefined();
    expect(registry.get("/s/new.jsonl")).toBe(panel);

    registry.remove("/s/new.jsonl");
    expect(registry.get("/s/new.jsonl")).toBeUndefined();
  });

  it("remove_only_drops_the_panel_it_is_given", () => {
    const registry = new PanelRegistry<FakePanel>();
    const first = fakePanel();
    const second = fakePanel();
    registry.add("/s/a.jsonl", first);
    registry.remove("/s/a.jsonl", second);
    expect(registry.get("/s/a.jsonl")).toBe(first);
  });
});
