import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";
import conanIcon from "../assets/conan-icon.png";
import { apiBase } from "../lib/gateway.ts";
import { isIdleNotification } from "../lib/idleNotification.ts";
import type {
  GatewayEvent,
  PlanEvent,
  PlanItem,
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
import { fmtTokens } from "./Widgets.tsx";
import { useTier } from "../hooks/useTier.ts";
import { PREMIUM_PRICE } from "../lib/license.ts";
import { openCheckout } from "../lib/buy.ts";
import { SkillFiredLottie } from "./SkillFiredLottie.tsx";

/* ───── US-102: Free-tier gating constants ─────────────────────────────────
 * The Free tier sees:
 *   - The latest 50 rows of basic hook event types only
 *     (PROMPT, PRETOOL, POSTTOOL, STOP, NOTIF, SESSION; no token chips,
 *      no click-to-expand POSTTOOL payloads, no Skills/Plan/Loop/Build rows).
 *   - Rows beyond the 50th are blurred behind a sticky "Upgrade" overlay.
 * Premium reveals SKILL/SKILL?/PLAN/LOOP/BUILD rows, unlimited rows, token
 * chips on STOP, click-to-expand POSTTOOL payloads, and Plan/Loop/Build
 * filter chips. See docs/v4.7-licensing-design.md §12 for the full matrix.
 */
const FREE_VISIBLE_LIMIT = 50;
/** A free-tier placeholder slot for a Premium-only row, kept in its original
 *  position so the chronology stays honest — every entry shows up, but the
 *  Premium ones are masked as "[Premium]". */
type FreeStubRow = {
  kind: "free-stub";
  ts: number;
  /** Original row's pill label (e.g. "SKILL", "PLAN"), used in the masked
   *  surface text — "[Premium] · SKILL". */
  origPill: string;
  /** Stable key derived from the masked row so React reuses the same DOM
   *  node across re-renders. */
  origKey: string;
};

/* The paywall "Upgrade" button opens the Polar checkout directly (see
 * `openCheckout` in lib/buy.ts) — a user who hits the wall has already decided
 * to pay, so the old bounce-to-Settings hop was pure funnel friction. The
 * License tab remains the post-purchase JWT paste/redemption surface. */

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

/** progress.txt activity subtypes — the `run-tasks.sh` runner trail. Renamed
 *  from LoopSubtype (v4.5-timeline) to disambiguate from Claude Code's own
 *  `/loop` skill, which now owns the Loop kind below. */
type BuildSubtype = "iteration" | "pass" | "trail";
/** Claude Code's `/loop` skill — invocation prompts + the ScheduleWakeup /
 *  CronCreate calls it uses to self-pace. */
type LoopSubtype = "invocation" | "schedule";

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
      /** Per-turn token total — only on STOP rows when the transcript JSONL
       *  surfaced a matching assistant `usage` block. Rendered as a "+12k"
       *  badge on the row's right edge. */
      tokens?: number;
    }
  | {
      kind: "build";
      ts: number;
      subtype: BuildSubtype;
      title: string;
      detail?: string;
    }
  | {
      kind: "loop";
      ts: number;
      eventId?: number;
      subtype: LoopSubtype;
      title: string;
      detail?: string;
      payload?: Record<string, unknown>;
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
    }
  | {
      kind: "plan";
      ts: number;
      subtype: "todo-write" | "plan-mode";
      eventId?: number;
      promptEventId?: number;
      /** TodoWrite items; present only when subtype === 'todo-write'. */
      items?: PlanItem[];
      /** ExitPlanMode plan text; present only when subtype === 'plan-mode'. */
      plan?: string;
    };

/** The active filter chips; an empty set means "All". */
type Filter = "hooks" | "skills" | "plan" | "loop" | "build";

