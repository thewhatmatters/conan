import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase } from "../lib/gateway.ts";
import type { Theme } from "./useTheme.ts";

/** Claude Code's terminal /theme state, as mirrored from Conan's app theme. */
export interface TerminalThemeState {
  /** Claude's current theme value on disk (e.g. "dark", "dark-daltonized"). */
  theme: string | null;
  /** Whether ~/.claude/settings.json exists — false makes the mirror a no-op. */
  available: boolean;
}

/**
 * The "Terminal text theme" layer (US-012): mirrors Conan's resolved app theme
 * into Claude Code's `theme` setting via the gateway (config-write, not a /theme
 * keystroke inject — see src/config/index.ts). Separate from useTheme so the two
 * theme layers aren't conflated; this one only touches Claude's terminal text.
 *
 * `mirror(theme)` POSTs and folds the result back into state, so a no-op (no
 * Claude config present) is reflected honestly. Fetches the current state on
 * mount/token change so the menu's checkmark + availability start accurate.
 */
export function useTerminalTheme(token: string | null) {
  const [state, setState] = useState<TerminalThemeState>({
    theme: null,
    available: false,
  });
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(apiBase() + "/api/claude/theme", {
      headers: { "x-conan-token": token },
    })
      .then((r) => r.json())
      .then((d: { theme: string | null; available: boolean }) => {
        if (!cancelled) setState({ theme: d.theme, available: d.available });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  const mirror = useCallback((theme: Theme) => {
    const t = tokenRef.current;
    if (!t) return;
    fetch(apiBase() + "/api/claude/theme", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-conan-token": t,
      },
      body: JSON.stringify({ theme }),
    })
      .then((r) => r.json())
      .then((d: { ok: boolean; theme?: string }) => {
        // Reflect the outcome: a successful write updates the shown value; a
        // no-op (ok:false, no config) leaves availability false.
        setState((prev) =>
          d.ok
            ? { theme: d.theme ?? prev.theme, available: true }
            : { theme: prev.theme, available: false },
        );
      })
      .catch(() => {});
  }, []);

  return { ...state, mirror };
}
