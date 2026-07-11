// US-001+: passive OAuth-endpoint usage path — replaces the throwaway pty
// /usage scrape with a direct HTTP call to Anthropic's OAuth usage endpoint,
// authenticated with the same access token Claude Code itself already holds
// in the macOS Keychain. See prd-usage-oauth-endpoint.md for the full design.

import { execFile } from "node:child_process";

const KEYCHAIN_SERVICE = "Claude Code-credentials";

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
