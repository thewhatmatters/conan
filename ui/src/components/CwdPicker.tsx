import { useEffect, useState } from "react";
import { ChevronsUpDown, CornerLeftUp, Folder, FolderInput } from "lucide-react";

import { Button, buttonVariants } from "./ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

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
 * Toolbar directory picker (US-040, backed by US-003). The cwd label is a shadcn
 * Popover trigger that opens a Command-driven browser of the local filesystem
 * (subdirectories of the current path, plus ".." to go up). The Command input
 * doubles as a filter over the listed folders and — when it looks like a path
 * (starts with "/" or "~") — a "Go to" target for jumping anywhere directly.
 * "Use this folder" PUTs the active cwd to the gateway, which re-scopes new
 * terminals, the Tasks reader (so the Tasks tab appears/disappears, US-039), and
 * the cwd-scoped widgets; already-running ptys keep their own cwd. The choice
 * persists across reloads (server-side). Invalid/inaccessible paths surface the
 * gateway's error inline. shadcn primitives + semantic tokens → light + dark.
 */
export default function CwdPicker({ cwd, token, onChange }: CwdPickerProps) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const headers = (): Record<string, string> =>
    token ? { "x-conan-token": token } : {};

  const browse = (path?: string) => {
    setError(null);
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    fetch(`/api/fs/dirs${q}`, { headers: headers() })
      .then((r) => r.json())
      .then((l: DirListing) => {
        setListing(l);
        setQuery("");
        if (l.error) setError(l.error);
      })
      .catch(() => setError("failed to list directory"));
  };

  // Open the browser at the current cwd each time the popover opens.
  useEffect(() => {
    if (open) browse(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // A query that looks like a filesystem path becomes a "Go to" target rather
  // than only a name filter, so the user can jump anywhere directly.
  const looksLikePath = query.startsWith("/") || query.startsWith("~");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title={`${cwd} — click to change working directory`}
        className={buttonVariants({
          variant: "outline",
          size: "sm",
          className:
            "h-7 min-w-0 max-w-[42vw] gap-1.5 bg-muted/50 px-2 font-mono text-xs font-normal text-muted-foreground",
        })}
      >
        <Folder />
        <span className="truncate">{prettyPath(cwd)}</span>
        <ChevronsUpDown className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[80vw] p-0">
        {/* shouldFilter=false: we filter folder entries ourselves so the same
            input can also act as a free-form path to "Go to". */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Filter folders, or type a /path…"
          />
          <div className="truncate border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            {browsePath}
          </div>
          {error && (
            <div className="border-b border-border bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
              {error}
            </div>
          )}
          <CommandList className="max-h-56">
            <CommandEmpty>No matching folders.</CommandEmpty>
            <CommandGroup>
              {looksLikePath && query.trim() && (
                <CommandItem
                  value={`__goto__${query}`}
                  onSelect={() => browse(query.trim())}
                >
                  <FolderInput />
                  <span className="truncate">Go to {query.trim()}</span>
                </CommandItem>
              )}
              {listing?.parent && (
                <CommandItem
                  value="__parent__"
                  onSelect={() => browse(listing.parent!)}
                >
                  <CornerLeftUp />
                  <span className="font-mono">..</span>
                  <span className="text-[10px] text-muted-foreground">
                    parent
                  </span>
                </CommandItem>
              )}
              {(listing?.entries ?? [])
                .filter((d) =>
                  looksLikePath
                    ? true
                    : d.name.toLowerCase().includes(query.toLowerCase()),
                )
                .map((d) => (
                  <CommandItem
                    key={d.path}
                    value={d.path}
                    onSelect={() => browse(d.path)}
                  >
                    <Folder />
                    <span className="truncate">{d.name}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center justify-between gap-2 border-t border-border p-2">
            <span className="truncate text-[10px] text-muted-foreground">
              New terminals + Tasks follow this; open ptys keep theirs.
            </span>
            <Button size="sm" onClick={() => select(browsePath)}>
              Use this folder
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
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
