import { useCallback, useEffect, useState } from "react";

/**
 * Conan-local appearance preferences, persisted to localStorage — a Conan pref,
 * NOT a mirror of Claude Code's `/config`, so it never touches
 * POST /api/claude/config. Mirrors the localStorage precedent in useTheme.
 *
 * Scaffolded in US-017 to give the Settings ▸ Appearance tab a home; the actual
 * controls land later: the terminal mono-font family + size picker (US-018/019)
 * and multi-theme selection (US-020+). The shape is intentionally forward-looking
 * so those stories can fill it in without a migration.
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

/**
 * Appearance state, persisted to localStorage. Returns the current `appearance`
 * plus `set` (patch one or more fields) and `reset` (back to defaults). Persists
 * on every change, like useTheme.
 */
export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(readInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      // localStorage may be unavailable (private mode); a missing persist is
      // non-fatal — the in-memory value still drives the session.
    }
  }, [appearance]);

  const set = useCallback((patch: Partial<Appearance>) => {
    setAppearance((a) => ({ ...a, ...patch }));
  }, []);

  const reset = useCallback(() => setAppearance({ ...DEFAULT_APPEARANCE }), []);

  return { appearance, set, reset };
}
