import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";
import type { Theme } from "../lib/themes.ts";

/**
 * Loads the user-defined themes from the token-gated GET /api/claude/themes
 * (US-022 — reads + validates ~/.conan/themes.json, CONAN_DATA_DIR-aware). The
 * gateway returns only strictly-validated palettes (known token keys + clean
 * color literals), so each entry is safe to merge over the built-ins and apply.
 *
 * User themes are static for a session (live fs.watch reload is out of scope),
 * so this fetches once when the token first arrives. The returned array is
 * reference-stable until the next fetch — useThemes(userThemes) registers it
 * into the apply store, so a stable reference avoids re-registration churn.
 * Resets to empty (built-ins only) when there's no token or the read fails.
 */
export function useUserThemes(token: string | null): Theme[] {
  const [themes, setThemes] = useState<Theme[]>([]);

  useEffect(() => {
    if (!token) {
      setThemes([]);
      return;
    }
    let cancelled = false;
    fetch(apiBase() + "/api/claude/themes", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // The route returns UserTheme[] (id/name/type/tokens), which matches the
        // UI Theme shape (tokens is a partial map — US-021 merges over defaults).
        if (!cancelled && Array.isArray(d)) setThemes(d as Theme[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  return themes;
}
