// US-023: persisted dashboard settings, backed by a small JSON file in the data
// directory (alongside the SQLite db). Today this holds the cost-ceiling
// configuration for the always-on budget guard; the shape is intentionally
// extensible so later stories can add their own sections.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../paths.js";

/** Where the settings JSON lives; override with CONAN_SETTINGS_PATH (tests). */
const SETTINGS_PATH =
  process.env.CONAN_SETTINGS_PATH ?? path.join(DATA_DIR, "settings.json");

/** Cost-ceiling configuration for the always-on budget guard (US-023). */
export interface BudgetSettings {
  /** Aggregate cost ceiling for the current day (USD). null = no limit. */
  dailyCostCeilingUsd: number | null;
  /** Per-session cost ceiling (USD). null = no limit. */
  perSessionCostCeilingUsd: number | null;
  /**
   * When true, block launching new headless sessions while the daily ceiling is
   * crossed (the optional throttling cap). Off by default so a misconfigured
   * ceiling can never silently wedge the dashboard.
   */
  throttleOverBudget: boolean;
}

export interface Settings {
  budget: BudgetSettings;
}

export const DEFAULT_BUDGET: BudgetSettings = {
  dailyCostCeilingUsd: null,
  perSessionCostCeilingUsd: null,
  throttleOverBudget: false,
};

const DEFAULT_SETTINGS: Settings = { budget: { ...DEFAULT_BUDGET } };

/** Read the settings file, falling back to defaults for any missing section. */
export function readSettings(): Settings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      budget: { ...DEFAULT_BUDGET, ...(parsed.budget ?? {}) },
    };
  } catch {
    // Missing or unreadable file -> defaults (no limits, throttling off).
    return { budget: { ...DEFAULT_BUDGET } };
  }
}

/** Just the budget section, with defaults applied. */
export function readBudgetSettings(): BudgetSettings {
  return readSettings().budget;
}

function writeSettings(settings: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

/** Coerce a user-supplied ceiling: a positive finite number, else null (no limit). */
function coerceCeiling(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return null;
}

/**
 * Apply a partial update to the budget settings and persist. Unspecified fields
 * keep their current value; ceilings are validated (positive number or null).
 */
export function updateBudgetSettings(patch: Partial<BudgetSettings>): BudgetSettings {
  const current = readSettings();
  const next: BudgetSettings = { ...current.budget };
  if ("dailyCostCeilingUsd" in patch) {
    next.dailyCostCeilingUsd = coerceCeiling(patch.dailyCostCeilingUsd);
  }
  if ("perSessionCostCeilingUsd" in patch) {
    next.perSessionCostCeilingUsd = coerceCeiling(patch.perSessionCostCeilingUsd);
  }
  if ("throttleOverBudget" in patch) {
    next.throttleOverBudget = patch.throttleOverBudget === true;
  }
  writeSettings({ ...current, budget: next });
  return next;
}
