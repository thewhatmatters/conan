import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";

/**
 * Self-update banner — surfaces newer Conan releases via the
 * tauri-plugin-updater that polls the GitHub Releases manifest URL
 * configured in `src-tauri/tauri.conf.json` (plugins.updater.endpoints).
 *
 * State machine:
 *   idle      → no update / haven't checked yet (banner hidden)
 *   available → manifest shows a newer version, user hasn't acted
 *   downloading → user clicked "Update", payload streaming + verifying
 *   ready     → download + signature check OK, awaiting `Restart`
 *   error     → check or download failed; banner shows the message + Retry
 *
 * The banner only renders when state ≠ idle, so the app shell pays nothing
 * when there's no update. Dismiss button moves to `idle` for the rest of
 * the session — the next launch re-checks.
 *
 * Implementation notes:
 *  - Lazy-imports the Tauri plugins so the browser dev build (where the
 *    plugins are absent) doesn't crash; falls back to idle silently.
 *  - One `check()` call on first mount, then a 4h interval — Conan's
 *    update cadence is human-scale; we don't need to poll more often.
 *  - `downloadAndInstall` is split into discrete download() then install()
 *    so we can surface progress; some Tauri versions expose only the
 *    combined API, which we fall back to.
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
      // Track progress so the banner shows a real percentage. The plugin's
      // download() yields {event,data} chunks; downloadAndInstall is a
      // convenience wrapper that does both. We use the split form so we
      // can surface a progress bar; if total is unknown we just show a
      // spinning Download icon.
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

  // Banner is a thin strip pinned to the top of the app shell. We position
  // it as a child of <App> so it shifts content down rather than overlaying
  // (overlaying the terminal looks broken when the title row is hidden).
  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-border bg-primary/10 px-3 text-xs text-foreground">
      <div className="flex min-w-0 items-center gap-2">
        {state.kind === "available" && (
          <>
            <Download className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">
              <span className="font-medium">Conan {state.version}</span>{" "}
              <span className="text-muted-foreground">
                is available — updates apply on restart.
              </span>
            </span>
          </>
        )}
        {state.kind === "downloading" && (
          <>
            <Download className="size-3.5 shrink-0 animate-pulse text-primary" />
            <span className="truncate text-muted-foreground">
              Downloading {state.version}
              {state.total
                ? ` — ${Math.round((state.received / state.total) * 100)}%`
                : "…"}
            </span>
          </>
        )}
        {state.kind === "ready" && (
          <>
            <RefreshCw className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">
              <span className="font-medium">Conan {state.version}</span>{" "}
              <span className="text-muted-foreground">
                downloaded — restart to apply.
              </span>
            </span>
          </>
        )}
        {state.kind === "error" && (
          <span className="truncate text-muted-foreground">
            Update check failed — {state.message}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {state.kind === "available" && (
          <button
            type="button"
            onClick={onUpdate}
            className="rounded-md bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Update
          </button>
        )}
        {state.kind === "ready" && (
          <button
            type="button"
            onClick={onRestart}
            className="rounded-md bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Restart
          </button>
        )}
        {state.kind === "error" && (
          <button
            type="button"
            onClick={checkOnce}
            className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={() => setState({ kind: "idle" })}
          aria-label="Dismiss"
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
