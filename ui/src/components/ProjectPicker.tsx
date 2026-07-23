import { useCallback, useMemo, useState } from "react";
import { ChevronUp, CornerDownLeft, Folder, FolderSearch, Loader2 } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { basename, pretty } from "./DirBrowser.tsx";
import { apiBase } from "../lib/gateway.ts";

/**
 * Command-palette project picker (US-006) — the add-project flow as a
 * keyboard-navigable "Sources" sheet (t3-code's pattern) instead of a raw
 * folder dialog. Two views inside one palette:
 *
 *  - SOURCES: the source list (v1: Local folder — remote sources are the
 *    deferred A1-b) plus recently-added projects inline for quick re-add.
 *  - BROWSE: a filterable folder browser over the gateway's /api/fs/list
 *    (the same listing DirBrowser used) — Enter descends into the
 *    highlighted folder, "Use this directory" selects the current one.
 *
 * Keyboard contract: ↑↓ navigate (cmdk), Enter select, Backspace back
 * (folder → parent view history, browse → sources; only when the filter is
 * empty, so clearing a query stays natural), Esc close (the Dialog).
 */

/** Structural copies of the gateway's /api/fs/list payload. */
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

// ── Recent projects (localStorage) ──────────────────────────────────────────

const RECENTS_KEY = "conan-recent-projects";
const RECENTS_MAX = 8;

export function loadRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string").slice(0, RECENTS_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Record a project path as recently added (called by the add-project flow)
 *  so the palette can offer it for quick re-add. Most-recent first, deduped. */
export function recordRecentProject(path: string) {
  try {
    const next = [path, ...loadRecentProjects().filter((p) => p !== path)];
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next.slice(0, RECENTS_MAX)));
  } catch {
    /* private-mode storage failures just lose the recents list */
  }
}

export default function ProjectPicker({
  token,
  start,
  onSelect,
  onClose,
}: {
  token: string | null;
  /** Where Browse starts — the app's active cwd, falling back to `~`. */
  start: string | null;
  /** A folder was chosen (from Recents or Browse) — add it as a project. */
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"sources" | "browse">("sources");
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  /** Visited-path history inside Browse — Backspace pops it (palette "back",
   *  distinct from ".." which always climbs to the parent). */
  const [, setStack] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const recents = useMemo(loadRecentProjects, []);

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

  const enterBrowse = () => {
    setMode("browse");
    setQuery("");
    setStack([]);
    load(start ?? "~");
  };

  /** Navigate to a folder, pushing the current one onto the back history. */
  const descend = (path: string) => {
    if (listing) setStack((s) => [...s, listing.path]);
    setQuery("");
    load(path);
  };

  /** Backspace: pop the Browse history, else fall back out to Sources. */
  const goBack = () => {
    if (mode !== "browse") return;
    setQuery("");
    setStack((s) => {
      const prev = s[s.length - 1];
      if (prev) {
        load(prev);
        return s.slice(0, -1);
      }
      setMode("sources");
      setListing(null);
      return [];
    });
  };

  const dirs = listing?.entries.filter((e) => e.isDir) ?? [];
  const itemCls = "text-xs";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-4 pb-2.5 pt-3.5">
          <DialogTitle className="text-sm">Add project</DialogTitle>
          <DialogDescription
            className="truncate font-mono text-[11px]"
            title={mode === "browse" ? listing?.path : undefined}
          >
            {mode === "browse" ? (listing ? pretty(listing.path) : "…") : "Choose a source"}
          </DialogDescription>
        </DialogHeader>
        <Command
          className="rounded-none bg-transparent"
          // Plain substring matching: cmdk's default fuzzy scoring makes
          // subsequence matches across labels/keywords (e.g. "docs" hits
          // "use-this-directory choose"), which turns Enter into an
          // accidental folder select. Folder names want literal filtering.
          filter={(value, search, keywords) => {
            const q = search.toLowerCase();
            return value.toLowerCase().includes(q) ||
              (keywords ?? []).some((k) => k.toLowerCase().includes(q))
              ? 1
              : 0;
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && query === "" && mode === "browse") {
              e.preventDefault();
              goBack();
            }
          }}
        >
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={mode === "browse" ? "Filter folders…" : "Where do your projects live?"}
            className="h-9 text-xs"
          />
          <CommandList className="max-h-80">
            {mode === "sources" ? (
              <>
                <CommandEmpty className="py-4 text-xs text-muted-foreground">
                  No matching source.
                </CommandEmpty>
                <CommandGroup heading="Sources">
                  <CommandItem
                    value="local-folder"
                    keywords={["browse", "disk", "directory"]}
                    onSelect={enterBrowse}
                    className={itemCls}
                  >
                    <FolderSearch className="text-muted-foreground" />
                    Local folder
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      browse ↵
                    </span>
                  </CommandItem>
                </CommandGroup>
                {recents.length > 0 && (
                  <CommandGroup heading="Recent projects">
                    {recents.map((p) => (
                      <CommandItem
                        key={p}
                        value={p}
                        keywords={[basename(p)]}
                        onSelect={() => onSelect(p)}
                        className={itemCls}
                      >
                        <Folder className="text-muted-foreground" />
                        <span className="shrink-0">{basename(p)}</span>
                        <span className="ml-auto min-w-0 truncate pl-3 font-mono text-[10px] text-muted-foreground">
                          {pretty(p)}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            ) : loading && !listing ? (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                <CommandEmpty className="py-4 text-xs text-muted-foreground">
                  {listing?.error ?? "No matching folders."}
                </CommandEmpty>
                {listing && (
                  <CommandGroup>
                    <CommandItem
                      value="use-this-directory"
                      keywords={["select", "choose", basename(listing.path)]}
                      onSelect={() => onSelect(listing.path)}
                      className={itemCls}
                    >
                      <CornerDownLeft className="text-primary" />
                      <span className="font-medium">Use this directory</span>
                      <span className="ml-auto min-w-0 truncate pl-3 font-mono text-[10px] text-muted-foreground">
                        {basename(listing.path)}
                      </span>
                    </CommandItem>
                    {listing.parent && (
                      <CommandItem
                        value="parent-directory"
                        keywords={[".."]}
                        onSelect={() => descend(listing.parent!)}
                        className={itemCls}
                      >
                        <ChevronUp className="text-muted-foreground" />
                        ..
                      </CommandItem>
                    )}
                    {dirs.map((d) => (
                      <CommandItem
                        key={d.path}
                        value={d.name}
                        onSelect={() => descend(d.path)}
                        className={itemCls}
                      >
                        <Folder className="text-muted-foreground" />
                        <span className="truncate">{d.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ {mode === "browse" ? "open folder" : "select"}</span>
          <span>⌫ back</span>
          <span>esc close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
