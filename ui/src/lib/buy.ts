/**
 * Buy Premium / checkout helpers, shared by every upgrade affordance so they
 * all open the SAME Polar checkout through the SAME URL-resolution chain.
 *
 * Before 1.0.5 only Settings ▸ License could open checkout; the Timeline and
 * Pulse paywalls bounced the user to that tab to find a second button. A user
 * who clicks "Upgrade" on a paywall has already decided to pay, so the extra
 * hop was pure funnel friction. These helpers let the paywalls open checkout
 * directly (path of least resistance) while the License tab stays as the
 * post-purchase JWT paste/redemption surface.
 */
import { apiBase } from "./gateway.ts";

/**
 * Default Polar hosted-checkout URL opened when the gateway supplies no
 * override. US-007 makes the live value runtime-configurable via `CONAN_BUY_URL`
 * (surfaced on /api/config as `buyUrl`); this constant is the fallback so the
 * button is never broken. The live "Buy Premium — in-app" checkout link from
 * the Polar dashboard (org `whatmatters`, product `Conan Premium`).
 */
export const BUY_PREMIUM_URL =
  "https://buy.polar.sh/polar_cl_yCw19D7U1STmkUlsNrQkGRwYkeRyr196LeoYJ46vMvd";

/**
 * Open an external URL via Tauri's shell plugin when running in the native app,
 * or `window.open` in the dev/browser context. Dynamic import so the build
 * doesn't hard-fail in non-Tauri environments — matches `lib/nativeNotify.ts`.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    // Browser dev / non-Tauri context: punt to the standard tab opener.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Cached resolved checkout URL. /api/config is the unauthenticated bootstrap
 * route (the UI reads its token from it), and `buyUrl` doesn't change within a
 * session, so we resolve it once on first checkout click and reuse it.
 */
let resolvedBuyUrl: string | null = null;

/**
 * Resolve the live checkout URL: the gateway's `buyUrl` (CONAN_BUY_URL override)
 * when set, else the bundled `BUY_PREMIUM_URL`. Any fetch failure falls back to
 * the bundled link so the button is never dead.
 */
async function resolveBuyUrl(): Promise<string> {
  if (resolvedBuyUrl) return resolvedBuyUrl;
  try {
    const r = await fetch(apiBase() + "/api/config");
    if (r.ok) {
      const c = (await r.json()) as { buyUrl?: string | null };
      resolvedBuyUrl = c.buyUrl || BUY_PREMIUM_URL;
      return resolvedBuyUrl;
    }
  } catch {
    /* fall through to the bundled default */
  }
  return BUY_PREMIUM_URL;
}

/**
 * Open the Polar checkout directly — the one-click path for the Timeline/Pulse
 * paywall "Upgrade" buttons. Resolves the runtime-configurable URL, then opens
 * it externally.
 */
export async function openCheckout(): Promise<void> {
  await openExternal(await resolveBuyUrl());
}
