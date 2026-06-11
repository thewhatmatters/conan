/**
 * Correlation-health regression guard (1.0.2 US-004).
 *
 * Claude Code 2.1.173 silently stopped writing session markers and Conan's
 * pty↔session correlation went dark with no visible signal — users found out
 * via an empty Timeline. This module tracks that failure shape so the next
 * silent Claude Code behavior change surfaces in QA instead: a session is at
 * status='running' and a live Conan terminal is hosting a `claude` process,
 * yet that terminal has had no correlated session for over a minute.
 *
 * Pure state machine: the terminal module gathers the inputs (process table,
 * DB running count, live ptys) and feeds one sample per reaper tick — no timer
 * of its own. The result is exposed as `correlationDegraded` on
 * GET /api/terminals. Each occurrence logs exactly once (and once again on
 * recovery); the degraded flag holds until a healthy sample clears it.
 */

/** How long the condition must persist before we call correlation degraded. */
const CORRELATION_DEGRADED_MS = 60_000;

/** One observation of the correlation-relevant world, taken per reaper tick. */
export interface CorrelationSample {
  /** Live terminals hosting a `claude` process but with NO correlated session. */
  orphanTerminals: number;
  /** Sessions currently at status='running' in the DB. */
  runningSessions: number;
}

let conditionSince: number | null = null;
let degraded = false;

/**
 * Feed one sample; returns the current degraded state. The condition must hold
 * continuously for {@link CORRELATION_DEGRADED_MS} before the flag trips — a
 * just-launched claude legitimately has no correlation until its first hook
 * event lands, and that startup window must not false-alarm.
 */
export function trackCorrelationHealth(
  sample: CorrelationSample,
  now: number = Date.now(),
): boolean {
  const conditionNow = sample.orphanTerminals > 0 && sample.runningSessions > 0;
  if (!conditionNow) {
    conditionSince = null;
    if (degraded) {
      degraded = false;
      console.log("[conan] pty↔session correlation recovered");
    }
    return degraded;
  }
  if (conditionSince === null) conditionSince = now;
  if (!degraded && now - conditionSince >= CORRELATION_DEGRADED_MS) {
    degraded = true;
    console.warn(
      `[conan] correlation degraded: ${sample.orphanTerminals} terminal(s) hosting a live claude ` +
        `have had no session correlation for >${CORRELATION_DEGRADED_MS / 1000}s ` +
        `(${sample.runningSessions} running session(s)) — Timeline & live-pty surfaces are dark`,
    );
  }
  return degraded;
}

/** Current degraded state — read by GET /api/terminals. */
export function isCorrelationDegraded(): boolean {
  return degraded;
}

/** Reset all tracking (tests only). */
export function resetCorrelationHealth(): void {
  conditionSince = null;
  degraded = false;
}
