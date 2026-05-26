# Conan v4 — backlog to research & decompose into a PRD later

Raw capture of issues + feature ideas found while **QA'ing the shipped v3 build**
(v3 = 48/48 stories, `loop/conan-v3`: multi-project global hook, Overview/Agents/
Skills/Settings nav, real shadcn foundation, broad Claude Code data from disk + CLI).

Same flow as v2/v3: capture raw to-dos here → research the open questions → fold
into a PRD → decompose into a fresh `prd.json` → run `run-tasks.sh`.

**How to log an entry** (newest appended at the bottom):
- **Type:** `BUG` (something shipped is broken/wrong) or `FEAT` (new ask/enhancement).
- **What:** the symptom or ask in plain words — what you saw vs. what you expected.
- **Where:** the view/component/file/route if known (e.g. `Overview`, `Dock.tsx`,
  `/api/claude/...`), and how to reproduce.
- **Open question:** anything to research before it can become a story.
- **Severity** (bugs): blocker / major / minor / cosmetic.

---

## To-dos

<!-- Template — copy per entry:

N. **[BUG|FEAT] <one-line title>.** <what you saw vs expected>.
   - **Where:** <view / component / route / repro steps>
   - **Severity:** <blocker|major|minor|cosmetic>   (bugs only)
   - **Open question:** <what to research before it's a story>

-->

1. **[FEAT] Move Pulse into the right Terminal sidebar; drop the tokens/cost toggle.**
   Pulse feels out of place in the widgets row — but its "is anything happening"
   context makes sense docked alongside the terminal. Explore relocating the Pulse
   chart into the **right-side dock** (the Terminal sidebar), **pinned at the top or
   bottom** of that column. Also **remove the tokens↔cost toggle** — cost is N/A on
   our token-based Claude Max plan (same rationale that killed the cost widget/ceiling
   in v2/v3); Pulse should just show tokens/activity.
   - **Where:** Pulse widget (hand-rolled stacked-area, v2 US-016; data from
     `src/pulse/index.ts`, global across all sessions) currently in the Overview
     widgets row; right dock is `ui/src/components/Dock.tsx` (Terminal|Tasks tabs,
     drag-resize).
   - **Open question:** top vs bottom pin, and how it coexists with the dock's
     Terminal/Tasks tabs + drag-resize (own pinned strip vs. a third tab?). Does it
     stay **global** (recommended — v3 kept Pulse global) or follow the active
     session/cwd once docked next to a terminal? Confirm the toggle removal doesn't
     break the `src/pulse` payload consumers.

2. **[BUG] shadcn/primitive adoption is partial — finish migrating bespoke controls.**
   v3 item 20 was supposed to put every component on shadcn primitives; QA confirms
   the *foundation* shipped but the *migration* did not complete. Several bespoke
   controls that item 20 named are still hand-rolled.
   - **Severity:** minor (a11y/keyboard/focus gap + inconsistency, not broken UX).
   - **Verified state (2026-05-26):**
     - **In place:** `ui/components.json`, `cn()` in `src/lib/utils.ts`, `radix-ui`
       meta-package + `cva`/`clsx`/`tailwind-merge`/`cmdk`/`lucide`, and 11 primitives
       in `ui/src/components/ui/` (badge, button, card, command, dialog, dropdown-menu,
       popover, select, switch, tabs, tooltip).
     - **12/25 app components use a primitive** (mostly v3 view pages: AgentsView,
       SettingsView, SkillsView, PluginsView, CheckpointsView, WhatsNewView,
       UltrareviewView, PromptHistoryView, HooksCoveragePanel, DoctorBanner, CwdPicker,
       Widgets).
     - **Not migrated, but should be** (raw controls where Radix exists):
       - `Dock.tsx` — 5 raw `<button>`; **Term ▾ dropdown + Terminal|Tasks tabs**
         hand-rolled → should be `ui/dropdown-menu` + `ui/tabs`.
       - `SessionBar.tsx` — 6 raw controls; the **`session ▾` picker** is still
         bespoke (no `ui/` import) → `ui/select` or `ui/dropdown-menu`.
       - `Sidebar.tsx` — raw nav `<button>`s.
       - `PendingApprovals.tsx` — raw approve/deny `<button>`s → `ui/button`.
     - **Legitimately exempt** (no primitive needed): Terminal (xterm.js), PulseChart
       (SVG), Toaster (custom), StatCard, TranscriptViewer, ActivityTimeline,
       SessionGlossaryInfo, TaskChecklist, App shell.
     - **Shallow adoption:** dropdown-menu, select, popover, command, switch, tooltip
       are each imported exactly **once** — the bespoke dropdowns/tooltips item 20
       flagged (Term ▾, session ▾) were not the ones converted.
   - **Open question:** scope a finish-the-migration story — list the exact components
     + which primitive each maps to; decide whether StatCard/ActivityTimeline get a
     shared componentized treatment (item 20's "componentize shared patterns": status
     dot, two-tier card, time-ago, scope badge) or stay as-is. Also fix the
     CLAUDE.md/memory note so it reflects "shadcn adopted, migration in progress."

