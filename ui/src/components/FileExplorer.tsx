import { Fragment, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  File as FileIcon,
  Folder,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { apiBase } from "../lib/gateway.ts";
import type { GatewayEvent } from "../hooks/useTasks.ts";

/** One filesystem entry (mirrors the gateway's FileEntry — types aren't shared
 *  across the gateway/UI module boundary, so this is a structural copy). */
interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

interface FileListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  error?: string;
}

/** Files Claude touched this session, split by the stronger signal (edited). */
interface Touched {
  edited: Set<string>;
  read: Set<string>;
}

const EMPTY_TOUCHED: Touched = { edited: new Set(), read: new Set() };

interface FileExplorerProps {
  token: string;
  /** The session correlated to this tab's pty — scopes the "Claude touched"
   *  overlay. Omit/null when there's no correlated session (the Files
   *  surface): the overlay is simply empty. */
  sessionId?: string | null;
  /** The root directory to browse (per-tab cwd, or the thread's project cwd
   *  for the Files surface). Null shows an empty state. */
  cwd: string | null;
  /** The latest app-WS event; its `seq` nudges the touched-files refresh so the
   *  badges keep up as Claude edits/reads without a manual refresh. */
  lastEvent?: (GatewayEvent & { seq: number }) | null;
}

/** /api/fs/read payload — the gateway caps the read at 64 KB, so
 *  readBytes < totalBytes means the preview is truncated. */
