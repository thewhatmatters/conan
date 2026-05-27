import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** The effective, resolved theme that the app + terminal actually render. */
export type Theme = "light" | "dark";
/** The user's stored choice: an explicit theme, or "auto" (match the OS). */
export type ThemePreference = Theme | "auto";

const STORAGE_KEY = "conan-theme";

function readInitial(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "auto")
    return stored;
  return "light"; // light is the default; dark/auto are opt-in via the menu
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Resolve a preference to the concrete theme to render right now. */
function resolve(pref: ThemePreference): Theme {
  return pref === "auto" ? systemTheme() : pref;
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/**
 * App theme state, persisted to localStorage and applied as a `.dark` class on
 * <html>. The terminal (xterm) reads the same tokens (see lib/terminalTheme),
 * so the whole experience stays consistent when the theme changes.
 *
 * Three preferences are supported (US-011): "light", "dark", and "auto" —
 * "auto" tracks the OS `prefers-color-scheme` live via matchMedia. `theme` is
 * the *resolved* concrete theme (what downstream renders); `preference` is the
 * user's stored choice (what the View ▸ Theme radio submenu checks).
 */
export function useTheme() {
  const [preference, setPref] = useState<ThemePreference>(readInitial);
  const [theme, setResolved] = useState<Theme>(() => resolve(readInitial()));

  // useLayoutEffect (not useEffect) so the `.dark` class is on <html> before any
  // child's passive effect reads the CSS tokens — otherwise the terminal, whose
  // theme effect runs first (child-before-parent), would read stale colors.
  useLayoutEffect(() => {
    const resolved = resolve(preference);
    setResolved(resolved);
    apply(resolved);
    localStorage.setItem(STORAGE_KEY, preference);
  }, [preference]);

  // In "auto" mode, follow OS changes live: re-resolve + re-apply when the
  // system scheme flips. Inactive (listener removed) for explicit light/dark.
  useEffect(() => {
    if (preference !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const resolved = systemTheme();
      setResolved(resolved);
      apply(resolved);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  const setTheme = useCallback((p: ThemePreference) => setPref(p), []);
  const toggle = useCallback(
    () => setPref((t) => (resolve(t) === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, preference, setTheme, toggle };
}
