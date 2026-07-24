# Conan — project context for Claude Code

> ⚠️ **CURRENT ARCHITECTURE (2026-07-24): Conan is CHAT-PRIMARY, not
> terminal-primary — and MERGED TO `main`.** Conan drives Claude Code, Codex,
> and Grok **headlessly** (stream-json/JSONL child processes normalized through
> the `AgentDriver` seam, over a `/ws/agent` WebSocket) behind a **custom chat
> UI** — a project-grouped thread sidebar + streaming transcript + interactive
> tool-approval + a fused prompt/skill/tool activity spine + a sigil composer
> (`@` files · `$` skills · `/` commands). The **terminal (`xterm.js`) surface
> and the DevTools HUD are REMOVED from the mounted UI** (`App.tsx` renders
> `ChatSurface`); the pty / HUD / Timeline code below remains in the repo but
> is **DORMANT** (unmounted, kept for reference/possible reuse). Live working
> state lives in **project memory** (the checkpoint entry auto-loads each
> session — `HANDOFF.md` is retired); task lists are
> `docs/chat-v1-qa-backlog.md` + `docs/t3-port-backlog.md`. The sections below
> still describe the dormant terminal-era subsystems and are accurate only as
> history for those. The stack, conventions, and gotchas below remain current.

Conan **was** a terminal-primary native desktop app (Tauri v2) that wrapped and
observed Claude Code: an `xterm.js` terminal as the main surface plus a
DevTools-style widget HUD (Usage · Skills · Agents · MCP) backed by
one loopback Node gateway packaged as a Tauri sidecar. That shell is now
dormant (see the note above). This file is auto-loaded by every Claude Code
session in this repo — keep it accurate.

## Stack
- **Gateway** (`src/`): TypeScript ESM, Express 4 + `ws` + `better-sqlite3` +
  `node-pty`. Run with `tsx`. Entry `src/gateway/index.ts`, port **3747**,
  loopback-only.
- **UI** (`ui/`): Vite + React 19 + TypeScript + Tailwind v4 (CSS-first,
  `@theme inline` + `.dark` in `ui/src/index.css`). Loaded by the Tauri
  webview (bundled frontend); dev uses the Vite server (:5173). The gateway
  is JSON-API + WebSockets only — it does **not** serve the UI to a browser.
  `xterm.js` (`@xterm/*`) for the terminal.
- **Desktop** (`src-tauri/`): a Tauri v2 crate that opens a native window
  onto the React + `xterm.js` UI and spawns the gateway as a bundled-node
  **sidecar** (`scripts/build-sidecar.mjs`).

## Run / build / verify
```bash
npm install                 # postinstall fixes node-pty's spawn-helper perms
npm run dev                 # gateway, tsx WATCH, :3747   (see footgun #1!)
npm start                   # gateway, NO watch (safer when self-editing)
cd ui && npm run dev        # Vite dev :5173, proxies /api + /ws -> :3747
npm run build               # root: typecheck + build ui   (CI gate)
npm run typecheck           # tsc --noEmit (gateway)

npm run build:sidecar       # (re)build the gateway sidecar binary + runtime/
npm run tauri:dev           # dev: Vite + native window + live sidecar
CI=true npm run tauri:build # bundle Conan.app + .dmg (CI=true for headless DMG)
```
- **Every change must `npm run typecheck` clean** (gateway) and
  `cd ui && npm run build` clean before commit.
- **Verify UI changes in a browser** with the `automate-browser` skill
  (screenshots, real interaction) — UI changes aren't done until visually
  checked.

## Chat architecture (CURRENT — the mounted app)
The chat-primary stack, built on `loop/conan-chat-v1` → `loop/conan-multi-provider`,
merged to `main` 2026-07-24.

