/**
 * Theme model + bundled built-in themes (US-020).
 *
 * A Theme is a named palette of CSS custom-property values. Selecting one (the
 * apply path lands in US-021) sets these on `document.documentElement` and
 * toggles `.dark` per the theme's `type`, reskinning the whole app + terminal.
 *
 * --- Canonical token-key contract -------------------------------------------
 * The keys below are the single source of truth for what a theme may set. They
 * mirror the color custom properties declared on `:root` / `.dark` in
 * ui/src/index.css (the `--radius` length token is intentionally NOT themeable).
 * A theme supplies values WITHOUT the leading `--` (e.g. `background`, not
 * `--background`); the apply path re-adds the prefix. Built-in themes below set
 * every key; user themes (US-022) may be partial and are merged over the
 * built-in default for their `type` (US-021) so every required token resolves.
 */
export const TOKEN_KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "border",
  "muted",
  "muted-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "popover",
  "popover-foreground",
  "destructive",
  "destructive-foreground",
  "input",
  "ring",
  "term-bg",
  "term-fg",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "heat-0",
  "heat-1",
  "heat-2",
  "heat-3",
  "heat-4",
] as const;

/** A canonical theme token key (one of the ~30 `--*` color custom properties). */
export type ThemeTokenKey = (typeof TOKEN_KEYS)[number];

/** Token map. Built-ins are complete; user themes may be partial (US-021 merge). */
export type ThemeTokens = Partial<Record<ThemeTokenKey, string>>;

export interface Theme {
  /** Stable identifier; persisted as the active selection (US-020). */
  id: string;
  /** Human-readable label shown in the picker (US-023). */
  name: string;
  /** Drives the `.dark` class on apply + the light/dark grouping in the picker. */
  type: "light" | "dark";
  /** Token values keyed by the canonical contract above. */
  tokens: ThemeTokens;
}

/** A complete token map (every canonical key set) — used by the built-ins. */
type FullTokens = Record<ThemeTokenKey, string>;

// --- Built-in themes ----------------------------------------------------------
// Light + Dark mirror the exact :root / .dark values in ui/src/index.css so the
// current look is reproduced when these are applied. The two extra palettes
// (Solarized Light, Dracula) give the picker a non-default option per type.

const LIGHT_TOKENS: FullTokens = {
  background: "#fafafa",
  foreground: "#171717",
  card: "#ffffff",
  "card-foreground": "#171717",
  border: "#e5e5e5",
  muted: "#f5f5f5",
  "muted-foreground": "#737373",
  primary: "#059669",
  "primary-foreground": "#ffffff",
  secondary: "#f5f5f5",
  "secondary-foreground": "#171717",
  accent: "#f5f5f5",
  "accent-foreground": "#171717",
  popover: "#ffffff",
  "popover-foreground": "#171717",
  destructive: "#dc2626",
  "destructive-foreground": "#ffffff",
  input: "#e5e5e5",
  ring: "#059669",
  "term-bg": "#ffffff",
  "term-fg": "#1f2937",
  "chart-1": "#059669",
  "chart-2": "#3b82f6",
  "chart-3": "#f59e0b",
  "chart-4": "#8b5cf6",
  "chart-5": "#ec4899",
  "heat-0": "#ebedf0",
  "heat-1": "#9be9a8",
  "heat-2": "#40c463",
  "heat-3": "#30a14e",
  "heat-4": "#216e39",
};

const DARK_TOKENS: FullTokens = {
  background: "#0a0a0a",
  foreground: "#ededed",
  card: "#171717",
  "card-foreground": "#ededed",
  border: "#262626",
  muted: "#1f1f1f",
  "muted-foreground": "#9aa0a6",
  primary: "#34d399",
  "primary-foreground": "#0a0a0a",
  secondary: "#1f1f1f",
  "secondary-foreground": "#ededed",
  accent: "#1f1f1f",
  "accent-foreground": "#ededed",
  popover: "#171717",
  "popover-foreground": "#ededed",
  destructive: "#f87171",
  "destructive-foreground": "#0a0a0a",
  input: "#262626",
  ring: "#34d399",
  "term-bg": "#0a0a0a",
  "term-fg": "#ededed",
  "chart-1": "#34d399",
  "chart-2": "#60a5fa",
  "chart-3": "#fbbf24",
  "chart-4": "#a78bfa",
  "chart-5": "#f472b6",
  "heat-0": "#1f1f1f",
  "heat-1": "#0e4429",
  "heat-2": "#006d32",
  "heat-3": "#26a641",
  "heat-4": "#39d353",
};

