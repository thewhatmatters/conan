import { useCallback, useEffect, useState } from "react";

/** Cost-ceiling settings (mirrors the gateway BudgetSettings, US-023). */
export interface BudgetSettings {
  dailyCostCeilingUsd: number | null;
  perSessionCostCeilingUsd: number | null;
  throttleOverBudget: boolean;
}

export interface SessionOverage {
  id: string;
  title: string | null;
  model: string | null;
  cost: number;
}

/** Budget status from GET /api/claude/budget (US-023). */
export interface BudgetStatus {
  settings: BudgetSettings;
  costToday: number;
  dailyPct: number | null;
  dailyOver: boolean;
  perSessionOver: SessionOverage[];
  overBudget: boolean;
  now: number;
}

/** The fields a budget-settings save accepts (snake_case, as the route wants). */
export interface BudgetUpdate {
  daily_cost_ceiling_usd?: number | null;
  per_session_cost_ceiling_usd?: number | null;
  throttle_over_budget?: boolean;
}

/**
 * Loads the cost-ceiling status (US-023) and refetches whenever a Claude Code
 * event arrives over the app WS — so the daily/per-session figures and the
 * over-budget alert stay live as cost is folded onto sessions by the parser.
 * `save` PUTs new ceilings (token-gated) and refetches.
 */
export function useBudget(
  eventSeq: number | null,
  token: string | null,
): {
  status: BudgetStatus | null;
  refresh: () => void;
  save: (update: BudgetUpdate) => Promise<void>;
} {
  const [status, setStatus] = useState<BudgetStatus | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/claude/budget")
      .then((r) => r.json())
      .then((s) => setStatus(s as BudgetStatus))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, eventSeq]);

  const save = useCallback(
    async (update: BudgetUpdate) => {
      if (!token) return;
      await fetch("/api/claude/settings/budget", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-conan-token": token,
        },
        body: JSON.stringify(update),
      }).catch(() => {});
      refresh();
    },
    [token, refresh],
  );

  return { status, refresh, save };
}
