import { FolderOpen, GitBranch } from "lucide-react";
import type { ConnStatus } from "../hooks/useTasks.ts";

interface StatusBarProps {
  /** App-wide active working directory (GET /api/config). */
  cwd?: string | null;
  /** Git branch + dirty count from the active session's widget data (useWidgets). */
  git?: { available: boolean; branch: string | null; dirty: number } | null;
  /** Gateway WS connection status — moved here out of the HUD (US-010). */
  status: ConnStatus;
  /** Gateway port, shown when connected. */
  port?: number;
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
 * Slim bottom status bar on the TerminalPane (US-010): always-visible
 * orientation — the working directory, the git branch (+ dirty count), and the
 * gateway connection. This is the single home for the gateway chip now (removed
 * from the HUD tab bar). Semantic tokens only so it recolors with the theme.
 */
export default function StatusBar({ cwd, git, status, port }: StatusBarProps) {
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-border bg-card px-3 py-1 text-xs text-muted-foreground">
      {cwd && (
        <span
          title={cwd}
          className="inline-flex min-w-0 items-center gap-1.5"
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="truncate">{prettyCwd(cwd)}</span>
        </span>
      )}
      {git?.available && git.branch && (
        <span
          title={
            git.dirty
              ? `${git.dirty} uncommitted change${git.dirty === 1 ? "" : "s"}`
              : "working tree clean"
          }
          className="inline-flex shrink-0 items-center gap-1.5"
        >
          <GitBranch className="size-3.5" />
          <span>{git.branch}</span>
          {git.dirty > 0 && (
            <span className="text-amber-500">●{git.dirty}</span>
          )}
        </span>
      )}
      <span className="ml-auto shrink-0">
        <GatewayChip status={status} port={port} />
      </span>
    </footer>
  );
}

/**
 * The gateway connection indicator (formerly in the HUD tab bar, US-018):
 * connected (green, "gateway :PORT"), connecting/reconnecting (amber, pulsing),
 * or offline (red) once backoff has given up.
 */
function GatewayChip({ status, port }: { status: ConnStatus; port?: number }) {
  const meta: Record<ConnStatus, { dot: string; text: string; label: string }> = {
    connected: {
      dot: "bg-primary",
      text: "text-primary",
      label: port ? `gateway :${port}` : "connected",
    },
    connecting: {
      dot: "bg-amber-500 animate-pulse",
      text: "text-muted-foreground",
      label: "connecting…",
    },
    reconnecting: {
      dot: "bg-amber-500 animate-pulse",
      text: "text-muted-foreground",
      label: "reconnecting…",
    },
    offline: {
      dot: "bg-red-500",
      text: "text-red-500",
      label: "offline",
    },
  };
  const m = meta[status];
  return (
    <span
      title={`Gateway connection: ${status}`}
      className={"inline-flex items-center gap-1.5 " + m.text}
    >
      <span className={"size-2 rounded-full " + m.dot} />
      {m.label}
    </span>
  );
}