**Run/QA (chat dev stack):** `npm start` (gateway :3747, NO watch — restart
manually after any `src/` edit; a stale gateway 404s new routes) +
`cd ui && npm run dev` (:5173). After ANY gateway restart verify BOTH ports —
vite drops silently; a stale `ui/node_modules/.vite` cache white-screens
(rm -rf + restart). Browser QA drives :5173 via the `automate-browser` skill;
per-story verification uses a throwaway stack (`CONAN_PORT=3799
CONAN_DATA_DIR=/tmp/x npm start` + `CONAN_PORT=3799 CONAN_UI_PORT=5199 npm run
dev` + `CONAN_ALLOWED_ORIGINS=http://localhost:5199`) so dev :3747 is never
touched. Playwright: panes are mounted-but-hidden — use `textarea:visible`.
Autonomous build loop: `run-tasks.sh` iterates a fresh agent over `prd.json`
(provider-agnostic via `AGENT_CMD`, e.g. `AGENT_CMD="claude -p
--permission-mode bypassPermissions" ./run-tasks.sh`; run detached; each story
commits on pass; decompose backlogs with the `decompose-prd` skill).
- **Backend `src/agent/` — MULTI-PROVIDER (T3-1, 2026-07-23).** The
  `AgentDriver` seam (`driver.ts`) now carries a `readonly capabilities:
  AgentCapabilities` descriptor (streamingDeltas / interactiveApproval /
  livePermissionSwitch / costUsd / reasoningText / resume + `permissionModes`
  in the provider's own vocabulary) and three drivers behind it:
  - `ClaudeDriver` (`claude.ts`): spawns `claude --print --output-format
    stream-json --input-format stream-json --verbose
    --include-partial-messages`, one process per session. Token-streaming,
    graceful interrupt (stdin `control_request`), **interactive tool-approval**
    via `--permission-prompt-tool stdio`, live permission-mode switch via
    `set_permission_mode` — **subscription auth, never `ANTHROPIC_API_KEY`**
    (the `sk-ant-oat*` gotcha). reasoningText FALSE (D2: headless claude
    redacts thought text).
  - `CodexDriver` (`codex.ts`): **one process per turn** — `codex exec --json`
    fresh, `codex exec resume <thread_id>` for later turns; prompt as argv +
    `stdin:'ignore'` (codex reads stdin when piped). No deltas, no $, no
    interactive approval; permission maps to `--sandbox
    read-only|workspace-write|danger-full-access`.
  - `GrokDriver` (`grok.ts`): one process per turn — `grok -p … --output-format
    streaming-json`, `--resume <sessionId>`. Token deltas, REAL reasoning
    text, `total_cost_usd`; no headless approval (approval-needing tools
    cancel the turn in `default` mode).
  `registry.ts` = the provider table (id/name/avatar letter C·X·G/binary/
  capabilities/factory) + login-shell install probe (10min TTL) behind
  `GET /api/agent/providers`. `index.ts` is the `/ws/agent` WS handler; the
  prompt frame carries `provider`, the driver is built from the registry
  (unknown/uninstalled → readable error event, never a silent claude
  fallback), and its capabilities are pushed to the client once at session
  start as `{type:'capabilities'}`.
- **Persistence (`src/db/`)** — `project` + `chat_thread` tables (thread rows
  carry a `provider` column, null = 'claude' for pre-migration rows). Threads
  are metadata-only; transcripts are **reconstructed from Claude's own JSONL**
  on reopen (`src/agent/history.ts`) and continued with `--resume`. A resumed
  thread relaunches its OWN provider. ⚠ History reconstruction is
  **Claude-only**: reopened codex/grok threads show a "history couldn't be
  found" banner and degrade to a fresh session (context lost) — plus an open
  grok bug (saved reported model `grok-4.5-build` is not a valid `-m` id →
  exit 1). Honest per-provider QA matrix: `docs/multi-provider-qa.md`.
  Routes: `GET/POST /api/agent/projects`, `DELETE
  /api/agent/threads/:sessionId`, `GET /api/agent/threads/:id/transcript`.
- **UI (`ui/src/`)** — `App.tsx` mounts `ChatSurface.tsx` (project-grouped thread
  sidebar; per-thread avatar letter resolves the persisted provider against the
  registry) → N `ChatPane.tsx` (one per thread, own `useAgentChat.ts` WS +
  process, mounted-but-hidden). The transcript is **capability-driven — no
  provider-name branching**: streamed text or an honest Working indicator
  (`streamingDeltas`), collapsed "Thinking" rows only where `reasoningText` is
  real (grok; hidden for claude per D2), tool cards w/ inline diffs, plan
  cards, per-turn footer showing $ (`costUsd`) or token counts. The permission
  chip renders `capabilities.permissionModes` (Codex shows its sandbox
  vocabulary; Supervised absent); `!interactiveApproval` hides the approval
  UI; `!livePermissionSwitch` notes "applies from the next turn".
  `ActivitySpine.tsx` = the fused prompt/skill/tool tick rail. Composer:
  provider chip (from `GET /api/agent/providers`, uninstalled = disabled w/
  tooltip, **locks after turn 1**) + model + permission chips +
  `ComposerAutocomplete.tsx` (`@` files/folders · `$` skills · `/` commands).
  `ProjectPicker.tsx`/`DirBrowser.tsx` = per-project folder pick.
- **Dormant (in repo, unmounted):** `TerminalPane`/`Terminal`, `Hud`/`Widgets`/
  `Timeline`/`PulseChart`/`*Widget`, `RadioBar`, `StatusBar`, `src/terminal/*`,
  `correlate.ts`, `terminal_session` table, and their gateway routes. The
  Architecture section below documents these — accurate for the dormant code,
  NOT for the mounted app.

## Architecture (DORMANT terminal-era subsystems — history, see note at top)
- **Glossary — "Session":** one Claude Code *run* (an agent conversation),
  keyed by `session_id`. Conan tracks its events, tool calls, token/cost,
  and status (running/idle/error). Sessions are **observed** — any hooked
  `claude` self-reports over the WS. NOT a browser/login session.
- Routes (only what the app calls): `GET /api/health`, `GET /api/config`
  (`{token, port, cwd}`), `GET /api/tasks` (build-loop trail for projects
  that ship a `prd.json`/`progress.txt` — Conan itself does not),
  `GET /api/terminals`, `GET /api/claude/sessions`,
  `GET /api/claude/sessions/:id/widgets` (Context breakdown),
  `GET /api/claude/usage` (`+?probe=1`), `GET /api/claude/pulse`,
  `GET /api/claude/skills` (carries `lastFiredAt` per skill),
  `GET /api/claude/agents` (installed subagent `.md` files — user + project +
  plugin — with frontmatter name/description/tools/model),
  `GET /api/claude/mcp` (`+?force=1`; shells `claude mcp list`),
  `GET /api/claude/config` + `POST /api/claude/config`,
  `GET /api/claude/timeline?session=…&since=…&limit=…`,
  `GET /api/doctor/claude` (install detection), and
  `POST /api/claude/events` (hook ingestion).
- WS: `/ws` carries app events + `{type:'tasks'}` + `{type:'skill-fired'}`,
  `{type:'skill-considered'}`, `{type:'plan'}`, and `{type:'usage-captured'}`
  broadcasts, snapshot on connect; `/ws/terminal` (node-pty). **Both
  authenticated on upgrade.**
- Auth (`src/gateway/auth.ts`): token (`CONAN_AUTH_TOKEN` |
  `.data/auth-token` | generated) + **Origin allowlist** — required because
  browsers don't apply same-origin policy to WebSockets (CVE-2025-52882). The
  app reads the token from same-origin `/api/config`. The gateway binds
  **loopback-only** (127.0.0.1).
- Terminal (`src/terminal/index.ts`): pty auto-launches `claude`
  (`mode=claude`, default) in the active cwd via a login shell;
  `mode=shell` for a plain shell.
- DB (`src/db/`): SQLite WAL at `.data/conan.db`; tables `session`, `event`,
  `terminal_session`, `prompt_consideration`. Idempotent init on boot.
- pty↔session correlation (`src/terminal/correlate.ts`): maps the live
  `/ws/terminal` pty to its `session_id`, and carries the
  **keystroke-injection** path used to run TUI slash commands (answer
  interactive prompts; inject `/context`, `/handoff`).
- Usage / Context capture (`src/usage/probe.ts`): pure ANSI-strip + bounded
  scrape + testable frame parsers (`parseUsageFrame`, `parseContextFrame`).
  Two capture paths: a **throwaway probe** for the account-global `/usage`
  rate-limit windows (`/api/claude/usage?probe=1`, macOS-preferred by the
  OAuth poller — see below), and **live-pty capture** for session-specific
  `/context` and `/usage` Session-block frames (passive when the user runs
  the command). Disk estimates (MCP/skills/memory size readers) are the
  labelled `≈ estimated` fallback. **Orphaned since the Context tab/banner
  removal:** `POST /api/claude/sessions/:id/context/refresh`,
  `GET/POST /api/claude/context/autorefresh`, and
  `POST /api/claude/sessions/:id/handoff` (the Context-pressure Compact
  action) still exist in the gateway but have no UI caller left — candidates
  for a follow-up backend cleanup pass, not removed yet.
- OAuth usage poller (`src/usage/oauthUsage.ts`, macOS-only): passively polls
  Anthropic's OAuth usage endpoint (token from the macOS Keychain entry
  `Claude Code-credentials`, never logged) on a background interval
  (`CONAN_OAUTH_USAGE_POLL_MS`, default 60s) — no pty, no throttle. `GET
  /api/claude/usage` prefers its cache over both the pty-probe
  `planUtilization` AND the pty-capture-only account-global windows slot
  (`getGlobalUsageWindows()` in `src/usage/probe.ts`), falling back to the
  pty paths untouched when the OAuth cache is empty (non-macOS, Keychain
  read failed, endpoint call failed). Replaced the old manual ↻ /usage
  refresh button (`UsageRefreshButton`, `POST
  /api/claude/sessions/:id/usage/refresh`) — removed once both windows and
  the per-session Session block became passively fresh with no user action.
  `GET /api/claude/usage` also tags which path produced the windows —
  `usageSource: "oauth" | "pty-probe" | null` — surfaced as an `· oauth` /
  `· pty fallback` badge in the Usage tab's sub-header (`Widgets.tsx`), since
  the two sources have very different freshness (passive ~60s vs throttled
  5min) but otherwise render identically.
