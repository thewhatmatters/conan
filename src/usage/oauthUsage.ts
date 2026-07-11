// US-001+: passive OAuth-endpoint usage path — replaces the throwaway pty
// /usage scrape with a direct HTTP call to Anthropic's OAuth usage endpoint,
// authenticated with the same access token Claude Code itself already holds
// in the macOS Keychain. See prd-usage-oauth-endpoint.md for the full design.

import { execFile } from "node:child_process";

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
