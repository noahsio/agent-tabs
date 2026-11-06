// jsdom has no ResizeObserver; the webview observes the composer, so every jsdom suite needs one that does nothing.
// A test that drives resizes stubs its own (see composerOverlay.test.ts).
if (typeof window !== "undefined" && globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// jsdom has no IntersectionObserver; the feed watches sentinels to know when a sent bubble is stuck. A no-op is enough
// for the jsdom suites (the stuck-state behaviour is covered under headless Chrome, which has a real one).
if (typeof window !== "undefined" && globalThis.IntersectionObserver === undefined) {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}
