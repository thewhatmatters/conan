/**
 * Claude Code's Notification hook fires for genuine permission prompts
 * ("Claude needs your permission to use Bash") AND for an idle "Claude is
 * waiting for your input" nudge after every completed turn. The idle one is
 * noise — nothing needs a response — so it's filtered from every notification
 * surface (native banner, Timeline NOTIF rows, browser toast). Matches by
 * message wording and FAILS OPEN: an unknown or missing message passes
 * through, so a Claude Code wording change re-enables noise rather than
 * silently swallowing permission prompts. Gateway TS and UI TS don't share
 * modules — keep this regex identical to src/timeline/index.ts.
 */
const IDLE_NOTIFICATION_RE = /waiting for your input/i;

export function isIdleNotification(message: unknown): boolean {
  return typeof message === "string" && IDLE_NOTIFICATION_RE.test(message);
}
