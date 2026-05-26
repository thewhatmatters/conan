import { useEffect, useRef, useState } from "react";
import type { UltrareviewState } from "../hooks/useUltrareview.ts";
import { Badge } from "./ui/badge.tsx";

/**
 * Code Review page (US-046). A token-gated, explicit (and billed) action that
 * runs `claude ultrareview` for the active repo — the current branch, or a
 * GitHub PR # — and renders the findings as they stream over /ws. Handles the
 * long-running case (a Running badge + a live, auto-scrolling output panel + a
 * Stop control) and surfaces errors (failed launch, non-zero exit, timeout).
 * Semantic tokens only, light + dark.
 */
export default function UltrareviewView({
  ultrareview,
  cwd,
  hasToken,
}: {
  ultrareview: UltrareviewState;
  cwd: string | null;
  hasToken: boolean;
}) {
  const { run, loaded, starting, actionError, start, stop } = ultrareview;
  const [pr, setPr] = useState("");
  const running = run?.status === "running";

  // Auto-scroll the output panel to the tail as new lines stream in.
  const outRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.output]);

  const targetLabel = run
    ? run.target.kind === "pr"
      ? `PR #${run.target.ref}`
      : "current branch"
    : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Code Review</h1>
        {run && <StatusBadge status={run.status} />}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Launch a multi-agent cloud review with{" "}
        <code className="font-mono">claude ultrareview</code> for the active repo
        {cwd && (
          <>
            {" "}(<span className="font-mono">{cwd}</span>)
          </>
        )}
        . This is an explicit, billed action you trigger.
      </p>

      {/* Launch controls */}
      <div className="mt-5 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            GitHub PR # <span className="opacity-70">(blank = current branch)</span>
            <input
              type="text"
              inputMode="numeric"
              value={pr}
              disabled={running || !hasToken}
              onChange={(e) => setPr(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="e.g. 42"
              className="w-36 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm text-foreground disabled:opacity-50"
            />
          </label>
          {running ? (
            <button
              onClick={stop}
              disabled={!hasToken}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              Stop review
            </button>
          ) : (
            <button
              onClick={() => start(pr || undefined)}
              disabled={starting || !hasToken}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {starting ? "Starting…" : "Run review"}
            </button>
          )}
        </div>
        {!hasToken && (
          <p className="mt-2 text-xs text-muted-foreground">
            Connecting to the gateway… the action enables once the token loads.
          </p>
        )}
        {actionError && (
          <p className="mt-2 text-xs text-red-500">{actionError}</p>
        )}
      </div>

      {/* Findings panel */}
      <div className="mt-5">
        {!loaded ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !run ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No review yet. Run one to see findings here.
          </p>
        ) : (
          <div className="rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{targetLabel}</span>
              {run.findingsCount !== null && (
                <Badge variant="secondary">{run.findingsCount} findings</Badge>
              )}
              <span>started {new Date(run.startedAt).toLocaleTimeString()}</span>
              {run.endedAt && (
                <span>· {((run.endedAt - run.startedAt) / 1000).toFixed(0)}s</span>
              )}
              {run.error && (
                <span className="text-red-500">· {run.error}</span>
              )}
            </div>
            <pre
              ref={outRef}
              className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground"
            >
              {run.output || (running ? "Waiting for output…" : "(no output)")}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "idle" | "running" | "done" | "error" }) {
  if (status === "running")
    return (
      <Badge variant="secondary">
        <span className="mr-1 inline-block size-2 animate-pulse rounded-full bg-amber-500" />
        Running
      </Badge>
    );
  if (status === "done") return <Badge variant="secondary">Done</Badge>;
  if (status === "error")
    return (
      <Badge variant="secondary" className="text-red-500">
        Error
      </Badge>
    );
  return null;
}
