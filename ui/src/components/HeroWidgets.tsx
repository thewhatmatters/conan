import type { Session } from "../hooks/useSessions.ts";
import type { SkillsState } from "../hooks/useSkills.ts";
import StatCard from "./StatCard.tsx";

interface HeroWidgetsProps {
  sessions: Session[];
  /** The session the Context/Skills widgets describe (running > newest). */
  activeSession: Session | null;
  skills: SkillsState;
}

/**
 * The hero metrics widget row (US-010): a row of stat cards at the top of the
 * /claude main area — Context, Skills, Cost today, Active sessions. Fed by the
 * live session grid + skills endpoint, so it updates as WS events arrive.
 * Uses the two-tier StatCard pattern and semantic tokens only.
 */
export default function HeroWidgets({
  sessions,
  activeSession,
  skills,
}: HeroWidgetsProps) {
  // Context window: tokens in vs. the model's window, for the active session.
  const ctxTokens = activeSession?.context_tokens ?? null;
  const ctxWindow = contextWindowFor(activeSession?.model ?? null);
  const ctxPct =
    ctxTokens != null ? Math.min(100, (ctxTokens / ctxWindow) * 100) : null;

  // Cost today: aggregate total_cost_usd across sessions active today.
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const costToday = sessions
    .filter((s) => s.last_activity >= startOfToday)
    .reduce((sum, s) => sum + (s.total_cost_usd || 0), 0);

  // Active-sessions breakdown.
  const running = sessions.filter((s) => s.status === "running").length;
  const idle = sessions.filter((s) => s.status === "idle").length;
  const error = sessions.filter(
    (s) => s.status !== "running" && s.status !== "idle",
  ).length;

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Context" sub={activeSession ? "active session" : "no session"}>
        <div className="flex items-center gap-3">
          <Ring pct={ctxPct} />
          <div className="min-w-0">
            <div className="text-xl font-semibold text-foreground">
              {ctxPct != null ? `${Math.round(ctxPct)}%` : "—"}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {ctxTokens != null
                ? `${fmtTokens(ctxTokens)} / ${fmtTokens(ctxWindow)}`
                : "no usage yet"}
            </div>
          </div>
        </div>
      </StatCard>

      <StatCard label="Skills" sub="available · loaded">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-semibold text-foreground">
            {skills.available}
          </span>
          <span className="text-sm text-muted-foreground">
            · {skills.loaded != null ? skills.loaded : "—"} loaded
          </span>
        </div>
      </StatCard>

      <StatCard label="Cost today" sub="across sessions">
        <div className="text-xl font-semibold text-foreground">
          {costToday > 0 ? `$${costToday.toFixed(2)}` : "$0.00"}
        </div>
      </StatCard>

      <StatCard label="Active sessions" sub="running · idle · error">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold text-foreground">
            {sessions.length}
          </span>
          <span className="flex items-center gap-2 text-[11px]">
            <Pip className="bg-primary" n={running} />
            <Pip className="bg-muted-foreground/40" n={idle} />
            <Pip className="bg-destructive" n={error} />
          </span>
        </div>
      </StatCard>
    </section>
  );
}

/** A small SVG progress ring for the context gauge (semantic tokens only). */
function Ring({ pct }: { pct: number | null }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const filled = pct != null ? (pct / 100) * c : 0;
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" className="shrink-0">
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        strokeWidth="4"
        className="stroke-muted-foreground/20"
      />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c}`}
        transform="rotate(-90 18 18)"
        className={pct != null && pct >= 80 ? "stroke-destructive" : "stroke-primary"}
      />
    </svg>
  );
}

/** A colored count pip; rendered muted when its count is zero. */
function Pip({ className, n }: { className: string; n: number }) {
  return (
    <span className={"inline-flex items-center gap-1 " + (n ? "" : "opacity-40")}>
      <span className={"size-2 rounded-full " + className} />
      <span className="text-foreground">{n}</span>
    </span>
  );
}

/**
 * Best-effort context-window size for a model slug. Claude's default window is
 * 200k; the 1M-context variants carry a "1m"/"[1m]" marker in the slug.
 */
function contextWindowFor(model: string | null): number {
  if (model && /1m/i.test(model)) return 1_000_000;
  return 200_000;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}
