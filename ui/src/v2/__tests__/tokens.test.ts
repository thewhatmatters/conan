/**
 * tokens.css — the v2 design-token bridge (contract §4.2).
 *
 * A smoke test, deliberately: it proves the token layer REACHES THE DOCUMENT
 * through the entry's own loader, and that the handful of variables the shell
 * would collapse without are declared on the scope Astryx resolves against.
 *
 * What it does NOT do is assert computed values — jsdom does not resolve
 * `var()`, and nearly every `--conan-*` token is an alias onto an Astryx theme
 * variable. Pinning resolved colours here would test jsdom, not the design.
 * The value-level check against Paper is the browser QA pass.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadV2Styles } from "../entry.tsx";

/** Every stylesheet Vitest has injected into this document, as raw text. */
function injectedCss(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("\n");
}

describe("v2 tokens.css", () => {
  beforeAll(async () => {
    // The real entry path: reset → astryx → theme → fonts → tokens, in cascade
    // order. If this ever stops injecting tokens, v2 renders unstyled in the
    // app too, which is exactly the failure this test is here to catch.
    await loadV2Styles();
  });

  it("is loaded by the v2 entry", () => {
    expect(injectedCss()).toContain("--conan-color-bg");
  });

  it("declares its tokens on the Astryx theme scope", () => {
    // `entry.tsx` stamps `data-astryx-theme="neutral"` on <html>; tokens.css
    // must key off the SAME element or every var() resolves to nothing.
    expect(injectedCss()).toMatch(/\[data-astryx-theme=["']?neutral["']?\]/);
  });

  it("declares the shell's load-bearing tokens", () => {
    const css = injectedCss();
    // One per structural decision the shell makes: app tone, the lifted well
    // and its single 24px corner, the sidebar's fixed width, and the two bar
    // heights. A missing one is a visibly broken shell, not a nuance.
    for (const token of [
      "--conan-color-bg",
      "--conan-color-content",
      "--conan-color-sidebar",
      "--conan-radius-page",
      "--conan-sidebar-width",
      "--conan-toolbar-height",
      "--conan-control-height",
    ]) {
      expect(css, `${token} is missing from tokens.css`).toContain(`${token}:`);
    }
  });

  it("gives transcript and composer separate readable measures", () => {
    const css = injectedCss();
    expect(css).toContain("--conan-chat-measure: 800px");
    expect(css).toContain("--conan-composer-measure: 450px");
  });

  it("sizes the breadcrumb thread menu to hug up to a 64-char title", () => {
    // Ceiling tracks the product cap (64 chars + check + padding ≈ 68ch), not
    // the old fixed 320px that left hollow empty space next to short rows.
    expect(injectedCss()).toContain("--conan-crumb-menu-max-width: 68ch");
  });

  it("auto-hides v2 scrollbars at rest and reveals them without resizing", () => {
    const css = injectedCss();
    expect(css).toContain("--conan-scrollbar-size: var(--conan-space-1h)");
    expect(css).toMatch(
      /@supports not selector\(::-webkit-scrollbar\)\s*{\s*\[data-astryx-theme=["']neutral["']\] \*\s*{[^}]*scrollbar-color:\s*transparent transparent[^}]*scrollbar-width:\s*thin[^}]*}\s*\[data-astryx-theme=["']neutral["']\] \*:hover\s*{[^}]*scrollbar-color:\s*var\(--conan-scrollbar-thumb-hover\) transparent/s,
    );
    expect(css).toMatch(
      /\*::-webkit-scrollbar\s*{[^}]*width:\s*var\(--conan-scrollbar-size\)/s,
    );
    expect(css).toMatch(
      /\*::-webkit-scrollbar-thumb\s*{[^}]*background-color:\s*transparent[^}]*border-radius:\s*var\(--conan-radius-full\)[^}]*transition:\s*background-color var\(--conan-duration-fast\) var\(--conan-ease\)/s,
    );
    expect(css).toMatch(/\*::-webkit-scrollbar-thumb:hover\s*{/);
    expect(css).toMatch(/\*::-webkit-scrollbar-thumb:active\s*{/);
    expect(css).toMatch(
      /\*::-webkit-scrollbar-button\s*{[^}]*display:\s*none[^}]*height:\s*0[^}]*width:\s*0/s,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*{\s*\[data-astryx-theme=["']neutral["']\] \*::-webkit-scrollbar-thumb\s*{[^}]*transition:\s*none/s,
    );
  });

  it("collapses the fixed sidebar below the shell breakpoint (US-506)", () => {
    const css = injectedCss();
    expect(css).toContain("--conan-shell-min-width: 960px");
    expect(css).toMatch(/@media\s*\(max-width:\s*959px\)/);
    expect(css).toMatch(/\[data-slot=["']sidebar-panel["']\]\s*{[^}]*display:\s*none/s);
  });

  it("frosts the pane header off the well's own tone (WHA-115)", () => {
    const css = injectedCss();
    // The glass has to be MIXED off `--conan-color-content`, not written as a
    // literal: the bar overlays the well, so a hard-coded tone would drift the
    // moment the well moves and the frosted bar would read as a foreign patch.
    expect(css).toMatch(
      /--conan-glass-tint:\s*color-mix\(in srgb, var\(--conan-color-content\) 82%, transparent\)/,
    );
    expect(css).toContain("--conan-glass-blur: 16px");
  });

  it("lets composer controls yield space to the send action at narrow widths", () => {
    const css = injectedCss();
    expect(css).toMatch(
      /\[data-slot=["']composer-controls["']\]\s*{[^}]*flex:\s*1 1 auto[^}]*min-width:\s*0/s,
    );
    expect(css).toMatch(
      /:has\(> \[data-slot=["']composer-controls["']\]\)\s*{[^}]*min-width:\s*0/s,
    );
    expect(css).toMatch(
      /\[data-slot=["']composer-controls["']\] button\s*{[^}]*min-width:\s*0/s,
    );
  });
});
