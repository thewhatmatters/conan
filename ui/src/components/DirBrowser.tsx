import { useCallback, useEffect, useState } from "react";
import { ChevronUp, Folder, Loader2 } from "lucide-react";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { apiBase } from "../lib/gateway.ts";
import { cn } from "../lib/utils.ts";

/** Collapse the home prefix to `~` (same treatment as StatusBar). */
export function pretty(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash !== -1) return "~" + rest.slice(slash);
  }
  return p;
}

export function basename(p: string): string {
  const base = p.replace(/\/+$/, "").split("/").pop();
  return base || p;
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
 *  dialog (extracted from the US-011 CwdPicker; US-025's add-project flow is
 *  its caller now). Lists directories only; descend by click, Up via the
 *  parent link, and "Use this directory" selects the current path. */
export default function DirBrowser({
  token,
  start,
  title = "Choose a folder",
  onSelect,
  onClose,
}: {
  token: string | null;
  start: string | null;
  title?: string;
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
          <DialogTitle>{title}</DialogTitle>
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
                  d.name.startsWith(".") ? "text-muted-foreground" : "text-foreground",
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
