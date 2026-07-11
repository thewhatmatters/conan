// US-001+: passive OAuth-endpoint usage path — replaces the throwaway pty
// /usage scrape with a direct HTTP call to Anthropic's OAuth usage endpoint,
// authenticated with the same access token Claude Code itself already holds
// in the macOS Keychain. See prd-usage-oauth-endpoint.md for the full design.

import { execFile } from "node:child_process";
import type { PlanUtilization, UsageWindow } from "./probe.js";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** Thrown by fetchOAuthUsage on any non-200 response. Never carries the token. */
export class OAuthUsageError extends Error {
  constructor(public readonly status: number) {
    super(`OAuth usage endpoint returned ${status}`);
    this.name = "OAuthUsageError";
  }
}

/**
 * Read the Claude Code OAuth access token from the macOS Keychain entry
 * Claude Code itself writes (`Claude Code-credentials`). Resolves to the
 * token, or null on any expected clean-fallback case: no `security` binary
 * (non-macOS), no matching Keychain entry, unparseable JSON, or a
 * `claudeAiOauth.accessToken` field that's missing (e.g. an entry holding
 * only `mcpOAuth` state). Never throws, never logs the token.
 */
export function readOAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          const token = parsed?.claudeAiOauth?.accessToken;
          resolve(typeof token === "string" && token.length > 0 ? token : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Call Anthropic's OAuth usage endpoint with the token from readOAuthToken().
 * Returns the parsed JSON body on a 200 response. Throws OAuthUsageError on
 * any non-200 response so callers can distinguish success from failure
 * instead of getting a fabricated empty result. Never logs the token.
 */
export async function fetchOAuthUsage(token: string): Promise<unknown> {
  const res = await fetch(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
    },
  });
  if (!res.ok) {
    throw new OAuthUsageError(res.status);
  }
  return res.json();
}

/**
 * One entry in the OAuth usage response's `limits[]` array — preferred over the
 * named top-level fields (five_hour/seven_day/…) per the spike's finding that
 * those can be null while limits[] carries the real data.
 */
interface OAuthLimit {
  kind: string;
  group: string;
  percent: number;
  resets_at: string | null;
  scope?: { model?: { id: string | null; display_name: string | null } | null } | null;
}

function isOAuthLimit(v: unknown): v is OAuthLimit {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.kind === "string" && typeof o.group === "string" && typeof o.percent === "number";
}

function extractLimits(json: unknown): OAuthLimit[] {
  if (!json || typeof json !== "object") return [];
  const limits = (json as Record<string, unknown>).limits;
  return Array.isArray(limits) ? limits.filter(isOAuthLimit) : [];
}

/** A weekly limit scoped to a Sonnet model — distinct from the all-models weekly_all entry. */
function isSonnetScoped(limit: OAuthLimit): boolean {
  return (
    limit.group === "weekly" &&
    limit.kind !== "weekly_all" &&
    /sonnet/i.test(limit.scope?.model?.display_name ?? "")
  );
}

function windowFromLimit(limit: OAuthLimit | undefined): UsageWindow | null {
  if (!limit) return null;
  const resetAt = typeof limit.resets_at === "string" ? Date.parse(limit.resets_at) : NaN;
  return { utilizationPct: limit.percent, resetAt: Number.isNaN(resetAt) ? null : resetAt };
}

/** ok below 80%, warning from 80%, limit at/above 100% — by the worst window. */
function deriveOAuthStatus(...windows: (UsageWindow | null)[]): "ok" | "warning" | "limit" {
  const max = Math.max(0, ...windows.filter((w): w is UsageWindow => !!w).map((w) => w.utilizationPct));
  if (max >= 100) return "limit";
  if (max >= 80) return "warning";
  return "ok";
}

/**
 * Normalize an OAuth usage response into Conan's existing PlanUtilization
 * shape (the same one probeUsage() produces), so the UI needs zero changes.
 * Sources window data from limits[] (see OAuthLimit); a missing/null window
 * maps to a null UsageWindow slot, never a synthesized zero-value window.
 */
export function parseOAuthUsage(json: unknown): PlanUtilization {
  const limits = extractLimits(json);
  const fiveHour = windowFromLimit(limits.find((l) => l.kind === "session"));
  const sevenDay = windowFromLimit(limits.find((l) => l.kind === "weekly_all"));
  const sevenDaySonnet = windowFromLimit(limits.find(isSonnetScoped));
  return {
    fiveHour,
    sevenDay,
    sevenDaySonnet,
    status: deriveOAuthStatus(fiveHour, sevenDay, sevenDaySonnet),
    probedAt: Date.now(),
  };
}
