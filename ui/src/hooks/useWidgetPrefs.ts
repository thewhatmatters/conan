import { useCallback, useEffect, useState } from "react";

/**
 * The widgets available in the picker-fronted hero area (US-010). The Plugins,
 * API-retry, and Top-tools widgets were dropped — they added no value. The
 * remaining/new widgets (MCP, Model & idle, Git, Context, Usage, Stats) plus
 * the carried-over Sessions/Skills/Cost cards all slot in here and are toggled
 * from the "Widgets ▾" picker.
 */
export const WIDGET_KEYS = [
  "context",
  "sessions",
  "skills",
  "cost",
  "mcp",
  "model",
  "git",
  "usage",
  "stats",
] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

export const WIDGET_LABELS: Record<WidgetKey, string> = {
  context: "Context",
  sessions: "Active sessions",
  skills: "Skills",
  cost: "Cost today",
  mcp: "MCP servers",
  model: "Model & idle",
  git: "Git status",
  usage: "Usage",
  stats: "Stats",
};

/**
 * Default set shown to a first-time user — five widgets so the row reads at a
 * glance without overflowing. The rest are one click away in the picker.
 */
const DEFAULT_ENABLED: WidgetKey[] = [
  "context",
  "sessions",
  "mcp",
  "model",
  "git",
];

const STORAGE_KEY = "conan.widgets.enabled";

/**
 * Persisted set of enabled hero widgets (US-010). Backed by localStorage so the
 * user's picker choices survive reloads. A first run (no stored value) shows the
 * five-widget default; an existing stored set is honored, with any retired keys
 * (plugins/retry/tools) silently dropped.
 */
export function useWidgetPrefs() {
  const [enabled, setEnabled] = useState<Set<WidgetKey>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw == null) return new Set(DEFAULT_ENABLED);
      const arr = JSON.parse(raw) as string[];
      return new Set(
        arr.filter((k): k is WidgetKey =>
          (WIDGET_KEYS as readonly string[]).includes(k),
        ),
      );
    } catch {
      return new Set(DEFAULT_ENABLED);
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabled]));
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  }, [enabled]);

  const toggle = useCallback((key: WidgetKey) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return { enabled, toggle, anyEnabled: enabled.size > 0 };
}
