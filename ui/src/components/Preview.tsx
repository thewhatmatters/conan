import { useEffect, useRef, useState } from "react";
import { ExternalLink, Play, Square, Terminal as TermIcon } from "lucide-react";
import { usePreview } from "../hooks/usePreview.ts";
import { Button } from "./ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";

/**
 * Preview dock tab (US-012): runs the active cwd's dev server (US-010) and
 * frames it live via Conan's same-origin /preview/:id reverse proxy (US-011),
 * so Claude's edits render in real time without leaving the dashboard. Provides
 * a dev-command picker (fed by package.json script discovery, with override),
 * start/stop controls, an "open in new tab" affordance, a run-state badge, and
 * an honest stdout/stderr log pane. Targets the cwd from /api/config; since the
 * backend stops a preview that belonged to the previous cwd, switching projects
 * leaves no dead iframe — the status flips to idle and we show the empty state.
 */
export default function Preview({
  token,
  cwd,
}: {
  token: string | null;
  cwd: string | null;
}) {
  const { status, discovery, log, busy, actionError, start, stop } = usePreview(
    token,
    cwd,
  );

  // The script the picker has selected; defaults to discovery's preferred pick
  // and follows it until the user overrides. Kept in sync as discovery loads.
  const [picked, setPicked] = useState<string | null>(null);
  const userPicked = useRef(false);
  useEffect(() => {
    if (!userPicked.current && discovery?.defaultScript) {
      setPicked(discovery.defaultScript);
    }
  }, [discovery?.defaultScript]);

  const [showLog, setShowLog] = useState(false);

  const candidates = discovery?.candidates ?? [];
  const running = status?.active ?? false;
  const state = status?.state ?? "idle";
  // The proxy is mounted at /preview/<id>/ once a port is bound; gate the iframe
  // on a known id+port so it never points at a dead target.
  const previewUrl =
    status?.id && status.port ? `/preview/${status.id}/` : null;

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Control strip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Select
          value={picked ?? undefined}
          onValueChange={(v) => {
            userPicked.current = true;
            setPicked(v);
          }}
          disabled={running || candidates.length === 0}
        >
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="dev command" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((c) => (
              <SelectItem key={c.script} value={c.script} className="text-xs">
                {c.script}
                <span className="ml-1.5 text-muted-foreground">
                  {c.command.length > 28 ? c.command.slice(0, 27) + "…" : c.command}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {running ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void stop()}
            disabled={busy}
          >
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void start(picked ?? undefined)}
            disabled={busy || candidates.length === 0}
          >
            <Play className="size-3.5" /> Start
          </Button>
        )}

        <StateBadge state={state} />

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            title="Show dev-server log"
            data-active={showLog}
            onClick={() => setShowLog((v) => !v)}
          >
            <TermIcon className="size-4" />
          </Button>
          {previewUrl && (
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              title="Open preview in a new tab"
              render={
                <a href={previewUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                </a>
              }
            />
          )}
        </div>
      </div>

      {/* Body: live iframe, or an honest empty/error state. */}
      <div className="relative min-h-0 flex-1 bg-background">
        {previewUrl ? (
          <iframe
            key={status?.id}
            src={previewUrl}
            title="Live preview"
            className="absolute inset-0 size-full border-0 bg-white"
          />
        ) : (
          <EmptyState
            state={state}
            cwd={cwd}
            discoveryError={discovery?.error}
            actionError={actionError}
            statusError={status?.error ?? null}
            hasCandidates={candidates.length > 0}
            busy={busy}
          />
        )}
      </div>

      {/* Log pane — folded by default; the "would I tail this?" output lives
          here so a failed start has a visible reason. */}
      {showLog && (
        <div className="h-40 shrink-0 overflow-auto border-t border-border bg-term-bg px-3 py-2">
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
            {log || "no output yet"}
          </pre>
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const meta: Record<string, { label: string; dot: string }> = {
    idle: { label: "idle", dot: "bg-muted-foreground/50" },
    starting: { label: "starting…", dot: "bg-amber-500 animate-pulse" },
    running: { label: "running", dot: "bg-primary" },
    exited: { label: "stopped", dot: "bg-muted-foreground/50" },
    error: { label: "error", dot: "bg-destructive" },
  };
  const m = meta[state] ?? meta.idle!;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={"size-1.5 rounded-full " + m.dot} />
      {m.label}
    </span>
  );
}

function EmptyState({
  state,
  cwd,
  discoveryError,
  actionError,
  statusError,
  hasCandidates,
  busy,
}: {
  state: string;
  cwd: string | null;
  discoveryError?: string;
  actionError: string | null;
  statusError: string | null;
  hasCandidates: boolean;
  busy: boolean;
}) {
  let msg: string;
  if (actionError) msg = actionError;
  else if (state === "error" && statusError) msg = statusError;
  else if (state === "starting" || busy) msg = "starting dev server…";
  else if (discoveryError || !hasCandidates)
    msg = `No dev command found in ${cwd ?? "this folder"} (looked for dev, start, preview).`;
  else if (state === "exited") msg = "Preview stopped.";
  else msg = "Pick a dev command and press Start to preview this project live.";

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">{msg}</p>
    </div>
  );
}
