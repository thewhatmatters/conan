// Timeline tab — DESIGN MOCKUP with hardcoded sample data.
//
// The proposed angle: render the chronological log of (a) hook events already
// ingested at POST /api/claude/events, (b) skill firing — and crucially the
// skills the model *considered but didn't fire* (the most opaque thing about
// skills today: "why didn't automate-browser trigger for that?"), and (c) the
// build-loop event stream. This file is the static mockup so we can react to the
// layout before doing the backend capture for the "considered" path and the
// /api/claude/timeline route. None of this rows reflect real data yet.

import { X } from "lucide-react";

type Kind = "hook" | "skill-fired" | "skill-considered" | "loop";
interface Row {
  /** Wall-clock time, just the HH:MM:SS part for display. */
  time: string;
  kind: Kind;
  /** Short ALL-CAPS tag rendered as a pill on the left. */
  type: string;
  /** The main line. */
  title: string;
  /** Optional second line (muted). */
  detail?: string;
  /** Optional structured "skills considered" block, attached to a prompt row. */
  skills?: { name: string; fired: boolean; reason: string }[];
}

// One realistic-ish session worth of events, descending — what the timeline
// would look like for the user's last prompt to land here.
const SAMPLE: Row[] = [
  { time: "14:42:51", kind: "loop", type: "LOOP", title: "US-008 PASS · session header", detail: "iteration 8 · 4m 47s" },
  { time: "14:42:33", kind: "hook", type: "STOP", title: "turn ended", detail: "3.2k out · 4 tools · 1 skill fired" },
  { time: "14:42:30", kind: "hook", type: "POSTTOOL", title: "Write ok · ui/src/components/SessionHeader.tsx", detail: "118 lines" },
  { time: "14:42:27", kind: "hook", type: "PRETOOL", title: "Write · ui/src/components/SessionHeader.tsx" },
  { time: "14:42:18", kind: "hook", type: "POSTTOOL", title: "Read ok · ui/src/components/TerminalPane.tsx", detail: "1.2k tokens" },
  { time: "14:42:14", kind: "hook", type: "PRETOOL", title: "Read · ui/src/components/TerminalPane.tsx" },
  { time: "14:42:09", kind: "skill-fired", type: "SKILL", title: "automate-browser fired", detail: "verify in light + dark via screenshot" },
  {
    time: "14:42:02",
    kind: "hook",
    type: "PROMPT",
    title: "“Add a Claude-banner session header above the terminal”",
    detail: "1.4k in · model claude-opus-4-7[1m]",
    skills: [
      { name: "automate-browser", fired: true, reason: "UI keyword “render” + browser-verify criterion" },
      { name: "deep-research",     fired: false, reason: "no research intent (build task)" },
      { name: "generate-skill",    fired: false, reason: "no scaffold intent" },
      { name: "refine-skill",      fired: false, reason: "no skill name in prompt" },
      { name: "draw-diagram",      fired: false, reason: "no diagram intent" },
    ],
  },
  { time: "14:38:11", kind: "loop", type: "LOOP", title: "iteration 8 → US-008", detail: "next: “Fixed Claude-banner session header”" },
  { time: "14:38:09", kind: "hook", type: "STOP", title: "turn ended", detail: "1.1k out · marked US-007 passes:true" },
  { time: "14:38:05", kind: "hook", type: "POSTTOOL", title: "Bash ok · validate.py prd.json", detail: "11 stories, 0 errors" },
  { time: "14:38:02", kind: "hook", type: "PRETOOL", title: "Bash · python3 validate.py" },
  { time: "14:37:55", kind: "hook", type: "NOTIF", title: "iteration 7 completed", detail: "automate-browser verification ok · light + dark" },
  { time: "14:37:11", kind: "hook", type: "SESSION", title: "SessionStart", detail: "cwd ~/Development/conan · model opus-4-7[1m] · v2.1.153" },
];

