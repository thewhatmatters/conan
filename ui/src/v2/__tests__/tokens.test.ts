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

  it("keeps the transcript and composer on the 800px chat measure", () => {
    expect(injectedCss()).toContain("--conan-chat-measure: 800px");
  });

  it("collapses the fixed sidebar below the shell breakpoint (US-506)", () => {
    const css = injectedCss();
    expect(css).toContain("--conan-shell-min-width: 960px");
    expect(css).toMatch(/@media\s*\(max-width:\s*959px\)/);
    expect(css).toMatch(/\[data-slot=["']sidebar-panel["']\]\s*{[^}]*display:\s*none/s);
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
