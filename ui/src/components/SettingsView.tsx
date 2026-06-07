import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { Check, Eye, EyeOff, Lock } from "lucide-react";
import { apiBase } from "../lib/gateway.ts";
import { TAB_LIST, TAB_TRIGGER } from "../lib/tabStyles.ts";
import {
  useTier,
  saveLicense,
  clearLicense,
} from "../hooks/useTier.ts";
import { PREMIUM_PRICE, type VerifyResult } from "../lib/license.ts";
import { PremiumUnlockBurst } from "./PremiumUnlockBurst.tsx";
import { useAppearance } from "../hooks/useAppearance.ts";
import { detectMonoFonts, DEFAULT_MONO } from "../lib/fontDetect.ts";
import { AUTO_ID } from "../hooks/useThemes.ts";
import {
  CONAN_THEME_ID,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  resolveTokens,
  type Theme,
} from "../lib/themes.ts";
/** Theme gating for Free users — Light, Dark, Auto, and the Conan brand theme
 *  are unlocked (US-006). Solarized, Dracula, and any user themes from
 *  themes.json render with a lock icon + muted style; clicking them opens
 *  Settings ▸ License instead of switching. */
const FREE_THEME_IDS = new Set([
  DEFAULT_LIGHT_ID,
  DEFAULT_DARK_ID,
  AUTO_ID,
  CONAN_THEME_ID,
]);
function isPremiumThemeId(id: string): boolean {
  return !FREE_THEME_IDS.has(id);
}
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
  doctor,
  initialTab,
  buyUrl,
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
  /** Claude Code install detection — surfaced as the top row of Status. */
  doctor?: {
    installed: boolean | null;
    version: string | null;
    path: string | null;
    error: string | null;
  };
  /** Optional tab to land on when the dialog opens — flips the controlled
   *  `Tabs` value once on the open-transition. The Upgrade button in the
   *  Timeline (US-102) passes `"license"` so the Free user lands directly on
   *  the paste-your-license surface. */
  initialTab?: "status" | "config" | "appearance" | "license";
  /** US-007: runtime-configurable Buy Premium checkout URL from /api/config.
   *  Falls back to the BUY_PREMIUM_URL default when unset, so the button is
   *  never broken. */
  buyUrl?: string | null;
}) {
  // Per-key inline save error, shared by both tabs (cleared on the next
  // successful save of that key). Lifted here so the Status and Config tabs write
  // through one `save()` — a key edited from either tab routes to the same file.
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Controlled tab state so external triggers (Upgrade button → US-102) can
  // jump straight to the License tab. Default lands on Status, mirroring the
  // pre-US-102 `defaultValue="status"`. Reset to `initialTab` whenever the
  // dialog transitions from closed → open with a non-undefined target.
  const [activeTab, setActiveTab] = useState<
    "status" | "config" | "appearance" | "license"
  >(initialTab ?? "status");
  useEffect(() => {
    if (open && initialTab) setActiveTab(initialTab);
  }, [open, initialTab]);

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

        <Tabs
          value={activeTab}
          onValueChange={(v) =>
            setActiveTab(v as "status" | "config" | "appearance" | "license")
          }
          className="flex min-w-0 flex-col gap-0"
        >
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
              <TabsTrigger value="license" className={TAB_TRIGGER}>
                License
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="status" className="mt-0">
            <StatusTab
              config={config}
              errors={errors}
              onSave={save}
              doctor={doctor}
            />
          </TabsContent>
          <TabsContent value="config" className="mt-0">
            <ConfigTab config={config} errors={errors} onSave={save} />
          </TabsContent>
          <TabsContent value="appearance" className="mt-0">
            <AppearanceTab
              themes={themes}
              activeThemeId={activeThemeId}
              onSelectTheme={onSelectTheme}
              onShowLicense={() => setActiveTab("license")}
            />
          </TabsContent>
          <TabsContent value="license" className="mt-0">
            <LicenseTab token={token} buyUrl={buyUrl} />
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
  doctor,
}: {
  config: ClaudeConfig | null;
  errors: Record<string, string>;
  onSave: (key: string, value: unknown) => void;
  doctor?: {
    installed: boolean | null;
    version: string | null;
    path: string | null;
    error: string | null;
  };
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
      <ClaudeInstallRow doctor={doctor} />
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

/**
 * Claude Code install diagnostic — the top row of the Status tab. Surfaces
 * whether the gateway can find `claude` on PATH (via the shell init that the
 * pty would use), the version, the resolved path, and any honest error from
 * the probe. Hidden during the initial probe (`installed: null`) so a flash
 * of "not detected" doesn't show on boot.
 */
function ClaudeInstallRow({
  doctor,
}: {
  doctor?: {
    installed: boolean | null;
    version: string | null;
    path: string | null;
    error: string | null;
  };
}) {
  if (!doctor || doctor.installed === null) return null;
  const ok = doctor.installed;
  return (
    <div className="flex flex-col gap-0.5 border-b border-border px-5 py-3">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-foreground">Claude Code</span>
        <span
          className={
            "shrink-0 tabular-nums " +
            (ok
              ? "text-foreground"
              : "text-amber-600 dark:text-amber-400")
          }
        >
          {ok
            ? doctor.version
              ? `v${doctor.version}`
              : "installed"
            : "not detected"}
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {ok ? (
          doctor.path ? (
            <span className="break-all">{doctor.path}</span>
          ) : (
            "version from last observed session (not on PATH from this shell)"
          )
        ) : (
          <>
            Install:{" "}
            <code className="rounded bg-muted px-1 py-px font-mono text-[10px]">
              npm install -g @anthropic-ai/claude-code
            </code>{" "}
            ·{" "}
            <a
              href="https://claude.com/claude-code"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              docs
            </a>
          </>
        )}
        {doctor.error && (
          <div className="mt-0.5 text-[10px] text-muted-foreground/80">
            {doctor.error}
          </div>
        )}
      </div>
    </div>
  );
}

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
  onShowLicense,
}: {
  themes: Theme[];
  activeThemeId: string;
  onSelectTheme: (id: string) => void;
  /** Jump to the License tab inside this same Settings dialog. Called when
   *  a Free user clicks a Premium-locked theme row. Direct callback (not
   *  the global `conan:open-settings` event) because that event's effect
   *  doesn't re-fire when the dialog's already open. */
  onShowLicense: () => void;
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
          onShowLicense={onShowLicense}
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

        <section>
          <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Motion
          </h3>

          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-2.5 last:border-b-0">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-foreground">
                Animations
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                Lightning bolt on the Timeline when a skill fires. The OS
                &ldquo;Reduce motion&rdquo; setting always wins.
              </div>
            </div>
            <div className="flex shrink-0 items-center">
              <Switch
                checked={appearance.animationsEnabled}
                onCheckedChange={(v) => set({ animationsEnabled: v })}
                aria-label="Enable animations"
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
  onShowLicense,
}: {
  themes: Theme[];
  activeThemeId: string;
  onSelectTheme: (id: string) => void;
  onShowLicense: () => void;
}) {
  const tier = useTier();
  const isFree = tier.tier === "free";
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
            locked={false}
            onShowLicense={onShowLicense}
          />
        </ul>
      </section>

      {light.length > 0 && (
        <ThemeGroup
          label="Light"
          themes={light}
          activeThemeId={activeThemeId}
          onSelectTheme={onSelectTheme}
          isFree={isFree}
          onShowLicense={onShowLicense}
        />
      )}
      {dark.length > 0 && (
        <ThemeGroup
          label="Dark"
          themes={dark}
          activeThemeId={activeThemeId}
          onSelectTheme={onSelectTheme}
          isFree={isFree}
          onShowLicense={onShowLicense}
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
  isFree,
  onShowLicense,
}: {
  label: string;
  themes: Theme[];
  activeThemeId: string;
  onSelectTheme: (id: string) => void;
  isFree: boolean;
  onShowLicense: () => void;
}) {
  return (
    <section>
      <h3 className="bg-muted/50 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ul>
        {themes.map((t) => {
          const locked = isFree && isPremiumThemeId(t.id);
          return (
            <ThemeRow
              key={t.id}
              name={t.name}
              swatches={<ThemeSwatches theme={t} />}
              selected={activeThemeId === t.id}
              onSelect={() => onSelectTheme(t.id)}
              locked={locked}
              onShowLicense={onShowLicense}
            />
          );
        })}
      </ul>
    </section>
  );
}

/** A selectable theme row: optional swatches + name on the left, check on
 *  right. When `locked` is true (Free user + a Premium theme), the row
 *  renders muted, the right-side glyph becomes a Lock, and clicking jumps
 *  to the License tab instead of switching the theme. */
function ThemeRow({
  name,
  description,
  swatches,
  selected,
  onSelect,
  locked,
  onShowLicense,
}: {
  name: string;
  description?: string;
  swatches?: ReactNode;
  selected: boolean;
  onSelect: () => void;
  locked: boolean;
  onShowLicense: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={locked ? onShowLicense : onSelect}
        aria-pressed={selected}
        title={locked ? `Conan Premium · ${PREMIUM_PRICE} unlocks this theme` : undefined}
        className={`flex w-full items-center justify-between gap-4 border-b border-border px-5 py-2.5 text-left last:border-b-0 hover:bg-muted/50 ${
          selected ? "bg-muted/40" : ""
        }`}
      >
        <div
          className={`flex min-w-0 items-center gap-3 ${locked ? "opacity-60" : ""}`}
        >
          {swatches}
          <div className="min-w-0">
            <div
              className={`truncate text-[13px] font-medium ${locked ? "text-muted-foreground" : "text-foreground"}`}
            >
              {name}
            </div>
            {description && (
              <div className="truncate text-[11px] text-muted-foreground">
                {description}
              </div>
            )}
          </div>
        </div>
        {locked ? (
          <Lock
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label="Premium"
          />
        ) : selected ? (
          <Check className="size-4 shrink-0 text-primary" aria-label="active" />
        ) : null}
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

/* ───── License tab (US-106) ──────────────────────────────────────────── */

/**
 * Default Polar hosted-checkout URL the Buy button opens when the gateway
 * supplies no override. US-007 makes the live value runtime-configurable via
 * `CONAN_BUY_URL` (surfaced on /api/config as `buyUrl`); this constant is the
 * fallback so the button is never broken. Will be swapped for the real
 * `https://buy.polar.sh/polar_cl_…` link once Polar approves the org (the Go
 * Live + Stripe Connect KYC flow) — set CONAN_BUY_URL and no rebuild is needed.
 */
const BUY_PREMIUM_URL = "https://conan.sh";

/**
 * Open an external URL via Tauri's shell plugin when running in the
 * native app, or `window.open` in the dev/browser context. Dynamic
 * import so the build doesn't hard-fail in non-Tauri environments —
 * matches the pattern used by `lib/nativeNotify.ts`.
 */
async function openExternal(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    // Browser dev / non-Tauri context: just punt to the standard tab opener.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Settings ▸ License — the only UI a user touches to activate Conan Premium.
 *
 *   - Banner: Free / Premium ✓ <fingerprint>, with an "expires" line that
 *     usually reads "lifetime 1.x" (the v1 `edition` claim is the gate, not
 *     `exp` — see [docs/v4.7-licensing-design.md](docs/v4.7-licensing-design.md) §1).
 *   - Paste field: 280-ish-char base64 JWT, masked by default with a show
 *     toggle. Masking isn't security (it's the user's own token) — it's so
 *     a 280-char noise blob doesn't look hostile in the form.
 *   - Apply button: routes through `saveLicense()` which verifies offline
 *     against the bundled Ed25519 public key BEFORE writing to disk. A
 *     failed verify never touches storage; the field stays populated so
 *     the user can edit/re-paste rather than re-locate the email.
 *   - Inline error: rendered from `VerifyResult.message` so users see
 *     "License expired 2031-01-01" or "Invalid license — signature does
 *     not match", not a generic 4xx.
 *   - Remove button: drops back to Free immediately, deletes the JWT file.
 *   - Buy Premium: opens the Polar checkout URL in the user's default browser.
 */
function LicenseTab({
  token,
  buyUrl,
}: {
  token: string | null;
  /** US-007: resolved Buy Premium URL from /api/config; falls back to the
   *  BUY_PREMIUM_URL default when null/unset. */
  buyUrl?: string | null;
}) {
  const tier = useTier(token);
  const [draft, setDraft] = useState("");
  const [showJwt, setShowJwt] = useState(false);
  const [applying, setApplying] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Distinct from tier.lastVerify: the verify result from THIS Apply attempt,
  // so the inline error is paired with the user's last action rather than
  // the boot-time verify (which might surface "no license" misleadingly here).
  const [applyResult, setApplyResult] = useState<VerifyResult | null>(null);
  // Fires the lightning-bolt celebration when a paste succeeds. Tracked
  // separately from applyResult so the burst is tied to the click event,
  // not to applyResult.ok lingering across re-renders (would re-fire on
  // any state change otherwise).
  const [unlockBurst, setUnlockBurst] = useState(false);

  async function apply(): Promise<void> {
    if (!draft.trim() || applying) return;
    setApplying(true);
    setApplyResult(null);
    try {
      const wasPremium = tier.tier === "premium";
      const r = await saveLicense(draft, token);
      setApplyResult(r);
      // Clear the draft only on success — keep it populated on failure so
      // the user can correct without re-pasting.
      if (r.ok) {
        setDraft("");
        // Only celebrate a real Free → Premium transition. Re-applying or
        // swapping an already-Premium license is a routine action and
        // doesn't deserve the same flourish — would feel cheap on repeat.
        if (!wasPremium) setUnlockBurst(true);
      }
    } finally {
      setApplying(false);
    }
  }

  async function remove(): Promise<void> {
    if (removing) return;
    setRemoving(true);
    try {
      await clearLicense(token);
      setApplyResult(null);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="relative space-y-4 px-5 py-5">
      {/* Celebration: lightning bolt overlay on first Free → Premium flip.
          Positioned absolute over the tab body; `pointer-events: none` so it
          never interrupts the user touching the Remove button or dismissing. */}
      <PremiumUnlockBurst
        play={unlockBurst}
        onDone={() => setUnlockBurst(false)}
      />
      {/* ── Tier banner ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        {tier.loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : tier.tier === "premium" && tier.license ? (
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                Premium
              </span>
              <span className="text-xs text-foreground">
                {tier.license.email}
              </span>
              <span
                className="font-mono text-[10px] text-muted-foreground"
                title={`License ID: ${tier.license.sub}`}
              >
                …{tier.license.sub.slice(-8)}
              </span>
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground">
              Lifetime of Conan 1.x — the upgrade gate is the{" "}
              <span className="font-mono">edition</span> claim, not an expiry.
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Multi-machine welcome — copy the JWT to as many Macs as you use.
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                Free
              </span>
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground">
              Live observability stays unlocked. Premium reveals the insight
              layer: full Timeline + skill / plan / tool-payload detail,
              Pulse 6h + 24h ranges, Skills last-fired history, and MCP
              auth-token watchdog.
            </div>
          </div>
        )}
      </div>

      {/* ── Apply a license ─────────────────────────────────────────────── */}
      <div className="space-y-2">
        <label
          htmlFor="license-jwt"
          className="block text-xs font-medium text-foreground"
        >
          {tier.tier === "premium"
            ? "Replace your license"
            : "Paste your license"}
        </label>
        <div className="flex items-stretch gap-2">
          <input
            id="license-jwt"
            type={showJwt ? "text" : "password"}
            spellCheck={false}
            autoComplete="off"
            placeholder="eyJhbGciOiJFZERTQSIs…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setShowJwt((s) => !s)}
            title={showJwt ? "Hide" : "Show"}
            className="flex items-center justify-center rounded-md border border-border bg-background px-2 text-muted-foreground hover:bg-muted"
          >
            {showJwt ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!draft.trim() || applying}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        </div>
        {applyResult && !applyResult.ok && (
          <div className="text-xs text-destructive">{applyResult.message}</div>
        )}
        {applyResult && applyResult.ok && (
          <div className="text-xs text-primary">
            License applied — Premium features unlocked.
          </div>
        )}
      </div>

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {tier.tier === "free" && (
          <button
            type="button"
            onClick={() => openExternal(buyUrl || BUY_PREMIUM_URL)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Buy Premium · {PREMIUM_PRICE}
          </button>
        )}
        {tier.tier === "premium" && (
          <button
            type="button"
            onClick={remove}
            disabled={removing}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {removing ? "Removing…" : "Remove license"}
          </button>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          One license, unlimited Macs. Lifetime of Conan 1.x.
        </span>
      </div>
    </div>
  );
}
