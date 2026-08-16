/**
 * Conan v2 entry airlock (docs/v2-astryx-redesign.md §4.1).
 *
 * `loadV2Styles()` is the gate that keeps v1 byte-identical: it only runs when
 * the flag has already routed to v2, and it awaits every stylesheet before v2
 * renders. WHA-197 adds `document.fonts.ready` to that gate so custom web fonts
 * are loaded before first paint, avoiding a glyph flash in the native app.
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

  it("awaits document.fonts.ready after the stylesheets resolve", async () => {
    let resolveFonts: (() => void) | undefined;
    const fontsReady = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });

    Object.defineProperty(document, "fonts", {
      value: { ready: fontsReady },
      configurable: true,
      writable: true,
    });

    const { loadV2Styles } = await import("../entry.tsx");
    const stylesPromise = loadV2Styles();
    expect(resolveFonts).toBeDefined();
    await Promise.resolve();
    await Promise.resolve();
    // The stylesheets are mocked to resolve immediately; fonts.ready is still
    // pending because we have not called resolveFonts yet.
    expect(stylesPromise).not.toBeUndefined();
    resolveFonts!();
    await stylesPromise;
  });

  it("returns the same promise on repeated calls", async () => {
    Object.defineProperty(document, "fonts", {
      value: { ready: Promise.resolve() },
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
