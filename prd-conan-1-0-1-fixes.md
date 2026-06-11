# Conan 1.0.1 — Observability Fixes

> Five investigated defects in Conan's observer surfaces — per-tab cwd in the footer, the vanishing Build chip, false idle notifications on three surfaces, cwd-based tab names, and account-global /usage windows trapped per-tab.
>
> *Generated 2026-06-10 by generate-prd from in-session discussion.*

## Problem

Conan 1.0.0 shipped as a terminal-primary observer for Claude Code, but five
defects undermine the core promise that what you see reflects what's
actually happening:

1. **The footer lies about where you are.** The status-bar cwd (and git
   branch) is one app-wide value that follows the *focused* terminal lazily.
   With tab 1 in `~/Development` and tab 2 in `~/Design`, switching to tab 2
   keeps showing `~/Development` until that tab happens to print a prompt.
2. **The Build chip is invisible while a build loop is running.** The
   Timeline's Build rows (the `run-tasks.sh` trail, formerly the "Loop"
   chip) only exist while `progress.txt` was written in the last 60 seconds
   — but the runner writes once per iteration, and an iteration is a whole
   story taking many minutes. During ~95% of a live loop the user sees
   nothing and concludes the feature is gone.
3. **False "waiting for input" alerts.** Claude Code emits an idle
   notification ~60s after every turn ends. Conan relays it as a macOS
   banner ("Conan is waiting for approval" when nothing needs approval) and
   as a redundant Timeline NOTIF row right after the STOP row. Verified in
   the live DB: 326 idle events vs 273 genuine permission prompts.
4. **Tabs are anonymous.** Un-renamed tabs show positional "Term N" even
   though each tab's working directory is known to the gateway — the user
   can't tell tabs apart without `/rename`-ing every session.
5. **The most important usage number hides in one tab.** The `/usage`
   rate-limit windows (Current session %, Current week) are account-global,
   but Conan caches each capture per session. The user's account sat at
   104% of the 5-hour window — visible in one tab, "Awaiting capture" in
   the other two.

## Solution

A 1.0.x maintenance release (ship as **1.0.1** via the existing auto-update
channel) that makes the observer truthful:

- **Footer follows the active tab.** Switching tabs instantly updates the
  cwd path and git branch to that tab's reality.
- **Build chip means "a loop is running."** The active-window gate matches
  the runner's real write cadence, so the chip and rows persist through an
  iteration instead of blinking for 60 seconds per story.
- **Notifications mean "you're needed."** Permission prompts still banner
  and still log; the post-turn idle nudge is filtered from the native
  banner, the Timeline, and the in-app Toaster.
- **Tabs name themselves.** Default label = the tab's cwd folder name
  (`conan`, `Design`), live-updating on `cd`, with duplicates
  disambiguated; an explicit `/rename` always wins; "Term N" survives only
  as the last resort.
- **Account-global usage is global.** The rate-limit windows render the
  latest capture from *any* session (or probe) on every tab, with a
  freshness hint; only the SESSION block (cost, wall, per-model tokens)
  stays per-tab.

## UX flow

- **Tabs/footer:** open two tabs in different projects → each tab is named
  after its folder; switching tabs flips the footer path + branch
  instantly; `cd` in a tab renames it (unless `/rename`d) and moves the
  footer when that tab is focused.
- **Build loop:** kick off `run-tasks.sh` → the Build chip appears in that
  project's session Timeline and stays for the duration of the run; rows
  age out only after the runner actually stops.
- **Stepping away:** finish a conversation and walk off → no banner. Claude
  hits a permission gate → banner (with the new mascot icon), Timeline
  NOTIF row, click focuses the right tab.
- **Usage tab:** any tab shows "Current session 104% · captured 12m ago"
  the moment any session (or the probe) has captured it; the SESSION cost
  block continues to reflect the active tab's own session.

## Technical architecture

All root causes were verified against code this session (line numbers as of
`main` @ `4448927`):

