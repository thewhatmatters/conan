import { useEffect, useState } from "react";
import type { BudgetStatus, BudgetUpdate } from "../hooks/useBudget.ts";

interface BudgetPanelProps {
  status: BudgetStatus | null;
  /** PUT new ceilings (token-gated); resolves after the refetch. */
  onSave: (update: BudgetUpdate) => Promise<void>;
}

/**
 * Cost-ceiling panel (US-023). Shows today's aggregate spend against the daily
 * ceiling, flags any per-session overage, and turns into a destructive alert
 * banner when over budget. An inline editor sets the per-day / per-session
 * ceilings and the optional launch-throttle. Semantic tokens only.
 */
export default function BudgetPanel({ status, onSave }: BudgetPanelProps) {
  const [editing, setEditing] = useState(false);

  const over = status?.overBudget ?? false;
  const daily = status?.settings.dailyCostCeilingUsd ?? null;
  const pct = status?.dailyPct ?? null;
  const costToday = status?.costToday ?? 0;

  return (
    <section
      className={
        "rounded-xl p-1 " + (over ? "bg-destructive/15" : "bg-muted")
      }
    >
      <div
        className={
          "rounded-lg border bg-card " +
          (over ? "border-destructive/50" : "border-border")
        }
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <span className={over ? "text-destructive" : "text-muted-foreground"}>
              {over ? <Alert /> : <Wallet />}
            </span>
            <span className="text-sm font-medium text-foreground">
              Cost ceiling
            </span>
            {over && (
              <span className="rounded-full bg-destructive px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
                Over budget
              </span>
            )}
          </div>
          <button
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>

        {/* Daily spend vs ceiling */}
        <div className="px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-muted-foreground">Today</span>
            <span className="font-mono text-foreground">
              ${costToday.toFixed(2)}
              {daily != null && (
                <span className="text-muted-foreground"> / ${daily.toFixed(2)}</span>
              )}
            </span>
          </div>
          {daily != null && (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={
                  "h-full rounded-full " +
                  (status?.dailyOver ? "bg-destructive" : "bg-primary")
                }
                style={{ width: `${Math.min(100, pct ?? 0)}%` }}
              />
            </div>
          )}
          {daily == null && !editing && (
            <p className="mt-1 text-xs text-muted-foreground">
              No daily ceiling set — usage is unbounded.{" "}
              <button
                onClick={() => setEditing(true)}
                className="text-foreground underline-offset-2 hover:underline"
              >
                Set one
              </button>
              .
            </p>
          )}

          {/* Per-session overages */}
          {status && status.perSessionOver.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {status.perSessionOver.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="truncate text-destructive">
                    {s.title ?? s.model ?? s.id.slice(0, 8)} over per-session limit
                  </span>
                  <span className="shrink-0 font-mono text-muted-foreground">
                    ${s.cost.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {editing && <BudgetEditor status={status} onSave={onSave} />}
      </div>
    </section>
  );
}

/** The inline ceiling editor: daily / per-session limits + throttle toggle. */
function BudgetEditor({
  status,
  onSave,
}: {
  status: BudgetStatus | null;
  onSave: (update: BudgetUpdate) => Promise<void>;
}) {
  const [daily, setDaily] = useState("");
  const [perSession, setPerSession] = useState("");
  const [throttle, setThrottle] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed inputs from the current settings whenever they (re)load.
  useEffect(() => {
    if (!status) return;
    setDaily(
      status.settings.dailyCostCeilingUsd != null
        ? String(status.settings.dailyCostCeilingUsd)
        : "",
    );
    setPerSession(
      status.settings.perSessionCostCeilingUsd != null
        ? String(status.settings.perSessionCostCeilingUsd)
        : "",
    );
    setThrottle(status.settings.throttleOverBudget);
  }, [status]);

  const parse = (v: string): number | null => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const submit = async () => {
    setSaving(true);
    await onSave({
      daily_cost_ceiling_usd: parse(daily),
      per_session_cost_ceiling_usd: parse(perSession),
      throttle_over_budget: throttle,
    });
    setSaving(false);
  };

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Daily ceiling (USD)" hint="blank = no limit">
          <MoneyInput value={daily} onChange={setDaily} placeholder="e.g. 25" />
        </Field>
        <Field label="Per-session ceiling (USD)" hint="blank = no limit">
          <MoneyInput
            value={perSession}
            onChange={setPerSession}
            placeholder="e.g. 5"
          />
        </Field>
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={throttle}
          onChange={(e) => setThrottle(e.target.checked)}
          className="accent-primary"
        />
        Block new session launches while over the daily ceiling
      </label>
      <div className="mt-3 flex justify-end">
        <button
          onClick={submit}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save ceilings"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-xs text-muted-foreground">
        {label}
        {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
      </span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function MoneyInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center rounded-md border border-border bg-background px-2 focus-within:ring-1 focus-within:ring-primary">
      <span className="text-xs text-muted-foreground">$</span>
      <input
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent px-1 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
      />
    </div>
  );
}

// --- icons (Lucide path data, inline to match the conan UI) ----------------

function Wallet() {
  return (
    <Svg>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </Svg>
  );
}

function Alert() {
  return (
    <Svg>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

function Svg({ children, size = 15 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
