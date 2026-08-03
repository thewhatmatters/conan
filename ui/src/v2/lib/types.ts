/**
 * v2 chat types — presentation-side descriptors only.
 * The gateway and v1 hooks stay untouched; these shape what the Astryx shell
 * holds about the active sidebar selection.
 */

import type { ProviderId } from "../../chat/model.ts";

/** Which agent a fresh turn launches on — the REAL provider union from the
 *  driver seam (this tree once redeclared it and silently dropped kimi). */
export type V2Provider = ProviderId;

/**
 * The thread the content well is hosting — the REOPEN DESCRIPTOR (p2d US-501).
 *
 * `cwd` is required so the first prompt can open a live session. Everything
 * from `sessionId` down is what makes selecting a saved thread continue THAT
 * conversation instead of starting a new one: the gateway relaunches on the
 * saved provider with `--resume <sessionId>`, and (as in v1) the saved
 * model/effort are re-applied so a continued thread stays on the config it
 * started with. A never-sent draft carries no `sessionId`.
 */
export interface ActiveThread {
  /** Stable selection key — the saved thread's session id. */
  key: string;
  cwd: string;
  projectId?: string;
  /** Project display name — the toolbar breadcrumb's parent crumb (US-503). */
  projectName?: string;
  provider: V2Provider;
  title?: string;
  /** Saved session to resume; absent for a thread that has never sent a turn. */
  sessionId?: string;
  /** Launch model of the saved session, re-applied on resume. */
  model?: string | null;
  /** Effort the saved session last used — seeds the chip, never locks. */
  effort?: string | null;
}