```
Issue 1 — per-tab cwd (gateway)
  src/terminal/index.ts   maybeAdoptCwd ~303-321: store parsed OSC 7 cwd on
                          the session (new TermSession.lastKnownCwd) BEFORE
                          the focusedTermId gate; same split in
                          pollProcessCwd (~339-355). On {type:'focus'} /
                          input focus change (~586-605): push
                          lastKnownCwd ?? cwd through setActiveCwd() →
                          existing lastCwd WS broadcast → footer.
                          listTerminalSessions (~679): add cwd field.
  Invariant kept: background tabs never call setActiveCwd directly (US-002).

Issue 2 — Build chip window (gateway + UI mirror)
  src/timeline/index.ts   BUILD_ACTIVE_WINDOW_MS = 60_000 (line 11), gate at
                          ~611-615 — widen to cover an iteration (~30 min)
                          or treat active while a run-tasks.sh process is
                          alive (pgrep) with mtime fallback.
  ui/.../Timeline.tsx     client mirror ~752-758 — keep both constants in sync.
  src/tasks/index.ts      progress.txt resolves under getActiveCwd() (8-9);
                          Issue 1 fixes the cwd-lag half.

Issue 3 — idle-notification filter (3 surfaces; needs sidecar rebuild)
  ui/.../useNativeNotifications.ts  ~118: drop /waiting for your input/i
                                    before throttle/send; fail open.
  src/timeline/index.ts   Notification→NOTIF map 221-226 (backfill)
  ui/.../Timeline.tsx     duplicate map 221-226 (live WS) — filter both or
                          hoist a shared isIdleNotification(msg).
  ui/.../Toaster.tsx      check + filter the same relay.

Issue 4 — cwd tab names (UI; depends on Issue 1's cwd field)
  ui/src/hooks/useTerminals.ts  terminalLabel 65-71 → new chain:
                                /renamed name:shortId → cwd basename
                                (dedup: "conan", "conan 2") → "Term N".

Issue 5 — global /usage windows (gateway)
  src/usage/probe.ts      liveCache Map<sessionId, LiveUsage> (~522) holds
                          the whole frame; split: windows portion → one
                          account-global slot {windows, capturedAt,
                          fromSession} written by every capture path
                          (passive, refresh-inject, ?probe=1); reuse/merge
                          with getCachedPlanUtilization rather than a third
                          cache. Widget read path: global windows + per-
                          session SESSION block; "Awaiting capture" only
                          when nothing exists anywhere.
```

Build/verify: every story gates on `npm run typecheck` + `cd ui && npm run
build`; gateway-touching stories need `npm run build:sidecar` before
`tauri:build`/`tauri:dev` (tauri:build alone bundles a stale sidecar). UI
verification via the automate-browser skill against the Vite dev view where
applicable; packaged-app behaviors (notifications, tabs) verified in
`tauri:dev`. Work happens OUTSIDE Conan (dogfooding footgun: editing
`src/gateway/*`/`src/terminal/*` from inside kills the editing pty).

## Data model

No DB schema changes. In-memory/API shape additions only:

```
TermSession        += lastKnownCwd: string | null        (gateway, in-memory)
TerminalSummary    += cwd: string | null                 (GET /api/terminals)
TerminalInfo (UI)  += cwd: string | null                 (useTerminals)
usage global slot   { windows: PlanWindows, capturedAt: number,
                      fromSession: string }              (gateway, in-memory)
```

## Pricing

No change. These are defect fixes shipped free to all 1.x users under the
existing $29-lifetime-1.x license terms; Premium gating (US-102/103) is
untouched — the Build chip remains a Premium surface, it just has to
actually work for Premium users.

## Roadmap

- **v1.0.1 (this PRD):** the five fixes, shipped together via
  `npm run release` + GitHub Releases auto-update.
- **Explicitly out of scope (captured for 1.1 in project memory):**
  Permissions HUD tab (/permissions mirror), Claude Radio video pane
  (unhide the existing /radio/embed iframe — never a second embed).
- **Later:** Polar Go-Live follow-through (checkout link, receipt template,
  paid-path test) — external, blocked on Polar/Stripe KYC, not part of this
  release.

## Risks

- **Self-edit footgun:** building these fixes from inside Conan kills the
  editing session's pty (tsx watch / sidecar restart). Mitigation: work in
  a native terminal; HANDOFF.md already mandates this.
- **Stale-trail regression (Issue 2):** widening the 60s window too far
  re-introduces the original bug (Build chip lingering after a run ends).
  The pgrep-based "runner alive" check avoids the tradeoff but adds a
  process-scan; pick one deliberately.
- **lsof poll frequency (Issue 1):** letting background tabs adopt cwd must
  not run the lsof fallback more often than today
  (CWD_POLL_MIN_SPACING_MS floor must still apply per tab).
- **Notification fail-open (Issue 3):** filtering by message string means a
  future Claude Code wording change silently re-enables the noise (fail
  open is deliberate — better noise than a swallowed permission prompt).
- **Footer fallback disagreement (Issue 1):** `activeSession?.cwd` /
  `config?.cwd` fallbacks in App.tsx:255 can briefly disagree with the new
  focus-push; eyeball on test.
- **Sidecar staleness:** any gateway story tested without
  `npm run build:sidecar` first will appear to "not work" (known gotcha).

## Open questions

- Issue 2: exact mechanism — widened `BUILD_ACTIVE_WINDOW_MS` (what value?)
  vs. pgrep "runner alive" with mtime fallback?
- Issue 4: disambiguation format for duplicate basenames — `conan 2` vs
  `conan:2` vs parent-dir prefix (`Development/conan`)?
- Issue 3: does Toaster.tsx actually relay idle notifications? (Assumed,
  not yet verified in code.)
- Issue 5: merge the global windows slot into
  `getCachedPlanUtilization`/`maybeProbe`'s existing cache, or a sibling
  slot? Exact freshness-hint copy ("captured 12m ago · from contentful")?
- Version/branding: ship as 1.0.1 assumed (inferred — user said "1.0.x
  fixes"); confirm before tagging.
