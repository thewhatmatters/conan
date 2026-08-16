/**
 * Conan v2 — entry point and CSS airlock.
 * (T0 of docs/v2-astryx-redesign.md; contracts §4.1 and the §2 isolation rule.)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Astryx's `reset.css` and `astryx.css` are app-GLOBAL: dropped into
 * `ui/src/index.css` they would fight v1's Tailwind preflight and restyle the
 * app we dogfood. So they are never statically imported anywhere. They are
 * pulled in by `import()` inside `loadV2Styles()` below, which runs only when
 * the flag has already routed to v2 — Vite emits them as their own chunk, and
 * with the flag off that chunk is never requested. v1 stays byte-identical.
 *
 * Nothing here imports Astryx components either: `App.v2.tsx` is reached via
 * `React.lazy`, so App.tsx can import this module statically (cheap — a flag
 * reader plus a lazy handle) without dragging the library into the v1 bundle.
 */
import { lazy } from "react";

/** localStorage key that turns v2 on. `"1"` = on; any other value = off. */
export const V2_FLAG_KEY = "conan-v2";

/**
 * Is the v2 UI active for this load?
 *
 * `localStorage.conan-v2` is authoritative when present, so a developer can
 * flip v2 on (or force it OFF) in a build where `VITE_CONAN_V2` is baked in.
 * With no stored value we fall back to the build-time env flag. Read once at
 * boot — flipping the key requires a reload, which is the intent: v1 and v2
 * load different global stylesheets and cannot coexist in one document.
 *
 * `localStorage` access is wrapped because it throws in a partitioned or
 * cookie-blocked context; the safe answer there is "v1", the default.
 */
export function isV2Enabled(): boolean {
  try {
    const stored = localStorage.getItem(V2_FLAG_KEY);
    if (stored !== null) return stored === "1";
  } catch {
    /* storage unavailable — fall through to the env flag */
  }
  const env = import.meta.env.VITE_CONAN_V2;
  return env === "1" || env === "true";
}

/**
 * Stamp the attributes Astryx's stylesheets key off.
 *
 * - `data-astryx-theme="neutral"` is the `@scope` root of
 *   `@astryxdesign/theme-neutral/theme.css` — without it NO token resolves and
 *   every component renders unstyled (silently; there is no warning).
 * - `data-theme="dark"` sets `color-scheme: dark`, which is what makes the
 *   `light-dark()` token values resolve to their dark side. The Paper artboard
 *   (`4I-0`) is dark mode, so v2 is dark for now; a v1-style light/dark toggle
 *   is a later task and only has to change this one attribute.
 *
 * Set on <html> rather than the v2 root so portalled content (dialogs,
 * popovers, toasts) inherits the theme too.
 */
export function applyV2ThemeAttributes(): void {
  const html = document.documentElement;
  html.setAttribute("data-astryx-theme", "neutral");
  html.setAttribute("data-theme", "dark");
}

let stylesPromise: Promise<void> | null = null;

/**
 * Load the v2 global stylesheets, once, in cascade order.
 *
 * The awaits are SEQUENTIAL on purpose: each `import()` injects its stylesheet
 * when it resolves, so racing them (Promise.all) would let the theme land
 * before the reset that it is supposed to override. Order is
 * reset → astryx → theme → fonts → tokens, mirroring the order Astryx's own
 * setup docs prescribe, with our bridge layer last so it always wins.
 *
 * After the font stylesheet is injected we explicitly load the Figtree weights
 * the v2 type scale uses (400/500/600/700). WebKit will resolve
 * `document.fonts.ready` immediately if no element references the faces yet,
 * so the explicit `fonts.load()` calls are what actually keep v2 from painting
 * before the custom glyphs are available (WHA-197).
 */
export function loadV2Styles(): Promise<void> {
  stylesPromise ??= (async () => {
    await import("@astryxdesign/core/reset.css");
    await import("@astryxdesign/core/astryx.css");
    await import("@astryxdesign/theme-neutral/theme.css");
    await import("./fonts.css");
    await import("./tokens.css");
    if (document.fonts) {
      await Promise.all([
        document.fonts.load("400 1em Figtree"),
        document.fonts.load("500 1em Figtree"),
        document.fonts.load("600 1em Figtree"),
        document.fonts.load("700 1em Figtree"),
      ]);
      await document.fonts.ready;
    }
  })();
  return stylesPromise;
}

/**
 * The v2 app. Suspends while the stylesheets and the Astryx bundle load, so the
 * caller must render it inside a `<Suspense>`. Styles are awaited BEFORE the
 * component module resolves — that ordering is what prevents a flash of
 * unstyled Astryx markup.
 */
export const AppV2 = lazy(async () => {
  applyV2ThemeAttributes();
  await loadV2Styles();
  return import("./App.v2.tsx");
});
