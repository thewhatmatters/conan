# Conan 1.0.2 — Marker-independent session correlation + usage capture reliability

> Restore the Timeline and every correlation-dependent surface after Claude Code 2.1.173 stopped writing per-pid session markers, and harden the /usage capture pipeline (flaky probe, missing Sonnet window).
>
> *Generated 2026-06-11 by generate-prd from in-session.*

## Problem

Claude Code auto-updated to **2.1.173** overnight (2026-06-11 00:46) and
interactive sessions **stopped writing the per-process marker files** at
`~/.claude/sessions/<pid>.json`. The marker write still exists in the binary
but now sits inside a `[concurrentSessions]` registration gated by the statsig
flag `tengu_concurrent_sessions` — reproduced outside Conan: an interactive
`claude` in a plain pty writes no marker; headless `claude -p` still does.

Conan's pty↔session correlation (`src/terminal/correlate.ts`) depends
**entirely** on those markers. With the directory empty, `/api/terminals`
returns `sessionId: null` and `hasLivePty: false`, which takes out — in one
shot — everything a user opens Conan for:

- **Timeline shows "no Claude session yet"** while a session is visibly
  running in the terminal. The Timeline is a core surface of the app.
- **`↻ /context` button gone** (ContextHeader + Widgets gate it on
  `hasLivePty`).
- **`↻ /usage` button gone** (`Widgets.tsx:535` — `if (!hasLivePty) return null`).
- **Compact/handoff action bar dead** (same gate).
- **Passive `/usage`/`/context` capture dropped** — the user runs `/usage` in
  the terminal, the gateway scrapes the frame, then throws it away because
  `correlateClaudeSession` returns null. The HUD silently drifts stale
  (observed: panel at a 7-min-old probe capture of 46%/51% while the live
  terminal showed 52%/52%).

Hooks still work — sessions and events reach the gateway and DB fine. Only
the pty↔session link broke. **Every user whose Claude Code auto-updates hits
this immediately**; 1.0.1 shipped yesterday and the flagship surface is
already dark. Users are going to be pissed.

Two adjacent reliability bugs surfaced during the same QA pass:

1. **Flaky throwaway probe** — a manually triggered
   `GET /api/claude/usage?probe=1` returned `planUtilization: null` (failed
   outright) while a probe ~13 minutes earlier had succeeded, on the same
   machine and version. A failed probe correctly does not clobber the cache,
   but the account-global windows can't reliably self-refresh.
2. **Sonnet window missing from probe captures** — the successful capture had
   `sevenDaySonnet: null` while the live terminal showed
   "Current week (Sonnet only) · 0% used". The parser handles `0%used`
   (`matchWindow`, `src/usage/probe.ts:415`), so the scraped frame most
   likely cut off before the third window rendered.

## Solution

Make correlation **marker-independent** so Conan never again depends on an
undocumented Claude Code internal that can be flag-flipped away, and harden
the usage capture path.

