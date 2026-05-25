/**
 * Derive an xterm.js theme from the app's CSS tokens so the terminal always
 * matches the active light/dark theme. Consumed by the terminal pane (US-016).
 *
 * Reads computed CSS custom properties at call time, so call it after a theme
 * change (and on mount) to keep xterm in sync.
 */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

export function getTerminalTheme(): XtermTheme {
  const background = cssVar("--term-bg", "#ffffff");
  const foreground = cssVar("--term-fg", "#1f2937");
  return {
    background,
    foreground,
    cursor: foreground,
  };
}
