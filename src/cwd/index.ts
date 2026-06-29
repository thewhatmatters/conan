import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, HOME } from "../paths.js";

/**
 * The app-wide active working directory (US-019). The toolbar directory picker
 * sets it; new terminals spawn in it (existing ptys keep theirs), and the Tasks
 * (prd.json/progress.txt) reader follows it. Persisted to .data/active-cwd so
 * the choice survives a gateway restart. Defaults to the repo root.
 *
 * Scope: this is *per-app* (one active cwd shared by the dashboard), not
 * per-terminal — already-running ptys keep the cwd they were spawned with.
 */
const CWD_FILE = path.join(DATA_DIR, "active-cwd");

let active = loadPersisted();
const listeners = new Set<(cwd: string) => void>();

/**
 * The startup default when there's no usable persisted choice. We prefer
 * ~/.claude (where the user's Claude Code config + projects live) so the app
 * opens somewhere meaningful, falling back to HOME — never the app's own
 * install location.
 */
function smartDefault(): string {
  const claudeDir = path.join(HOME, ".claude");
  if (isUsableDir(claudeDir)) return claudeDir;
  return HOME;
}

function loadPersisted(): string {
  try {
    const raw = fs.readFileSync(CWD_FILE, "utf8").trim();
    if (raw && isUsableDir(raw)) return raw;
  } catch {
    /* no persisted cwd — fall through to the smart default */
  }
  return smartDefault();
}

/** Expand a leading ~ to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

/** A readable, traversable directory (the only thing we'll accept as a cwd). */
function isUsableDir(p: string): boolean {
  try {
    if (!fs.statSync(p).isDirectory()) return false;
    fs.accessSync(p, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The current active working directory. */
export function getActiveCwd(): string {
  return active;
}

export interface SetCwdResult {
  ok: boolean;
  cwd: string;
  error?: string;
}

/**
 * Validate and set the active cwd. Rejects anything that isn't an accessible
 * directory with a clear, path-bearing message; on success persists the choice
 * and notifies subscribers (so the Tasks watcher re-scopes immediately).
 */
export function setActiveCwd(input: unknown): SetCwdResult {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, cwd: active, error: "path required" };
  }
  const resolved = path.resolve(expandHome(input.trim()));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, cwd: active, error: `no such directory: ${resolved}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, cwd: active, error: `not a directory: ${resolved}` };
  }
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return { ok: false, cwd: active, error: `not accessible: ${resolved}` };
  }

  active = resolved;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CWD_FILE, resolved);
  } catch {
    /* best-effort persist — the in-memory value still updates */
  }
  for (const fn of listeners) {
    try {
      fn(resolved);
    } catch {
      /* a listener throwing must not block the others */
    }
  }
  return { ok: true, cwd: resolved };
}

/** Subscribe to active-cwd changes; returns an unsubscribe fn. */
export function onCwdChange(fn: (cwd: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  /** The directory that was listed (resolved absolute path). */
  path: string;
  /** Its parent, or null at the filesystem root. */
  parent: string | null;
  /** Immediate subdirectories (hidden dot-dirs excluded), name-sorted. */
  entries: DirEntry[];
  error?: string;
}

/**
 * List the immediate subdirectories of `input` (defaults to the active cwd) for
 * the toolbar picker. Hidden dot-directories are omitted; unreadable targets
 * degrade to an empty listing with an `error` so the UI can explain itself.
 */
export function listDirs(input?: string): DirListing {
  const target =
    typeof input === "string" && input.trim()
      ? path.resolve(expandHome(input.trim()))
      : active;
  const parentOf = path.dirname(target);
  const parent = parentOf === target ? null : parentOf;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { path: target, parent, entries: [], error: `cannot read: ${target}` };
  }

  const entries = dirents
    .filter((d) => {
      if (d.name.startsWith(".")) return false;
      if (d.isDirectory()) return true;
      // Follow symlinks that point at directories.
      if (d.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(target, d.name)).isDirectory();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { path: target, parent, entries };
}

export interface FileEntry {
  name: string;
  /** Absolute path of the entry. */
  path: string;
  isDir: boolean;
  /** Size in bytes (0 for directories or un-stat-able entries). */
  size: number;
  /** Last-modified time in epoch ms (0 when un-stat-able). */
  mtimeMs: number;
}

export interface FileListing {
  /** The directory that was listed (resolved absolute path). */
  path: string;
  /** Its parent, or null at the filesystem root. */
  parent: string | null;
  /** Immediate contents — files AND directories, dirs first then name-sorted. */
  entries: FileEntry[];
  error?: string;
}

/**
 * List the immediate contents (files AND directories) of `input` for the file
 * explorer. Unlike {@link listDirs}, this keeps files and dot-entries (the UI
 * dims the latter). Directories sort first, then case-insensitive name order.
 * Unreadable targets degrade to an empty listing with an `error`; a single
 * un-stat-able entry (broken symlink, EACCES) never throws the whole listing.
 */
export function listEntries(input?: string): FileListing {
  const target =
    typeof input === "string" && input.trim()
      ? path.resolve(expandHome(input.trim()))
      : active;
  const parentOf = path.dirname(target);
  const parent = parentOf === target ? null : parentOf;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { path: target, parent, entries: [], error: `cannot read: ${target}` };
  }

  const entries = dirents
    .map((d) => {
      const full = path.join(target, d.name);
      let isDir = d.isDirectory();
      let size = 0;
      let mtimeMs = 0;
      try {
        // stat (not lstat) so symlinks report their target's kind + size.
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // Broken symlink or permission denied — keep the entry with the
        // dirent's own type and zeroed stats rather than dropping it.
      }
      return { name: d.name, path: full, isDir, size, mtimeMs };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { path: target, parent, entries };
}
