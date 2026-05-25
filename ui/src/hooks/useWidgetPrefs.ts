import { useCallback, useEffect, useState } from "react";

/** The opt-in secondary widgets (US-022), all off by default. */
export const WIDGET_KEYS = [
  "mcp",
  "plugins",
  "model",
  "retry",
  "tools",
  "git",
] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

export const WIDGET_LABELS: Record<WidgetKey, string> = {
  mcp: "MCP servers",
  plugins: "Plugins",
  model: "Model & idle",
  retry: "API retry rate",
  tools: "Top tools",
  git: "Git status",
};

const STORAGE_KEY = "conan.widgets.enabled";

/**
 * Persisted set of enabled secondary widgets (US-022). Backed by localStorage
 * so a user's "add widget" choices survive reloads. Default is empty — the
 * main view stays limited to the hero row + pending-approvals until opted in.
 */
export function useWidgetPrefs() {
  const [enabled, setEnabled] = useState<Set<WidgetKey>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(arr.filter((k): k is WidgetKey =>
        (WIDGET_KEYS as readonly string[]).includes(k),
      ));
    } catch {
      return new Set();
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
