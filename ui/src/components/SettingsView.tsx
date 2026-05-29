import { useMemo, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Switch } from "./ui/switch.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Check } from "lucide-react";
import { apiBase } from "../lib/gateway.ts";
import { TAB_LIST, TAB_TRIGGER } from "../lib/tabStyles.ts";
import { useAppearance } from "../hooks/useAppearance.ts";
import { detectMonoFonts, DEFAULT_MONO } from "../lib/fontDetect.ts";
import { AUTO_ID } from "../hooks/useThemes.ts";
import { resolveTokens, type Theme } from "../lib/themes.ts";
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
 *   - **Status** — the values Claude Code currently has set, grouped by the source
 *     scope (Project / User / Global) they were read from, plus the list of
 *     setting sources consulted. Rows whose key is in the editable schema are now
 *     live controls (US-016) editing in place; unmatched rows stay read-only.
 *   - **Config** — the editable-key catalog from GET /api/claude/config's
 *     `schema` (every editable key + its type), rendered as live controls
 *     (US-010): a switch for booleans, a dropdown for enums, a text/number input
 *     otherwise. Changes persist via POST /api/claude/config and re-read on save.
 *   - **Appearance** — Conan-local visual preferences (US-017), persisted to
 *     localStorage via useAppearance — NOT a Claude-config mirror, so it never
 *     touches POST /api/claude/config. Scaffolds a Terminal section that hosts
 *     the font picker (US-018/019) and theme picker (US-020+).
 *
 * Both tabs write through the same lifted `save()` (POST /api/claude/config,
 * read-modify-write). Writes route to the key's schema scope (settings vs global)
 * regardless of the display group a Status row was read from, so a Project-scoped
 * read is never written to the wrong file. Edits apply to Claude Code's on-disk
 * config and may only take effect on the next Claude session (no live hot-reload).
 * Themed with semantic tokens only.
 */
