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

> Note: where this section describes Free/Premium gating (Timeline row masking,
> filter chips, Pulse caps), that gating is **currently disabled** —
> `PAYWALL_ENABLED = false`, see "Licensing / release status" below. The code
> still exists in these unmounted components; nothing enforces it.

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

## Licensing / release status (as of 2026-07-24)

**Shipped releases:** `v1.0.0` … **`v1.4.0`** (2026-07-11, the latest public
release — agent activity, project skills, live usage, pulse polish). Every
public release so far is the **terminal-era** app. The chat-primary rebuild is
merged to `main` but **has never been released**; users on the auto-updater are
still on v1.4.0.

**⚠️ The paywall is OFF.** `PAYWALL_ENABLED = false` in
[ui/src/hooks/useTier.ts](ui/src/hooks/useTier.ts) — every feature is available
to every user, and the in-app "Buy Premium" CTA is gone. This is an honesty
fix: the surfaces Premium gated (Timeline insight rows, Pulse, the Radio nag)
were all unmounted in the chat rebuild, so on the current build a license would
buy nothing. Premium gating gets revisited once the feature set is settled —
re-enabling is that one flag plus a decision about WHAT to gate.

The licensing machinery is deliberately intact and still works: Ed25519 JWT
verification ([ui/src/lib/license.ts](ui/src/lib/license.ts)), storage at
`$CONAN_DATA_DIR/license.jwt` via `GET/PUT/DELETE /api/license`, the best-effort
revocation refresh from `license.conan.sh/revoked.json`, and the Settings ▸
License tab (a user WITH a license sees their real Premium details; a user
without sees an explicit "All features unlocked — no license required"
banner). Polar.sh remains live as Merchant of Record — the checkout link still
works and `conan.sh` still links to it; nothing in the app points at it.

**Locked commercial decisions** (still true, just not enforced right now):
production domain `conan.sh`; JWT `edition = "v1"`, `ACCEPTED_EDITIONS =
{"v1"}`; **$29 one-time, lifetime 1.x**, no trial, no subscription, no
per-device limit. Polar org slug `whatmatters`, product `Conan Premium`.
`PREMIUM_PRICE` is centralized in [ui/src/lib/license.ts](ui/src/lib/license.ts).
Real purchases have gone through end-to-end (checkout → webhook → JWT mint →
`/claim` page → license email → refund/revoke), so the pipeline is proven.

**Infrastructure that exists and works:**
- Developer ID signing + notarization end-to-end via `npm run release` (Apple
  Team `4P6GX328VY`; app-specific password in the `conan-notarize` keychain
  profile). Produces a Gatekeeper-accepted `.app` + `.dmg`.
- `conan-license/` ([github.com/thewhatmatters/conan-license](https://github.com/thewhatmatters/conan-license))
  on Vercel at `https://license.conan.sh` with Upstash KV; issues + revokes
  licenses from Polar webhooks, serves `/claim` and `revoked.json`.
- Ed25519 keypair — private key in 1Password + Vercel env; public key bundled
  into the app.

**Two hard-won gotchas worth keeping** (both were launch-killers):
- **Polar follows the Standard Webhooks spec** (`webhook-id`/`-timestamp`/
  `-signature`, HMAC over `{id}.{ts}.{body}`, base64 `v1,<sig>`, key = UTF-8 of
  the full `polar_whs_…` secret) — NOT a Stripe-style `t=,v1=<hex>` dialect. A
  self-consistent synthetic test passed while every real delivery 401'd.
- **A non-null `buyUrl` default shadows the bundled checkout link.** The
  gateway once defaulted `/api/config`'s `buyUrl` to `https://conan.sh`, and
  the UI's `buyUrl || BUY_PREMIUM_URL` fallback meant the Buy button opened the
  homepage instead of checkout. `buyUrl` is null unless `CONAN_BUY_URL` is set.

**Anti-footgun:** `scripts/release.mjs` scrubs `.claude/.data/.DS_Store` out of
the .app bundle before notarization — a running Conan.app can write to its own
Resources directory between sign and notarize. If notarization reports "a
sealed resource is missing or invalid", look for stray files in
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
