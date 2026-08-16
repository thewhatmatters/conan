/**
 * Shared chrome for Effort / Permission chips built on Astryx Selector.
 *
 * Selector is a form control — its trigger container applies
 * `inputWrapperStyles.base` (border, surface fill, inset hover/focus rings).
 * The model picker's face is a ghost Button with no border. Randy rejected
 * the form chrome on these composer chips (WHA-200).
 *
 * `Selector` puts consumer `xstyle` on that same bordered trigger container
 * (see Selector.tsx: stylex.props(inputWrapperStyles.base, …, xstyle)). So
 * these overrides hit the bordered element directly — no descendant selectors
 * into library internals.
 *
 * Focus: the combobox button sets `outline: none` and documents that the
 * wrapper's `:focus-within` inset is the only focus treatment. A pure
 * `:focus-visible` rule on this wrapper never matches (focus is on the child
 * button). Zero resting border/shadow; paint a focus-within inset so keyboard
 * focus is visible without restoring the form face.
 *
 * Token: Astryx uses `--color-accent-muted` against a light input surface.
 * On this ghost chip the ring sits on the composer's near-black (~rgb(27,27,27));
 * accent-muted (~rgb(38,38,38)) paints but fails WCAG non-text contrast (~1.14:1).
 * Use `--conan-color-accent` (same as ThreadRow/WHA-117 focus) for a readable ring.
 */
import * as stylex from "@stylexjs/stylex";

export const chipSelectorChrome = stylex.create({
  // ChatComposer sets pointer-events:none while disabled; effort/permission
  // stay reachable. minWidth:0 lets the flex row compress at narrow width.
  root: {
    minWidth: 0,
    pointerEvents: "auto",
  },
  // Ghost resting face + visible focus-within inset on composer chrome.
  trigger: {
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
    },
    borderColor: {
      default: "transparent",
      // Stay transparent under focus — ring is box-shadow, not form border.
      ":focus-within": "transparent",
    },
    borderRadius: "var(--conan-radius-pill)",
    borderStyle: "none",
    borderWidth: 0,
    boxShadow: {
      default: "none",
      ":hover:not(:focus-within)": "none",
      // 2px inset shape matches Astryx; accent (not accent-muted) for contrast
      // on the transparent/ghost face over the composer.
      ":focus-within":
        "inset 0px 0px 0px 2px var(--conan-color-accent)",
    },
    maxWidth: "100%",
    minWidth: 0,
  },
});
