import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Folder,
  FolderOpen,
  FolderSearch,
  History,
  Loader2,
  Lock,
} from "lucide-react";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { apiBase, isTauri } from "../lib/gateway.ts";
import { cn } from "../lib/utils.ts";

/**
 * Per-thread working-directory chip (US-011). Sits in the composer's chip row:
 * shows the thread's effective cwd (basename) and, until the first turn locks
 * the launch config, opens a dropdown of the app's active directory + recent
 * directories (localStorage) + Browse. Browse is a native folder dialog under
 * Tauri (@tauri-apps/plugin-dialog) and an in-app directory browser over
 * GET /api/fs/list everywhere else (browser dev has no native dialogs).
 */

const RECENTS_KEY = "conan-chat-recent-cwds";
const RECENTS_MAX = 8;

/** Most-recent-first list of directories previously used by chat threads. */
export function recentCwds(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Record a directory a thread actually ran in (called at the first prompt). */
export function recordRecentCwd(cwd: string): void {
  try {
    const next = [cwd, ...recentCwds().filter((p) => p !== cwd)].slice(0, RECENTS_MAX);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — recents are a convenience, not a requirement.
  }
}

/** Collapse the home prefix to `~` (same treatment as StatusBar). */
function pretty(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash !== -1) return "~" + rest.slice(slash);
  }
  return p;
}

function basename(p: string): string {
  const base = p.replace(/\/+$/, "").split("/").pop();
  return base || p;
}

export default function CwdPicker({
  token,
  value,
  defaultCwd,
  locked,
  onChange,
}: {
  token: string | null;
  /** The thread's explicitly chosen cwd; null = following the app default. */
  value: string | null;
  /** The app's active cwd from /api/config — the default for new threads. */
  defaultCwd: string | null;
  /** Launch config fixed after the first turn — chip becomes a static indicator. */
  locked: boolean;
  onChange: (cwd: string) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const effective = value ?? defaultCwd;
  const label = effective ? basename(effective) : "Directory";
  const recents = recentCwds().filter((p) => p !== effective);

  const browse = async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({
        directory: true,
        defaultPath: effective ?? undefined,
        title: "Choose the thread's working directory",
      });
      if (typeof dir === "string" && dir) onChange(dir);
    } else {
      setBrowsing(true);
    }
  };

  if (locked) {
    return (
      <span
        title={
          (effective ? `${effective}\n` : "") +
          "Locked for this thread — a new chat starts a fresh directory"
        }
        className="flex min-w-0 cursor-default items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
      >
        <FolderOpen className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate">{label}</span>
        <Lock className="size-3 shrink-0 opacity-60" />
      </span>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          title={effective ?? undefined}
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none"
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-80">
          {defaultCwd && (
            <DropdownMenuItem onClick={() => onChange(defaultCwd)}>
              <Folder className="size-3.5 text-muted-foreground" />
              <div className="flex min-w-0 flex-col">
                <span>{basename(defaultCwd)}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {pretty(defaultCwd)} · app directory
                </span>
              </div>
            </DropdownMenuItem>
          )}
          {recents.length > 0 && <DropdownMenuSeparator />}
          {recents.map((p) => (
            <DropdownMenuItem key={p} onClick={() => onChange(p)}>
              <History className="size-3.5 text-muted-foreground" />
              <div className="flex min-w-0 flex-col">
                <span>{basename(p)}</span>
                <span className="truncate text-[11px] text-muted-foreground">{pretty(p)}</span>
              </div>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={browse}>
            <FolderSearch className="size-3.5 text-muted-foreground" />
            Browse…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {browsing && (
        <DirBrowser
          token={token}
          start={effective}
          onSelect={(p) => {
            onChange(p);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}

/** Structural copies of the gateway's /api/fs/list payload (FileExplorer does
 *  the same — types aren't shared across the gateway/UI boundary). */
interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}
interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  error?: string;
}

/** In-app directory browser — the browser/dev fallback for the native folder
 *  dialog. Lists directories only; descend by click, Up via the parent link,
 *  and "Use this directory" selects the current path. */
function DirBrowser({
  token,
  start,
  onSelect,
  onClose,
}: {
  token: string | null;
  start: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (path: string) => {
      if (!token) return;
      setLoading(true);
      fetch(apiBase() + `/api/fs/list?path=${encodeURIComponent(path)}`, {
        headers: { "x-conan-token": token },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((l: FsListing | null) => l && setListing(l))
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [token],
  );

  useEffect(() => {
    load(start ?? "~");
    // Load only the starting directory on mount; navigation drives the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirs = listing?.entries.filter((e) => e.isDir) ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Choose working directory</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={listing?.path}>
            {listing ? pretty(listing.path) : "…"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          {listing?.parent && (
            <button
              type="button"
              onClick={() => load(listing.parent!)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <ChevronUp className="size-3.5 shrink-0" />
              ..
            </button>
          )}
          {loading && !listing ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          ) : dirs.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {listing?.error ?? "No subdirectories."}
            </p>
          ) : (
            dirs.map((d) => (
              <button
                key={d.path}
                type="button"
                onClick={() => load(d.path)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                  d.name.startsWith(".") ? "text-muted-foreground/60" : "text-foreground",
                )}
              >
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{d.name}</span>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!listing} onClick={() => listing && onSelect(listing.path)}>
            Use this directory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
