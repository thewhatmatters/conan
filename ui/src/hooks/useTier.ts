/**
 * `useTier()` — the single source of truth for "is this user on Free or Premium?"
 * (US-101). Every gated surface (Timeline depth cap, Pulse range cap, Skills
 * history cap, MCP watchdog) reads this hook to decide whether to enable its
 * Premium behavior.
 *
 * Lifecycle:
 *
 *   1. On app boot, `loadTierFromGateway()` fetches the saved JWT from
 *      `GET /api/license` and verifies it offline with `verifyLicense()`
 *      against the bundled Ed25519 public key.
 *   2. In parallel, `loadRevocationListFromCdn()` does a best-effort fetch
 *      of `https://license.conan.sh/revoked.json` to learn about any subs
 *      revoked since this build was cut. Failure to fetch is silent — the
 *      app is offline-by-default, so honoring a stale list is the correct
 *      tradeoff.
 *   3. The store maintains both the verified license (if any) and the
 *      revocation set, recomputing the effective tier whenever either changes.
 *   4. `saveLicense(jwt)` and `clearLicense()` write through to the gateway
 *      AND verify locally so the hook's state flips immediately — no app
 *      restart, no race with the next render.
 *
 * Why a module-level store + subscribe-pattern instead of React Context:
 *   - The tier is read from many places (every gated component); a Context
 *     forces all consumers to re-render on any unrelated state change in
 *     the same Provider. A subscribe-store re-renders only the components
 *     that depend on the slice that changed.
 *   - Tier needs to be readable from non-React code paths too (the
 *     Tauri app menu, the gateway response middleware), and a module store
 *     trivially exposes a `getCurrentTier()` for that.
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  licenseFingerprint,
  verifyLicense,
  type VerifiedLicense,
  type VerifyResult,
} from "../lib/license.ts";
import { apiBase } from "../lib/gateway.ts";

export type Tier = "free" | "premium";

/** Public state the hook surfaces. Discriminated so consumers can render
 *  specific Premium copy (with expiry, fingerprint) without re-parsing the
 *  JWT every time. */
export interface TierState {
  tier: Tier;
  /** The verified license, when tier === 'premium'. */
  license: VerifiedLicense | null;
  /** Last verify attempt's result, useful for Settings' error rendering. */
  lastVerify: VerifyResult | null;
  /** Subs the bundled snapshot + the fetched /revoked.json union together. */
  revokedSubs: ReadonlySet<string>;
  /** True while the boot-time load is in flight; UI can show a tiny skeleton. */
  loading: boolean;
}

/* ───── Module-level store ──────────────────────────────────────────────── */

let state: TierState = {
  tier: "free",
  license: null,
  lastVerify: null,
  // Bundled revocation snapshot would normally live in
  // `ui/src/lib/revoked.ts`; not yet authored — start with an empty set.
  // Best-effort CDN fetch fills it in on boot.
  revokedSubs: new Set(),
  loading: true,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): TierState {
  return state;
}

/** Replace the state and notify subscribers. Internal — call the named
 *  mutators below rather than this directly. */
function setState(patch: Partial<TierState>): void {
  state = { ...state, ...patch };
  notify();
}

/**
 * Recompute the effective tier from the current license + revocation set.
 * Called whenever either input changes. The verifier already checks
 * revocation, but the revocation set is fetched async — so a license can
 * land verified-ok at t0 and then flip to revoked at t1 when the CDN
 * snapshot arrives. This function bridges that.
 */
function recompute(): void {
  const v = state.lastVerify;
  if (!v || !v.ok) {
    setState({ tier: "free", license: null });
    return;
  }
  // Re-check against the latest revocation set (the verifier may have
  // run when revokedSubs was empty; an arriving snapshot moves the goalpost).
  if (state.revokedSubs.has(v.license.sub)) {
    setState({
      tier: "free",
      license: null,
      lastVerify: {
        ok: false,
        code: "revoked",
        message: "License has been revoked",
      },
    });
    return;
  }
  setState({ tier: "premium", license: v.license });
}

/* ───── Boot-time loaders ───────────────────────────────────────────────── */

/** Fetch the saved JWT from the gateway, verify it offline, update state. */
async function loadTierFromGateway(token: string | null): Promise<void> {
  if (!token) {
    setState({ loading: false });
    return;
  }
  try {
    const r = await fetch(apiBase() + "/api/license", {
      headers: { "x-conan-token": token },
    });
    if (!r.ok) {
      setState({ loading: false });
      return;
    }
    const body = (await r.json()) as { jwt: string | null };
    if (!body.jwt) {
      setState({ loading: false });
      return;
    }
    const verified = await verifyLicense(body.jwt, state.revokedSubs);
    setState({ lastVerify: verified, loading: false });
    recompute();
  } catch (e) {
    console.warn("[useTier] gateway license fetch failed:", e);
    setState({ loading: false });
  }
}

