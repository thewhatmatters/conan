/**
 * Local mono-font detection without `queryLocalFonts()` — that API is
 * Chromium-only and absent in the macOS WKWebView the Tauri build runs in
 * (US-018). Instead we use the classic **canvas advance-width trick**: render a
 * probe string in each generic baseline family, then again with a candidate
 * prepended ("Candidate, monospace"). If the candidate is actually installed
 * the browser uses it and the measured advance width shifts away from the
 * baseline for at least one generic family; if it isn't, the string falls back
 * to the baseline and the widths match exactly. This works the same in Chrome
 * (dev) and WKWebView (the built app) since it only needs a 2D canvas.
 */

/**
 * The curated candidate list we probe for. Ordered roughly by how common they
 * are on macOS first, then popular installable coding fonts. `DEFAULT_MONO`
 * names the built-in fallback stack's lead family so the picker can always
 * offer "the default" even when nothing else is detected.
 */
export const MONO_FONT_CANDIDATES = [
  "Menlo",
  "Monaco",
  "SF Mono",
  "Courier New",
  "Geist Mono",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Hack",
  "Source Code Pro",
  "IBM Plex Mono",
] as const;

/** The lead family of Terminal.tsx's built-in fallback stack (always offered). */
export const DEFAULT_MONO = "Geist Mono";

// Generic baselines: a candidate counts as "installed" if it shifts the advance
// width away from ANY of these. Using all three reduces false negatives where a
// candidate happens to match one generic family's metrics.
const BASELINES = ["monospace", "serif", "sans-serif"] as const;

// A glyph-dense probe string at a large size so per-glyph width differences
// accumulate into an easily-measured advance-width delta.
const PROBE_TEXT = "mmmmmmmmmmlli1234567890MWQ@%";
const PROBE_SIZE = 72;

/**
 * True if `family` appears to be installed locally. Pure measurement; never
 * throws (a missing canvas context just reports "not detected").
 */
export function isFontAvailable(
  family: string,
  ctx: CanvasRenderingContext2D | null,
): boolean {
  if (!ctx) return false;
  for (const base of BASELINES) {
    ctx.font = `${PROBE_SIZE}px ${base}`;
    const baseWidth = ctx.measureText(PROBE_TEXT).width;
    // Quote the family so multi-word names ("SF Mono") parse as one family.
    ctx.font = `${PROBE_SIZE}px "${family}", ${base}`;
    const testWidth = ctx.measureText(PROBE_TEXT).width;
    // A meaningful shift (sub-pixel rounding noise guarded by the epsilon) means
    // the candidate rendered instead of falling back to the baseline.
    if (Math.abs(testWidth - baseWidth) > 0.5) return true;
  }
  return false;
}

/**
 * Probe the curated candidate list and return the families that appear to be
 * installed. `DEFAULT_MONO` is always included (and listed first) so the picker
 * can always represent the built-in default even if detection comes up empty.
 */
export function detectMonoFonts(): string[] {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }

  const detected = MONO_FONT_CANDIDATES.filter((f) => isFontAvailable(f, ctx));

  // Always offer the default first, de-duplicated, preserving candidate order.
  const ordered = [DEFAULT_MONO, ...detected];
  return Array.from(new Set(ordered));
}
