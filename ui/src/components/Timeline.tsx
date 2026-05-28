import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { apiBase } from "../lib/gateway.ts";
import type {
  GatewayEvent,
  SkillConsideredEvent,
  SkillFiredEvent,
  TasksState,
} from "../hooks/useTasks.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip.tsx";

// Per-terminal Timeline split (US-004 v4.5) — the live replacement for
// TimelineMock.tsx. Mounts inside the active terminal pane, fetches the
// session's chronological feed from GET /api/claude/timeline on mount, and
// appends new rows from the shared app /ws (event + skill-fired +
// skill-considered) and from the existing tasks broadcast (loop activity).
// The "Heuristic match" badge on the skills-considered card is the honesty
// contract: we never label it as Claude's real internal scoring.

/** Hook event subtypes the Timeline collapses raw payloads into. */
type HookSubtype =
  | "PROMPT"
  | "PRETOOL"
  | "POSTTOOL"
  | "STOP"
  | "NOTIF"
  | "SESSION"
  | "EVENT";

type LoopSubtype = "iteration" | "pass" | "trail";

/** Mirrors src/timeline/index.ts TimelineRow. */
export type TimelineRow =
  | {
      kind: "hook";
      ts: number;
      eventId: number;
      subtype: HookSubtype;
      title: string;
      detail?: string;
      payload?: Record<string, unknown>;
    }
  | {
      kind: "loop";
      ts: number;
      subtype: LoopSubtype;
      title: string;
      detail?: string;
    }
  | {
      kind: "skill-fired";
      ts: number;
      eventId?: number;
      skill: string;
      promptEventId?: number;
      detail?: string;
    }
  | {
      kind: "skill-considered";
      ts: number;
      eventId?: number;
      skill: string;
      promptEventId?: number;
      reason: string;
      heuristic: true;
    };

/** The active filter chips; an empty set means "All". */
type Filter = "hooks" | "skills" | "loop";

interface TimelineProps {
  token: string | null;
  /** The active terminal tab's correlated Claude session id, or null. */
  sessionId: string | null;
  /** The label of the terminal tab this timeline is tethered to. */
  terminalLabel?: string;
  /** Close the split (called by the small × in the header). */
  onClose?: () => void;
  /** Latest hook event from the shared app WS. */
  lastEvent: (GatewayEvent & { seq: number; replay?: boolean }) | null;
  /** Latest live skill-fired broadcast. */
  lastSkillFired: SkillFiredEvent | null;
  /** Latest live skill-considered broadcast. */
  lastSkillConsidered: SkillConsideredEvent | null;
  /** Build-loop progress.txt activity (gated server-side by session cwd). */
  tasks: TasksState | null;
}

