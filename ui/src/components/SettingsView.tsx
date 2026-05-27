import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import type {
  ClaudeConfig,
  ConfigEntry,
  ConfigScope,
} from "../hooks/useConfig.ts";

/**
 * Top-level Settings view (US-008): a read-only mirror of Claude Code's `/config`
 * screen, opened from the native Conan ▸ Settings menu item (⌘,) which dispatches
 * a `conan:open-settings` window event App listens for. Renders the entries from
 * GET /api/claude/config (US-007) as a grouped, searchable list — one group per
 * source scope (Project / User / Global), each row showing the label, value, and
 * the file it was read from. Everything is managed by Claude Code on disk; Conan
 * only reads it, so the view is explicitly read-only (no inputs). Themed with
 * semantic tokens only.
 */
export default function SettingsView({
  open,
  onClose,
  config,
}: {
  open: boolean;
  onClose: () => void;
  config: ClaudeConfig | null;
}) {
  const [query, setQuery] = useState("");

  // Filter by label / key / stringified value, then group by source scope so the
  // list reads like Claude's /config (rows clustered by where they're managed).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const entries = (config?.entries ?? []).filter((e) => {
      if (!q) return true;
      return (
        e.label.toLowerCase().includes(q) ||
        e.key.toLowerCase().includes(q) ||
        formatValue(e.value).toLowerCase().includes(q)
      );
    });
    const order: ConfigScope[] = ["Project", "User", "Global"];
    return order
      .map((scope) => ({ scope, rows: entries.filter((e) => e.source === scope) }))
      .filter((g) => g.rows.length > 0);
  }, [config, query]);

  const total = config?.entries.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-2 border-b border-border px-5 pb-4 pt-5">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Claude Code configuration — managed by Claude Code on disk, shown here
            read-only.
          </DialogDescription>
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {config == null ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">
              Loading configuration…
            </p>
          ) : total === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">
              No Claude Code configuration found.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">
              No settings match “{query}”.
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.scope}>
                <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.scope}
                </h3>
                <ul>
                  {g.rows.map((e) => (
                    <ConfigRow key={`${e.source}:${e.key}`} entry={e} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One read-only config row: label + value, with its source file as the affordance. */
function ConfigRow({ entry }: { entry: ConfigEntry }) {
  return (
    <li className="flex items-center justify-between gap-4 border-b border-border px-5 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-foreground">
          {entry.label}
        </div>
        <div
          className="truncate text-[11px] text-muted-foreground"
          title={`Managed by Claude Code · ${entry.sourcePath}`}
        >
          {entry.source} · {entry.sourcePath}
        </div>
      </div>
      <code className="shrink-0 rounded-sm bg-muted px-2 py-0.5 font-mono text-[12px] text-foreground">
        {formatValue(entry.value)}
      </code>
    </li>
  );
}

/** Render a config value as a compact, readable string (never throws). */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
