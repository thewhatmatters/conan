/**
 * Offline license verification for Conan Premium.
 *
 * The Conan binary ships with the bundled Ed25519 public key below — the
 * matching private key lives only in the conan-license/ Vercel issuer and
 * in 1Password. Verification is offline-by-default; the only network call
 * is a best-effort fetch of the public revocation list (see §7 of
 * docs/v4.7-licensing-design.md), and even that fails gracefully.
 *
 * Used by the planned `useTier()` hook (US-101): if a license is present,
 * verified, and not revoked → tier flips to 'premium'. Anything else → free.
 *
 * Pure function + small surface so it can be tested in isolation. The
 * Tauri-app integration (loading/saving the JWT under
 * ~/Library/Application Support/so.whatmatters.conan/license.jwt) is the
 * caller's responsibility.
 */
import * as ed from "@noble/ed25519";

/**
 * Bundled Ed25519 public key (base64url, 32 raw bytes). Frozen at build time.
 *
 * Generated 2026-05-29 alongside the conan-license/ scaffold. The matching
 * private key lives ONLY in:
 *   1. 1Password (`Conan license Ed25519 private (2026-05)`)
 *   2. The conan-license/ Vercel project env (`LICENSE_PRIVATE_KEY_BASE64`)
 *
 * Rotating this key invalidates every license issued against the previous
 * one — plan a deprecation window first (see conan-license/ README).
 */
export const LICENSE_PUBLIC_KEY_BASE64 =
  "Dda3imbTa4xCOZTa96_Drrl53k89PZwp4Bd34_pCrY4";

/** Expected JWT issuer. Locked. */
const ISSUER = "conan.sh";
/** This build's accepted editions. v1.x builds accept v1 licenses; future
 *  v2.x builds will accept v2, and MAY accept v1 for a grandfathering window. */
const ACCEPTED_EDITIONS = new Set<string>(["v1"]);

/** Parsed + validated license claims. */
export interface VerifiedLicense {
  sub: string;
  email: string;
  tier: "premium";
  iat: number;
  exp: number;
  edition: string;
  polarOrderId: string;
}

/** Discriminated result so callers can render specific error UI without
 *  re-parsing exception messages. */
export type VerifyResult =
  | { ok: true; license: VerifiedLicense }
  | {
      ok: false;
      code:
        | "malformed"
        | "signature"
        | "issuer"
        | "expired"
        | "edition"
        | "revoked"
        | "clock-skew";
      message: string;
    };

/* ─── base64url helpers ──────────────────────────────────────────────────── */

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
}

/* ─── verify ─────────────────────────────────────────────────────────────── */

/**
 * Verify a JWT against the bundled public key + claim invariants.
 *
 * Pass `revokedSubs` from the union of the bundled revocation snapshot and
 * any freshly-fetched /revoked.json (the caller maintains that set; this
 * function only does the lookup).
 *
 * `now` is a hook for tests; in production omit it and we read Date.now().
 */
export async function verifyLicense(
  jwt: string,
  revokedSubs: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
): Promise<VerifyResult> {
  // 1. Structural — three base64url segments.
  const parts = jwt.trim().split(".");
  if (parts.length !== 3)
    return { ok: false, code: "malformed", message: "Not a valid license format" };

  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(headerB64) as typeof header;
    payload = decodeJson(payloadB64) as typeof payload;
  } catch {
    return { ok: false, code: "malformed", message: "Couldn't decode the license payload" };
  }
  if (header.alg !== "EdDSA" || header.typ !== "JWT")
    return { ok: false, code: "malformed", message: "Unexpected license algorithm" };

  // 2. Signature — the most important check. A forged token without the
  //    private key cannot pass this.
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlDecode(sigB64);
  const pub = b64urlDecode(LICENSE_PUBLIC_KEY_BASE64);
  let valid: boolean;
  try {
    valid = await ed.verifyAsync(sig, signingInput, pub);
  } catch {
    valid = false;
  }
  if (!valid)
    return {
      ok: false,
      code: "signature",
      message: "Invalid license — signature does not match",
    };

  // 3. Issuer — exact string match.
  if (payload.iss !== ISSUER)
    return {
      ok: false,
      code: "issuer",
      message: "Invalid license — wrong issuer",
    };

  // 4. Clock skew anti-cheat. If iat is more than 1 day in the future, the
  //    user's clock is wildly off (or someone's trying to backdate revocation).
  const nowSec = Math.floor(now / 1000);
  if (typeof payload.iat !== "number" || payload.iat > nowSec + 86_400)
    return {
      ok: false,
      code: "clock-skew",
      message: "Your system clock appears to be wrong — please correct it and try again.",
    };

  // 5. Expiry — far-future paranoia floor, but we still check.
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    const when = typeof payload.exp === "number"
      ? new Date(payload.exp * 1000).toISOString().slice(0, 10)
      : "?";
    return {
      ok: false,
      code: "expired",
      message: `License expired ${when}`,
    };
  }

  // 6. Edition — this build's accepted set.
  if (typeof payload.edition !== "string" || !ACCEPTED_EDITIONS.has(payload.edition))
    return {
      ok: false,
      code: "edition",
      message: "License for a future version of Conan — please update the app",
    };

  // 7. Revocation.
  if (typeof payload.sub !== "string")
    return { ok: false, code: "malformed", message: "License has no sub" };
  if (revokedSubs.has(payload.sub))
    return { ok: false, code: "revoked", message: "License has been revoked" };

  // 8. Tier — only "premium" is meaningful (no trial path in v0).
  if (payload.tier !== "premium")
    return {
      ok: false,
      code: "malformed",
      message: "Unexpected license tier",
    };

  // Required string fields.
  if (
    typeof payload.email !== "string" ||
    typeof payload.polarOrderId !== "string"
  )
    return { ok: false, code: "malformed", message: "License missing fields" };

  return {
    ok: true,
    license: {
      sub: payload.sub,
      email: payload.email,
      tier: "premium",
      iat: payload.iat,
      exp: payload.exp,
      edition: payload.edition,
      polarOrderId: payload.polarOrderId,
    },
  };
}

/** Show last 8 chars of `sub` as a fingerprint chip in Settings ▸ License.
 *  Keeps the email PII out of the UI by default; recognizable enough for
 *  the user to confirm "yes, that's mine." */
export function licenseFingerprint(sub: string): string {
  return sub.length > 8 ? sub.slice(-8) : sub;
}