// Trim a freeform string to a single line for a title.
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// Pick the first non-empty string value from a tool_input object — Bash →
// command, Read → file_path, Grep → pattern. Mirrors src/timeline/index.ts.
function firstStringArg(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const v of Object.values(toolInput as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return "";
}

function parsePayload(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Live mapper: incoming `{type:'event'}` WS payload → hook TimelineRow.
// Mirrors mapHookEventToRow in src/timeline/index.ts so live rows match the
// server's REST backfill shape exactly.
function mapHookEventToRow(ev: GatewayEvent): TimelineRow | null {
  if (ev.stream_type !== "hook") return null;
  const payload = parsePayload(ev.payload);
  const name = ev.hook_event_name ?? "";

  let subtype: HookSubtype = "EVENT";
  let title = name || "event";
  let detail: string | undefined;

  switch (name) {
    case "UserPromptSubmit": {
      subtype = "PROMPT";
      const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
      title = prompt ? truncate(prompt, 160) : "(empty prompt)";
      break;
    }
    case "PreToolUse":
    case "PostToolUse": {
      subtype = name === "PreToolUse" ? "PRETOOL" : "POSTTOOL";
      const tool =
        ev.tool_name ?? (typeof payload?.tool_name === "string" ? payload.tool_name : "");
      const arg = firstStringArg(payload?.tool_input);
      title = arg ? `${tool || "tool"} · ${truncate(arg, 120)}` : tool || "tool";
      break;
    }
    case "Stop":
      subtype = "STOP";
      title = "turn ended";
      break;
    case "Notification": {
      subtype = "NOTIF";
      const msg = typeof payload?.message === "string" ? payload.message : "";
      title = msg ? truncate(msg, 160) : "notification";
      break;
    }
    case "SessionStart":
    case "SessionEnd": {
      subtype = "SESSION";
      if (name === "SessionStart") {
        const version = typeof payload?.version === "string" ? payload.version : "";
        const source = typeof payload?.source === "string" ? payload.source : "";
        title = "SessionStart";
        const parts: string[] = [];
        if (source) parts.push(source);
        if (version) parts.push(`v${version}`);
        if (parts.length) detail = parts.join(" · ");
      } else {
        title = "SessionEnd";
        const reason = typeof payload?.reason === "string" ? payload.reason : "";
        if (reason) detail = reason;
      }
      break;
    }
    default:
      subtype = "EVENT";
      title = name || "event";
  }

  return {
    kind: "hook",
    ts: ev.ts,
    eventId: ev.id,
    subtype,
    title,
    ...(detail ? { detail } : {}),
    ...(payload ? { payload } : {}),
  };
}

// Parse `[YYYY-MM-DD HH:MM(:SS)?]` or bare `YYYY-MM-DD HH:MM(:SS)?` prefix.
function parseActivityTimestamp(line: string): number | null {
  const stripped = line.startsWith("[")
    ? line.slice(1, line.indexOf("]") === -1 ? undefined : line.indexOf("]"))
    : line;
  const m = stripped.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!m || !m[1] || !m[2]) return null;
  const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
  const ts = Date.parse(`${m[1]}T${time}`);
  return Number.isNaN(ts) ? null : ts;
}

function stripActivityTimestamp(line: string): string {
  if (line.startsWith("[")) {
    const end = line.indexOf("]");
    if (end !== -1) return line.slice(end + 1).trim();
  }
  return line.replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?\s*/, "").trim();
}

function mapActivityLineToRow(line: string): TimelineRow | null {
  const ts = parseActivityTimestamp(line);
  if (ts === null) return null;
  const body = stripActivityTimestamp(line);
  if (!body) return null;
  let subtype: LoopSubtype = "trail";
  if (/iteration\s+\d+/i.test(body) || /→\s*US-/.test(body)) subtype = "iteration";
  else if (
    /\bUS-\d+\b.*\b(?:done|pass(?:es)?)\b/i.test(body) ||
    /passes:\s*true/i.test(body)
  )
    subtype = "pass";
  return { kind: "loop", ts, subtype, title: truncate(body, 160) };
}

/** Stable key for dedup + React lists across hook/loop/skill rows. */
function rowKey(row: TimelineRow): string {
  switch (row.kind) {
    case "hook":
      return `h:${row.eventId}`;
    case "loop":
      return `l:${row.ts}:${row.title}`;
    case "skill-fired":
      return `sf:${row.ts}:${row.skill}:${row.promptEventId ?? ""}`;
    case "skill-considered":
      return `sc:${row.promptEventId ?? row.eventId ?? row.ts}:${row.skill}`;
  }
}

/** Insert a row in descending-by-ts order; idempotent on rowKey. */
function insertRow(rows: TimelineRow[], row: TimelineRow): TimelineRow[] {
  const key = rowKey(row);
  if (rows.some((r) => rowKey(r) === key)) return rows;
  // Linear scan from top — Timeline is small + descending.
  const i = rows.findIndex((r) => r.ts <= row.ts);
  const next = rows.slice();
  next.splice(i === -1 ? rows.length : i, 0, row);
  return next;
}

