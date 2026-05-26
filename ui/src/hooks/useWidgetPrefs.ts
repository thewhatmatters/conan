import { useCallback, useEffect, useState } from "react";

/**
 * The widgets available in the picker-fronted hero area (US-010). The Plugins,
 * API-retry, and Top-tools widgets were dropped — they added no value. The
 * "Cost today" card was also removed (US-024): Claude Max is token-based, so a
 * dollar figure is irrelevant. The remaining/new widgets (MCP, Model & idle,
 * Git, Context, Usage, Stats) plus the carried-over Sessions/Skills cards all
 * slot in here and are toggled from the "Widgets ▾" picker.
 */
export const WIDGET_KEYS = [
  "context",
  "sessions",
  "skills",
  "mcp",
  "model",
  "git",
  "metrics",
  "usage",
  "stats",
] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

/**
 * What context each widget reflects (US-019), so the user knows whether a figure
 * tracks the selected session, the active working directory, or the whole machine:
 *   - session — follows the timeline session ▾ (updates when the selection changes)
 *   - cwd     — follows the app-wide active cwd (the toolbar directory)
 *   - global  — unscoped / machine-wide
 *
 * Decision (documented): Git, MCP, and Last-session metrics are cwd-scoped. Git
 * reads the active cwd's work tree; MCP reflects the servers configured for that
 * context (global + project mcpServers); metrics read the last-session figures
 * Claude Code recorded for that project. They re-scope when the active cwd changes.
 */
export type WidgetScope = "session" | "cwd" | "global";

export const WIDGET_SCOPE: Record<WidgetKey, WidgetScope> = {
  context: "session",
  model: "session",
  skills: "session",
  git: "cwd",
  mcp: "cwd",
  metrics: "cwd",
  sessions: "global",
  usage: "global",
  stats: "global",
};

/** Hover hint explaining each scope (shown on the per-widget scope badge). */
export const SCOPE_HINT: Record<WidgetScope, string> = {
  session: "Session-scoped — follows the timeline session ▾",
  cwd: "Directory-scoped — follows the active working directory",
  global: "Global — machine-wide, unscoped",
};

export const WIDGET_LABELS: Record<WidgetKey, string> = {
  context: "Context",
  sessions: "Active sessions",
  skills: "Skills",
  mcp: "MCP servers",
  model: "Model & idle",
  git: "Git status",
  metrics: "Last session",
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
