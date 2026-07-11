// US-003: parseOAuthUsage() against the sample OAuth usage response documented
// in prd-usage-oauth-endpoint.md's Data model section (captured via spike,
// 2026-07-10). Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOAuthUsage } from "./oauthUsage.js";

// Sample response from prd-usage-oauth-endpoint.md — seven_day_sonnet is null
// at the top level, but limits[] carries a weekly_scoped entry (inactive,
// percent 0) whose scope.model.display_name ("Fable") is NOT Sonnet, so it
// must NOT be picked up as the sevenDaySonnet window.
const SAMPLE = {
  five_hour: {
    utilization: 1.0,
    resets_at: "2026-07-11T04:30:00.059203+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 5.0,
    resets_at: "2026-07-13T20:00:00.059227+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day_sonnet: null,
  seven_day_opus: null,
  seven_day_oauth_apps: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: 2000,
    used_credits: 0.0,
    utilization: 0.0,
    currency: "USD",
    disabled_reason: "out_of_credits",
    daily: null,
    weekly: null,
  },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 1,
      severity: "normal",
      resets_at: "2026-07-11T04:30:00.059203+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 5,
      severity: "normal",
      resets_at: "2026-07-13T20:00:00.059227+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      severity: "normal",
      resets_at: null,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: { amount_minor: 2000, currency: "USD", exponent: 2 },
    percent: 0,
    severity: "normal",
    enabled: false,
  },
  member_dashboard_available: false,
};

test("parseOAuthUsage maps limits[] session -> fiveHour, weekly_all -> sevenDay", () => {
  const parsed = parseOAuthUsage(SAMPLE);
  assert.equal(parsed.fiveHour?.utilizationPct, 1);
  assert.equal(parsed.fiveHour?.resetAt, Date.parse("2026-07-11T04:30:00.059203+00:00"));
  assert.equal(parsed.sevenDay?.utilizationPct, 5);
  assert.equal(parsed.sevenDay?.resetAt, Date.parse("2026-07-13T20:00:00.059227+00:00"));
});

test("parseOAuthUsage leaves sevenDaySonnet null when no weekly entry is Sonnet-scoped", () => {
  const parsed = parseOAuthUsage(SAMPLE);
  // The one weekly_scoped entry present is scoped to "Fable", not Sonnet, so
  // it must not be mistaken for the Sonnet window — never a synthesized zero.
  assert.equal(parsed.sevenDaySonnet, null);
});

test("parseOAuthUsage picks up a Sonnet-scoped weekly entry when present", () => {
  const withSonnet = {
    limits: [
      ...SAMPLE.limits,
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 42,
        severity: "normal",
        resets_at: "2026-07-13T20:00:00.000000+00:00",
        scope: { model: { id: "claude-sonnet-5", display_name: "Sonnet" }, surface: null },
        is_active: true,
      },
    ],
  };
  const parsed = parseOAuthUsage(withSonnet);
  assert.equal(parsed.sevenDaySonnet?.utilizationPct, 42);
  assert.equal(parsed.sevenDaySonnet?.resetAt, Date.parse("2026-07-13T20:00:00.000000+00:00"));
});

test("parseOAuthUsage derives status from the worst window (ok/warning/limit)", () => {
  const parsed = parseOAuthUsage(SAMPLE);
  assert.equal(parsed.status, "ok");

  const warning = parseOAuthUsage({ limits: [{ kind: "session", group: "session", percent: 85, resets_at: null }] });
  assert.equal(warning.status, "warning");

  const limit = parseOAuthUsage({ limits: [{ kind: "weekly_all", group: "weekly", percent: 100, resets_at: null }] });
  assert.equal(limit.status, "limit");
});

test("parseOAuthUsage handles a missing/malformed limits[] without throwing", () => {
  const parsed = parseOAuthUsage({});
  assert.equal(parsed.fiveHour, null);
  assert.equal(parsed.sevenDay, null);
  assert.equal(parsed.sevenDaySonnet, null);
  assert.equal(parsed.status, "ok");
});
