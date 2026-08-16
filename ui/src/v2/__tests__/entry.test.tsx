/**
 * Conan v2 entry airlock (docs/v2-astryx-redesign.md §4.1).
 *
 * `loadV2Styles()` is the gate that keeps v1 byte-identical: it only runs when
 * the flag has already routed to v2, and it awaits every stylesheet before v2
 * renders. WHA-197 explicitly loads the Figtree weights the v2 type scale uses
 * so custom web fonts are ready before first paint, avoiding a glyph flash in
 * the native app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@astryxdesign/core/reset.css", () => ({}));
vi.mock("@astryxdesign/core/astryx.css", () => ({}));
vi.mock("@astryxdesign/theme-neutral/theme.css", () => ({}));
vi.mock("../fonts.css", () => ({}));
vi.mock("../tokens.css", () => ({}));

describe("loadV2Styles", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explicitly loads Figtree weights and awaits fonts.ready", async () => {
    const loadPromises: Array<{ resolve: () => void; spec: string }> = [];
    const load = vi.fn((spec: string) => {
      let resolveLoad: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      loadPromises.push({ resolve: resolveLoad!, spec });
      return promise;
    });

    let resolveFonts: (() => void) | undefined;
    const fontsReady = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });

    Object.defineProperty(document, "fonts", {
      value: { ready: fontsReady, load },
      configurable: true,
      writable: true,
    });

    const { loadV2Styles } = await import("../entry.tsx");
    const stylesPromise = loadV2Styles();
    let settled = false;
    stylesPromise.then(() => {
      settled = true;
    });

    // The stylesheet imports are mocked but still resolve asynchronously;
    // wait for the code to reach the explicit font loads.
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    expect(load).toHaveBeenCalledWith("400 1em Figtree");
    expect(load).toHaveBeenCalledWith("500 1em Figtree");
    expect(load).toHaveBeenCalledWith("600 1em Figtree");
    expect(load).toHaveBeenCalledWith("700 1em Figtree");

    // Resolving only three of the four explicit loads must keep the promise
    // pending: it is awaiting the fourth load, not merely fonts.ready.
    for (let i = 0; i < 3; i++) loadPromises[i]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // Once all four loads resolve, the function is awaiting fonts.ready.
    loadPromises[3]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // Resolve the global fonts.ready signal.
    resolveFonts!();
    await stylesPromise;
    expect(settled).toBe(true);
  });

  it("returns the same promise on repeated calls", async () => {
    Object.defineProperty(document, "fonts", {
      value: { ready: Promise.resolve(), load: vi.fn(() => Promise.resolve()) },
      configurable: true,
      writable: true,
    });

    const { loadV2Styles } = await import("../entry.tsx");
    const first = loadV2Styles();
    const second = loadV2Styles();
    expect(second).toBe(first);
    await first;
  });
});
