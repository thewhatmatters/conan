import { Hexagon } from "lucide-react";
import type { Session } from "../hooks/useSessions.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import { CONAN_VERSION } from "../lib/appMenu.ts";

interface SessionHeaderProps {
  /** The session correlated to the ACTIVE terminal tab (US-003), or null. */
  session: Session | null;
  /** The active session's widget payload (carries liveContext + claudeVersion). */
  data: WidgetData | null;
  /** App-wide fallback cwd (config.cwd) when no session cwd is known. */
  cwd?: string | null;
}

/** Collapse a $HOME-prefixed absolute path to `~/…` (macOS/Linux/root). */
function collapseHome(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, "~");
}

/** Prefix a bare version (e.g. "2.1.152") with "v"; pass through if already prefixed. */
function vlabel(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`;
}

/** "1M context" / "200K context" from a resolved window-token count. */
function windowLabel(windowTokens: number | null | undefined): string | null {
  if (windowTokens == null || windowTokens <= 0) return null;
  if (windowTokens >= 1_000_000) {
    const m = windowTokens / 1_000_000;
    return `${m === Math.round(m) ? m : m.toFixed(1)}M context`;
  }
  return `${Math.round(windowTokens / 1000)}K context`;
}

/** Friendly model name from a raw slug ("claude-opus-4-7[1m]" → "Opus 4.7"). */
function prettyModel(slug: string): string {
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(slug);
  if (!m) return slug;
  const fam = (m[1] ?? "").toLowerCase();
  const family = fam.charAt(0).toUpperCase() + fam.slice(1);
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2] ?? "";
  return `${family} ${version}`.trim();
}

/** The "[1m]"/"-1m" marker on a slug flags the 1M-context beta. */
const is1mSlug = (s: string | null): boolean =>
  !!s && /\[1m\]|-1m\b/i.test(s);

/**
 * A pinned, Claude-banner-style header atop the terminal pane (US-008). Mirrors
 * the three lines Claude prints on launch so the user sees what's running
 * without scrolling the terminal back: (1) a logo placeholder + product line
 * with BOTH versions — Conan's own (CONAN_VERSION) and the Claude Code version
 * captured from the SessionStart hook (US-001, `—` when unknown); (2) the model
 * and its context window (`Opus 4.7 (1M context)`) from the live /context
 * capture, falling back to the transcript/session model; (3) the session cwd,
 * `~`-collapsed.
 *
 * Describes the ACTIVE terminal tab's session (App derives it from activeTid via
 * useTerminals). When the tab is uncorrelated (no session yet) it still renders
 * the logo + Conan version + cwd with the model line muted and the Claude
 * version `—`, never a blank bar. Flush, semantic-token-only styling with a 1px
 * bottom border; it sits between the tab strip and the xterm surface and does
 * not affect the terminal body.
 */
export default function SessionHeader({
  session,
  data,
  cwd,
}: SessionHeaderProps) {
  const claudeVersion = data?.claudeVersion ?? session?.claude_version ?? null;

  const live = data?.liveContext ?? null;
  // Prefer the live /context capture's pretty name; otherwise prettify the
  // transcript/session model slug (the documented fallback) so the common
  // pre-capture state still reads like Claude's banner ("Opus 4.7").
  const rawModel = data?.context?.model ?? session?.model ?? null;
  const modelDisplay =
    live?.modelDisplay ?? (rawModel ? prettyModel(rawModel) : null);
  // Window: the gateway-resolved size when known, else infer the 1M beta from
  // the slug marker so the fallback line still shows "(1M context)".
  const win =
    windowLabel(live?.windowTokens ?? data?.context?.windowTokens) ??
    (is1mSlug(rawModel) ? "1M context" : null);
  const modelLine = modelDisplay
    ? win
      ? `${modelDisplay} (${win})`
      : modelDisplay
    : null;

  const rawCwd = session?.cwd ?? cwd ?? null;
  const cwdLine = rawCwd ? collapseHome(rawCwd) : null;

  return (
    <div className="flex items-center gap-2.5 border-b border-border bg-card px-3 py-1.5">
      <Hexagon className="size-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="flex min-w-0 flex-col leading-tight">
        {/* Line 1: product line — both versions. */}
        <div className="truncate text-[11px] font-medium text-foreground">
          Conan {CONAN_VERSION}
          <span className="text-muted-foreground"> · </span>
          Claude Code {claudeVersion ? vlabel(claudeVersion) : "—"}
        </div>
        {/* Line 2: model (context); muted placeholder when uncorrelated. */}
        <div
          className={
            "truncate text-[11px] " +
            (modelLine ? "text-muted-foreground" : "italic text-muted-foreground/60")
          }
        >
          {modelLine ?? "no model"}
        </div>
        {/* Line 3: session cwd, ~-collapsed. */}
        {cwdLine && (
          <div className="truncate font-mono text-[10px] text-muted-foreground/80">
            {cwdLine}
          </div>
        )}
      </div>
    </div>
  );
}
