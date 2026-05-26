import { useCallback, useEffect, useState } from "react";

/** Auto-updater health from a one-shot `claude doctor` (mirrors the gateway). */
export interface DoctorHealth {
  ran: boolean;
  ok: boolean;
  summary: string | null;
  error: string | null;
}

export interface DoctorState {
  /** Installed Claude Code version, or null when unknown. */
  installedVersion: string | null;
  /** Newest version the local changelog knows about, or null. */
  latestVersion: string | null;
  /** True when latestVersion is newer than installedVersion. */
  updateAvailable: boolean;
  /** ~/.claude.json autoUpdates flag (null when unreadable). */
  autoUpdates: boolean | null;
  /** Native-install auto-update guard flag, or null. */
  autoUpdatesProtectedForNative: boolean | null;
  /** changelog.md mtime (epoch ms), or null. */
  changelogLastFetched: number | null;
  /** True until the first fetch settles. */
  loaded: boolean;
  /** The last `claude doctor` health run, or null until one is requested. */
  health: DoctorHealth | null;
  /** True while a token-gated doctor check is in flight. */
  checking: boolean;
  /** Run a bounded `claude doctor` health check (token-gated). */
  runCheck: () => void;
}

/**
 * Loads the version/update status (US-045) from GET /api/claude/doctor: the
 * installed Claude Code version, the newest changelog version, whether an update
 * is available, and the auto-update posture. Refetches on each WS event (via
 * `trigger`) so the indicator stays live. `runCheck()` fires the token-gated
 * `?check=1` variant that additionally runs a bounded `claude doctor` and folds
 * its health summary into state. Every failure degrades to a safe empty shape.
 */
export function useDoctor(trigger: number | null, token: string | null): DoctorState {
  const [data, setData] = useState<{
    installedVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    autoUpdates: boolean | null;
    autoUpdatesProtectedForNative: boolean | null;
    changelogLastFetched: number | null;
    loaded: boolean;
    health: DoctorHealth | null;
  }>({
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    autoUpdates: null,
    autoUpdatesProtectedForNative: null,
    changelogLastFetched: null,
    loaded: false,
    health: null,
  });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/doctor")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setData((s) => ({
          installedVersion:
            typeof d?.installedVersion === "string" ? d.installedVersion : null,
          latestVersion: typeof d?.latestVersion === "string" ? d.latestVersion : null,
          updateAvailable: d?.updateAvailable === true,
          autoUpdates: typeof d?.autoUpdates === "boolean" ? d.autoUpdates : null,
          autoUpdatesProtectedForNative:
            typeof d?.autoUpdatesProtectedForNative === "boolean"
              ? d.autoUpdatesProtectedForNative
              : null,
          changelogLastFetched:
            typeof d?.changelogLastFetched === "number" ? d.changelogLastFetched : null,
          loaded: true,
          // Keep any health summary from a prior runCheck across passive refetches.
          health: s.health,
        }));
      })
      .catch(() => {
        if (!cancelled) setData((s) => ({ ...s, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [trigger]);

  const runCheck = useCallback(() => {
    if (!token || checking) return;
    setChecking(true);
    fetch("/api/claude/doctor?check=1", {
      headers: { "x-conan-token": token },
    })
      .then((r) => r.json())
      .then((d) => {
        setData((s) => ({
          ...s,
          health:
            d?.health && typeof d.health === "object"
              ? (d.health as DoctorHealth)
              : { ran: false, ok: false, summary: null, error: "no response" },
        }));
      })
      .catch(() => {
        setData((s) => ({
          ...s,
          health: { ran: false, ok: false, summary: null, error: "request failed" },
        }));
      })
      .finally(() => setChecking(false));
  }, [token, checking]);

  return { ...data, checking, runCheck };
}
