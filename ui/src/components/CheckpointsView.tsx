import { useEffect, useMemo, useState } from "react";
import {
  useCheckpoints,
  fetchSnapshotContent,
  type CheckpointSession,
  type CheckpointSnapshot,
  type SnapshotContent,
} from "../hooks/useCheckpoints.ts";
import { Badge } from "./ui/badge.tsx";

/** A file within a session: one hash, its revisions newest-first. */
interface FileGroup {
  hash: string;
  versions: CheckpointSnapshot[];
  latestMtime: number;
}

/** Group a session's flat snapshot list into per-file (per-hash) revisions. */
function groupByFile(session: CheckpointSession): FileGroup[] {
  const byHash = new Map<string, CheckpointSnapshot[]>();
  for (const s of session.snapshots) {
    const arr = byHash.get(s.hash) ?? [];
    arr.push(s);
    byHash.set(s.hash, arr);
  }
  const groups: FileGroup[] = [];
  for (const [hash, versions] of byHash) {
    versions.sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.mtime - a.mtime);
    groups.push({
      hash,
      versions,
      latestMtime: versions.reduce((m, v) => Math.max(m, v.mtime), 0),
    });
  }
  groups.sort((a, b) => b.latestMtime - a.latestMtime);
  return groups;
}

/** Identifies which snapshot the preview pane is showing. */
interface Selection {
  sessionId: string;
  hash: string;
  version: number | null;
}

function sameSel(a: Selection | null, s: CheckpointSnapshot): boolean {
  return (
    !!a &&
    a.sessionId === s.sessionId &&
    a.hash === s.hash &&
    a.version === s.version
  );
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Checkpoints / rewind viewer (US-031). Browses Claude Code's per-session
 * file-history snapshots from GET /api/claude/checkpoints (US-008): every
 * session that has snapshots, its files (grouped by content hash) and each
 * file's @vN revisions with mtimes. Selecting a revision previews its full
 * snapshot content (read-only) from the per-snapshot content endpoint.
 *
 * This is deliberately READ-ONLY — there is no restore/rewind action in this
 * story; the banner says so. Loading + empty states throughout; shadcn
 * primitives + semantic tokens, so light/dark follow the theme.
 */
export default function CheckpointsView({ trigger = 0 }: { trigger?: number }) {
  const { sessions, loaded } = useCheckpoints(trigger);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<Selection | null>(null);
  const [content, setContent] = useState<SnapshotContent | null>(null);
  const [previewState, setPreviewState] = useState<
    "idle" | "loading" | "error"
  >("idle");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.sessionId.toLowerCase().includes(q) ||
        s.snapshots.some((snap) => snap.hash.toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  // Load the selected snapshot's content (read-only). Re-runs on selection.
  useEffect(() => {
    if (!sel) {
      setContent(null);
      setPreviewState("idle");
      return;
    }
    let cancelled = false;
    setPreviewState("loading");
    setContent(null);
    fetchSnapshotContent(sel.sessionId, sel.hash, sel.version).then((c) => {
      if (cancelled) return;
      if (c) {
        setContent(c);
        setPreviewState("idle");
      } else {
        setPreviewState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sel]);

  const totalSnapshots = useMemo(
    () => sessions.reduce((n, s) => n + s.snapshots.length, 0),
    [sessions],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold tracking-tight">Checkpoints</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Per-session file snapshots Claude Code keeps under{" "}
        <code className="font-mono">~/.claude/file-history</code>. Pick a file
        revision to preview the saved content.
      </p>

      {/* Read-only banner — this story previews snapshots; it never restores. */}
      <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
        <LockIcon />
        <span>
          <span className="font-medium text-foreground">Read-only.</span>{" "}
          Snapshots are shown for inspection — there is no restore or rewind
          here.
        </span>
      </div>

      {!loaded ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : sessions.length === 0 ? (
        <Empty>
          No checkpoints yet. Claude Code writes file snapshots to{" "}
          <code className="font-mono">~/.claude/file-history</code> as it edits
          files during a session.
        </Empty>
      ) : (
        <>
          <div className="mt-5 flex items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <SearchIcon />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                placeholder="Filter by session or file hash…"
                className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
              />
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {sessions.length} session{sessions.length === 1 ? "" : "s"} ·{" "}
              {totalSnapshots} snapshot{totalSnapshots === 1 ? "" : "s"}
            </span>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
            {/* Master list: sessions → files → versions */}
            <div className="min-w-0 space-y-2">
              {filtered.length === 0 ? (
                <Empty>No checkpoints match your filter.</Empty>
              ) : (
                filtered.map((s) => (
                  <SessionRow
                    key={s.sessionId}
                    session={s}
                    sel={sel}
                    onSelect={setSel}
                  />
                ))
              )}
            </div>

            {/* Preview pane */}
            <PreviewPane
              sel={sel}
              content={content}
              state={previewState}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** One expandable session, listing its files and their revisions. */
function SessionRow({
  session,
  sel,
  onSelect,
}: {
  session: CheckpointSession;
  sel: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const [open, setOpen] = useState(false);
  const files = useMemo(() => groupByFile(session), [session]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-3 text-left"
        aria-expanded={open}
      >
        <Chevron open={open} />
        <div className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs text-foreground">
            {session.sessionId}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
            {session.snapshots.length} snapshot
            {session.snapshots.length === 1 ? "" : "s"} ·{" "}
            {fmtTime(session.latestMtime)}
          </span>
        </div>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-3">
          {files.map((f) => (
            <div key={f.hash} className="min-w-0">
              <div className="flex items-center gap-2">
                <FileIcon />
                <span
                  className="truncate font-mono text-xs text-foreground"
                  title={f.hash}
                >
                  {f.hash}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
                {f.versions.map((v) => {
                  const active = sameSel(sel, v);
                  return (
                    <button
                      key={`${v.hash}@v${v.version}`}
                      onClick={() =>
                        onSelect({
                          sessionId: v.sessionId,
                          hash: v.hash,
                          version: v.version,
                        })
                      }
                      title={fmtTime(v.mtime)}
                      className={
                        "rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors " +
                        (active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-muted-foreground hover:border-primary hover:text-foreground")
                      }
                    >
                      {v.version != null ? `@v${v.version}` : "@v?"}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Read-only content preview for the selected snapshot. */
function PreviewPane({
  sel,
  content,
  state,
}: {
  sel: Selection | null;
  content: SnapshotContent | null;
  state: "idle" | "loading" | "error";
}) {
  return (
    <div className="flex min-h-[20rem] min-w-0 flex-col rounded-lg border border-border bg-card">
      {!sel ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          Select a file revision to preview its snapshot.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="min-w-0">
              <span
                className="block truncate font-mono text-xs text-foreground"
                title={sel.hash}
              >
                {sel.hash}
                {sel.version != null ? ` @v${sel.version}` : ""}
              </span>
              {content && (
                <span className="text-[11px] text-muted-foreground">
                  {fmtTime(content.mtime)}
                </span>
              )}
            </div>
            <Badge variant="outline">read-only</Badge>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {state === "loading" ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : state === "error" ? (
              <p className="p-4 text-sm text-muted-foreground">
                Snapshot not found or unreadable.
              </p>
            ) : content && content.content.length === 0 ? (
              <p className="p-4 text-sm italic text-muted-foreground">
                (empty file)
              </p>
            ) : content ? (
              <pre className="overflow-auto p-4 text-xs leading-relaxed text-foreground">
                <code>{content.content}</code>
              </pre>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={
        "shrink-0 text-muted-foreground transition-transform " +
        (open ? "rotate-90" : "")
      }
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-muted-foreground"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-muted-foreground"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
