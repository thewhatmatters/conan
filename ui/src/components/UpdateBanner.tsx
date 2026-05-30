import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, X, AlertTriangle } from "lucide-react";

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

/** Lazy plugin loaders — `window.__TAURI__` is the cheapest probe for "am I
 *  inside the Tauri webview?" without importing anything heavy. Returns
 *  null in the browser dev build so the rest of the component degrades to
 *  a permanent idle state. */
async function loadUpdater(): Promise<typeof import("@tauri-apps/plugin-updater") | null> {
  if (typeof window === "undefined") return null;
  if (!(window as unknown as { __TAURI__?: unknown }).__TAURI__) return null;
  try {
    return await import("@tauri-apps/plugin-updater");
  } catch {
    return null;
  }
}
async function loadProcess(): Promise<typeof import("@tauri-apps/plugin-process") | null> {
  if (typeof window === "undefined") return null;
  if (!(window as unknown as { __TAURI__?: unknown }).__TAURI__) return null;
  try {
    return await import("@tauri-apps/plugin-process");
  } catch {
    return null;
  }
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
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  // Boot + interval check. Cleared on unmount so HMR doesn't leak timers.
  useEffect(() => {
    void checkOnce();
    const t = window.setInterval(() => void checkOnce(), POLL_MS);
    return () => window.clearInterval(t);
  }, [checkOnce]);

  const onUpdate = useCallback(async () => {
    if (state.kind !== "available") return;
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
    const proc = await loadProcess();
    if (!proc) return;
    await proc.relaunch();
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
        {/* Header row: icon + label + dismiss */}
        <div className="flex items-start gap-2">
          <div className="mt-0.5 shrink-0">
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
          <button
            type="button"
            onClick={() => setState({ kind: "idle" })}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
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

        {/* Action row — only when there's something for the user to do. */}
        {(state.kind === "available" ||
          state.kind === "ready" ||
          state.kind === "error") && (
          <div className="flex items-center justify-end gap-1.5">
            {state.kind === "available" && (
              <button
                type="button"
                onClick={onUpdate}
                className="rounded-md bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Update
              </button>
            )}
            {state.kind === "ready" && (
              <button
                type="button"
                onClick={onRestart}
                className="rounded-md bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Restart
              </button>
            )}
            {state.kind === "error" && (
              <button
                type="button"
                onClick={checkOnce}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