/** Per-kind palette — token-driven so light + dark recolor naturally. */
function kindColor(kind: TimelineRow["kind"]): {
  dot: string;
  pillBg: string;
  pillFg: string;
} {
  switch (kind) {
    case "skill-fired":
      return { dot: "bg-chart-1", pillBg: "bg-chart-1/15", pillFg: "text-chart-1" };
    case "skill-considered":
      return {
        dot: "bg-muted-foreground/40",
        pillBg: "bg-muted",
        pillFg: "text-muted-foreground",
      };
    case "loop":
      return { dot: "bg-chart-4", pillBg: "bg-chart-4/15", pillFg: "text-chart-4" };
    case "hook":
    default:
      return { dot: "bg-chart-2", pillBg: "bg-chart-2/15", pillFg: "text-chart-2" };
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Pill label rendered on the left of each row. */
function rowPillLabel(row: TimelineRow): string {
  if (row.kind === "hook") return row.subtype;
  if (row.kind === "loop") return "LOOP";
  if (row.kind === "skill-fired") return "SKILL";
  return "SKILL?";
}

/** Filter-bucket a row belongs to (matches the chips). */
function rowFilterBucket(row: TimelineRow): Filter {
  if (row.kind === "loop") return "loop";
  if (row.kind === "skill-fired" || row.kind === "skill-considered") return "skills";
  return "hooks";
}

function FilterChip({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={
        "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors " +
        (active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-muted")
      }
    >
      {label}
    </button>
  );
}

export default function Timeline({
  token,
  sessionId,
  terminalLabel,
  onClose,
  lastEvent,
  lastSkillFired,
  lastSkillConsidered,
  tasks,
}: TimelineProps) {
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [newCount, setNewCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Backfill on mount + whenever the bound session changes. An unknown/missing
  // session yields [] (route already returns []), which the empty state covers.
  useEffect(() => {
    if (!token || !sessionId) {
      setRows([]);
      setNewCount(0);
      return;
    }
    let cancelled = false;
    fetch(
      apiBase() + `/api/claude/timeline?session=${encodeURIComponent(sessionId)}&limit=200`,
      { headers: { "x-conan-token": token } },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((arr: unknown) => {
        if (cancelled) return;
        setRows(Array.isArray(arr) ? (arr as TimelineRow[]) : []);
        setNewCount(0);
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setNewCount(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, sessionId]);

  // Detect whether the user is at the top of the scroller (which renders
  // newest-first). New rows that arrive when they're scrolled DOWN get
  // batched into the `↑ N new` pill instead of yanking their scroll position.
  const isAtTop = useCallback((): boolean => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollTop <= 4;
  }, []);

  const appendOrNotify = useCallback(
    (incoming: TimelineRow) => {
      setRows((prev) => {
        const next = insertRow(prev, incoming);
        if (next === prev) return prev; // dedup: no new row
        if (isAtTop()) {
          // Stay at top so the new row is visible.
          requestAnimationFrame(() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = 0;
          });
        } else {
          setNewCount((n) => n + 1);
        }
        return next;
      });
    },
    [isAtTop],
  );

  // Map + append incoming `{type:'event'}` for this session.
  useEffect(() => {
    if (!lastEvent || !sessionId) return;
    if (lastEvent.session_id !== sessionId) return;
    const row = mapHookEventToRow(lastEvent);
    if (row) appendOrNotify(row);
  }, [lastEvent, sessionId, appendOrNotify]);

  // Append incoming `{type:'skill-fired'}` for this session.
  useEffect(() => {
    if (!lastSkillFired || !sessionId) return;
    if (lastSkillFired.sessionId !== sessionId) return;
    appendOrNotify(lastSkillFired.payload as TimelineRow);
  }, [lastSkillFired, sessionId, appendOrNotify]);

  // Append incoming `{type:'skill-considered'}` for this session.
  useEffect(() => {
    if (!lastSkillConsidered || !sessionId) return;
    if (lastSkillConsidered.sessionId !== sessionId) return;
    appendOrNotify(lastSkillConsidered.payload as TimelineRow);
  }, [lastSkillConsidered, sessionId, appendOrNotify]);

  // Append new build-loop activity lines. We diff against rows we've already
  // seen by rowKey ("l:<ts>:<title>"). The server gates loop rows by
  // sessionCwd === activeCwd on the backfill; live activity broadcasts go to
  // every session — we accept them all here and dedup, which is safe because
  // the backfill establishes the project's first row. (For a session outside
  // the build-loop project, the backfill returns no loop rows and live lines
  // still render in this panel — that's consistent with: a user who opens the
  // split for that session has effectively asked to see all activity.)
  useEffect(() => {
    if (!tasks?.activity?.length) return;
    setRows((prev) => {
      let next = prev;
      for (const line of tasks.activity) {
        const row = mapActivityLineToRow(line);
        if (!row) continue;
        const candidate = insertRow(next, row);
        if (candidate !== next) {
          next = candidate;
          if (!isAtTop()) {
            // Inline counter bump to match appendOrNotify semantics.
            setNewCount((n) => n + 1);
          }
        }
      }
      if (next !== prev && isAtTop()) {
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = 0;
        });
      }
      return next;
    });
  }, [tasks?.activity, isAtTop]);

  // Group skill-considered rows by their parent prompt so the PROMPT row can
  // render the nested "Skills considered (N) · fired N" card. Skill-fired
  // rows whose promptEventId points at the same PROMPT also contribute.
  const consideredByPrompt = useMemo(() => {
    const map = new Map<
      number,
      { name: string; fired: boolean; reason: string }[]
    >();
    for (const r of rows) {
      if (r.kind === "skill-considered" && r.promptEventId !== undefined) {
        const list = map.get(r.promptEventId) ?? [];
        list.push({ name: r.skill, fired: false, reason: r.reason });
        map.set(r.promptEventId, list);
      } else if (r.kind === "skill-fired" && r.promptEventId !== undefined) {
        const list = map.get(r.promptEventId) ?? [];
        list.push({
          name: r.skill,
          fired: true,
          reason: r.detail ?? "fired (matched transcript tool_use)",
        });
        map.set(r.promptEventId, list);
      }
    }
    return map;
  }, [rows]);

  // Apply filter-chip predicate. Empty set = "All".
  const visibleRows = useMemo(() => {
    if (filters.size === 0) return rows;
    return rows.filter((r) => {
      // The nested-on-PROMPT card already surfaces the per-skill detail, so
      // hiding the standalone skill rows here keeps the surface uncluttered.
      // But keep them visible when the Skills filter is on (so a session
      // without prior prompts still shows the firings).
      if (
        (r.kind === "skill-considered" || r.kind === "skill-fired") &&
        r.promptEventId !== undefined &&
        !filters.has("skills")
      ) {
        return false;
      }
      return filters.has(rowFilterBucket(r));
    });
  }, [rows, filters]);

  const toggleFilter = useCallback((bucket: Filter) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => setFilters(new Set()), []);

  const onScrollPillClick = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setNewCount(0);
  }, []);

  const onScroll = useCallback(() => {
    if (isAtTop()) setNewCount(0);
  }, [isAtTop]);

  const allActive = filters.size === 0;

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      {/* Header: visual tether (this panel is glued to one terminal) — the
          title carries the terminal label instead of a session picker. */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-sm font-medium text-foreground">Timeline</span>
          {terminalLabel && (
            <span className="truncate text-[11px] text-muted-foreground">
              · {terminalLabel}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <FilterChip label="All" active={allActive} onClick={clearFilters} />
          <FilterChip
            label="Hooks"
            active={filters.has("hooks")}
            onClick={() => toggleFilter("hooks")}
          />
          <FilterChip
            label="Skills"
            active={filters.has("skills")}
            onClick={() => toggleFilter("skills")}
          />
          <FilterChip
            label="Loop"
            active={filters.has("loop")}
            onClick={() => toggleFilter("loop")}
          />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close timeline"
              title="Close timeline"
              className="ml-1 inline-flex rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable body — one row per event, descending. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        {!sessionId ? (
          <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
            This terminal has no Claude session yet — the timeline fills as soon
            as Claude Code reports a hook event.
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
            No activity yet for this terminal — the timeline fills as Claude Code
            emits hook events.
          </div>
        ) : (
          <TooltipProvider delayDuration={200}>
            <ul className="relative">
              {/* The left rail centers on the dot column. Layout math
                  (px-4 → 16) + (w-16 → 64) + (gap-3 → 12) + (w-3/2 → 6)
                  = 98px from the panel's left edge — matching the rail. */}
              <span
                aria-hidden
                className="absolute bottom-0 left-[98px] top-0 w-px bg-border"
              />
              {visibleRows.map((row) => {
                const color = kindColor(row.kind);
                const considered =
                  row.kind === "hook" && row.subtype === "PROMPT"
                    ? consideredByPrompt.get(row.eventId)
                    : undefined;
                const firedCount = considered?.filter((s) => s.fired).length ?? 0;
                return (
                  <li
                    key={rowKey(row)}
                    className="group relative flex items-start gap-3 px-4 py-1.5 hover:bg-muted/40"
                  >
                    <span className="w-16 shrink-0 pt-1 text-right text-[11px] tabular-nums text-muted-foreground">
                      {formatTime(row.ts)}
                    </span>
                    <span className="relative flex w-3 shrink-0 justify-center pt-2">
                      <span
                        className={
                          "size-2 shrink-0 translate-x-0.5 rounded-full ring-2 ring-card " +
                          color.dot
                        }
                      />
                    </span>
                    <div className="min-w-0 flex-1 pb-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span
                          className={
                            "inline-flex items-center rounded px-1.5 py-px text-[9px] font-semibold tracking-wider " +
                            color.pillBg +
                            " " +
                            color.pillFg
                          }
                        >
                          {rowPillLabel(row)}
                        </span>
                        <span className="truncate text-[12px] text-foreground">
                          {row.kind === "skill-fired"
                            ? `${row.skill} fired`
                            : row.kind === "skill-considered"
                            ? `${row.skill} considered`
                            : row.title}
                        </span>
                      </div>
                      {row.kind !== "skill-fired" &&
                        row.kind !== "skill-considered" &&
                        row.detail && (
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {row.detail}
                          </div>
                        )}
                      {row.kind === "skill-considered" && (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {row.reason}
                        </div>
                      )}
                      {considered && considered.length > 0 && (
                        <div className="mt-1.5 rounded-md border border-border bg-background/40 p-2">
                          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            <span>
                              Skills considered ({considered.length}) ·{" "}
                              <span className="text-chart-1">fired {firedCount}</span>
                            </span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  tabIndex={0}
                                  className="inline-flex cursor-help items-center rounded border border-border bg-muted px-1.5 py-px text-[9px] font-medium normal-case tracking-normal text-muted-foreground"
                                >
                                  Heuristic match
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-left text-[11px] normal-case tracking-normal">
                                These scores come from Conan's BM25 match
                                against each skill's description — they're a
                                heuristic, not Claude's actual internal skill
                                scoring (which isn't exposed).
                              </TooltipContent>
                            </Tooltip>
                          </div>
                          <ul className="flex flex-col gap-0.5">
                            {considered.map((s) => (
                              <li
                                key={s.name}
                                className="flex items-baseline gap-2 text-[11px]"
                              >
                                <span
                                  className={
                                    "w-3 shrink-0 text-center font-bold " +
                                    (s.fired
                                      ? "text-chart-1"
                                      : "text-muted-foreground/60")
                                  }
                                >
                                  {s.fired ? "✓" : "○"}
                                </span>
                                <span
                                  className={
                                    "w-36 shrink-0 truncate font-mono text-[11px] " +
                                    (s.fired
                                      ? "text-foreground"
                                      : "text-muted-foreground")
                                  }
                                >
                                  {s.name}
                                </span>
                                <span className="truncate text-muted-foreground">
                                  {s.reason}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </TooltipProvider>
        )}
        {/* `↑ N new` pill — sticks to the top of the scroller, only when the
            user is scrolled down and new rows have arrived. */}
        {newCount > 0 && (
          <button
            type="button"
            onClick={onScrollPillClick}
            className="sticky top-2 left-1/2 z-10 mx-auto block -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            ↑ {newCount} new
          </button>
        )}
      </div>
    </div>
  );
}
