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

function cssColorVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!value) return fallback;

  // v1 themes use concrete colours already; avoid DOM work on their hot path.
  if (!value.includes("var(") && !value.includes("light-dark(")) return value;

  // Theme tokens may contain CSS color functions such as light-dark(). xterm
  // needs a concrete color, so let the browser resolve the expression in the
  // document's actual color-scheme before handing it to the canvas renderer.
  const probe = document.createElement("span");
  probe.style.backgroundColor = `var(${name})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved || value;
}

export function getTerminalTheme(): XtermTheme {
  const background = cssColorVar("--term-bg", "#ffffff");
  const foreground = cssColorVar("--term-fg", "#1f2937");
  return {
    background,
    foreground,
    cursor: foreground,
  };
}