1. **Correlation fallback chain** (priority order):
   1. *Markers* (today's path) — keep as primary when present: cheap and
      exact, and Anthropic may flip the flag back on.
   2. *Hook-reported pid* — the Conan hook (`scripts/hooks/send-event.mjs`)
      runs as a descendant of the live `claude` process; it reports the
      claude pid (walked from its own ppid chain) alongside the session_id
      it already sends. The gateway persists pid→session and correlates by
      checking which hook-reported pid is a descendant of the pty — the same
      structural `ps` walk `correlateClaudeSession` already does, with the
      marker replaced by hook data Conan controls end-to-end.
   3. *cwd + recency* (existing last-resort fallback) — unchanged, but note
      it mis-binds when two tabs share a cwd (the dogfooding setup), so it
      must stay last.
2. **Probe hardening** — diagnose why `?probe=1` fails intermittently on
   2.1.173 (scrape bound vs timing vs TUI change), then fix: longer/adaptive
   capture window, retry-once on empty parse, and surface probe failure in
   the API payload instead of silently returning null.
3. **Sonnet window capture** — ensure the scrape captures the full three-window
   frame (the third window renders last); add a parser/fixture test from a
   real 2.1.173 frame including a `0% used` Sonnet window.
4. **Regression guard** — a gateway-side health signal (log + API field) when
   a running session exists with no correlated pty for >N seconds, so the
   next silent breakage is visible in QA instead of discovered by users.

## UX flow

Invisible repair — no new UI. The acceptance experience is: open Conan,
launch a session, and within seconds the Timeline fills, `↻ /context` and
`↻ /usage` appear, the Compact bar arms under pressure, and running `/usage`
in the terminal updates the HUD panel ("captured 0m ago"). Both free and
premium tiers depend on these surfaces, so the fix is unconditional — no
gating interaction.

## Technical architecture

Touched components (all existing — no new services):

```
scripts/hooks/send-event.mjs     + report claudePid (walk ppid chain to the
                                   nearest `claude` process) on every event
src/gateway/index.ts             + accept/persist claudePid on /api/claude/events
src/db/                          + session.claude_pid column (nullable, idempotent
                                   ALTER on boot)
src/terminal/correlate.ts        + fallback: match pty descendants against
                                   hook-reported pids (DB), markers stay primary
src/usage/probe.ts               + probe retry/bounds fix, Sonnet window capture,
                                   fixture test from a live 2.1.173 frame
src/terminal/index.ts            (consumer — unchanged call sites)
```

Verification points already exposed: `/api/terminals[].sessionId` non-null,
`GET /api/claude/sessions/:id/widgets → hasLivePty: true`, Timeline rows over
`/ws`.

⚠ Build constraints (from CLAUDE.md): edits to `src/gateway/*` /
`src/terminal/*` must not run under the in-dock `tsx watch` session
(footgun #1), and the loop's verification needs `npm run build:sidecar`
before any `tauri:build` (stale-sidecar gotcha).

## Data model

```
session
  + claude_pid INTEGER NULL   -- last hook-reported live pid for this session
```

No other schema changes. `terminal_session`, `event`,
`prompt_consideration` unchanged.

## Pricing

Not applicable — bug-fix patch release; both free and premium surfaces are
broken without it. No pricing change ($29 one-time stands).

## Roadmap

- **v1.0.2 (this loop):** correlation fallback chain (hook pid → gateway →
  correlate), probe hardening, Sonnet window fix, regression-guard signal,
  full QA of the previously blocked surfaces (Timeline rows, US-004 Build
  chip, both ↻ CTAs, passive capture freshness), then `npm run release` +
  GitHub release per the release-conan skill.
- **Later:** watch Claude Code releases for the marker/`tengu_concurrent_sessions`
  flag returning (markers stay the primary path either way); consider
  upstreaming a feature request for a stable session-discovery API.

## Risks

- **cwd+recency last-resort can mis-bind** two sessions in the same
  directory — exactly the dogfooding setup (two `conan` tabs). The
  hook-pid path must land as the real fallback, not the cwd heuristic.
- **ppid-walk fragility:** the hook process's chain to `claude` crosses a
  shell layer; if Claude Code changes how hooks spawn, the walk needs a
  `ps`-based search for the nearest ancestor named `claude` rather than a
  fixed depth. (inferred — exact spawn shape unverified this session)
- **Claude Code is a moving target:** 2.1.173 changed marker behavior via a
  server-side flag; the probe TUI frame can change the same way. Fixture
  tests pin today's shape but a watchdog signal (Solution §4) is the real
  mitigation.
- **Dogfooding footgun:** this loop edits `src/terminal/*` and
  `src/gateway/*` — running it from inside Conan under `tsx watch` kills the
  editing session's own pty. The loop must run externally (`npm start`, or a
  separate checkout).
- **Probe cost:** each throwaway probe burns a real `claude` spawn; retrying
  on failure must cap at one retry to avoid spend creep.

## Open questions

- Why exactly does the `?probe=1` probe fail intermittently on 2.1.173?
  (Untested this session — needs the probe's raw scrape logged once.)
- Was 2.1.172 also affected, or only 2.1.173? (Test was interrupted; matters
  only for understanding blast radius, not for the fix.)
- Does the hook event fire early enough (SessionStart) to correlate before
  the user's first prompt, or does the Timeline need a UserPromptSubmit-time
  catch-up?
- Will `tengu_concurrent_sessions` flip back on server-side? (Out of our
  control; fix must not depend on it either way.)
