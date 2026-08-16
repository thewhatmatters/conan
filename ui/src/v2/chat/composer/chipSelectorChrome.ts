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
 */
import * as stylex from "@stylexjs/stylex";

export const chipSelectorChrome = stylex.create({
  // ChatComposer sets pointer-events:none while disabled; effort/permission
  // stay reachable. minWidth:0 lets the flex row compress at narrow width.
  root: {
    minWidth: 0,
    pointerEvents: "auto",
  },
  // Ghost face: transparent, pill, wash on hover — same language as ModelPicker
  // / the previous DropdownMenu chip triggers. Explicitly zero every border and
  // box-shadow state that inputWrapperStyles.base sets (default, hover, focus).
  trigger: {
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
    },
    borderColor: {
      default: "transparent",
      ":focus-within": "transparent",
    },
    borderRadius: "var(--conan-radius-pill)",
    borderStyle: "none",
    borderWidth: 0,
    boxShadow: {
      default: "none",
      ":focus-within": "none",
      ":hover:not(:focus-within)": "none",
    },
    maxWidth: "100%",
    minWidth: 0,
  },
});
