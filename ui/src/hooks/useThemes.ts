import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  BUILTIN_THEMES,
  DEFAULT_LIGHT_ID,
  type Theme,
} from "../lib/themes.ts";

/**
 * Theme selection state (US-020): merges the bundled built-in themes with any
 * (later) user themes, exposes the available themes + the active theme + a
 * setter, and persists the active selection by `id` in localStorage.
 *
 * This story is the MODEL + selection only — it does NOT apply the theme to the
 * DOM (that's US-021) and renders no UI (US-023). It deliberately lives beside
 * the existing useTheme (light/dark/auto) rather than replacing it; US-021
 * folds the two together when the apply path lands.
 *
 * Backed by a module-level store + useSyncExternalStore (same pattern as
 * useAppearance) so every consumer shares one active-id source of truth.
 */
const STORAGE_KEY = "conan-theme-id";

function readInitialId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // localStorage may be unavailable (private mode) — fall through to default.
  }
  return DEFAULT_LIGHT_ID;
}

// --- Shared module-level store -------------------------------------------------
let activeId: string = readInitialId();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): string {
  return activeId;
}

function setActiveIdStore(id: string) {
  if (id === activeId) return;
  activeId = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the in-memory selection still drives this session.
  }
  emit();
}

/** Merge built-ins with user themes; a user theme overrides a built-in by id. */
function mergeThemes(userThemes: Theme[]): Theme[] {
  if (userThemes.length === 0) return BUILTIN_THEMES;
  const byId = new Map<string, Theme>();
  for (const t of BUILTIN_THEMES) byId.set(t.id, t);
  for (const t of userThemes) byId.set(t.id, t);
  return Array.from(byId.values());
}

/**
 * @param userThemes optional user-supplied themes (US-022 reads these from
 *   ~/.conan/themes.json); they merge over built-ins by id. Defaults to none.
 */
export function useThemes(userThemes: Theme[] = []) {
  const activeIdValue = useSyncExternalStore(subscribe, getSnapshot);

  const themes = useMemo(() => mergeThemes(userThemes), [userThemes]);

  // Resolve the active theme; fall back to the default if the stored id no
  // longer exists (e.g. a user theme was removed from themes.json).
  const activeTheme = useMemo(
    () =>
      themes.find((t) => t.id === activeIdValue) ??
      themes.find((t) => t.id === DEFAULT_LIGHT_ID) ??
      themes[0],
    [themes, activeIdValue],
  );

  const setActiveTheme = useCallback((id: string) => setActiveIdStore(id), []);

  return { themes, activeId: activeIdValue, activeTheme, setActiveTheme };
}
