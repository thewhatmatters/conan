// US-023: cost ceiling + budget guard for always-on usage. Evaluates the
// configured per-day and per-session cost ceilings (src/settings) against the
// cost actually recorded on the session table (total_cost_usd, folded in by the
// stream-json parser, US-007). Feeds the UI alert/widget and the launch
// throttle that can block new sessions when over the daily budget.
import { getDb } from "../db/index.js";
import { readBudgetSettings, type BudgetSettings } from "../settings/index.js";

/** A session that has crossed the per-session ceiling. */
export interface SessionOverage {
  id: string;
  title: string | null;
  model: string | null;
  cost: number;
}

export interface BudgetStatus {
  settings: BudgetSettings;
  /** Aggregate cost across sessions active today (USD). */
  costToday: number;
  /** costToday / dailyCeiling as a percent, or null when no daily ceiling set. */
  dailyPct: number | null;
  /** True when a daily ceiling is set and costToday meets/exceeds it. */
  dailyOver: boolean;
  /** Sessions whose total_cost_usd meets/exceeds the per-session ceiling. */
  perSessionOver: SessionOverage[];
  /** True when any configured ceiling has been crossed — drives the UI alert. */
  overBudget: boolean;
  /** Server clock at evaluation time (epoch ms). */
  now: number;
}

interface CostRow {
  id: string;
  title: string | null;
  model: string | null;
  total_cost_usd: number;
  last_activity: number;
}

/** Start of the local day in epoch ms — the window for the daily ceiling. */
function startOfToday(): number {
  return new Date().setHours(0, 0, 0, 0);
}

/**
 * Evaluate the configured cost ceilings against recorded session cost. "Today"
 * mirrors the hero Cost-today widget (US-010): sessions whose last_activity
 * falls on the current day, summed by total_cost_usd.
 */
export function budgetStatus(): BudgetStatus {
  const settings = readBudgetSettings();
  const now = Date.now();
  const today = startOfToday();

  const rows = getDb()
    .prepare(
      `SELECT id, title, model, total_cost_usd, last_activity
         FROM session`,
    )
    .all() as CostRow[];

  const costToday = rows
    .filter((r) => r.last_activity >= today)
    .reduce((sum, r) => sum + (r.total_cost_usd || 0), 0);

  const dailyCeiling = settings.dailyCostCeilingUsd;
  const dailyPct =
    dailyCeiling && dailyCeiling > 0 ? (costToday / dailyCeiling) * 100 : null;
  const dailyOver = dailyCeiling != null && costToday >= dailyCeiling;

  const perCeiling = settings.perSessionCostCeilingUsd;
  const perSessionOver: SessionOverage[] =
    perCeiling != null
      ? rows
          .filter((r) => (r.total_cost_usd || 0) >= perCeiling)
          .map((r) => ({
            id: r.id,
            title: r.title,
            model: r.model,
            cost: r.total_cost_usd || 0,
          }))
          .sort((a, b) => b.cost - a.cost)
      : [];

  return {
    settings,
    costToday,
    dailyPct,
    dailyOver,
    perSessionOver,
    overBudget: dailyOver || perSessionOver.length > 0,
    now,
  };
}

export interface LaunchGate {
  allowed: boolean;
  /** Human-readable reason when blocked (surfaced to the caller / UI). */
  reason?: string;
}

/**
 * The throttling cap (acceptance criterion 3): when throttleOverBudget is on and
 * the daily ceiling has been crossed, block launching a new session. Disabled by
 * default, so this is a no-op unless the operator opts in.
 */
export function canLaunchSession(): LaunchGate {
  const status = budgetStatus();
  if (status.settings.throttleOverBudget && status.dailyOver) {
    const ceiling = status.settings.dailyCostCeilingUsd;
    return {
      allowed: false,
      reason: `Daily cost ceiling reached ($${status.costToday.toFixed(2)} of $${ceiling?.toFixed(2)}). New sessions are throttled until the ceiling is raised or the day rolls over.`,
    };
  }
  return { allowed: true };
}