/**
 * Best-effort revocation list refresh. Honored when reachable, silently
 * tolerated when offline. The CDN file is cached 5 min by Vercel, so we
 * don't need to throttle here.
 */
async function loadRevocationListFromCdn(): Promise<void> {
  try {
    const r = await fetch("https://license.conan.sh/revoked.json", {
      // Use cache; the CDN sets Cache-Control: max-age=300.
      cache: "default",
    });
    if (!r.ok) return;
    const body = (await r.json()) as { revoked: string[] };
    if (!Array.isArray(body.revoked)) return;
    setState({ revokedSubs: new Set(body.revoked) });
    recompute();
  } catch {
    // Offline-by-default: failure is silent + the previous revocation set
    // (bundled snapshot once that ships, otherwise empty) stays in effect.
  }
}

/** Idempotent boot — safe to call repeatedly; only the first call with a real
 *  token runs work. Calls with `token === null` are no-ops that DON'T burn the
 *  idempotence flag — App.tsx renders useTier(config?.token ?? null) before
 *  config arrives, so the first effect always sees null. If we started the
 *  boot on that null call, the gateway fetch would early-exit and license
 *  would never rehydrate across restarts (regression seen in 0.1.1).
 *
 *  Revocation list refresh is decoupled — it doesn't need a token, so we run
 *  it on the first call regardless. */
let bootStarted = false;
let revocationStarted = false;
export function bootTierStore(token: string | null): void {
  if (!revocationStarted) {
    revocationStarted = true;
    void loadRevocationListFromCdn();
  }
  if (bootStarted) return;
  if (!token) return; // wait for the real token; useEffect will re-fire
  bootStarted = true;
  void loadTierFromGateway(token);
}

/* ───── Public mutators ─────────────────────────────────────────────────── */

/**
 * Verify + persist + flip a freshly pasted JWT. Returns the verify result
 * so the Settings UI can render an inline error without re-running verify.
 *
 * Order matters: verify FIRST, then PUT, then flip the store. A failed
 * verify never touches disk.
 */
export async function saveLicense(
  jwt: string,
  token: string | null,
): Promise<VerifyResult> {
  const verified = await verifyLicense(jwt, state.revokedSubs);
  if (!verified.ok) {
    setState({ lastVerify: verified });
    recompute();
    return verified;
  }
  if (!token) {
    // No gateway access (shouldn't happen in normal Tauri runs); flip the
    // store anyway so the user sees the change, but warn loudly.
    console.warn("[useTier] no token; license verified but NOT persisted");
    setState({ lastVerify: verified });
    recompute();
    return verified;
  }
  try {
    const r = await fetch(apiBase() + "/api/license", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-conan-token": token,
      },
      body: JSON.stringify({ jwt }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "<unreadable>");
      return {
        ok: false,
        code: "malformed",
        message: `Couldn't save license to disk: ${text}`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      code: "malformed",
      message: `Couldn't save license to disk: ${(e as Error).message}`,
    };
  }
  setState({ lastVerify: verified });
  recompute();
  return verified;
}

/** Delete the saved license + flip to Free immediately. */
export async function clearLicense(token: string | null): Promise<void> {
  if (token) {
    try {
      await fetch(apiBase() + "/api/license", {
        method: "DELETE",
        headers: { "x-conan-token": token },
      });
    } catch (e) {
      console.warn("[useTier] DELETE /api/license failed:", e);
    }
  }
  setState({ lastVerify: null });
  recompute();
}

/* ───── React hook surface ──────────────────────────────────────────────── */

/**
 * Subscribe to the tier store. Returns the full state — destructure what
 * you need (`const { tier, license, lastVerify } = useTier()`).
 *
 * Pass `token` if you need the boot-time load to fire; usually `App.tsx`
 * mounts a single `bootTierStore(token)` once at top level and this hook
 * just reads, but passing it here is a safety net for components mounted
 * before the boot call.
 */
export function useTier(token?: string | null): TierState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (token !== undefined) bootTierStore(token);
  }, [token]);
  return snapshot;
}

/**
 * Non-React reader — for places that need the current tier outside the
 * render tree (the app menu, the gateway fetch middleware, etc.). Always
 * read this fresh; cached references can stale on a flip.
 */
export function getCurrentTier(): Tier {
  return state.tier;
}

/** Short fingerprint used by the Settings banner — proxies through to the
 *  pure helper in lib/license so the hook surface is self-contained. */
export function getLicenseFingerprint(): string | null {
  return state.license ? licenseFingerprint(state.license.sub) : null;
}