const SOLARIZED_LIGHT_TOKENS: FullTokens = {
  background: "#fdf6e3",
  foreground: "#657b83",
  card: "#eee8d5",
  "card-foreground": "#586e75",
  border: "#ddd6c1",
  muted: "#eee8d5",
  "muted-foreground": "#93a1a1",
  primary: "#268bd2",
  "primary-foreground": "#fdf6e3",
  secondary: "#eee8d5",
  "secondary-foreground": "#586e75",
  accent: "#eee8d5",
  "accent-foreground": "#586e75",
  popover: "#fdf6e3",
  "popover-foreground": "#657b83",
  destructive: "#dc322f",
  "destructive-foreground": "#fdf6e3",
  input: "#ddd6c1",
  ring: "#268bd2",
  "term-bg": "#fdf6e3",
  "term-fg": "#657b83",
  "chart-1": "#268bd2",
  "chart-2": "#2aa198",
  "chart-3": "#b58900",
  "chart-4": "#6c71c4",
  "chart-5": "#d33682",
  "heat-0": "#eee8d5",
  "heat-1": "#c5e1a5",
  "heat-2": "#9ccc65",
  "heat-3": "#689f38",
  "heat-4": "#33691e",
};

const DRACULA_TOKENS: FullTokens = {
  background: "#282a36",
  foreground: "#f8f8f2",
  card: "#21222c",
  "card-foreground": "#f8f8f2",
  border: "#44475a",
  muted: "#343746",
  "muted-foreground": "#6272a4",
  primary: "#bd93f9",
  "primary-foreground": "#282a36",
  secondary: "#343746",
  "secondary-foreground": "#f8f8f2",
  accent: "#343746",
  "accent-foreground": "#f8f8f2",
  popover: "#21222c",
  "popover-foreground": "#f8f8f2",
  destructive: "#ff5555",
  "destructive-foreground": "#282a36",
  input: "#44475a",
  ring: "#bd93f9",
  "term-bg": "#282a36",
  "term-fg": "#f8f8f2",
  "chart-1": "#50fa7b",
  "chart-2": "#8be9fd",
  "chart-3": "#f1fa8c",
  "chart-4": "#bd93f9",
  "chart-5": "#ff79c6",
  "heat-0": "#343746",
  "heat-1": "#2d4a3e",
  "heat-2": "#2e7d52",
  "heat-3": "#43b581",
  "heat-4": "#50fa7b",
};

/** IDs of the default light/dark themes — the `auto` pair maps to these (US-021). */
export const DEFAULT_LIGHT_ID = "light";
export const DEFAULT_DARK_ID = "dark";

/** The themes shipped with the app, in picker order. */
export const BUILTIN_THEMES: Theme[] = [
  { id: DEFAULT_LIGHT_ID, name: "Light", type: "light", tokens: LIGHT_TOKENS },
  { id: DEFAULT_DARK_ID, name: "Dark", type: "dark", tokens: DARK_TOKENS },
  {
    id: "solarized-light",
    name: "Solarized Light",
    type: "light",
    tokens: SOLARIZED_LIGHT_TOKENS,
  },
  { id: "dracula", name: "Dracula", type: "dark", tokens: DRACULA_TOKENS },
];

/** The built-in default theme for a given type — the merge base for partials. */
export function defaultThemeForType(type: "light" | "dark"): Theme {
  return type === "dark"
    ? BUILTIN_THEMES.find((t) => t.id === DEFAULT_DARK_ID)!
    : BUILTIN_THEMES.find((t) => t.id === DEFAULT_LIGHT_ID)!;
}

// --- Apply path (US-021) ------------------------------------------------------

/**
 * Resolve a (possibly partial) theme to a complete token map by merging its
 * tokens over the built-in default for its `type`. A user theme (US-022) may
 * omit keys; this guarantees every canonical token resolves so the UI never
 * breaks with a missing value.
 */
export function resolveTokens(theme: Theme): FullTokens {
  const base = defaultThemeForType(theme.type).tokens as FullTokens;
  return { ...base, ...theme.tokens };
}

/**
 * Window event dispatched after a theme is applied. Live consumers that read
 * computed CSS custom properties at call time — the xterm terminals via
 * getTerminalTheme() — listen for this to re-read, so a same-type switch
 * (e.g. Dark → Dracula, where the `.dark` class and the coarse light/dark prop
 * don't change) still reskins the terminal.
 */
export const THEME_APPLIED_EVENT = "conan:theme-applied";

/**
 * Apply a theme to the document: set every canonical token as an inline custom
 * property on <html> (overriding the :root/.dark stylesheet values), toggle the
 * `.dark` class per the theme's `type` (so Tailwind `dark:` variants +
 * `.dark`-scoped CSS — including `color-scheme` — still behave), then notify
 * live consumers (terminals) to re-read via THEME_APPLIED_EVENT.
 *
 * Replaces useTheme's old `.dark`-only apply: the full token set now drives the
 * look, so multiple palettes (not just light/dark) reskin the whole app live.
 */
export function applyTheme(theme: Theme): void {
  const tokens = resolveTokens(theme);
  const root = document.documentElement;
  for (const key of TOKEN_KEYS) {
    root.style.setProperty(`--${key}`, tokens[key]);
  }
  root.classList.toggle("dark", theme.type === "dark");
  window.dispatchEvent(new Event(THEME_APPLIED_EVENT));
}
