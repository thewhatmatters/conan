import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** Result shape of GET /api/claude/doctor — mirrors src/doctor/claude.ts. */
export interface DoctorState {
  /** True iff `claude` resolved on PATH AND `--version` ran (or a historical
   *  SessionStart row vouches for it). `null` while the first fetch is in
   *  flight — lets the UI hide the banner during boot to avoid a flash. */
  installed: boolean | null;
  /** Semver string (e.g. "2.1.155"), or null when probe failed. */
  version: string | null;
  /** Absolute path the shell resolved for `claude`, or null. */
  path: string | null;
  /** Non-fatal note (e.g. "live probe failed; using last observed") — surfaced
   *  in the Settings diagnostic so users can debug a PATH issue. */
  error: string | null;
}

const EMPTY: DoctorState = {
  installed: null,
  version: null,
  path: null,
  error: null,
};

/**
 * Probe the gateway for whether Claude Code is installed on this machine.
 *
 * Fired once when the token arrives — the backend caches the result for 10
 * minutes so this is cheap even if multiple components reach for it. Drives
 * three UI surfaces: the first-launch install banner on the terminal pane,
 * the Settings ▸ Status diagnostic line, and the empty-state copy in the
 * HUD's Usage tab (so we don't tell a user who can't run Claude "Awaiting a
 * live Claude session").
 */
export function useDoctor(token: string | null): DoctorState {
  const [state, setState] = useState<DoctorState>(EMPTY);

  useEffect(() => {
    if (!token) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    fetch(apiBase() + "/api/claude/doctor", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setState({
          installed: typeof d.installed === "boolean" ? d.installed : null,
          version: typeof d.version === "string" ? d.version : null,
          path: typeof d.path === "string" ? d.path : null,
          error: typeof d.error === "string" ? d.error : null,
        });
      })
      .catch(() => {
        // Gateway unreachable — keep `installed: null` so the banner stays
        // hidden rather than flashing a wrong "not installed" claim.
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return state;
}