interface TimelineProps {
  token: string | null;
  /** The active terminal tab's correlated Claude session id, or null. */
  sessionId: string | null;
  /** The label of the terminal tab this timeline is tethered to. */
  terminalLabel?: string;
  /** Latest hook event from the shared app WS. */
  lastEvent: (GatewayEvent & { seq: number; replay?: boolean }) | null;
  /** Latest live skill-fired broadcast. */
  lastSkillFired: SkillFiredEvent | null;
  /** Latest live skill-considered broadcast. */
  lastSkillConsidered: SkillConsideredEvent | null;
  /** Latest live plan broadcast (TodoWrite / ExitPlanMode). */
  lastPlan: PlanEvent | null;
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
      const msg = typeof payload?.message === "string" ? payload.message : "";
      // Idle "waiting for your input" nudges get no NOTIF row (US-005) —
      // mirrors the same filter in the server backfill (src/timeline/index.ts).
      if (isIdleNotification(msg)) return null;
      subtype = "NOTIF";
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
    // Carry per-turn tokens through on Stop events so the live-append path
    // shows the +Nk badge identically to the REST backfill (the gateway
    // enriches Stop broadcasts with `tokens` from the JSONL usage block).
    ...(subtype === "STOP" && typeof ev.tokens === "number"
      ? { tokens: ev.tokens }
      : {}),
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
  let subtype: BuildSubtype = "trail";
  if (/iteration\s+\d+/i.test(body) || /→\s*US-/.test(body)) subtype = "iteration";
  else if (
    /\bUS-\d+\b.*\b(?:done|pass(?:es)?)\b/i.test(body) ||
    /passes:\s*true/i.test(body)
  )
    subtype = "pass";
  return { kind: "build", ts, subtype, title: truncate(body, 160) };
}

