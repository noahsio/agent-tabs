import { describe, expect, it } from "vitest";
import { ImageStore, sharedImages } from "../../src/sessions/images";

const ref = (id: string): { id: string; mimeType: string } => ({ id, mimeType: "image/png" });

describe("ImageStore", () => {
  it("image_store_evicts_by_bytes", () => {
    const store = new ImageStore(10);
    store.put(ref("a"), "xxxx");
    store.put(ref("b"), "xxxx");
    expect(store.get("a")).toBeDefined(); // touch: b is now the oldest
    store.put(ref("c"), "xxxx");
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toEqual({ mimeType: "image/png", data: "xxxx" });
    expect(store.get("c")).toBeDefined();
  });

  it("replaces_same_id_without_double_counting", () => {
    const store = new ImageStore(10);
    store.put(ref("a"), "xxxxxxxx");
    store.put(ref("a"), "yyyyyyyy");
    expect(store.get("a")?.data).toBe("yyyyyyyy");
  });

  it("clear_empties", () => {
    const store = new ImageStore();
    store.put(ref("a"), "x");
    store.clear();
    expect(store.get("a")).toBeUndefined();
  });

  it("drop_scope_removes_only_ids_under_that_prefix", () => {
    const store = new ImageStore();
    store.put(ref("tab-1/u1:0"), "x");
    store.put(ref("tab-2/u1:0"), "y");
    store.dropScope("tab-1/");
    expect(store.get("tab-1/u1:0")).toBeUndefined();
    expect(store.get("tab-2/u1:0")?.data).toBe("y");
    expect(store.size).toBe(1);
  });

  it("the_host_wide_store_holds_about_100_mb", () => {
    const store = sharedImages;
    const image = "x".repeat(5_000_000);
    for (let index = 0; index < 25; index++) store.put(ref(`bench/${index}`), image);
    expect(store.size).toBe(20); // 100 MiB / 5 MB
    store.dropScope("bench/");
    expect(store.size).toBe(0);
  });
});