/**
 * Map a row's kind onto the dot/badge color the rail + pill use. Semantic +
 * chart tokens only — so the timeline recolors with the theme.
 */
function kindColor(kind: Kind): { dot: string; pillBg: string; pillFg: string } {
  switch (kind) {
    case "skill-fired":
      return { dot: "bg-chart-1", pillBg: "bg-chart-1/15", pillFg: "text-chart-1" };
    case "skill-considered":
      return { dot: "bg-muted-foreground/40", pillBg: "bg-muted", pillFg: "text-muted-foreground" };
    case "loop":
      return { dot: "bg-chart-4", pillBg: "bg-chart-4/15", pillFg: "text-chart-4" };
    case "hook":
    default:
      return { dot: "bg-chart-2", pillBg: "bg-chart-2/15", pillFg: "text-chart-2" };
  }
}

function FilterChip({ label, active }: { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      disabled
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

export default function TimelineMock({
  terminalLabel,
  onClose,
}: {
  /** The label of the terminal tab this timeline is tethered to. */
  terminalLabel?: string;
  /** Close the split (called by the small × in the header). */
  onClose?: () => void;
}) {
  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      {/* Header: the tether is visual (this panel is glued to one terminal),
          so the title names the terminal it's bound to instead of needing a
          session picker. Filters stay; a small × closes the split. */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-sm font-medium text-foreground">
            Timeline
          </span>
          {terminalLabel && (
            <span className="truncate text-[11px] text-muted-foreground">
              · {terminalLabel}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <FilterChip label="All" active />
          <FilterChip label="Hooks" />
          <FilterChip label="Skills" />
          <FilterChip label="Loop" />
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

      {/* Scrollable timeline body — one row per event, descending. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <ul className="relative">
          {/* The left rail — a faint vertical line behind the dots. The dot
              column sits at px-4 (16) + w-16 (64) + gap-3 (12) + w-3/2 (6) =
              98px from the panel's left edge, so the rail centers there. */}
          <span
            aria-hidden
            className="absolute bottom-0 left-[98px] top-0 w-px bg-border"
          />
          {SAMPLE.map((row, i) => (
            <li
              key={i}
              className="group relative flex items-start gap-3 px-4 py-1.5 hover:bg-muted/40"
            >
              <span className="w-16 shrink-0 pt-1 text-right text-[11px] tabular-nums text-muted-foreground">
                {row.time}
              </span>
              <span className="relative flex w-3 shrink-0 justify-center pt-2">
                <span
                  className={
                    "size-2 shrink-0 translate-x-0.5 rounded-full ring-2 ring-card " +
                    kindColor(row.kind).dot
                  }
                />
              </span>
              <div className="min-w-0 flex-1 pb-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={
                      "inline-flex items-center rounded px-1.5 py-px text-[9px] font-semibold tracking-wider " +
                      kindColor(row.kind).pillBg +
                      " " +
                      kindColor(row.kind).pillFg
                    }
                  >
                    {row.type}
                  </span>
                  <span className="truncate text-[12px] text-foreground">
                    {row.title}
                  </span>
                </div>
                {row.detail && (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {row.detail}
                  </div>
                )}
                {row.skills && (
                  <div className="mt-1.5 rounded-md border border-border bg-background/40 p-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      Skills considered ({row.skills.length}) ·{" "}
                      <span className="text-chart-1">
                        fired {row.skills.filter((s) => s.fired).length}
                      </span>
                    </div>
                    <ul className="flex flex-col gap-0.5">
                      {row.skills.map((s) => (
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
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Honest footer — flagging that this is a mockup, not live data. */}
      <div className="shrink-0 border-t border-border bg-muted/30 px-4 py-1.5 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">Mockup</span> · sample data.
        Real wiring would source rows from <code>POST /api/claude/events</code>
        (hooks) + the build-loop trail (loop) + a new <em>skills-considered</em>
        capture in the hook handler (the genuinely new piece).
      </div>
    </div>
  );
}
