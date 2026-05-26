import {
  ArrowUpCircle,
  CheckCircle2,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
} from "lucide-react";
import type { DoctorState } from "../hooks/useDoctor.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

/**
 * Doctor + version/update banner (US-045). Surfaces the installed Claude Code
 * version, an update-available indicator (newest changelog version vs installed)
 * and the auto-update posture (~/.claude.json autoUpdates), plus an optional
 * one-shot `claude doctor` health check (token-gated, bounded) whose summary —
 * or graceful "unavailable" — renders inline. shadcn primitives, semantic
 * tokens, light+dark. Degrades to a quiet "version unknown" when nothing is
 * readable.
 */
export default function DoctorBanner({ doctor }: { doctor: DoctorState }) {
  const {
    installedVersion,
    latestVersion,
    updateAvailable,
    autoUpdates,
    loaded,
    health,
    checking,
    runCheck,
  } = doctor;

  // The headline reflects the update state; colours stay token-driven so the
  // banner reads correctly in both themes.
  const tone = updateAvailable
    ? "border-amber-500/40 bg-amber-500/5"
    : "border-border bg-card";

  return (
    <div className={"rounded-lg border p-4 " + tone}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {updateAvailable ? (
          <ArrowUpCircle className="size-5 shrink-0 text-amber-500" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              {!loaded
                ? "Checking Claude Code version…"
                : updateAvailable
                  ? "Update available"
                  : installedVersion
                    ? "Claude Code is up to date"
                    : "Claude Code version unknown"}
            </h2>
            {installedVersion && (
              <Badge variant="secondary">v{installedVersion} installed</Badge>
            )}
            {updateAvailable && latestVersion && (
              <Badge variant="default">v{latestVersion} available</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {loaded && installedVersion ? (
              <>
                Auto-updates are{" "}
                <span className="font-medium text-foreground">
                  {autoUpdates === null ? "unknown" : autoUpdates ? "on" : "off"}
                </span>
                {updateAvailable
                  ? autoUpdates
                    ? " — Claude Code will update itself."
                    : " — run "
                  : "."}
                {updateAvailable && !autoUpdates && (
                  <code className="font-mono">claude update</code>
                )}
                {updateAvailable && !autoUpdates && " to upgrade."}
              </>
            ) : loaded ? (
              <>
                No version on disk yet — Claude Code records it after it next runs
                or checks for updates.
              </>
            ) : (
              <>Reading version + auto-update status…</>
            )}
          </p>
        </div>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={runCheck}
            disabled={checking}
            title="Run a one-shot `claude doctor` auto-updater health check"
          >
            {checking ? (
              <RefreshCw className="animate-spin" />
            ) : (
              <Stethoscope />
            )}
            {checking ? "Running…" : "Run doctor"}
          </Button>
        </div>
      </div>

      {health && (
        <div className="mt-3 rounded-md border border-border bg-background/60 p-3">
          {health.ok && health.summary ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs text-foreground">
              {health.summary}
            </pre>
          ) : (
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
              <span>
                Health check unavailable
                {health.error ? <> — {health.error}</> : null}.{" "}
                <code className="font-mono">claude doctor</code> is an interactive
                command, so it may print nothing when run in the background.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