interface FileContent {
  path: string;
  content: string;
  totalBytes: number;
  readBytes: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Heuristic binary sniff on the UTF-8-decoded preview: NUL bytes or a
 *  meaningful share of replacement characters mean this wasn't text. */
function looksBinary(content: string): boolean {
  if (content.includes("\u0000")) return true;
  const replacements = content.match(/�/g)?.length ?? 0;
  return replacements > 0 && replacements / Math.max(content.length, 1) > 0.01;
}

/** A GET against the gateway carrying the auth token header. */
function authedGet(path: string, token: string): Promise<Response> {
  return fetch(apiBase() + path, { headers: { "x-conan-token": token } });
}

/** Shorten an absolute path for the breadcrumb (~ for $HOME-rooted paths). */
function prettyPath(p: string): string {
  const home = "/Users/";
  // Best-effort: collapse "/Users/<name>" to "~" without knowing $HOME exactly.
  const m = p.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (p.startsWith(home) && m) return "~" + (m[1] ?? "");
  return p;
}

/**
 * The File Explorer: a read-only, lazy-expanding tree of a working directory,
 * with files Claude touched this session badged (ember = edited/written,
 * muted = read) when a session is correlated. Folders expand inline on click;
 * files open a read-only content view (bounded /api/fs/read, honest
 * truncated/binary notices); each row reveals in Finder or copies its path.
 * Mounted by the Files surface (Conan Surfaces US-003, rooted at the thread's
 * project cwd) and by the dormant terminal-era TerminalPane split panel.
 */
export default function FileExplorer({
  token,
  sessionId,
  cwd,
  lastEvent,
}: FileExplorerProps) {
  const [root, setRoot] = useState<FileListing | null>(null);
  // path → its listing; caches expanded subdirectories so a collapse/re-expand
  // doesn't refetch. Cleared whenever the root cwd changes.
  const [cache, setCache] = useState<Record<string, FileListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState<Touched>(EMPTY_TOUCHED);
  const [error, setError] = useState<string | null>(null);
  // Read-only file view (Conan Surfaces US-003): clicking a file swaps the
  // tree for its content, fetched via the same bounded /api/fs/read the pin
  // picker uses. Back returns to the tree with expansion state intact.
  const [openFile, setOpenFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!openFile) {
      setFileContent(null);
      setFileError(null);
      return;
    }
    let cancelled = false;
    setFileContent(null);
    setFileError(null);
    authedGet(`/api/fs/read?path=${encodeURIComponent(openFile.path)}`, token)
      .then(async (r) => {
        const data = (await r.json()) as FileContent & { error?: string };
        if (cancelled) return;
        if (!r.ok || data.error) setFileError(data.error ?? "could not read file");
        else setFileContent(data);
      })
      .catch(() => {
        if (!cancelled) setFileError("could not read file");
      });
    return () => {
      cancelled = true;
    };
  }, [openFile, token]);

  const loadDir = useCallback(
    (path: string) => {
      authedGet(`/api/fs/list?path=${encodeURIComponent(path)}`, token)
        .then((r) => r.json())
        .then((data: FileListing) =>
          setCache((prev) => ({ ...prev, [data.path]: data })),
        )
        .catch(() => {});
    },
    [token],
  );

  // (Re)load the root listing whenever the tab's cwd changes; reset expansion +
  // cache so a `cd` starts fresh rather than showing the old tree's children.
  useEffect(() => {
    if (!cwd) {
      setRoot(null);
      return;
    }
    let cancelled = false;
    setExpanded(new Set());
    setCache({});
    setError(null);
    setOpenFile(null);
    authedGet(`/api/fs/list?path=${encodeURIComponent(cwd)}`, token)
      .then((r) => r.json())
      .then((data: FileListing) => {
        if (cancelled) return;
        setRoot(data);
        setCache({ [data.path]: data });
        if (data.error) setError(data.error);
      })
      .catch(() => {
        if (!cancelled) setError("could not read directory");
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, token]);

  // The set of files Claude touched this session, refreshed as it works (the
  // lastEvent.seq dependency re-pulls after each hook event lands).
  useEffect(() => {
    if (!sessionId) {
      setTouched(EMPTY_TOUCHED);
      return;
    }
    let cancelled = false;
    authedGet(`/api/fs/touched?session=${encodeURIComponent(sessionId)}`, token)
      .then((r) => r.json())
      .then((d: { edited?: string[]; read?: string[] }) => {
        if (cancelled) return;
        setTouched({
          edited: new Set(d.edited ?? []),
          read: new Set(d.read ?? []),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, token, lastEvent?.seq]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!cache[path]) loadDir(path);
      }
      return next;
    });
  };

  const reveal = (path: string) => {
    fetch(apiBase() + "/api/fs/reveal", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": token },
      body: JSON.stringify({ path }),
    }).catch(() => {});
  };

  const copyPath = (path: string) => {
    navigator.clipboard?.writeText(path).catch(() => {});
  };

  const refresh = () => {
    if (!cwd) return;
    setCache({});
    setExpanded(new Set());
    authedGet(`/api/fs/list?path=${encodeURIComponent(cwd)}`, token)
      .then((r) => r.json())
      .then((data: FileListing) => {
        setRoot(data);
        setCache({ [data.path]: data });
      })
      .catch(() => {});
  };

  const renderEntries = (listing: FileListing | undefined, depth: number): ReactNode => {
    if (!listing) return null;
    return listing.entries.map((e) => (
      <Fragment key={e.path}>
        <Row
          entry={e}
          depth={depth}
          expanded={expanded.has(e.path)}
          touched={
            touched.edited.has(e.path)
              ? "edited"
              : touched.read.has(e.path)
                ? "read"
                : null
          }
          onToggle={() => toggleDir(e.path)}
          onOpen={() => setOpenFile(e)}
          onReveal={() => reveal(e.path)}
          onCopy={() => copyPath(e.path)}
        />
        {e.isDir && expanded.has(e.path) && renderEntries(cache[e.path], depth + 1)}
      </Fragment>
    ));
  };

  // The preview is truncated when the gateway's 64 KB cap cut the read short.
  const truncated =
    fileContent != null && fileContent.readBytes < fileContent.totalBytes;
  const binary = fileContent != null && looksBinary(fileContent.content);

  // <aside> root so every scroll region below picks up the themed 6px
  // scrollbar (`aside .overflow-auto` in index.css) instead of the OS default
  // — the drift the CLAUDE.md conventions TODO called out.
  return (
    <aside className="flex h-full min-h-0 flex-col bg-card">
      {openFile ? (
        /* File view (read-only): back + name + size header, then content. */
        <>
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <button
              onClick={() => setOpenFile(null)}
              title="Back to files"
              aria-label="Back to files"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
            </button>
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
              title={openFile.path}
            >
              {openFile.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {formatBytes(openFile.size)}
            </span>
          </div>
          {fileError ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{fileError}</p>
          ) : !fileContent ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading…
            </p>
          ) : binary ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Binary file — no preview ({formatBytes(fileContent.totalBytes)}).
            </p>
          ) : (
            <>
              {truncated && (
                <p className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                  Too large to show in full — first{" "}
                  {formatBytes(fileContent.readBytes)} of{" "}
                  {formatBytes(fileContent.totalBytes)}.
                </p>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                <pre className="px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                  {fileContent.content}
                </pre>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {/* Breadcrumb header — h-9 fixed, matching every other secondary
              toolbar (Timeline's own header, HudTabHeader) exactly, not just
              "close enough" padding. */}
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
              title={cwd ?? undefined}
            >
              {cwd ? prettyPath(cwd) : "No directory"}
            </span>
            <button
              onClick={refresh}
              title="Refresh"
              aria-label="Refresh"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto py-1 text-xs">
            {error ? (
              <p className="px-3 py-2 text-muted-foreground">{error}</p>
            ) : !root ? (
              <p className="px-3 py-2 text-muted-foreground">
                {cwd ? "Loading…" : "Waiting for a working directory…"}
              </p>
            ) : root.entries.length === 0 ? (
              <p className="px-3 py-2 text-muted-foreground">Empty directory</p>
            ) : (
              renderEntries(root, 0)
            )}
          </div>
        </>
      )}
    </aside>
  );
}

interface RowProps {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  touched: "edited" | "read" | null;
  onToggle: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopy: () => void;
}

/** One tree row: indent + chevron (dirs) + icon + name + touched dot + actions.
 *  Dirs expand inline; files open the read-only content view. */
function Row({
  entry,
  depth,
  expanded,
  touched,
  onToggle,
  onOpen,
  onReveal,
  onCopy,
}: RowProps) {
  const isDot = entry.name.startsWith(".");
  return (
    <div
      className="group flex items-center gap-1 px-2 py-0.5 hover:bg-muted/60"
      style={{ paddingLeft: depth * 12 + 8 }}
    >
      <button
        onClick={entry.isDir ? onToggle : onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
      >
        {entry.isDir ? (
          <ChevronRight
            className={
              "size-3 shrink-0 text-muted-foreground transition-transform " +
              (expanded ? "rotate-90" : "")
            }
          />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {entry.isDir ? (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={
            "truncate " + (isDot ? "text-muted-foreground" : "text-foreground")
          }
        >
          {entry.name}
        </span>
      </button>

      {/* "Claude touched this" badge — ember for edited/written, muted for read. */}
      {touched ? (
        <span
          title={
            touched === "edited"
              ? "Edited by Claude this session"
              : "Read by Claude this session"
          }
          className={
            "size-1.5 shrink-0 rounded-full " +
            (touched === "edited" ? "bg-brand" : "bg-muted-foreground/50")
          }
        />
      ) : null}

      {/* Hover actions — reveal in Finder, copy path. */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={onReveal}
          title="Reveal in Finder"
          aria-label="Reveal in Finder"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3" />
        </button>
        <button
          onClick={onCopy}
          title="Copy path"
          aria-label="Copy path"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Copy className="size-3" />
        </button>
      </span>
    </div>
  );
}