export default function SettingsView({
  open,
  onClose,
  config,
  token,
  onSaved,
  themes,
  activeThemeId,
  onSelectTheme,
}: {
  open: boolean;
  onClose: () => void;
  config: ClaudeConfig | null;
  token: string | null;
  onSaved: () => void;
  /** All selectable themes (built-ins + user themes) for the Appearance picker. */
  themes: Theme[];
  /** The active selection id (a theme id, or "auto"). */
  activeThemeId: string;
  /** Select a theme by id (or "auto"); applies live + persists, View-menu synced. */
  onSelectTheme: (id: string) => void;
}) {
  // Per-key inline save error, shared by both tabs (cleared on the next
  // successful save of that key). Lifted here so the Status and Config tabs write
  // through one `save()` — a key edited from either tab routes to the same file.
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(key: string, value: unknown) {
    if (!token) {
      setErrors((e) => ({ ...e, [key]: "no gateway token" }));
      return;
    }
    try {
      const r = await fetch(apiBase() + "/api/claude/config", {
        method: "POST",
        headers: { "content-type": "application/json", "x-conan-token": token },
        body: JSON.stringify({ key, value }),
      });
      const d = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!r.ok || !d?.ok) {
        setErrors((e) => ({ ...e, [key]: d?.error || `save failed (${r.status})` }));
        return;
      }
      setErrors((e) => {
        if (!(key in e)) return e;
        const rest = { ...e };
        delete rest[key];
        return rest;
      });
      onSaved();
    } catch (err) {
      setErrors((e) => ({ ...e, [key]: (err as Error).message }));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1.5 border-b border-border px-5 pb-4 pt-5">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Claude Code configuration — managed by Claude Code on disk. Edits apply
            on the next Claude session (no live hot-reload).
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="status" className="flex min-w-0 flex-col gap-0">
          <div className="flex items-center border-b border-border px-5">
            <TabsList className={TAB_LIST}>
              <TabsTrigger value="status" className={TAB_TRIGGER}>
                Status
              </TabsTrigger>
              <TabsTrigger value="config" className={TAB_TRIGGER}>
                Config
              </TabsTrigger>
              <TabsTrigger value="appearance" className={TAB_TRIGGER}>
                Appearance
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="status" className="mt-0">
            <StatusTab config={config} errors={errors} onSave={save} />
          </TabsContent>
          <TabsContent value="config" className="mt-0">
            <ConfigTab config={config} errors={errors} onSave={save} />
          </TabsContent>
          <TabsContent value="appearance" className="mt-0">
            <AppearanceTab
              themes={themes}
              activeThemeId={activeThemeId}
              onSelectTheme={onSelectTheme}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Status tab — the values Claude Code currently has set, grouped by source scope,
 * plus the setting sources that were consulted. Groups render directly (no search
 * box). Rows whose key matches an editable schema KeyType render the shared
 * KeyControl and save through the lifted `onSave` (US-016); unmatched rows stay
 * read-only (the current `code` value).
 */
function StatusTab({
  config,
  errors,
  onSave,
}: {
  config: ClaudeConfig | null;
  errors: Record<string, string>;
  onSave: (key: string, value: unknown) => void;
}) {
  // Group by source scope so the list reads like Claude's /config (rows
  // clustered by where they're managed).
  const groups = useMemo(() => {
    const entries = config?.entries ?? [];
    const order: ConfigScope[] = ["Project", "User", "Global"];
    return order
      .map((scope) => ({ scope, rows: entries.filter((e) => e.source === scope) }))
      .filter((g) => g.rows.length > 0);
  }, [config]);

  // Editable schema keyed by `key` so each Status row can find its control type.
  const schemaByKey = useMemo(() => {
    const m = new Map<string, KeyType>();
    for (const k of config?.schema ?? []) m.set(k.key, k);
    return m;
  }, [config]);

  const total = config?.entries.length ?? 0;

  return (
    <div className="flex flex-col">
      <p className="border-b border-border px-5 py-2.5 text-[11px] text-muted-foreground">
        Edits apply to Claude Code&rsquo;s config on disk and may only take effect
        on the next Claude session.
      </p>
      <div className="max-h-[52vh] overflow-y-auto overflow-x-hidden">
        {config == null ? (
          <p className="px-5 py-6 text-[13px] text-muted-foreground">
            Loading configuration…
          </p>
        ) : total === 0 ? (
          <p className="px-5 py-6 text-[13px] text-muted-foreground">
            No Claude Code configuration found.
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.scope}>
              <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {g.scope}
              </h3>
              <ul>
                {g.rows.map((e) => (
                  <ConfigRow
                    key={`${e.source}:${e.key}`}
                    entry={e}
                    keyType={schemaByKey.get(e.key)}
                    error={errors[e.key]}
                    onSave={(v) => onSave(e.key, v)}
                  />
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
 * Each row is a live control driven by the key's type metadata (US-010): a switch
 * for booleans, a dropdown for enums, a text/number input otherwise. Saving POSTs
 * a single key to /api/claude/config (read-modify-write, US-002) and on success
 * re-reads the config (`onSaved`) so the value sticks across reopen; a save error
 * surfaces inline without closing the dialog.
 */
function ConfigTab({
  config,
  errors,
  onSave,
}: {
  config: ClaudeConfig | null;
  errors: Record<string, string>;
  onSave: (key: string, value: unknown) => void;
}) {
  // Index the current values by key so each editable row starts from what's set.
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
    <div className="flex flex-col">
      <p className="border-b border-border px-5 py-2.5 text-[11px] text-muted-foreground">
        Edits apply to Claude Code&rsquo;s config on disk and may only take effect
        on the next Claude session.
      </p>
      <div className="max-h-[52vh] overflow-y-auto overflow-x-hidden">
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
                    error={errors[k.key]}
                    onSave={(v) => onSave(k.key, v)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Appearance tab — Conan-local visual preferences (US-017), persisted to
 * localStorage via useAppearance. This is NOT a Claude-config mirror, so it does
 * not POST to /api/claude/config and carries no "next Claude session" caveat.
 * Hosts the terminal mono-font picker + size control (US-018); the chosen values
 * are stored in the appearance pref and applied to live terminals in US-019. The
 * theme picker (US-020+) lands here too. Themed with semantic tokens only.
 */
function AppearanceTab({
  themes,
  activeThemeId,
  onSelectTheme,
}: {
  themes: Theme[];
  activeThemeId: string;
  onSelectTheme: (id: string) => void;
}) {
  const { appearance, set } = useAppearance();

  // Detect the installed mono fonts once (canvas advance-width trick — works in
  // WKWebView where queryLocalFonts() is unavailable). The default is always
  // included so the dropdown can represent the built-in fallback even when
  // detection finds nothing. If a previously-picked font is no longer detected
  // (e.g. uninstalled), keep it selectable so the UI still reflects the pref.
  const fonts = useMemo(() => {
    const detected = detectMonoFonts();
    const picked = appearance.terminalFontFamily;
    if (picked && !detected.includes(picked)) return [...detected, picked];
    return detected;
  }, [appearance.terminalFontFamily]);

  // The "use the default stack" sentinel — null in the pref maps to this so the
  // Select always has a concrete value (Radix Select can't bind to null).
  const DEFAULT_VALUE = "__default__";
  const fontValue = appearance.terminalFontFamily ?? DEFAULT_VALUE;

  return (
    <div className="flex flex-col">
      <p className="border-b border-border px-5 py-2.5 text-[11px] text-muted-foreground">
        Conan&rsquo;s own look &amp; feel — stored locally on this machine. Takes
        effect immediately; not part of Claude Code&rsquo;s config.
      </p>
      <div className="max-h-[52vh] overflow-y-auto overflow-x-hidden">
        <ThemeSection
          themes={themes}
          activeThemeId={activeThemeId}
          onSelectTheme={onSelectTheme}
        />

        <section>
          <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Terminal
          </h3>

          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-foreground">
                Font family
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                Detected monospace fonts on this machine
              </div>
            </div>
            <div className="flex shrink-0 items-center">
              <Select
                value={fontValue}
                onValueChange={(v) =>
                  set({ terminalFontFamily: v === DEFAULT_VALUE ? null : v })
                }
              >
                <SelectTrigger className="h-8 w-48 text-[12px]" aria-label="Terminal font family">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE} className="text-[12px]">
                    Default ({DEFAULT_MONO})
                  </SelectItem>
                  {fonts.map((f) => (
                    <SelectItem
                      key={f}
                      value={f}
                      className="text-[12px]"
                      style={{ fontFamily: `"${f}", ui-monospace, monospace` }}
                    >
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-2.5 last:border-b-0">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-foreground">
                Font size
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                Terminal text size in pixels
              </div>
            </div>
            <div className="flex shrink-0 items-center">
              <input
                type="number"
                min={8}
                max={32}
                value={appearance.terminalFontSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 8 && n <= 32) {
                    set({ terminalFontSize: n });
                  }
                }}
                aria-label="Terminal font size"
                className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Theme picker (US-023) inside the Appearance tab. Lists every selectable theme —
 * the bundled built-ins + any user themes from ~/.conan/themes.json (US-022) —
 * grouped + labelled by light/dark, each with a small palette-swatch preview. An
 * "Auto" row follows the OS. Selecting applies live (US-021) and persists by id;
 * the row reflects the active selection, staying in sync with the View ▸ Theme
 * menu (both drive the same useThemes store). Semantic tokens only.
 */
function ThemeSection({
  themes,
  activeThemeId,
  onSelectTheme,
}: {
  themes: Theme[];
  activeThemeId: string;
  onSelectTheme: (id: string) => void;
}) {
  const light = themes.filter((t) => t.type === "light");
  const dark = themes.filter((t) => t.type === "dark");

  return (
    <>
      <section>
        <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Theme
        </h3>
        <ul>
          <ThemeRow
            name="Auto — match system"
            description="Follow the OS light/dark setting"
            selected={activeThemeId === AUTO_ID}
            onSelect={() => onSelectTheme(AUTO_ID)}
          />
        </ul>
      </section>

      {light.length > 0 && (
        <ThemeGroup
          label="Light"
          themes={light}
          activeThemeId={activeThemeId}
          onSelectTheme={onSelectTheme}
        />
      )}
      {dark.length > 0 && (
        <ThemeGroup
          label="Dark"
          themes={dark}
          activeThemeId={activeThemeId}
          onSelectTheme={onSelectTheme}
        />
      )}
    </>
  );
}

/** One light/dark group of theme rows under its own subheader. */
function ThemeGroup({
  label,
  themes,
  activeThemeId,
  onSelectTheme,
}: {
  label: string;
  themes: Theme[];
  activeThemeId: string;
  onSelectTheme: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ul>
        {themes.map((t) => (
          <ThemeRow
            key={t.id}
            name={t.name}
            swatches={<ThemeSwatches theme={t} />}
            selected={activeThemeId === t.id}
            onSelect={() => onSelectTheme(t.id)}
          />
        ))}
      </ul>
    </section>
  );
}

/** A selectable theme row: optional swatches + name on the left, check on right. */
function ThemeRow({
  name,
  description,
  swatches,
  selected,
  onSelect,
}: {
  name: string;
  description?: string;
  swatches?: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex w-full items-center justify-between gap-4 border-b border-border px-5 py-2.5 text-left last:border-b-0 hover:bg-muted/50 ${
          selected ? "bg-muted/40" : ""
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          {swatches}
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">
              {name}
            </div>
            {description && (
              <div className="truncate text-[11px] text-muted-foreground">
                {description}
              </div>
            )}
          </div>
        </div>
        {selected && (
          <Check className="size-4 shrink-0 text-primary" aria-label="active" />
        )}
      </button>
    </li>
  );
}

/** A tiny preview of a theme's palette — a few representative resolved tokens. */
function ThemeSwatches({ theme }: { theme: Theme }) {
  // resolveTokens merges a (possibly partial) user theme over its type's default,
  // so every swatch has a real color even for a partial themes.json entry.
  const tokens = resolveTokens(theme);
  const keys = ["background", "primary", "chart-1", "chart-2", "foreground"] as const;
  return (
    <div className="flex shrink-0 overflow-hidden rounded-sm border border-border">
      {keys.map((k) => (
        <span
          key={k}
          className="size-4"
          style={{ backgroundColor: tokens[k] }}
          aria-hidden
        />
      ))}
    </div>
  );
}

/**
 * One Status-tab config row: label + source affordance on the left. When the
 * row's key is in the editable schema (`keyType`), the right side is the live
 * KeyControl and saves through `onSave` — the write routes to the key's schema
 * scope (settings vs global), not the display group it was read from (US-016).
 * Without a matching schema key it stays read-only (the current `code` value).
 */
function ConfigRow({
  entry,
  keyType,
  error,
  onSave,
}: {
  entry: ConfigEntry;
  keyType?: KeyType;
  error?: string;
  onSave: (value: unknown) => void;
}) {
  return (
    <li className="border-b border-border px-5 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-4">
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
        <div className="flex shrink-0 items-center">
          {keyType ? (
            <KeyControl keyType={keyType} hasValue value={entry.value} onSave={onSave} />
          ) : (
            <code className="rounded-sm bg-muted px-2 py-0.5 font-mono text-[12px] text-foreground">
              {formatValue(entry.value)}
            </code>
          )}
        </div>
      </div>
      {error && (
        <p className="mt-1.5 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * One editable-key row (US-010): label + key/type subtitle on the left, and the
 * live control the `kind` implies on the right — a switch for booleans, a
 * dropdown for enums, a text/number input otherwise. A save error renders inline
 * beneath the row without closing the dialog.
 */
function SchemaRow({
  keyType,
  hasValue,
  value,
  error,
  onSave,
}: {
  keyType: KeyType;
  hasValue: boolean;
  value: unknown;
  error?: string;
  onSave: (value: unknown) => void;
}) {
  const typeLabel =
    keyType.kind === "enum" && keyType.values && keyType.values.length > 0
      ? `enum: ${keyType.values.join(" · ")}`
      : keyType.kind;
  return (
    <li className="border-b border-border px-5 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground">
            {keyType.label}
          </div>
          <div className="truncate text-[11px] text-muted-foreground" title={typeLabel}>
            {keyType.key} · {typeLabel}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <KeyControl keyType={keyType} hasValue={hasValue} value={value} onSave={onSave} />
        </div>
      </div>
      {error && (
        <p className="mt-1.5 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** The type-appropriate editable control for one key, controlled by `value`. */
function KeyControl({
  keyType,
  hasValue,
  value,
  onSave,
}: {
  keyType: KeyType;
  hasValue: boolean;
  value: unknown;
  onSave: (value: unknown) => void;
}) {
  if (keyType.kind === "boolean") {
    return (
      <Switch
        checked={value === true}
        onCheckedChange={(checked) => onSave(checked)}
        aria-label={keyType.label}
      />
    );
  }

  if (keyType.kind === "enum" && keyType.values && keyType.values.length > 0) {
    return (
      <Select
        value={hasValue && typeof value === "string" ? value : undefined}
        onValueChange={(v) => onSave(v)}
      >
        <SelectTrigger className="h-8 w-48 text-[12px]" aria-label={keyType.label}>
          <SelectValue placeholder="not set" />
        </SelectTrigger>
        <SelectContent>
          {keyType.values.map((v) => (
            <SelectItem key={v} value={v} className="text-[12px]">
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // string / number / enum-without-values → free input committed on blur or Enter.
  return (
    <TextControl keyType={keyType} hasValue={hasValue} value={value} onSave={onSave} />
  );
}

/** A text/number input that commits on Enter or blur, only when the value changed. */
function TextControl({
  keyType,
  hasValue,
  value,
  onSave,
}: {
  keyType: KeyType;
  hasValue: boolean;
  value: unknown;
  onSave: (value: unknown) => void;
}) {
  const initial = hasValue ? formatValue(value) : "";
  const [draft, setDraft] = useState(initial);
  // Re-sync the draft when the saved value changes (e.g. after a refetch).
  const [seed, setSeed] = useState(initial);
  if (seed !== initial) {
    setSeed(initial);
    setDraft(initial);
  }

  const isNumber = keyType.kind === "number";

  function commit() {
    if (draft === initial) return;
    if (isNumber) {
      const n = Number(draft);
      if (draft.trim() === "" || !Number.isFinite(n)) return;
      onSave(n);
    } else {
      onSave(draft);
    }
  }

  return (
    <input
      type={isNumber ? "number" : "text"}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      placeholder="not set"
      aria-label={keyType.label}
      className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
    />
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
