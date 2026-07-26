import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { apiBase } from "../lib/gateway.ts";
import { cn } from "../lib/utils.ts";
import { parseUnifiedPatch, type FileDiff } from "../lib/diff.ts";
import { DiffView, DiffStat } from "./DiffView.tsx";

/**
 * The Diff surface (Conan Surfaces US-005): "Review changes in this thread."
 * The thread's transcript already carries which files its tool calls touched
 * (Edit/Write/MultiEdit/NotebookEdit inputs — extracted client-side by
 * ChatPane); this surface hydrates those paths against the working tree via
 * POST /api/fs/diff and renders each file's patch with the transcript's own
 * DiffView row treatment. v1 is working-tree-only — committed work honestly
 * reads as a clean tree ("Uncommitted changes").
 */

type DiffApiStatus = "modified" | "added" | "deleted" | "untracked";

/** One file from POST /api/fs/diff (structural copy of the gateway's DiffFile
 *  — types aren't shared across the module boundary). */
interface DiffApiFile {
  path: string;
  status: DiffApiStatus;
  patch: string;
  truncated: boolean;
}

interface DiffApiResult {
  repo: boolean;
  root: string | null;
  files: DiffApiFile[];
}

/** A hydrated file row: the API entry + its parsed, render-ready patch. */
interface DiffRow extends DiffApiFile {
  diff: FileDiff;
}

/** Status badge styling — the on-tint `{color}-700 dark:{color}-300` pattern. */
const STATUS_BADGE: Record<DiffApiStatus, string> = {
  modified: "bg-muted text-muted-foreground",
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  untracked: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  deleted: "bg-red-500/10 text-red-700 dark:text-red-300",
};

export default function DiffSurface({
  token,
  cwd,
  touchedPaths,
}: {
  token: string | null;
  /** The thread's project cwd — the repo the diffs run in. */
  cwd: string | null;
  /** Absolute paths this thread's edit tools touched, deduped, first-touch
   *  order (from ChatPane's transcript items — history + live). */
  touchedPaths: string[];
}) {
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [repo, setRepo] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Refetch when the SET of touched paths changes (a new file edited mid-turn),
  // not on every transcript re-render — items stream constantly.
  const pathsKey = useMemo(() => touchedPaths.join("\n"), [touchedPaths]);

  const fetchDiff = useCallback(async () => {
    if (!token || !cwd || touchedPaths.length === 0) {
      setRows([]);
      setRepo(true);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const post = (paths: string[]) =>
      fetch(apiBase() + "/api/fs/diff", {
        method: "POST",
        headers: { "content-type": "application/json", "x-conan-token": token },
        body: JSON.stringify({ cwd, paths }),
      });
    try {
      let r = await post(touchedPaths);
      if (r.status === 400) {
        // A touched path outside the repo (e.g. a plan file under ~/.claude)
        // rejects the whole request — retry with the cwd-scoped subset.
        const base = cwd.replace(/\/+$/, "") + "/";
        const inside = touchedPaths.filter((p) => p.startsWith(base));
        if (inside.length === 0) {
          setRows([]);
          setRepo(true);
          return;
        }
        r = await post(inside);
      }
      if (!r.ok) {
        const data = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "could not load diffs");
        return;
      }
      const data = (await r.json()) as DiffApiResult;
      setRepo(data.repo);
      setRows(
        data.files.map((f) => ({ ...f, diff: parseUnifiedPatch(f.path, f.patch) })),
      );
    } catch {
      setError("could not load diffs");
    } finally {
      setLoading(false);
    }
    // pathsKey stands in for touchedPaths — same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, cwd, pathsKey]);

  useEffect(() => {
    void fetchDiff();
  }, [fetchDiff]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // <aside> root + literal `overflow-auto` so the list picks up the themed
  // 6px scrollbar (`aside .overflow-auto` in index.css), per convention.
  return (
    <aside className="flex h-full min-h-0 flex-col bg-card">
      {/* Sub-toolbar — h-9 fixed like every secondary bar (HudTabHeader,
          FileExplorer's breadcrumb). "Uncommitted changes" is the honest v1
          scope: working-tree-only, no thread-start baseline yet. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-[11px] text-muted-foreground">Uncommitted changes</span>
        {rows != null && rows.length > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        )}
        <button
          onClick={() => void fetchDiff()}
          title="Refresh"
          aria-label="Refresh diffs"
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1 text-xs">
        {error ? (
          <p className="px-3 py-2 text-muted-foreground">{error}</p>
        ) : rows == null ? (
          <p className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </p>
        ) : !repo ? (
          <p className="px-3 py-2 text-muted-foreground">
            This thread's directory isn't a git repository — nothing to diff.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-muted-foreground">
            {touchedPaths.length === 0
              ? "This thread hasn't changed any files yet."
              : "No uncommitted changes — this thread's edits are already committed (or reverted)."}
          </p>
        ) : (
          rows.map((f) => {
            const open = expanded.has(f.path);
            return (
              <Fragment key={f.path}>
                <button
                  onClick={() => toggle(f.path)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 shrink-0 text-muted-foreground transition-transform",
                      open && "rotate-90",
                    )}
                  />
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                      STATUS_BADGE[f.status],
                    )}
                  >
                    {f.status}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground"
                    title={f.path}
                  >
                    {f.path}
                  </span>
                  <DiffStat added={f.diff.added} removed={f.diff.removed} />
                </button>
                {open && (
                  <div className="space-y-1.5 px-3 pb-2 pl-8">
                    {f.truncated && (
                      <p className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                        Patch too large — showing the first part only.
                      </p>
                    )}
                    {f.diff.lines ? (
                      <DiffView diff={f.diff} header={false} />
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        Binary file — diff not shown.
                      </p>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })
        )}
      </div>
    </aside>
  );
}
