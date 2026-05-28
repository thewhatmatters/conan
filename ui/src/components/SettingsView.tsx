import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import type {
  ClaudeConfig,
  ConfigEntry,
  ConfigScope,
  KeyType,
} from "../hooks/useConfig.ts";

/**
 * Top-level Settings view, opened from the native Conan ▸ Settings menu item (⌘,)
 * which dispatches a `conan:open-settings` window event App listens for. Split
 * into two tabs mirroring Claude Code's own `/settings` screen (US-009):
 *
 *   - **Status** — the read-only mirror of Claude Code's on-disk config: the
 *     concrete values currently set, grouped by the source scope (Project / User
 *     / Global) they were read from, plus the list of setting sources consulted.
 *   - **Config** — the editable-key catalog from GET /api/claude/config's
 *     `schema` (every editable key + its type), rendered read-only here as the
 *     scaffold US-010 makes interactive.
 *
 * Everything is managed by Claude Code on disk; Conan only reads it this loop, so
 * both tabs are read-only. Themed with semantic tokens only.
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
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1.5 border-b border-border px-5 pb-4 pt-5">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Claude Code configuration — managed by Claude Code on disk, shown here
            read-only.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="status" className="flex flex-col gap-0">
          <div className="border-b border-border px-5 py-2.5">
            <TabsList>
              <TabsTrigger value="status">Status</TabsTrigger>
              <TabsTrigger value="config">Config</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="status" className="mt-0">
            <StatusTab config={config} />
          </TabsContent>
          <TabsContent value="config" className="mt-0">
            <ConfigTab config={config} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Status tab — the existing read-only mirror: the values Claude Code currently
 * has set, grouped by source scope, with a search box, plus the setting sources
 * that were consulted.
 */
function StatusTab({ config }: { config: ClaudeConfig | null }) {
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
    <div className="flex flex-col">
      <div className="border-b border-border px-5 py-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="max-h-[52vh] overflow-y-auto">
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

        {config != null && config.files.length > 0 && (
          <section>
            <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Setting sources
            </h3>
            <ul>
              {config.files.map((f) => (
                <li
                  key={`${f.scope}:${f.path}`}
                  className="flex items-center justify-between gap-4 border-b border-border px-5 py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-foreground">
                      {f.scope}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground" title={f.path}>
                      {f.path}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 text-[11px] ${f.present ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {f.present ? "present" : "absent"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * Config tab — the editable-key catalog from the GET /api/claude/config `schema`.
 * Lists every editable key with its type and current value (from the read-only
 * entries when set), grouped by target file. Read-only in THIS story (US-009);
 * the controls become interactive in US-010.
 */
function ConfigTab({ config }: { config: ClaudeConfig | null }) {
  // Index the current values by key so each editable row can show what's set.
  const valueByKey = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const e of config?.entries ?? []) m.set(e.key, e.value);
    return m;
  }, [config]);

  const groups = useMemo(() => {
    const schema = config?.schema ?? [];
    const order: { scope: KeyType["scope"]; label: string }[] = [
      { scope: "settings", label: "settings.json" },
      { scope: "global", label: "~/.claude.json" },
    ];
    return order
      .map((g) => ({ ...g, rows: schema.filter((k) => k.scope === g.scope) }))
      .filter((g) => g.rows.length > 0);
  }, [config]);

  return (
    <div className="max-h-[52vh] overflow-y-auto">
      {config == null ? (
        <p className="px-5 py-6 text-[13px] text-muted-foreground">
          Loading configuration…
        </p>
      ) : groups.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-muted-foreground">
          No editable settings available.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.scope}>
            <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {g.label}
            </h3>
            <ul>
              {g.rows.map((k) => (
                <SchemaRow
                  key={k.key}
                  keyType={k}
                  hasValue={valueByKey.has(k.key)}
                  value={valueByKey.get(k.key)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
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

/**
 * One editable-key row (read-only scaffold): label, the value type, and the
 * current value when set (or a muted "not set"). US-010 swaps the value column
 * for the live control the `kind` implies.
 */
function SchemaRow({
  keyType,
  hasValue,
  value,
}: {
  keyType: KeyType;
  hasValue: boolean;
  value: unknown;
}) {
  const typeLabel =
    keyType.kind === "enum" && keyType.values && keyType.values.length > 0
      ? `enum: ${keyType.values.join(" · ")}`
      : keyType.kind;
  return (
    <li className="flex items-center justify-between gap-4 border-b border-border px-5 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-foreground">
          {keyType.label}
        </div>
        <div className="truncate text-[11px] text-muted-foreground" title={typeLabel}>
          {keyType.key} · {typeLabel}
        </div>
      </div>
      {hasValue ? (
        <code className="shrink-0 rounded-sm bg-muted px-2 py-0.5 font-mono text-[12px] text-foreground">
          {formatValue(value)}
        </code>
      ) : (
        <span className="shrink-0 text-[11px] italic text-muted-foreground">not set</span>
      )}
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