- Doctor (`src/doctor/claude.ts`): cached (10min TTL) Claude Code install
  detection — probes via interactive login shell, falls back to historical
  `session.claude_version` from the DB. Drives the install banner.
- UI: `App.tsx` shell renders `components/TerminalPane.tsx` (N `Terminal.tsx`
  tabs in a **real VS-Code-style tab strip**, mounted-but-hidden so switching
  never tears down a pty; a `StatusBar.tsx` cwd/branch footer below; and an
  optional **per-tab `Timeline.tsx` split panel** toggled via
  `PanelRightOpen` next to `+` or `⌘\` — tethered visually to the terminal
  so its rows describe THAT session's hooks/skills/plan/loop/build) beside
  `components/Hud.tsx` (the DevTools-style widget HUD). Agent spawns
  (`kind:"agent"` rows, backend in `src/timeline/index.ts`) render inline in
  the Timeline's classic feed — an icon+status-colored "AGENT" pill (running
  = pulsing primary, done = the same dim treatment `skill-considered` rows
  use) plus an always-visible detail card (model/tools/duration/tokens),
  same pattern as the nested "Skills considered" card under PROMPT rows.
  Two other placements were tried and dropped: a toggle inside the Timeline
  split panel (buried, nobody opened it), then a dedicated
  `AgentLanesBar.tsx` toolbar + `AgentLanes.tsx` waterfall popover above the
  terminal (the popover itself didn't land — dogfooding feedback). Both were
  deleted; identity now lives in the row label, not a comparative
  multi-agent view. Free tier: AGENT rows are Premium-masked the same way
  SKILL/PLAN/LOOP/BUILD already are. The Timeline's row-kind filter is a
  `FilterDropdown` (multiselect `DropdownMenu`, not a chip row — a chip
  stopped scaling once Agents joined the set): "All" is the first item,
  separated and single-select-only; every other kind (Hooks always visible,
  Skills/Plan/Loop/Build/Agents Premium-gated) is an independent checkbox
  that keeps the menu open on toggle. The HUD tabs are **Usage · Skills ·
  Agents · MCP** — `Widgets.tsx` (Usage; folds in the Pulse throughput chart
  via `PulseChart.tsx`), `SkillsWidget.tsx`, `AgentsWidget.tsx` (installed
  subagent *definitions*, static — distinct from the Timeline's live runtime
  spawns), `McpWidget.tsx` — the Context tab/banner (`ContextHeader.tsx`)
  was removed once Claude Code's own statusline started surfacing live
  context % directly in the terminal, making the scraped/estimated Context
  view redundant — with a `RadioBar.tsx` (Claude Radio play/pause,
  gateway-hosted YouTube iframe at `/radio/embed`) pinned at the HUD's
  bottom. The session-scoped tabs follow the **active terminal tab**.
  `SettingsView.tsx` is the tabbed Status/Config dialog (⌘,). Charts live in
  `components/charts/` (vendored Tremor `AreaChart`/`ProgressCircle`). Hooks
  `hooks/{useTheme,useTasks,useWidgets,usePulse,useUsage,useSessions,
  useTerminals,useSkills,useAgents,useMcp,useConfig,useDoctor,
  useNativeNotifications}.ts`; `lib/{chartUtils,nativeNotify,appMenu,
  gateway}.ts`.

## Conventions
- **Semantic theme tokens only** — `bg-background`, `text-foreground`,
  `bg-card`, `border-border`, `text-muted-foreground`, `bg-term-bg`. Never
  hard-code `neutral-*`/hex in components. Light is default; dark via
  toggle. The terminal theme derives from the same tokens
  (`getTerminalTheme()`).
- **shadcn primitives** in `ui/src/components/ui/*` (`button`, `select`,
  `dropdown-menu`, `tabs`, …) — reach for these for any new control; the
  semantic token names match shadcn so they drop in cleanly.
- **Secondary toolbars are always `h-9 shrink-0` — a fixed height, not
  padding that happens to land close.** Every in-panel header bar (HUD tab
  headers via `shared/HudTabHeader.tsx`, `Timeline.tsx`'s own header,
  `FileExplorer.tsx`'s breadcrumb header, the Files/Timeline switch) must
  match exactly so panels read as one consistent chrome, not
  slightly-different bars. This drifted twice in one session (`py-1.5`
  instead of `h-9`, `text-sm` instead of the `text-[11px]
  text-muted-foreground` title convention) — check new/edited toolbars
  against an existing one (e.g. `HudTabHeader`) before shipping, don't just
  eyeball it.
- **TODO: `FileExplorer.tsx`'s scrollbar doesn't match Timeline/Terminal.**
  The discreet 6px themed scrollbar (`aside .overflow-auto` in `index.css`)
  is scoped to elements inside an `<aside>` wrapper — Timeline and the HUD
  panels get it automatically because they're `<aside>`-rooted. `FileExplorer`'s
  scroll container is a plain `<div className="... overflow-y-auto ...">`,
  which matches neither the `<aside>` ancestor nor the literal `overflow-auto`
  class the CSS selector targets, so it falls back to the default OS
  scrollbar. Fix: either wrap it in `<aside>` (matching Timeline) or switch
  the selector/class so `overflow-y-auto` qualifies too — check FadeScroll.tsx
  isn't a cleaner fit first, since Timeline/HUD panels use it already.
- **Charts ride Tremor Raw** (recharts-based, Tailwind-v4-native copy-in
  components vendored under `ui/src/components/charts/`), themed through
  `ui/src/lib/chartUtils.ts` so colors resolve to the `--color-chart-1..5`
  CSS vars and honor light/dark. Use Tremor for any new chart; do **not**
  install `@tremor/react` (Tailwind v3 only).
- **CORS reflector + WS Origin allowlist** apply to **every** new gateway
  endpoint — required because WKWebView is strict about non-same-origin
  fetches from `tauri://localhost`.
- **Gateway is single-instance on :3747.** On startup, if the port is
  already bound, exit immediately with a clear message — never crash with a
  raw `EADDRINUSE` stack. Override with `CONAN_PORT`.
- **The Timeline must auto-surface activity so nobody needs a terminal
  `tail`.** It renders, live over the app WS: Claude Code hook events
  (`{type:'event'}`), skills-fired + skills-considered (BM25 heuristic),
  plan rows (TodoWrite/ExitPlanMode), `/loop` rows, and the build trail.
  Treat "would I otherwise tail a file to watch this?" as a signal it
  belongs in the Timeline.

## Gotchas
- **node-pty spawn-helper** ships non-executable → `posix_spawnp failed`.
  Fixed by `scripts/fix-node-pty.mjs` (postinstall). Re-run `npm install`
  if it recurs.
- **OAuth tokens (`sk-ant-oat*`) are blocked for third-party API calls.**
  The *interactive* terminal `claude` uses your normal CLI login (fine).
  Any headless API path must use `ANTHROPIC_API_KEY`.
- **WKWebView CORS strictness** — fetches from `tauri://localhost` against
  `http://127.0.0.1:3747` need explicit `Access-Control-Allow-Origin`
  reflection (see the CORS middleware in `src/gateway/index.ts`); the WS
  Origin allowlist alone is not enough.
- **Ad-hoc signing rotates the CDHash on every rebuild**, so macOS TCC
  re-prompts for permissions each time. Use a stable Developer-ID
  Application certificate (see `docs/tauri-desktop.md`) to make TCC grants
  persist.

## ⚠️ Dogfooding footguns (running Claude inside Conan to edit Conan)
1. **Gateway under `tsx watch` (`npm run dev`) restarts on `src/**` edits
   and kills ALL ptys — including the in-dock session making the edit.**
   If you must build from inside the dock, run the gateway with `npm start`
   (no watch) and **avoid editing `src/gateway/*` or `src/terminal/*` from
   the in-dock session.**
2. **Hiding the dock / reloading the UI / UI HMR currently kills the pty**
   (WS-close → `term.kill()`). Don't reload while a session is mid-task.
3. Safest model: run the *editing* session externally (or a separate Conan
   instance on another port) and use this dashboard to **observe**.

## Roadmap
- **`docs/v4.7-licensing-design.md`** — Ed25519 JWT licensing (offline
  verification, Polar.sh issuance).
- **`docs/v4.7-update-design.md`** — Tauri-plugin-updater + minisign
  signing + Cloudflare R2 hosting.
- **`docs/tauri-desktop.md`** — Developer-ID sign + notarize path for
  distribution; `npm run release` is the locked end-to-end flow
  (sign + notarize + staple); `CI=true npm run tauri:build` headless-DMG note.
- **`docs/sidecar.md`** — sidecar build internals (relocatable C launcher
  + `runtime/` tree with Node and the native addons as real files).
- **`docs/global-hooks.md`** — global `~/.claude` hook setup so any
  `claude` run anywhere self-reports.

## v0.1 → v1.0 launch progress (as of 2026-05-30)

**Decided + locked.** Production domain `conan.sh`; first public release
is `1.0.0` (skipping the v0.x semver); JWT `edition = "v1"`;
`ACCEPTED_EDITIONS = {"v1"}`. License is **$29 one-time, lifetime 1.x,**
no trial, no subscription, no per-device limit, day-one paid. Polar.sh
is the Merchant of Record. Org slug `whatmatters`, product name
`Conan Premium`. See [docs/v4.7-licensing-design.md](docs/v4.7-licensing-design.md)
§1 + §5 + §11 for the full table.

**Gating model: depth of insight, not depth of history** (decided
2026-05-30 — replaces the original 7d/90d Timeline + 1h/24h Pulse
history caps, which fail the WTP test for a live tool). Free gives a
useful Claude observer (live terminal, Context, Usage, basic Timeline:
PROMPT + tool calls + STOP + SESSION). Premium adds the insight layer:
SKILL? scoring rows, PLAN rows, LOOP rows, BUILD rows, token chips,
click-to-expand POSTTOOL payloads, Pulse 6h/24h, Skills `last fired`,
MCP auth watchdog. Timeline cap is **50 rows in current session**, with
an end-of-list "[ See what Premium adds — $29 ]" footer. See
[docs/v4.7-licensing-design.md](docs/v4.7-licensing-design.md) §12 for
the full free/premium matrix.

**Built + working.**
- ✅ Developer ID signing + notarization end-to-end via `npm run release`
  (Apple Developer Team `4P6GX328VY`, identity in login Keychain,
  app-specific password under `notarytool` keychain profile `conan-notarize`).
  Produces a Gatekeeper-accepted `.app` + `.dmg`; `spctl --assess` reports
  `source=Notarized Developer ID`.
- ✅ Ed25519 keypair generated; **private key only in 1Password + Vercel
  env**; public key bundled into [ui/src/lib/license.ts](ui/src/lib/license.ts).
- ✅ `conan-license/` separate repo
  ([github.com/thewhatmatters/conan-license](https://github.com/thewhatmatters/conan-license))
  deployed to Vercel at **`https://license.conan.sh`**. Upstash KV
  attached, `KV_*` env vars auto-injected.
- ✅ End-to-end loop verified: issuer signs JWT → Conan UI's
  `verifyLicense()` returns `{ok: true}` with all 7 claims round-tripping.
  Synthetic webhook test (`scripts/test-webhook.mjs` in conan-license)
  proves Polar HMAC verify + JWT mint + KV write all work in production.
- ✅ Polar org `WhatMatters` configured; product `Conan Premium` ($29
  one-time, ⚠ Polar product price still $39 — update in dashboard) exists;
  webhook → `license.conan.sh/api/polar-webhook` with
  `order.created` + `order.refunded`; Organization Access Token created
  in **Settings → Preferences → Developers** section (scroll to bottom).
- ✅ **US-101** — `useTier()` hook + license loader/saver
  ([ui/src/hooks/useTier.ts](ui/src/hooks/useTier.ts), gateway routes
  `GET/PUT/DELETE /api/license`, storage at `$CONAN_DATA_DIR/license.jwt`,
  best-effort revocation list refresh from `license.conan.sh/revoked.json`).
- ✅ **US-106** — Settings ▸ License tab (banner, masked paste field with
  show/hide toggle, Apply button, inline error from `VerifyResult`, Remove
  button when Premium, Buy Premium button → `openExternal(BUY_PREMIUM_URL)`
  via Tauri shell plugin). `BUY_PREMIUM_URL` in
  [SettingsView.tsx](ui/src/components/SettingsView.tsx) carries the live
  Polar checkout link (`https://buy.polar.sh/polar_cl_yCw19…`, wired
  2026-06-12); runtime-overridable via `CONAN_BUY_URL`.

**Also built + working (formerly the "Resume here" backlog):**
- ✅ **US-102** — Timeline insight gating, shipped on main
  ([Timeline.tsx](ui/src/components/Timeline.tsx)): hard-wall blur at
  `FREE_VISIBLE_LIMIT = 50` rows with the centered Conan-icon+lock
  upgrade card → Settings ▸ License; Premium-only row kinds
  (SKILL/SKILL?/PLAN/LOOP/BUILD) masked as `[Premium]` stubs in place;
  STOP token chips + nested skills-considered cards + Premium filter
  chips all hidden on Free.
- ✅ **US-103** — Pulse live-data cap, shipped on main
  ([PulseChart.tsx](ui/src/components/PulseChart.tsx)): 60s grace
  clock (`FREE_PULSE_GRACE_MS`), then blur + upgrade wall; Premium
  never gates. Plus US-103.5 theme gate (Light/Dark/Auto free).
- ✅ **$29 price in code** — centralized as `PREMIUM_PRICE` in
  [ui/src/lib/license.ts](ui/src/lib/license.ts) (commit `08cafba`).
- ✅ `v1.0.0`–`v1.0.4` tagged, released, auto-update verified. 1.0.3
  (2026-06-12) shipped the checkout-link constant plus the
  model-family parse fix (`claude-fable-5` in `/context`//`/usage`
  frames — `src/context/index.ts` + `src/usage/probe.ts`, regression
  tests in `src/context/index.test.ts`, now part of `npm test`).
  **1.0.4 (2026-06-12, `4be9cc0`) fixes the launch-critical Buy Premium
  bug 1.0.3 left behind:** the gateway defaulted `/api/config` `buyUrl`
  to `https://conan.sh`, and the UI's `buyUrl || BUY_PREMIUM_URL`
  fallback meant that always-truthy default shadowed the bundled Polar
  checkout link — the button opened the homepage, never checkout.
  `buyUrl` is now null unless `CONAN_BUY_URL` is set.
  **1.0.5 (2026-06-14, `1ac6bd1`) cuts paywall funnel friction:** the
  Timeline, Pulse, and radio-rickroll "Upgrade" CTAs used to dispatch
  `conan:open-settings` to bounce the user to Settings ▸ License to hunt
  for a second Buy button. They now open the Polar checkout directly
  (one click to pay). `BUY_PREMIUM_URL` + `openExternal` lifted out of
  [SettingsView.tsx](ui/src/components/SettingsView.tsx) into the shared
  [ui/src/lib/buy.ts](ui/src/lib/buy.ts), which adds `openCheckout()`
  (resolves `buyUrl` from `/api/config` with the bundled link as
  fallback). The License tab stays the post-purchase JWT paste surface.
- ❌ **US-104** (Skills `last fired` gating) + **US-105** (MCP auth
  watchdog) — **cut from v1.0 (2026-05-30)**; the shipped surfaces
  (Timeline, Pulse, Radio, License paste) carry the pitch.
- ✅ **Polar application approved (2026-06-12)** — Go Live unblocked.

**Resume here (in order — ALL Polar-dashboard-side; the code is
launch-ready). The agent cannot do these: autonomous login to Polar is
blocked by policy, and the `POLAR_API_TOKEN` lives only in Vercel prod
env (pulling it locally is also blocked). User actions:**
1. **Finish Stripe Connect KYC** if the Go Live flow asks (identity,
   bank, tax) — the Polar application itself is now approved.
2. **Fix product price $39 → $29** on `Conan Premium` in the dashboard
   (code already says $29 everywhere).
3. ✅ **Live checkout link generated + wired + SHIPPED (2026-06-12)** —
   `BUY_PREMIUM_URL` in
   [SettingsView.tsx](ui/src/components/SettingsView.tsx) points at
   `https://buy.polar.sh/polar_cl_yCw19D7U1STmkUlsNrQkGRwYkeRyr196LeoYJ46vMvd`
   (runtime-overridable via `CONAN_BUY_URL`). ⚠ In `v1.0.3` the link
   was unreachable — the gateway's `buyUrl` default shadowed it and the
   button opened conan.sh; **actually reaching users since `v1.0.4`**.
4. ~~Customize the Polar receipt email template~~ — **IMPOSSIBLE +
   REPLACED (2026-06-12)**: Polar has no merchant-editable receipt
   template (`{{order.metadata.license}}` never existed). Shipped
   instead in conan-license `32cd5b5` (live on license.conan.sh):
   **`/claim` page** (checkout Success URL → JWT from KV, copy button,
   retry/race handling) + **Resend license email** (`lib/email.ts`,
   best-effort; inert until `RESEND_API_KEY` exists). See design doc
   §2–3 (revised). Remaining user steps: (a) Resend account + verify
   domain `conan.sh` (DKIM/SPF) + `RESEND_API_KEY` → Vercel env;
   (b) Polar checkout link Success URL →
   `https://license.conan.sh/claim?checkout_id={CHECKOUT_ID}`;
   (c) static Custom Benefit note on Conan Premium pointing at /claim.
5. ✅ **Verification sale COMPLETE (2026-06-12)** — real $29 purchase +
   refund, full lifecycle green: order.created → 200 `issued license
   lic_YYEDJC2AW02SNS9DFKZNTPX7GC`; `/claim?checkout_id=<real uuid>`
   renders the JWT; license email delivered; order.refunded → 200
   revoke; `revoked.json` carries the lic. **It caught a launch-killer:**
   the webhook verifier + synthetic test both spoke a Stripe-style
   `t=,v1=<hex>` signature dialect Polar never sends — real deliveries
   401'd while the self-consistent test passed. Polar follows the
   **Standard Webhooks spec** (`webhook-id`/`-timestamp`/`-signature`,
   HMAC over `{id}.{ts}.{body}`, base64 `v1,<sig>`, key = UTF-8 of the
   full `polar_whs_…` secret). Fixed in conan-license `3adce62`,
   cross-validated against the real standardwebhooks lib. Recovery
   pattern: resend failed deliveries from Polar ▸ Settings ▸ Webhooks.
6. ~~Rotate the webhook secret + license private key~~ — **DECLINED by
   user (2026-06-12)**; transcript-leak risk accepted (local-filesystem
   threat model only).
7. ✅ **conan.sh buy wiring LIVE (2026-06-12, conan-marketing
   `1b6df96`)** — deliberately NOT a second button: the gold price
   mentions ("$29 once" Hero caption, "Premium $29, once" CTA band) link
   to the Polar checkout, `conan_buy_click` GA4 event mirrors
   `conan_download`. Checkout page dressed (product image = OG card,
   description, Custom Benefit). Plus `conan.sh/claim` →
   `license.conan.sh/claim` redirect (query-preserving, `53da149`).
8. **PH launch** (target Sun 2026-06-14) — the only remaining item.
   Playbook: conan-marketing/docs/launch-playbook.md.

**Don't lose:** the webhook signing secret was pasted in the
2026-05-29 chat transcript. Rotate it in Polar → Settings → Webhooks
before public launch (Settings → Regenerate Secret → update
`POLAR_WEBHOOK_SECRET` in Vercel → redeploy). Same applies to the
license private key — rotate before the first real sale if you want
to be discipline-clean about it.

**Anti-footgun:** scripts/release.mjs scrubs `.claude/.data/.DS_Store`
out of the .app bundle before notarization to dodge a known race where
a running Conan.app writes to its own Resources directory between sign
and notarize. If notarization complains about "a sealed resource is
missing or invalid", look for stray files in
`Conan.app/Contents/Resources/`.

<!-- wire-vault:start -->
## Knowledge vault — project layer

This project's durable knowledge (overview, decisions, gotchas) lives in the
cross-project vault at `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/OBSDN/projects/conan/`
(default vault: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/OBSDN`).

- **Read first:** before re-deriving an architecture decision or re-debugging
  a non-obvious issue, check `projects/conan/index.md` there.
- **Write path:** durable insights go through `/curate-knowledge` (gated) —
  never write vault articles directly.
<!-- wire-vault:end -->