/** Stable key for dedup + React lists across hook/loop/skill/plan rows. */
function rowKey(row: TimelineRow): string {
  switch (row.kind) {
    case "hook":
      return `h:${row.eventId}`;
    case "build":
      return `b:${row.ts}:${row.title}`;
    case "loop":
      return `l:${row.eventId ?? row.ts}:${row.subtype}`;
    case "skill-fired":
      return `sf:${row.ts}:${row.skill}:${row.promptEventId ?? ""}`;
    case "skill-considered":
      return `sc:${row.promptEventId ?? row.eventId ?? row.ts}:${row.skill}`;
    case "plan":
      return `p:${row.ts}:${row.subtype}:${row.promptEventId ?? row.eventId ?? ""}`;
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
      // Solid color — alpha-based dim (`/40`) let the rail line show through
      // the dot's center, which made the dim row visually look like the dot
      // was missing. Full-opacity muted-foreground reads as "considered, not
      // fired" without breaking the visual line.
      return {
        dot: "bg-muted-foreground",
        pillBg: "bg-muted",
        pillFg: "text-muted-foreground",
      };
    case "build":
      // The runner trail keeps the chart-4 violet it always had — visual
      // continuity for users who knew it as "Loop" before the rename.
      return { dot: "bg-chart-4", pillBg: "bg-chart-4/15", pillFg: "text-chart-4" };
    case "loop":
      // Claude Code's `/loop` skill — distinct color so it never visually
      // collides with build-trail rows on the same surface.
      return { dot: "bg-chart-3", pillBg: "bg-chart-3/15", pillFg: "text-chart-3" };
    case "plan":
      return { dot: "bg-chart-5", pillBg: "bg-chart-5/15", pillFg: "text-chart-5" };
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
  if (row.kind === "build") return "BUILD";
  if (row.kind === "loop") return "LOOP";
  if (row.kind === "plan") return "PLAN";
  if (row.kind === "skill-fired") return "SKILL";
  return "SKILL?";
}

/** Filter-bucket a row belongs to (matches the chips). */
function rowFilterBucket(row: TimelineRow): Filter {
  if (row.kind === "build") return "build";
  if (row.kind === "loop") return "loop";
  if (row.kind === "plan") return "plan";
  if (row.kind === "skill-fired" || row.kind === "skill-considered") return "skills";
  return "hooks";
}

/** Count completed items in a TodoWrite list (for the row title). */
function countTodos(items: PlanItem[] | undefined): { total: number; done: number } {
  if (!items?.length) return { total: 0, done: 0 };
  let done = 0;
  for (const it of items) if (it.status === "completed") done++;
  return { total: items.length, done };
}

/** Title shown next to the PLAN pill — collapsed view. */
function planRowTitle(row: TimelineRow & { kind: "plan" }): string {
  if (row.subtype === "todo-write") {
    const { total, done } = countTodos(row.items);
    return `${total} todo${total === 1 ? "" : "s"} · ${done} done`;
  }
  return "Entered plan mode";
}

/** Status icon for one TodoWrite item — never fabricated. */
function todoBadge(status: PlanItem["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "◐";
  return "○";
}

function todoBadgeColor(status: PlanItem["status"]): string {
  if (status === "completed") return "text-chart-1";
  if (status === "in_progress") return "text-chart-3";
  return "text-muted-foreground/60";
}

/**
 * Render one Timeline row. Pulled out of the inline `.map` (where it lived
 * before US-102) so the same renderer powers both the unlocked top-of-list
 * and the blurred Free-tier tail.
 *
 * `consideredByPrompt` is the grouped skills-considered map; passed in
 * rather than recomputed per row.
 *
 * `isFree` gates the Premium-only bits inside an otherwise-visible row:
 *   - STOP rows hide their +tokens chip
 *   - PROMPT rows hide their nested "Skills considered" card
 * The Premium-only row kinds (SKILL / SKILL? / PLAN / LOOP / BUILD) are
 * already swapped for `free-stub` placeholders upstream, so they hit the
 * `free-stub` branch here.
 */
function renderTimelineRow(
  row: TimelineRow | FreeStubRow,
  opts: {
    consideredByPrompt: Map<
      number,
      { name: string; fired: boolean; reason: string }[]
    >;
    isFree: boolean;
    /** Row keys that came from the initial backfill — these are historical,
     *  so the skill-fired lottie skips its play and renders the static glyph.
     *  Anything not in here is treated as a live arrival → animates once. */
    historicalKeys: Set<string>;
  },
) {
  // US-102 Free-tier placeholder: muted dot, muted "[Premium]" pill, blank
  // detail row. No interactive affordance — the upgrade CTA lives in the
  // sticky overlay at the bottom (and in Settings ▸ License).
  if (row.kind === "free-stub") {
    return (
      <li
        key={row.origKey}
        className="group relative flex flex-col px-4 py-1.5"
      >
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/60">
            {formatTime(row.ts)}
          </span>
          <span className="relative flex w-3 shrink-0 justify-center">
            <span className="size-2 shrink-0 translate-x-px rounded-full bg-muted-foreground/30 ring-2 ring-card" />
          </span>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="inline-flex items-center rounded bg-muted px-1.5 py-px text-[9px] font-semibold tracking-wider text-muted-foreground/70">
              {row.origPill}
            </span>
            <span className="inline-flex items-center gap-1 truncate text-[12px] text-muted-foreground/70">
              <Lock className="size-3" />
              Premium
            </span>
          </div>
        </div>
      </li>
    );
  }

  const color = kindColor(row.kind);
  const considered =
    row.kind === "hook" && row.subtype === "PROMPT"
      ? opts.consideredByPrompt.get(row.eventId)
      : undefined;
  const firedCount = considered?.filter((s) => s.fired).length ?? 0;
  return (
    <li
      key={rowKey(row)}
      className="group relative flex flex-col px-4 py-1.5 hover:bg-muted/40"
    >
      {/* Title sub-row — `items-center` does the alignment work the row
          template used to fake with hand-tuned paddings. Time, dot, and
          the pill+title flex are all vertically centered. Detail/reason/
          plan sub-rows are siblings inside the flex-col li, indented
          (`pl-[100px]`) to land under the content column. */}
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
          {formatTime(row.ts)}
        </span>
        {row.kind === "skill-fired" ? (
          <SkillFiredLottie
            animate={!opts.historicalKeys.has(rowKey(row))}
          />
        ) : (
          <span className="relative flex w-3 shrink-0 justify-center">
            <span
              className={
                "size-2 shrink-0 translate-x-px rounded-full ring-2 ring-card " +
                color.dot
              }
            />
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
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
              : row.kind === "plan"
              ? planRowTitle(row)
              : row.title}
          </span>
          {/* Per-turn token-burn badge (STOP rows only). Pinned to the
              row's right edge so it reads like a column, tooltip explains
              what the number sums. Hidden for Free (US-102) — the
              token-cost story is Premium. */}
          {!opts.isFree &&
            row.kind === "hook" &&
            row.subtype === "STOP" &&
            row.tokens != null && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-auto shrink-0 cursor-help tabular-nums text-[10px] text-muted-foreground">
                    +{fmtTokens(row.tokens)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">
                  Turn total: input + cache + output
                </TooltipContent>
              </Tooltip>
            )}
        </div>
      </div>
      {(row.kind === "hook" ||
        row.kind === "build" ||
        row.kind === "loop") &&
        row.detail && (
          <div className="mt-0.5 truncate pl-[100px] text-[11px] text-muted-foreground">
            {row.detail}
          </div>
        )}
      {row.kind === "skill-considered" && (
        <div className="mt-0.5 truncate pl-[100px] text-[11px] text-muted-foreground">
          {row.reason}
        </div>
      )}
      {row.kind === "plan" &&
        row.subtype === "todo-write" &&
        row.items &&
        row.items.length > 0 && (
          <div className="ml-[100px] mt-1.5 rounded-md border border-border bg-background/40 p-2">
            <ul className="flex flex-col gap-0.5">
              {row.items.map((it, i) => (
                <li
                  key={i}
                  className="flex items-baseline gap-2 text-[11px]"
                >
                  <span
                    className={
                      "w-3 shrink-0 text-center font-bold " +
                      todoBadgeColor(it.status)
                    }
                  >
                    {todoBadge(it.status)}
                  </span>
                  <span
                    className={
                      "truncate " +
                      (it.status === "completed"
                        ? "text-muted-foreground line-through"
                        : it.status === "in_progress"
                        ? "font-medium text-foreground"
                        : "text-foreground")
                    }
                  >
                    {it.status === "in_progress" && it.activeForm
                      ? it.activeForm
                      : it.content}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      {row.kind === "plan" &&
        row.subtype === "plan-mode" &&
        row.plan && (
          <div className="ml-[100px] mt-1.5 rounded-md border border-border bg-background/40 p-2">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
              {row.plan}
            </pre>
          </div>
        )}
      {/* Nested "Skills considered" card under PROMPT — Premium-only (the
          BM25 heuristic is exactly the kind of insight Free doesn't see). */}
      {!opts.isFree && considered && considered.length > 0 && (
        <div className="ml-[100px] mt-1.5 rounded-md border border-border bg-background/40 p-2">
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
                These scores come from Conan's BM25 match against each
                skill's description — they're a heuristic, not Claude's
                actual internal skill scoring (which isn't exposed).
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
                    (s.fired ? "text-chart-1" : "text-muted-foreground/60")
                  }
                >
                  {s.fired ? "✓" : "○"}
                </span>
                <span
                  className={
                    "w-36 shrink-0 truncate font-mono text-[11px] " +
                    (s.fired ? "text-foreground" : "text-muted-foreground")
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
    </li>
  );
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
  lastEvent,
  lastSkillFired,
  lastSkillConsidered,
  lastPlan,
  tasks,
}: TimelineProps) {
  const tier = useTier();
  const isFree = tier.tier === "free";
  const [rows, setRows] = useState<TimelineRow[]>([]);
  // Row keys that came from the initial backfill — used to tell SkillFiredLottie
  // not to animate historical rows on the first render. Populated atomically
  // with each setRows from the backfill effect; appendOrNotify deliberately
  // does NOT add to this set, so live arrivals always animate once.
  const historicalKeysRef = useRef<Set<string>>(new Set());
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [newCount, setNewCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // US-102: ref on the blurred section + a visibility flag driven by an
  // IntersectionObserver. When any blurred row enters the scroll viewport,
  // we light up an absolute-positioned upgrade card outside the scroller so
  // it sits at vertical center of the panel regardless of scroll depth.
  const blurSectionRef = useRef<HTMLDivElement>(null);
  const [blurInView, setBlurInView] = useState(false);
  // Fade-edge indicators — true when there's clipped content above/below the
  // visible viewport. Updated on scroll, content-change, and panel resize so a
  // freshly-shrunk panel surfaces the fades without needing a user scroll.
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setCanScrollUp(false);
      setCanScrollDown(false);
      return;
    }
    setCanScrollUp(el.scrollTop > 1);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  // Time tick — bumps every 15s so the Build-aging filter below re-runs and
  // stale Build rows / the Build chip drop out without needing a server poll.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  // Build rows are "actively running"-only: a row is dropped once its parsed
  // ts is older than 30 min (mirrors BUILD_ACTIVE_WINDOW_MS in
  // src/timeline/index.ts — update both in lockstep). A stale trail from a
  // past run ages out of the open panel; the server-side gate already keeps
  // it out of the initial fetch too. 30 min covers a typical run-tasks.sh
  // story iteration (progress.txt is written once per iteration).
  const freshRows = useMemo(() => {
    const buildCutoff = now - 1_800_000;
    return rows.filter((r) => r.kind !== "build" || r.ts > buildCutoff);
  }, [rows, now]);

  // Backfill on mount + whenever the bound session changes. An unknown/missing
  // session yields [] (route already returns []), which the empty state covers.
  useEffect(() => {
    if (!token || !sessionId) {
      historicalKeysRef.current = new Set();
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
        const backfilled = Array.isArray(arr) ? (arr as TimelineRow[]) : [];
        // Snapshot every backfilled key into the historical set BEFORE we
        // setRows — render runs with the correct set on the first pass, so
        // no historical skill-fired row plays its lottie on initial mount.
        historicalKeysRef.current = new Set(backfilled.map(rowKey));
        setRows(backfilled);
        setNewCount(0);
      })
      .catch(() => {
        if (!cancelled) {
          historicalKeysRef.current = new Set();
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

  // Append incoming `{type:'plan'}` (TodoWrite / ExitPlanMode) for this session.
  // The Plan HUD tab was removed in US-007 — these PLAN rows are now the
  // session's sole planning surface, scoped to its terminal tab.
  useEffect(() => {
    if (!lastPlan || !sessionId) return;
    if (lastPlan.sessionId !== sessionId) return;
    appendOrNotify(lastPlan.payload as TimelineRow);
  }, [lastPlan, sessionId, appendOrNotify]);

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

  // Apply filter-chip predicate on top of the fresh (aged-out) set. Empty set = "All".
  const visibleRows = useMemo(() => {
    if (filters.size === 0) return freshRows;
    return freshRows.filter((r) => {
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
  }, [freshRows, filters]);

  /* US-102: For Free, swap Premium-only rows (SKILL fired, SKILL? considered,
   * PLAN, LOOP, BUILD) with masked stubs in their original position. The
   * chronology stays honest — every entry shows up — but the Premium ones
   * read as "[Premium] · KIND" placeholders that nudge upgrade.  */
  const renderRows = useMemo<(TimelineRow | FreeStubRow)[]>(() => {
    if (!isFree) return visibleRows;
    return visibleRows.map<TimelineRow | FreeStubRow>((r) => {
      if (
        r.kind === "skill-fired" ||
        r.kind === "skill-considered" ||
        r.kind === "plan" ||
        r.kind === "loop" ||
        r.kind === "build"
      ) {
        return {
          kind: "free-stub",
          ts: r.ts,
          origPill: rowPillLabel(r),
          origKey: rowKey(r),
        };
      }
      return r;
    });
  }, [visibleRows, isFree]);
  /* Hard-wall gate: once the Free user crosses FREE_VISIBLE_LIMIT total rows,
   * the ENTIRE timeline blurs and the upgrade card centers over it. Below the
   * threshold, everything renders crisp (no partial peek). This is a stronger
   * conversion signal than the earlier "latest 50 crisp + tail blurred" split:
   * the user watches their session fill up and the moment row 51 lands, the
   * panel locks. Live observability lives in Context/Usage/Radio (never
   * gated); Timeline is the depth-of-insight pitch. */
  const overFreeLimit = isFree && renderRows.length > FREE_VISIBLE_LIMIT;
  const freeUnlockedRows = overFreeLimit ? [] : renderRows;
  const freeBlurredRows = overFreeLimit ? renderRows : [];

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
    updateFades();
  }, [isAtTop, updateFades]);

  // Recompute fades on content size change (rows appending, filter switching)
  // and on panel resize (the per-tab Timeline split divider). One ResizeObserver
  // on the scroll container catches both — no scroll event fires for either.
  useEffect(() => {
    updateFades();
  }, [rows, filters, updateFades]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateFades);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFades]);

  // US-102: pin the upgrade card to the panel's vertical center whenever any
  // blurred row is visible in the scroll viewport. We watch the blurred ul's
  // intersection with the scroll container — when it pokes in (or fills it),
  // `blurInView` flips true and the absolute overlay below the scroller
  // renders. Sticky-inside-scroller didn't work because once the user scrolled
  // past the END of the blurred mass the sticky element popped back to its
  // natural bottom position; an outside-the-scroller overlay always centers.
  useEffect(() => {
    if (!isFree || freeBlurredRows.length === 0) {
      setBlurInView(false);
      return;
    }
    const target = blurSectionRef.current;
    const root = scrollRef.current;
    if (!target || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setBlurInView(entry?.isIntersecting ?? false);
      },
      { root, threshold: 0 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [isFree, freeBlurredRows.length]);

  const allActive = filters.size === 0;
  // Filter chips are dynamic: a chip only renders when this session has at
  // least one row of that kind in the *fresh* set. So Build vanishes when its
  // rows age out; Loop only appears when the user has invoked /loop.
  const bucketCounts = useMemo(() => {
    const c: Record<Filter, number> = {
      hooks: 0,
      skills: 0,
      plan: 0,
      loop: 0,
      build: 0,
    };
    for (const r of freshRows) c[rowFilterBucket(r)]++;
    return c;
  }, [freshRows]);

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      {/* Header: visual tether (this panel is glued to one terminal) — the
          title carries the terminal label instead of a session picker. */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
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
          {bucketCounts.hooks > 0 && (
            <FilterChip
              label="Hooks"
              active={filters.has("hooks")}
              onClick={() => toggleFilter("hooks")}
            />
          )}
          {/* US-102: Skills / Plan / Loop / Build chips are Premium. Free sees
              only the Hooks chip — the other event kinds are masked into
              "[Premium]" stubs below, with no filter affordance. */}
          {!isFree && bucketCounts.skills > 0 && (
            <FilterChip
              label="Skills"
              active={filters.has("skills")}
              onClick={() => toggleFilter("skills")}
            />
          )}
          {!isFree && bucketCounts.plan > 0 && (
            <FilterChip
              label="Plan"
              active={filters.has("plan")}
              onClick={() => toggleFilter("plan")}
            />
          )}
          {!isFree && bucketCounts.loop > 0 && (
            <FilterChip
              label="Loop"
              active={filters.has("loop")}
              onClick={() => toggleFilter("loop")}
            />
          )}
          {!isFree && bucketCounts.build > 0 && (
            <FilterChip
              label="Build"
              active={filters.has("build")}
              onClick={() => toggleFilter("build")}
            />
          )}
        </div>
      </div>

      {/* Scrollable body — one row per event, descending. Wrapped in a
          relative shell so the fade-edge overlays sit on top of the scroller
          (not inside it, where they'd scroll with the content). */}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-auto"
      >
        {!sessionId ? (
          <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
            This terminal has no Claude session yet — the timeline fills as soon
            as Claude Code reports a hook event.
          </div>
        ) : renderRows.length === 0 ? (
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
              {freeUnlockedRows.map((row) => renderTimelineRow(row, {
                consideredByPrompt,
                isFree,
                historicalKeys: historicalKeysRef.current,
              }))}
            </ul>
            {/* US-102: The blurred tail — kept inside the same scroller so the
                user can feel "there's more" while scrolling past the latest 50.
                The upgrade gate itself lives OUTSIDE the scroller (rendered
                below as an absolute overlay) so it stays vertically centered
                in the panel regardless of scroll position. */}
            {isFree && freeBlurredRows.length > 0 && (
              <div ref={blurSectionRef} className="relative">
                <ul
                  aria-hidden
                  className="pointer-events-none relative select-none opacity-70 [filter:blur(7px)]"
                >
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-[98px] top-0 w-px bg-border"
                  />
                  {freeBlurredRows.map((row) =>
                    renderTimelineRow(row, { consideredByPrompt, isFree, historicalKeys: historicalKeysRef.current }),
                  )}
                </ul>
              </div>
            )}
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
      {/* Edge fades — sit on top of the scroller (not inside it) so the
          gradient itself doesn't scroll. `pointer-events-none` so hover/scroll
          still hit the rows underneath. Opacity-transitioned so the first
          rows hide/unhide smoothly when the panel resizes or content grows. */}
      <div
        aria-hidden
        className={
          "pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-card to-transparent transition-opacity duration-200 " +
          (canScrollUp ? "opacity-100" : "opacity-0")
        }
      />
      <div
        aria-hidden
        className={
          "pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent transition-opacity duration-200 " +
          (canScrollDown ? "opacity-100" : "opacity-0")
        }
      />
      {/* US-102: Upgrade gate — absolute over the panel viewport, vertically
          centered. Fades in when any blurred row enters the scroller's
          intersection (driven by the IntersectionObserver above). Sits OUTSIDE
          the scroller so the user's scroll position can't carry it off the
          natural sticky bound. `pointer-events-none` on the wrapper so users
          can keep scrolling the blurred mass behind it; `pointer-events-auto`
          on the card itself keeps the Upgrade button clickable. */}
      <div
        aria-hidden={!blurInView}
        className={
          "pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4 transition-opacity duration-200 " +
          (blurInView ? "opacity-100" : "opacity-0")
        }
      >
        <div className="pointer-events-auto flex max-w-xs flex-col items-center gap-3 rounded-xl border border-border bg-card/95 px-6 py-5 text-center shadow-xl backdrop-blur-md">
          {/* Conan icon + lock badge — the locked product, not a generic gate. */}
          <div className="relative">
            <img
              src={conanIcon}
              alt="Conan"
              className="size-10 rounded-md"
            />
            <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-border bg-card shadow-sm">
              <Lock className="size-3 text-muted-foreground" />
            </span>
          </div>
          {/* Headline + sub paired tightly so they read as one block. */}
          <div className="flex flex-col items-center gap-0.5">
            <div className="text-[13px] font-semibold leading-tight text-foreground">
              Unlock the full Timeline
            </div>
            <div className="text-[11px] leading-tight text-muted-foreground">
              Conan Premium · {PREMIUM_PRICE} · lifetime
            </div>
          </div>
          <button
            type="button"
            onClick={() => void openCheckout()}
            className="rounded-md bg-primary px-4 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Upgrade
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
