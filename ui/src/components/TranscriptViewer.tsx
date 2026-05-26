import { useMemo, useState } from "react";
import type {
  TranscriptBlock,
  TranscriptMessage,
  TranscriptState,
} from "../hooks/useTranscript.ts";
import SortToggle, { type SortDir } from "./shared/SortToggle.tsx";

/**
 * Transcript viewer (US-014). Renders a session's full conversation —
 * user / assistant / tool messages with timestamps — read from the
 * Claude Code JSONL under ~/.claude (never duplicated into SQLite). A missing or
 * unreadable transcript degrades to an empty state.
 *
 * US-002: a newest/oldest-first SortToggle (the shared control from US-001, also
 * used by the Activity timeline) flips display order. Defaults to newest-first
 * so the latest turn sits on top; tie-broken on ts then uuid for stability.
 */
export default function TranscriptViewer({ state }: { state: TranscriptState }) {
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    // The JSONL arrives oldest-first; keep that index as the final, stable
    // tie-break so messages with equal ts and uuid never reorder arbitrarily.
    const indexed = state.messages.map((m, i) => ({ m, i }));
    indexed.sort((a, b) => {
      const ta = a.m.ts ?? 0;
      const tb = b.m.ts ?? 0;
      const byTs = sortDir === "asc" ? ta - tb : tb - ta;
      if (byTs !== 0) return byTs;
      const ua = a.m.uuid ?? "";
      const ub = b.m.uuid ?? "";
      const byUuid = sortDir === "asc" ? cmp(ua, ub) : cmp(ub, ua);
      if (byUuid !== 0) return byUuid;
      return sortDir === "asc" ? a.i - b.i : b.i - a.i;
    });
    return indexed.map((x) => x.m);
  }, [state.messages, sortDir]);

  if (state.loading) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Loading transcript…
      </div>
    );
  }

  if (!state.found || state.messages.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No transcript on disk for this session yet. Conversations are read from
        the Claude Code JSONL under <code className="font-mono">~/.claude</code>.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <SortToggle value={sortDir} onChange={setSortDir} />
      </div>
      {sorted.map((m, i) => (
        <MessageCard key={m.uuid ?? i} message={m} />
      ))}
    </div>
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function MessageCard({ message }: { message: TranscriptMessage }) {
  const meta = roleMeta(message.role);
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={
            "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium " +
            meta.badge
          }
        >
          {meta.label}
        </span>
        {message.ts && (
          <time className="font-mono text-xs text-muted-foreground">
            {formatTs(message.ts)}
          </time>
        )}
      </div>
      <div className="space-y-2">
        {message.blocks.map((b, i) => (
          <Block key={i} block={b} />
        ))}
      </div>
    </div>
  );
}

function Block({ block }: { block: TranscriptBlock }) {
  switch (block.type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap text-sm text-foreground">{block.text}</p>
      );
    case "thinking":
      return (
        <p className="whitespace-pre-wrap border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
          {block.text}
        </p>
      );
    case "tool_use":
      return (
        <div className="rounded-md border border-border bg-muted/50 p-2">
          <div className="mb-1 font-mono text-xs font-medium text-foreground">
            → {block.name}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {stringifyInput(block.input)}
          </pre>
        </div>
      );
    case "tool_result":
      return (
        <div
          className={
            "rounded-md border p-2 " +
            (block.isError
              ? "border-destructive/40 bg-destructive/10"
              : "border-border bg-muted/30")
          }
        >
          <div
            className={
              "mb-1 font-mono text-xs font-medium " +
              (block.isError ? "text-destructive" : "text-muted-foreground")
            }
          >
            {block.isError ? "✗ result" : "✓ result"}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {truncate(block.text)}
          </pre>
        </div>
      );
    default:
      return null;
  }
}

function roleMeta(role: TranscriptMessage["role"]): { label: string; badge: string } {
  switch (role) {
    case "user":
      return { label: "User", badge: "bg-primary/15 text-primary" };
    case "assistant":
      return { label: "Assistant", badge: "bg-muted text-foreground" };
    case "tool":
      return {
        label: "Tool result",
        badge: "bg-muted/60 text-muted-foreground",
      };
  }
}

function stringifyInput(input: unknown): string {
  try {
    const s = JSON.stringify(input, null, 2);
    return truncate(s ?? "");
  } catch {
    return String(input);
  }
}

const MAX = 4000;
function truncate(s: string): string {
  return s.length > MAX ? s.slice(0, MAX) + `\n… (${s.length - MAX} more chars)` : s;
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
