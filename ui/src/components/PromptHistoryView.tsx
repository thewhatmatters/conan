import { useEffect, useMemo, useState } from "react";
import {
  usePromptHistory,
  type PromptHistoryEntry,
} from "../hooks/usePromptHistory.ts";
import { Badge } from "./ui/badge.tsx";

const PAGE_SIZE = 50;

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Last path segment of a cwd, for a compact project label. */
function projectLabel(project: string | null): string | null {
  if (!project) return null;
  const parts = project.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || project;
}

/**
 * Prompt-history search UI (US-034). Renders the user's Claude Code prompt
 * history (US-015 backend: ~/.claude/history.jsonl) newest-first, with a
 * debounced text search, a project filter, per-entry timestamps, and
 * server-side pagination so large histories stay snappy (the gateway paginates
 * via limit/offset and returns the matched `total`).
 *
 * Read-only. shadcn primitives + semantic tokens, so light/dark follow the
 * theme; loading + empty states throughout.
 */
export default function PromptHistoryView({
  trigger = 0,
}: {
  trigger?: number;
}) {
  const [queryInput, setQueryInput] = useState("");
  const [projectInput, setProjectInput] = useState("");
  const [page, setPage] = useState(0);

  // Debounce the free-text inputs so we don't refetch on every keystroke.
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(queryInput.trim());
      setProject(projectInput.trim());
    }, 200);
    return () => clearTimeout(id);
  }, [queryInput, projectInput]);

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [q, project]);

  const { entries, total, loaded, loading } = usePromptHistory({
    q: q || undefined,
    project: project || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    trigger,
  });

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = q.length > 0 || project.length > 0;
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold tracking-tight">Prompt History</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Every prompt you've sent Claude Code, newest-first, from{" "}
        <code className="font-mono">~/.claude/history.jsonl</code>. Search the
        text or filter by project.
      </p>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <SearchIcon />
          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            spellCheck={false}
            placeholder="Search prompts…"
            aria-label="Search prompts"
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        <div className="relative min-w-0 sm:w-64">
          <FolderIcon />
          <input
            value={projectInput}
            onChange={(e) => setProjectInput(e.target.value)}
            spellCheck={false}
            placeholder="Filter by project…"
            aria-label="Filter by project"
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
      </div>

      {!loaded ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : total === 0 ? (
        <Empty>
          {hasFilter
            ? "No prompts match your search."
            : "No prompt history yet. Claude Code records your prompts to ~/.claude/history.jsonl as you use it."}
        </Empty>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
              {total.toLocaleString()} prompt{total === 1 ? "" : "s"}
            </span>
            {loading && <span className="italic">Loading…</span>}
          </div>

          <ul className="mt-2 space-y-2">
            {entries.map((e, i) => (
              <PromptRow key={`${page}-${i}`} entry={e} highlight={q} />
            ))}
          </ul>

          {pageCount > 1 && (
            <div className="mt-5 flex items-center justify-center gap-2">
              <PageButton
                disabled={page === 0 || loading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                label="Previous page"
              >
                ‹ Prev
              </PageButton>
              <span className="px-2 text-xs text-muted-foreground">
                Page {page + 1} of {pageCount.toLocaleString()}
              </span>
              <PageButton
                disabled={page >= pageCount - 1 || loading}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                label="Next page"
              >
                Next ›
              </PageButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One prompt entry: text (with match highlight), timestamp + project badge. */
function PromptRow({
  entry,
  highlight,
}: {
  entry: PromptHistoryEntry;
  highlight: string;
}) {
  const proj = projectLabel(entry.project);
  const parts = useMemo(
    () => highlightParts(entry.display, highlight),
    [entry.display, highlight],
  );
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
        {parts.map((p, i) =>
          p.match ? (
            <mark
              key={i}
              className="rounded bg-primary/20 text-foreground"
            >
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{fmtTime(entry.timestamp)}</span>
        {proj && (
          <Badge variant="outline" className="font-normal" title={entry.project ?? undefined}>
            {proj}
          </Badge>
        )}
      </div>
    </li>
  );
}

/** Split text into match / non-match runs for highlighting (case-insensitive). */
function highlightParts(
  text: string,
  needle: string,
): { text: string; match: boolean }[] {
  const n = needle.trim();
  if (!n) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  const target = n.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(target, i);
    if (idx === -1) {
      out.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) out.push({ text: text.slice(i, idx), match: false });
    out.push({ text: text.slice(idx, idx + target.length), match: true });
    i = idx + target.length;
  }
  return out;
}

function PageButton({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
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

function FolderIcon() {
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
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}