3. **[BUG] Context widget shows "no usage yet" (empty) — and under-captures `/context`.**
   Two layers: (a) the widget renders blank despite a live session + real `/context`
   data; (b) even working, it only reconstructs ONE total %, not the rich category
   breakdown `/context` exposes.
   - **Severity:** major (a headline widget reads empty in normal use).
   - **Symptom:** empty ring + "no usage yet" while `/context` in the terminal shows
     54.4k/1m (5%) with a full breakdown.
   - **Data path (verified):** widget → `GET /api/claude/sessions/:id/widgets` →
     `readWidgets()` (`src/widgets/index.ts:107`) → `readContextUsage()`
     (`src/transcript/index.ts:221`), which scans the session's transcript JSONL for
     the **last assistant message's `usage` block** and sums `input_tokens +
     cache_read_input_tokens + cache_creation_input_tokens`; falls back to the
     `session.context_tokens` DB column, else "no usage yet".
   - **Likely root cause (verify):** `ui/src/App.tsx:87` binds the widget to
     `sessions.find(s => s.status === "running") ?? sessions[0]`. The grid has ~155
     sessions (2 running / 74 idle / 79 error), so it grabs the **first running row**,
     which (i) may not be the live terminal session, and (ii) may have no parseable
     `usage` line or a `session_id` ≠ transcript filename (forked/resumed/`--from-pr`).
     `readContextUsage` then returns null → blank. Also check the session-liveness
     reaper: 79 "error" + 74 "idle" out of 155 smells like stale rows skewing the pick.
   - **Bigger gap (the real ask):** `/context` reports per-category usage — **System
     prompt, System tools, MCP tools, Memory files, Skills, Messages, Free space** —
     but the transcript `usage` block carries only totals, so Conan can't get the split
     from it. Same TUI-only constraint family as `/usage` (v3 item 2). Options to
     research: **(A)** PTY `/context` scrape (spawn PTY → send `/context` → strip ANSI
     → parse categories; brittle but real, mirrors v3's `/usage` Path B); **(B)** compute
     categories from disk — memory files = CLAUDE.md + MEMORY.md sizes, skills =
     SKILL.md sizes, MCP tools from `~/.claude.json`, messages from transcript — an
     approximation Conan can own; **(C)** ship the total-% fix now, layer breakdown later.
   - **Open question:** fix the session binding first (pick the actually-live session,
     not `find(running)`), confirm transcripts carry `usage`, then decide A/B/C for the
     category breakdown. Consider a stacked mini-bar or legend in the widget once split
     data exists.

4. **[BUG] Timeline "Approve" doesn't reach an interactive terminal prompt; only 2 of 3 options.**
   Approving a permission/Notification prompt from the activity timeline showed only
   2 choices (terminal showed 3) and, after hitting Approve, the terminal's prompt was
   untouched — the approval went nowhere.
   - **Severity:** major (the "drive Claude Code" promise silently no-ops for the common
     interactive case, and the UI falsely reports success).
   - **Root cause (verified) — driven-only plumbing:**
     - `listPendingPermissions()` (`src/session/index.ts:805`) iterates **`byLaunchId`
       only** — i.e. sessions Conan *launched* (stream-json driven). The `pending` map is
       populated solely from `control_request:can_use_tool` events (`src/session/parser.ts:215`)
       that **only driven sessions emit**.
     - `decidePermission()` (`src/session/index.ts`) writes a `control_response` to
       **`live.child.stdin`** — a pipe that exists only for a Conan-spawned driven child.
     - An **interactive terminal `claude`** (dock pty / observed session) is in neither
       `byLaunchId` nor `bySessionId`; its TUI prompt is answered by **keystrokes**, with
       no stdin control channel. So a timeline decision can never reach a terminal prompt.
   - **Compounding defects:**
     - **Silent false-success:** `POST /api/claude/sessions/:id/permission`
       (`src/gateway/index.ts:694`) returns `{ ok: true, ...result }` even when
       `decidePermission` returns `delivered: false` (no live driven session / stdin not
       writable). The UI optimistically clears the card (`PendingApprovals.tsx:29`) → looks
       approved, did nothing. **Must surface `delivered:false`** and not clear.
     - **2 vs 3 options:** UI hardcodes `allow|deny` (`PendingApprovals.tsx:4,93-104`); the
       TUI prompt offers 3 (Yes / Yes-and-don't-ask-again / No). The richer
       `permission_suggestions` is captured (`parser.ts:232`) but never surfaced.
   - **Fix directions to research:**
     - **Answer interactive prompts for real:** inject keystrokes into the matching pty
       (write the option index + Enter to the correlated `terminal_session`). True TUI
       driving — brittle but the only path for observed/terminal sessions. Reuse the
       pty↔session correlation from `src/terminal/correlate.ts` (v4 item — `/rename` work)
       to bind a prompt to the right terminal.
     - **Surface the 3rd option** by mapping `permission_suggestions` → buttons.
     - **Honesty floor:** propagate `delivered:false` to the UI; when a prompt belongs to
       an interactive session Conan can't answer, either hide the buttons with an
       "answer in terminal" note or clearly mark it non-actionable.
   - **Open question:** did the card the user approved actually belong to a *different*
     (driven) session than the terminal they were watching? Confirm whether any
     Notification-hook-sourced prompts reach the pending list (they currently can't —
     `listPendingPermissions` is driven-only), which would explain a phantom/mismatched
     card. Decide the scope: keystroke-injection driving vs. honest read-only + "answer
     in terminal."

5. **[FEAT] Transcript view needs a newest/oldest-first sort toggle (like the timeline).**
   The Activity tab's timeline already has a sort toggle (US-021), but the **Transcript**
   tab renders messages in fixed chronological order with no control. Add the same
   newest-first (default) ↔ oldest-first toggle to the Transcript.
   - **Where:** `ui/src/components/TranscriptViewer.tsx` maps `state.messages` in natural
     (oldest-first) order, no sort UI. `ActivityTimeline.tsx:316` already has a reusable
     `SortToggle` ("Newest first" / "Oldest first") + the sort logic at line 79.
   - **Build sketch:** reuse/extract `SortToggle` (lift it out of ActivityTimeline into a
     shared component so both tabs share one control), add a `sortDir` state to
     TranscriptViewer defaulting to **"desc" / newest-first**, and reverse the
     `state.messages` display order accordingly (stable tie-break on `ts`/uuid).
   - **Open question:** default newest-first per the ask — confirm that's wanted for a
     *transcript* (conversations usually read oldest→newest top-to-bottom; newest-first
     means the latest turn is at the top). Tie to v4 item 2's shared-component cleanup —
     SortToggle is a good candidate for the componentization pass.

6. **[FEAT] Live in-Conan preview of the project in the current cwd ("run the app & see it").**
   Conan already *observes and drives* Claude Code editing a project; it should also let
   you **run that project's dev server and see the rendered result inside Conan**, keyed
   to the **cwd Conan is pointed at**. Example: cwd is a Landing Page folder -> click
   "Preview" -> Conan runs `npm run dev` and renders the live page in a panel beside the
   terminal, updating as Claude edits. One window: code on one side, the running app on
   the other. (To be explicit: the preview targets the **current cwd** — the same cwd
   already in `/api/config`, shown in the toolbar, and used to launch the terminal
   `claude`; no new "which folder" concept is introduced.)
   - **Where:** new `src/preview/index.ts` (process manager, mirrors `src/terminal/index.ts`
     node-pty handling); new proxy mount in `src/gateway/index.ts` (single
     `http.createServer(app)` at `:748`, `express.static` at `:741`, manual
     `server.on("upgrade")` WS router at `:825` — all of which the proxy/HMR path plugs
     into); new "Preview" tab in `ui/src/components/Dock.tsx` (sibling to Terminal|Tasks)
     hosting the iframe.
   - **Proposed approach — reverse-proxy, not naive iframe:**
     - **Spawn** the dev command in the cwd via the existing pty mechanism; parse stdout
       for the bound port (e.g. Vite's `Local: http://localhost:NNNN`, which auto-increments
       if taken). Make the command **configurable per cwd** (read `package.json` scripts,
       offer a picker) — not every project is `npm run dev`.
     - **Proxy** `GET /preview/:id/* -> http://localhost:<devport>/*` so the preview is
       **same-origin** with Conan: it inherits the existing token + Origin auth, works over
       `wss://` under TLS (no mixed-content), and lets Conan **strip `X-Frame-Options` /
       CSP `frame-ancestors`** so the iframe always renders (a naive cross-origin
       `<iframe src=:5173>` is fragile — Next.js et al. refuse to frame, and it sits
       outside the auth/Origin model). Adds one dep (`http-proxy-middleware`) — repo
       currently has only `express` + `ws`.
     - **HMR websocket** is the fiddly part: extend the `:825` upgrade handler to also
       route `/preview/:id` WS upgrades to the dev server, and set Vite
       `server.hmr.clientPort`/path so the browser dials hot-reload back through `:3747`
       (not `:5173` directly). Without this the page loads but HMR silently dies.
   - **Open question:**
     - **"Sandbox" scope:** running a project's dev server = executing arbitrary code on
       the host. Conan is loopback-only so blast radius is bounded; decide whether v1 is
       just **run + proxy + preview** (recommended) or attempts real isolation
       (containers/VMs — much bigger lift, probably out of scope for a personal dashboard).
     - **Dogfooding footgun #1** applies: a spawned preview under `tsx watch` dies on
       `src/**` edits — confirm preview processes are managed the safe way (don't tie their
       lifecycle to the gateway's watch restart).
     - Command discovery/picker UX; how preview lifecycle binds to cwd changes (stop/restart
       on cwd switch?); single-preview vs. multiple concurrent; whether to show dev-server
       stdout/stderr (a second pane or fold into the timeline per the "would I tail this?"
       rule).
