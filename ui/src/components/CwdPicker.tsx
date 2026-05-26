import { useEffect, useRef, useState } from "react";

interface DirEntry {
  name: string;
  path: string;
}

interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  error?: string;
}

interface CwdPickerProps {
  /** The current active working directory (from /api/config). */
  cwd: string;
  /** Gateway auth token; required for the directory browse + set routes. */
  token: string | null;
  /** Called with the new active cwd after a successful change. */
  onChange: (cwd: string) => void;
}

/**
 * Toolbar directory picker (US-019). The cwd label opens a browser of the local
 * filesystem (subdirectories of the current path, plus ".." to go up). Picking
 * "Use this folder" PUTs the active cwd to the gateway, which re-scopes new
 * terminals + the Tasks reader; already-running ptys keep their own cwd. A typed
 * path can be navigated to directly. Invalid/inaccessible paths surface the
 * gateway's error inline.
 */
export default function CwdPicker({ cwd, token, onChange }: CwdPickerProps) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState(cwd);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const headers = (): Record<string, string> =>
    token ? { "x-conan-token": token } : {};

  const browse = (path?: string) => {
    setError(null);
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    fetch(`/api/fs/dirs${q}`, { headers: headers() })
      .then((r) => r.json())
      .then((l: DirListing) => {
        setListing(l);
        setTyped(l.path);
        if (l.error) setError(l.error);
      })
      .catch(() => setError("failed to list directory"));
  };

  // Open the browser at the current cwd each time the dropdown opens.
  useEffect(() => {
    if (open) browse(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (path: string) => {
    if (!token) {
      setError("not connected");
      return;
    }
    fetch("/api/cwd", {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify({ cwd: path }),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (ok && j.ok) {
          onChange(j.cwd);
          setOpen(false);
        } else {
          setError(j.error ?? "could not set directory");
        }
      })
      .catch(() => setError("failed to set directory"));
  };

  const browsePath = listing?.path ?? cwd;

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${cwd} — click to change working directory`}
        className="flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-muted"
      >
        <FolderIcon />
        <span className="truncate">{prettyPath(cwd)}</span>
        <span className="text-[10px]">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-96 max-w-[80vw] rounded-md border border-border bg-card p-2 shadow-md">
          {/* Typed path: Enter navigates the browser there. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              browse(typed);
            }}
            className="mb-2 flex items-center gap-1.5"
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              placeholder="/path/to/project"
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
            <button
              type="submit"
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              Go
            </button>
          </form>

          <div className="mb-1 truncate font-mono text-[11px] text-muted-foreground">
            {browsePath}
          </div>

          {error && (
            <div className="mb-1 rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-500">
              {error}
            </div>
          )}

          <div className="max-h-56 overflow-auto rounded border border-border">
            {listing?.parent && (
              <button
                onClick={() => browse(listing.parent!)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
              >
                <span className="font-mono">..</span>
                <span className="text-[10px]">(parent)</span>
              </button>
            )}
            {listing?.entries.map((d) => (
              <button
                key={d.path}
                onClick={() => browse(d.path)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
              >
                <FolderIcon />
                <span className="truncate">{d.name}</span>
              </button>
            ))}
            {listing && listing.entries.length === 0 && !listing.parent && (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                no subdirectories
              </div>
            )}
            {listing && listing.entries.length === 0 && listing.parent && (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                no subdirectories here
              </div>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="truncate text-[10px] text-muted-foreground">
              New terminals + Tasks follow this; open ptys keep theirs.
            </span>
            <button
              onClick={() => select(browsePath)}
              className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              Use this folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Abbreviate $HOME to ~ for a compact toolbar path. */
function prettyPath(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length).split("/");
    if (rest.length > 1) return "~/" + rest.slice(1).join("/");
  }
  return p;
}

function FolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}
