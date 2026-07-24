import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, AlertTriangle } from "lucide-react";
import { isTauri } from "../lib/gateway.ts";

/**
 * Self-update toast — surfaces newer Conan releases via tauri-plugin-updater
 * polling the GitHub Releases manifest URL configured in
 * `src-tauri/tauri.conf.json` (plugins.updater.endpoints). Renders as a
 * floating card in the bottom-left of the window so it never displaces the
 * terminal / HUD layout; positions itself with `fixed` so it sits over
 * whatever the user's currently looking at.
 *
 * State machine:
 *   idle      → no update / haven't checked yet (toast hidden)
 *   available → manifest shows a newer version, user hasn't acted
 *   downloading → user clicked "Update", payload streaming + verifying
 *   ready     → download + signature check OK, awaiting `Restart`
 *   error     → check or download failed; toast shows the message + Retry
 *
 * Implementation notes:
 *  - Lazy-imports the Tauri plugins so the browser dev build (where the
 *    plugins are absent) doesn't crash; falls back to idle silently.
 *  - One `check()` call on first mount, then a 4h interval.
 *  - Dismiss (the X) moves to `idle` for the rest of the session — the
 *    next launch re-checks.
 */

type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string; notes?: string | null }
  | {
      kind: "downloading";
      version: string;
      received: number;
      total: number | null;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

const POLL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** "Am I inside the Tauri webview?" — Tauri v2 sets `__TAURI_INTERNALS__`
 *  (renamed from v1's `__TAURI__`). Delegate to the shared probe in
 *  gateway.ts so this stays in sync if the global is ever renamed again.
 *
 *  Returns true in BOTH the bundled `.app` AND `npm run tauri:dev`. Returns
 *  false only when the UI is loaded in a plain browser (vite dev w/o the
 *  Tauri shell), which is the surface the demo path below targets. */
function isInTauri(): boolean {
  return isTauri();
}

/** Lazy plugin loaders — only imported when actually inside Tauri so the
 *  browser dev build doesn't try to resolve native bindings. */
async function loadUpdater(): Promise<typeof import("@tauri-apps/plugin-updater") | null> {
  if (!isInTauri()) return null;
  try {
    return await import("@tauri-apps/plugin-updater");
  } catch {
    return null;
  }
}
async function loadProcess(): Promise<typeof import("@tauri-apps/plugin-process") | null> {
  if (!isInTauri()) return null;
  try {
    return await import("@tauri-apps/plugin-process");
  } catch {
    return null;
  }
}

/** Dev-only fake — surfaces the toast in `vite dev` (no Tauri) so the
 *  component is visually testable. In a real build (Tauri), `isInTauri()`
 *  short-circuits this whole branch and the real updater plugin drives the
 *  state machine. Triggered by:
 *    - Auto on mount in dev (immediate "available")
 *    - `window.__conanUpdateDemo('<kind>')` from DevTools to flip state
 *    - Clicking Update / Restart / Retry runs simulated transitions */
const DEMO_VERSION = "1.0.1";
const DEMO_TOTAL_BYTES = 64 * 1024 * 1024; // 64MB simulated download size

/** True when the updater error means "no release to update to" (a 404 on the
 *  releases endpoint, or no valid release JSON) rather than a real failure.
 *  Treated as "up to date" → silent. Tauri's updater throws
 *  "Could not fetch a valid release JSON from the remote" for the 404 case;
 *  offline/DNS/5xx throw distinct network messages that fall through to the
 *  error toast. */
function isNoReleaseAvailable(message: string): boolean {
  return /valid release json|releases?\/latest|not found|\b404\b|no (?:published )?release/i.test(
    message,
  );
}

export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });

  /** Single check() pass — used on boot AND on the 4h interval AND on the
   *  user's manual Retry click. Idempotent: a fresh `available` overrides
   *  whatever was on screen. */
  const checkOnce = useCallback(async () => {
    const updater = await loadUpdater();
    if (!updater) return;
    try {
      const update = await updater.check();
      if (!update) {
        setState({ kind: "idle" });
        return;
      }
      setState({
        kind: "available",
        version: update.version,
        notes: update.body ?? null,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A 404 / "no valid release JSON" from the endpoint means there's simply
      // no published release to update to (pre-launch, or the GitHub Release
      // isn't cut yet) — that's "you're up to date," not a failure. Stay silent
      // rather than nag with an error toast on every launch. Genuine network
      // failures (offline, DNS, 5xx) still surface so the user knows the check
      // couldn't run.
      if (isNoReleaseAvailable(message)) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "error", message });
    }
  }, []);

  // Boot + interval check. Cleared on unmount so HMR doesn't leak timers.
  //
  // Dev branch: if we're not inside Tauri AND we're in Vite dev mode, auto-
  // surface the "available" state immediately so the toast is visually
  // testable without a build. Also expose `window.__conanUpdateDemo('<kind>')`
  // for cycling through the other states from DevTools. Both branches are
  // dead-code-eliminated by Vite in the production build because
  // `import.meta.env.DEV` is statically false there.
  useEffect(() => {
    // Dev mode (both vite-only AND tauri:dev): auto-surface the demo banner
    // so the toast is visible without waiting for a real update. The real
    // updater is skipped in dev because the GitHub endpoint would 404 on a
    // private repo + we want predictable visuals during iteration. In dev's
    // tauri:dev path, Restart still calls the REAL relaunch() — onRestart
    // probes loadProcess() at click time, so the demo banner can drive a
    // real restart of the dev shell.
    if (import.meta.env.DEV) {
      // Don't auto-surface the demo banner during development — it overlaps the
      // composer and gets in the way of iteration. Stays idle by default; call
      // `window.__conanUpdateDemo('available')` from DevTools to show it on
      // demand for visual testing. Production polling is unchanged below.
      (
        window as unknown as { __conanUpdateDemo?: (k: string) => void }
      ).__conanUpdateDemo = (kind: string) => {
        const map: Record<string, UpdateState> = {
          idle: { kind: "idle" },
          available: {
            kind: "available",
            version: DEMO_VERSION,
            notes: null,
          },
          downloading: {
            kind: "downloading",
            version: DEMO_VERSION,
            received: Math.round(DEMO_TOTAL_BYTES * 0.32),
            total: DEMO_TOTAL_BYTES,
          },
          ready: { kind: "ready", version: DEMO_VERSION },
          error: {
            kind: "error",
            message:
              "Failed to fetch update manifest: network unreachable (demo)",
          },
        };
        const next = map[kind];
        if (next) setState(next);
        else
          console.log(
            "usage: __conanUpdateDemo('available'|'downloading'|'ready'|'error'|'idle')",
          );
      };
      return; // skip real polling
    }
    void checkOnce();
    const t = window.setInterval(() => void checkOnce(), POLL_MS);
    return () => window.clearInterval(t);
  }, [checkOnce]);

  const onUpdate = useCallback(async () => {
    if (state.kind !== "available") return;
    // Dev branch — simulate a download: tick `received` upward every 80ms
    // until we reach DEMO_TOTAL_BYTES, then flip to ready. Fires in BOTH
    // vite-only AND tauri:dev because we want predictable demo timing for
    // visual iteration, not whatever a real download would do.
    if (import.meta.env.DEV) {
      let received = 0;
      const total = DEMO_TOTAL_BYTES;
      const tick = window.setInterval(() => {
        received = Math.min(total, received + Math.round(total / 25));
        if (received >= total) {
          window.clearInterval(tick);
          setState({ kind: "ready", version: DEMO_VERSION });
          return;
        }
        setState({
          kind: "downloading",
          version: DEMO_VERSION,
          received,
          total,
        });
      }, 80);
      return;
    }
    const updater = await loadUpdater();
    if (!updater) return;
    try {
      const update = await updater.check();
      if (!update) {
        setState({ kind: "idle" });
        return;
      }
      // Track progress so the toast shows a real percentage. The plugin's
      // download() yields {event,data} chunks; downloadAndInstall is a
      // convenience wrapper that does both.
      let received = 0;
      let total: number | null = null;
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          total =
            typeof evt.data.contentLength === "number"
              ? evt.data.contentLength
              : null;
          setState({
            kind: "downloading",
            version: update.version,
            received: 0,
            total,
          });
        } else if (evt.event === "Progress") {
          received += evt.data.chunkLength;
          setState({
            kind: "downloading",
            version: update.version,
            received,
            total,
          });
        } else if (evt.event === "Finished") {
          setState({ kind: "ready", version: update.version });
        }
      });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [state]);

  const onRestart = useCallback(async () => {
    // Always try the real plugin first — in tauri:dev OR the bundled .app
    // it's available and ACTUALLY relaunches. Falling back to a no-op only
    // when there's no Tauri shell (pure browser vite) so the demo path on a
    // designer's laptop still has a sane "click does something" behavior.
    const proc = await loadProcess();
    if (proc) {
      await proc.relaunch();
      return;
    }
    console.log("[update] Restart: no Tauri shell — dismissing toast");
    setState({ kind: "idle" });
  }, []);

  if (state.kind === "idle") return null;

  // Compute progress percent once so the JSX stays clean.
  const progressPct =
    state.kind === "downloading" && state.total && state.total > 0
      ? Math.min(100, Math.round((state.received / state.total) * 100))
      : null;

  return (
    // Bottom-left floating card. z-50 keeps it above the HUD + terminal but
    // below anything modal (Settings dialog is Radix-managed and uses its
    // own portal at z ≥ 100). pointer-events-none on the wrapper lets clicks
    // pass through any sliver around the card; pointer-events-auto on the
    // card itself keeps its controls hot.
    <div className="pointer-events-none fixed bottom-4 left-4 z-50">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex w-72 flex-col gap-2 rounded-xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur-md"
      >
        {/* Single row: icon + (title + sub) + action button. items-center
            centers the button vertically on the two-line text block; the
            button sits inline with the bold title visually because the
            title's the dominant line in the stack. */}
        <div className="flex items-center gap-2">
          <div className="shrink-0">
            {state.kind === "available" && (
              <Download className="size-4 text-primary" />
            )}
            {state.kind === "downloading" && (
              <Download className="size-4 animate-pulse text-primary" />
            )}
            {state.kind === "ready" && (
              <RefreshCw className="size-4 text-primary" />
            )}
            {state.kind === "error" && (
              <AlertTriangle className="size-4 text-destructive" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {state.kind === "available" && (
              <>
                <div className="text-[12px] font-semibold leading-tight text-foreground">
                  Conan {state.version} is available
                </div>
                <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                  Update applies on restart.
                </div>
              </>
            )}
            {state.kind === "downloading" && (
              <>
                <div className="text-[12px] font-semibold leading-tight text-foreground">
                  Downloading {state.version}
                </div>
                <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                  {progressPct !== null
                    ? `${progressPct}% — please wait`
                    : "Please wait…"}
                </div>
              </>
            )}
            {state.kind === "ready" && (
              <>
                <div className="text-[12px] font-semibold leading-tight text-foreground">
                  Conan {state.version} ready
                </div>
                <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                  Restart to apply.
                </div>
              </>
            )}
            {state.kind === "error" && (
              <>
                <div className="text-[12px] font-semibold leading-tight text-foreground">
                  Update check failed
                </div>
                <div
                  title={state.message}
                  className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-muted-foreground"
                >
                  {state.message}
                </div>
              </>
            )}
          </div>
          {state.kind === "available" && (
            <button
              type="button"
              onClick={onUpdate}
              className="shrink-0 rounded-md bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Update
            </button>
          )}
          {state.kind === "ready" && (
            <button
              type="button"
              onClick={onRestart}
              className="shrink-0 rounded-md bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Restart
              </button>
          )}
          {state.kind === "error" && (
            <div className="flex shrink-0 flex-col gap-1">
              <button
                type="button"
                onClick={checkOnce}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => setState({ kind: "idle" })}
                className="rounded-md px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>

        {/* Progress bar — only while downloading + only when content-length
            is known. When the server doesn't report Content-Length we just
            keep the pulsing download icon as the loading affordance. */}
        {state.kind === "downloading" && progressPct !== null && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width] duration-150 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
