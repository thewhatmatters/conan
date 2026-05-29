import { useCallback, useSyncExternalStore } from "react";
import {
  BUILTIN_THEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
} from "../lib/themes.ts";
import {
  AUTO_ID,
  getActiveId,
  resolveTheme,
  setActiveIdStore,
  subscribe,
} from "./useThemes.ts";

/** The effective, resolved theme that the app + terminal actually render. */
export type Theme = "light" | "dark";
/** The user's stored choice: an explicit theme, or "auto" (match the OS). */
export type ThemePreference = Theme | "auto";

/**
 * Light/dark/auto adapter over the shared theme store (useThemes). The apply
 * path + persistence now live in useThemes (US-021); this hook exists so the
 * existing View ▸ Theme radio submenu and the App `theme` prop keep their
 * light/dark/auto vocabulary unchanged while there is one apply path underneath.
 * US-023 rewires the menu to the full theme list.
 *
 * `theme` is the *resolved* concrete theme (what downstream renders);
 * `preference` is the user's stored choice (what the radio submenu checks):
 * "auto" when the active selection follows the OS, else the active theme's type.
 */
export function useTheme() {
  const activeId = useSyncExternalStore(subscribe, getActiveId);
  const resolved = resolveTheme(activeId, BUILTIN_THEMES);
  const theme: Theme = resolved.type;
  const preference: ThemePreference = activeId === AUTO_ID ? "auto" : theme;

  // "light" | "dark" | "auto" are all valid activeIds (the first two are
  // built-in theme ids; "auto" is the special pair), so set directly.
  const setTheme = useCallback((p: ThemePreference) => setActiveIdStore(p), []);
  const toggle = useCallback(
    () =>
      setActiveIdStore(
        resolveTheme(getActiveId(), BUILTIN_THEMES).type === "dark"
          ? DEFAULT_LIGHT_ID
          : DEFAULT_DARK_ID,
      ),
    [],
  );

  return { theme, preference, setTheme, toggle };
}
