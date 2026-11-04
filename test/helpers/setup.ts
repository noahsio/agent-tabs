// jsdom has no ResizeObserver; the webview observes the composer, so every jsdom suite needs one that does nothing.
// A test that drives resizes stubs its own (see composerOverlay.test.ts).
if (typeof window !== "undefined" && globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
