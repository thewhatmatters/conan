/**
 * v2 chat types — presentation-side descriptors only.
 * The gateway and v1 hooks stay untouched; these shape what the Astryx shell
 * holds about the active sidebar selection.
 */

/** Which agent a fresh turn launches on. Mirrors the provider chip vocabulary. */
export type V2Provider = "claude" | "codex" | "grok";

/**
 * The thread the content well is hosting. `cwd` is required so the first
 * prompt can open a live session; `provider` defaults to claude at selection
 * time. Real project/thread ids land in p2d — p2a uses a placeholder key.
 */
export interface ActiveThread {
  /** Stable selection key (placeholder title id for the skeleton). */
  key: string;
  cwd: string;
  projectId?: string;
  provider: V2Provider;
  title?: string;
}
