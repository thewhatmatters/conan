import { useCallback, useLayoutEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "conan-theme";

function readInitial(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return "light"; // light is the default; dark is opt-in via the toggle
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/**
 * App theme state, persisted to localStorage and applied as a `.dark` class on
 * <html>. The terminal (xterm) reads the same tokens (see lib/terminalTheme),
 * so the whole experience stays consistent when toggled.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readInitial);

  // useLayoutEffect (not useEffect) so the `.dark` class is on <html> before any
  // child's passive effect reads the CSS tokens — otherwise the terminal, whose
  // theme effect runs first (child-before-parent), would read stale colors.
  useLayoutEffect(() => {
    apply(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(
    () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, setTheme, toggle };
}
