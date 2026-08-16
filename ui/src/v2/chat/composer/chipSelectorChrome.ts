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
 * wrapper's `:focus-within` inset ring is the only focus treatment. A pure
 * `:focus-visible` rule on this wrapper never matches (focus is on the child
 * button). Zero resting border/shadow; restore the Astryx focus-within inset
 * so keyboard focus still paints without bringing back the form face.
 */
import * as stylex from "@stylexjs/stylex";

export const chipSelectorChrome = stylex.create({
  // ChatComposer sets pointer-events:none while disabled; effort/permission
  // stay reachable. minWidth:0 lets the flex row compress at narrow width.
  root: {
    minWidth: 0,
    pointerEvents: "auto",
  },
  // Ghost resting face + Astryx focus-within inset (inputStyles.stylex.ts).
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
      // Same token/shape Astryx uses for Selector focus (inputStyles.stylex.ts).
      ":focus-within":
        "inset 0px 0px 0px 2px var(--color-accent-muted)",
    },
    maxWidth: "100%",
    minWidth: 0,
  },
});
