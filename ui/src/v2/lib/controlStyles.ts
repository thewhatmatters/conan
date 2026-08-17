/**
 * controlStyles — one interaction model for v2's icon buttons (WHA-203).
 *
 * Randy, 2026-08-17, on the sidebar's Projects header: "Can we have consistency
 * in the button states, default/hover/pressed/inactive and such. In the example
 * here the filter button looks white, the add folder looks gray. What are we
 * doing?"
 *
 * Measured answer at `12aa3d3`: the sort trigger rested at `#FAFAFA` in a 28×28
 * 10px-radius Astryx ghost button, the add-project control at `#A3A3A3` in a
 * hand-rolled 32×32 4px-radius `<button>`, and NEITHER responded to hover,
 * press, or focus at all. Two origins, no reconciliation.
 *
 * The ladder below is that reconciliation. It is exported rather than repeated
 * so a third control cannot invent a fourth treatment:
 *
 *   rest      muted icon, no fill        — the rail stays quiet
 *   hover     primary icon + wash tint
 *   pressed   the selected-row tint
 *   focus     2px accent outline, drawn INSIDE the 32px lane
 *   disabled  muted at 40%, no hover response
 *
 * `iconButtonOpen` is for a menu trigger while its own flyout is up: the
 * pointer has to leave the trigger to reach the menu, and a control that drops
 * back to rest under its own open menu reads as broken. Same reasoning as
 * `ProjectTree`'s `menuSlotOpen`.
 */
import * as stylex from "@stylexjs/stylex";

export const controlStyles = stylex.create({
  iconButton: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
      ":active": "var(--conan-wash-row-selected)",
    },
    borderStyle: "none",
    borderRadius: "var(--conan-radius-sm)",
    color: {
      default: "var(--conan-icon-muted)",
      ":hover": "var(--conan-icon-primary)",
    },
    cursor: "pointer",
    display: "flex",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    justifyContent: "center",
    // Drawn inside the lane: a 32px control in a 32px slot has no room for an
    // outset ring, and an outset one would collide with its neighbour.
    outline: {
      default: "none",
      ":focus-visible": "2px solid var(--conan-color-accent)",
    },
    outlineOffset: {
      default: "0",
      ":focus-visible": "-2px",
    },
    padding: 0,
    transition: "background-color var(--conan-duration-fast) ease, color var(--conan-duration-fast) ease",
    width: "var(--conan-control-height)",
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
    },
  },
  /** A trigger holds the hover treatment while its own menu is open. */
  iconButtonOpen: {
    backgroundColor: "var(--conan-wash-hover)",
    color: "var(--conan-icon-primary)",
  },
  /**
   * Inert, and it must LOOK inert: the hover and active tints are pinned back
   * to transparent, because a disabled control that still lights up on hover
   * promises something it will not do.
   */
  iconButtonDisabled: {
    backgroundColor: {
      default: "transparent",
      ":hover": "transparent",
      ":active": "transparent",
    },
    color: {
      default: "var(--conan-icon-muted)",
      ":hover": "var(--conan-icon-muted)",
    },
    cursor: "default",
    opacity: 0.4,
  },
});
