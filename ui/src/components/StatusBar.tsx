import { FolderOpen, GitBranch } from "lucide-react";

interface StatusBarProps {
  /** App-wide active working directory (GET /api/config). */
  cwd?: string | null;
  /** Git branch + dirty count from the active session's widget data (useWidgets). */
  git?: { available: boolean; branch: string | null; dirty: number } | null;
}

/** Collapse the home prefix to `~` so long absolute paths stay readable. */
function prettyCwd(cwd: string): string {
  const home = "/Users/";
  if (cwd.startsWith(home)) {
    const rest = cwd.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash !== -1) return "~" + rest.slice(slash);
  }
  return cwd;
}

/**
 * Slim bottom status bar on the TerminalPane (US-004): always-visible
 * orientation that reads at a glance — the working directory hugs the left edge
 * and the git branch hugs the right edge (justify-between), each truncating
 * independently. Dirtiness is a VS Code–style bare `*` appended to the branch
 * name (e.g. `main*`); a clean tree shows the plain branch. The gateway
 * connection chip was dropped here (US-004). Semantic tokens only so it recolors
 * with the theme.
 */
export default function StatusBar({ cwd, git }: StatusBarProps) {
  return (
    <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 py-1 text-xs text-muted-foreground">
      {cwd ? (
        <span title={cwd} className="inline-flex min-w-0 items-center gap-1.5">
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="truncate">{prettyCwd(cwd)}</span>
        </span>
      ) : (
        <span />
      )}
      {git?.available && git.branch && (
        <span
          title={
            git.dirty
              ? `${git.dirty} uncommitted change${git.dirty === 1 ? "" : "s"}`
              : "working tree clean"
          }
          className="inline-flex min-w-0 items-center gap-1.5"
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">
            {git.branch}
            {git.dirty > 0 && "*"}
          </span>
        </span>
      )}
    </footer>
  );
}
