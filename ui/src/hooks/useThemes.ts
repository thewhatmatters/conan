import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  applyTheme,
  BUILTIN_THEMES,
  DEFAULT_LIGHT_ID,
  defaultThemeForType,
  type Theme,
} from "../lib/themes.ts";

/**
 * Theme selection + apply authority.
 *
 * US-020 built the model + selection (by id, persisted). US-021 adds the apply
 * path: this module is now the single source of truth that writes the active
 * theme's tokens onto <html> and toggles `.dark` per type — replacing
 * useTheme's old `.dark`-only apply (useTheme is now a thin light/dark/auto
 * shim over this same store, so there is exactly one apply path).
 *
 * The active selection is an `activeId`: a concrete theme id (e.g. "dracula"),
 * or the special `AUTO_ID` ("auto") which maps to the default light/dark pair
 * and follows the OS `prefers-color-scheme` live.
 *
 * Backed by a module-level store + useSyncExternalStore (same pattern as
 * useAppearance) so every consumer shares one active-id source of truth, and
 * the apply happens once imperatively per change (not once per mounted hook).
 */
const STORAGE_KEY = "conan-theme-id";
/** useTheme's old key — migrated once so an existing light/dark/auto choice sticks. */
const LEGACY_KEY = "conan-theme";

/** Special selection: follow the OS, mapping to the default light/dark pair. */
export const AUTO_ID = "auto";

type ConcreteType = "light" | "dark";

function systemType(): ConcreteType {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readInitialId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    // One-time migration from useTheme's old preference key. "light"/"dark" are
    // built-in theme ids and "auto" is the special pair, so they're all valid
    // activeIds as-is.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy === "light" || legacy === "dark" || legacy === AUTO_ID)
      return legacy;
  } catch {
    // localStorage may be unavailable (private mode) — fall through to default.
  }
  return DEFAULT_LIGHT_ID;
}

/**
 * Resolve an activeId (theme id or "auto") to a concrete Theme from `themes`.
 * "auto" maps to the default theme for the current OS scheme; an unknown id
 * falls back to the default light theme so a removed user theme never breaks.
 */
export function resolveTheme(id: string, themes: Theme[]): Theme {
  if (id === AUTO_ID) return defaultThemeForType(systemType());
  return (
    themes.find((t) => t.id === id) ??
    themes.find((t) => t.id === DEFAULT_LIGHT_ID) ??
    themes[0]!
  );
}

// --- Shared module-level store -------------------------------------------------
let activeId: string = readInitialId();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getActiveId(): string {
  return activeId;
}

/**
 * Apply the active selection. Resolves against the BUILT-IN palette: built-ins
 * (incl. the auto pair) cover US-021; user themes (US-022/US-023) layer on
 * later. This is the one imperative apply, so a reload, the View menu, or the
 * Appearance picker all reskin immediately.
 */
function applyActive() {
  applyTheme(resolveTheme(activeId, BUILTIN_THEMES));
}

export function setActiveIdStore(id: string) {
  if (id === activeId) return;
  activeId = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the in-memory selection still drives this session.
  }
  applyActive();
  emit();
}

// Apply once at module load so the tokens are on <html> before React mounts and
// before any terminal reads getTerminalTheme() — no flash of the default theme.
applyActive();

// Follow the OS live while "auto" is selected (mirrors useTheme's old behavior,
// now reskinning the full token set instead of only the `.dark` class).
window
  .matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener?.("change", () => {
    if (activeId === AUTO_ID) applyActive();
  });

// Window-event bridge (same convention as conan:open-settings / :toggle-timeline
// in App.tsx) so the native View ▸ Theme menu and the Appearance picker (US-023)
// can drive selection without importing the hook. detail = theme id or "auto".
window.addEventListener("conan:set-theme", (e) => {
  const id = (e as CustomEvent<string>).detail;
  if (typeof id === "string") setActiveIdStore(id);
});

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
  const activeIdValue = useSyncExternalStore(subscribe, getActiveId);

  const themes = useMemo(() => mergeThemes(userThemes), [userThemes]);

  // Resolve the active theme; fall back to the default if the stored id no
  // longer exists (e.g. a user theme was removed from themes.json).
  const activeTheme = useMemo(
    () => resolveTheme(activeIdValue, themes),
    [themes, activeIdValue],
  );

  const setActiveTheme = useCallback((id: string) => setActiveIdStore(id), []);

  return { themes, activeId: activeIdValue, activeTheme, setActiveTheme };
}
