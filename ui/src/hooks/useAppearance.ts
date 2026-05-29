import { useCallback, useSyncExternalStore } from "react";

/**
 * Conan-local appearance preferences, persisted to localStorage — a Conan pref,
 * NOT a mirror of Claude Code's `/config`, so it never touches
 * POST /api/claude/config. Mirrors the localStorage precedent in useTheme.
 *
 * Scaffolded in US-017 to give the Settings ▸ Appearance tab a home; the
 * controls landed since: the terminal mono-font family + size picker (US-018)
 * and the live-apply path to every terminal (US-019). Multi-theme selection
 * (US-020+) layers on later. The shape is intentionally forward-looking so
 * those stories can fill it in without a migration.
 *
 * Backed by a module-level store + useSyncExternalStore (US-019): every
 * `useAppearance()` consumer shares one source of truth, so changing the font
 * in Settings notifies ALL mounted terminals at once — not just newly opened
 * tabs.
 */
export interface Appearance {
  /** Terminal mono-font family; `null` means "use the built-in default stack". */
  terminalFontFamily: string | null;
  /** Terminal font size in px. */
  terminalFontSize: number;
}

/** The defaults applied when nothing is stored (or a stored value is invalid). */
export const DEFAULT_APPEARANCE: Appearance = {
  terminalFontFamily: null,
  terminalFontSize: 13,
};

const STORAGE_KEY = "conan-appearance";

function readInitial(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      terminalFontFamily:
        typeof parsed.terminalFontFamily === "string"
          ? parsed.terminalFontFamily
          : DEFAULT_APPEARANCE.terminalFontFamily,
      terminalFontSize:
        typeof parsed.terminalFontSize === "number" &&
        Number.isFinite(parsed.terminalFontSize)
          ? parsed.terminalFontSize
          : DEFAULT_APPEARANCE.terminalFontSize,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

// --- Shared module-level store -------------------------------------------------
// One snapshot object shared by every consumer; mutating it through set()/reset()
// swaps the reference and notifies all subscribers, so each useAppearance() hook
// (Settings picker, every Terminal) re-renders with the new value in lockstep.
let current: Appearance = readInitial();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // localStorage may be unavailable (private mode); a missing persist is
    // non-fatal — the in-memory value still drives the session.
  }
}

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): Appearance {
  return current;
}

function setAppearanceStore(patch: Partial<Appearance>) {
  current = { ...current, ...patch };
  persist();
  emit();
}

function resetAppearanceStore() {
  current = { ...DEFAULT_APPEARANCE };
  persist();
  emit();
}

/**
 * Appearance state, persisted to localStorage. Returns the current `appearance`
 * plus `set` (patch one or more fields) and `reset` (back to defaults). Every
 * consumer shares one store, so a change anywhere updates everywhere live.
 */
export function useAppearance() {
  const appearance = useSyncExternalStore(subscribe, getSnapshot);

  const set = useCallback((patch: Partial<Appearance>) => {
    setAppearanceStore(patch);
  }, []);

  const reset = useCallback(() => resetAppearanceStore(), []);

  return { appearance, set, reset };
}
