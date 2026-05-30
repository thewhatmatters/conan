# Conan — project context for Claude Code

Conan is a **terminal-primary native desktop app (Tauri v2) that wraps and
observes Claude Code**: an `xterm.js` terminal as the main surface plus a
DevTools-style widget HUD (Context · Usage · Pulse · Skills · MCP) backed by
one loopback Node gateway packaged as a Tauri sidecar. This file is
auto-loaded by every Claude Code session in this repo — keep it accurate.

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

## Architecture
- **Glossary — "Session":** one Claude Code *run* (an agent conversation),
  keyed by `session_id`. Conan tracks its events, tool calls, token/cost,
  and status (running/idle/error). Sessions are **observed** — any hooked
  `claude` self-reports over the WS. NOT a browser/login session.
- Routes (only what the app calls): `GET /api/health`, `GET /api/config`
  (`{token, port, cwd}`), `GET /api/tasks` (build-loop trail for projects
  that ship a `prd.json`/`progress.txt` — Conan itself does not),
  `GET /api/terminals`, `GET /api/claude/sessions`,
  `GET /api/claude/sessions/:id/widgets` (Context breakdown),
  `POST /api/claude/sessions/:id/context/refresh` and `.../usage/refresh`
  (inject `/context`/`/usage` into the correlated pty + capture),
  `POST /api/claude/sessions/:id/handoff` (inject `/handoff` for the
  Context-pressure Compact), `GET/POST /api/claude/context/autorefresh`,
  `GET /api/claude/usage` (`+?probe=1`), `GET /api/claude/pulse`,
  `GET /api/claude/skills` (carries `lastFiredAt` per skill),
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
  interactive prompts; inject `/context`, `/usage`, `/handoff`).
- Usage / Context capture (`src/usage/probe.ts`): pure ANSI-strip + bounded
  scrape + testable frame parsers (`parseUsageFrame`, `parseContextFrame`).
  Two capture paths: a **throwaway probe** for the account-global `/usage`
  rate-limit windows (`/api/claude/usage?probe=1`), and **live-pty capture**
  for session-specific `/context` and `/usage` Session-block frames
  (passive when the user runs the command, or via the
  `.../context/refresh` and `.../usage/refresh` routes). Disk estimates
  (MCP/skills/memory size readers) are the labelled `≈ estimated` fallback.
- Doctor (`src/doctor/claude.ts`): cached (10min TTL) Claude Code install
  detection — probes via interactive login shell, falls back to historical
  `session.claude_version` from the DB. Drives the install banner.
- UI: `App.tsx` shell renders `components/TerminalPane.tsx` (N `Terminal.tsx`
  tabs in a **real VS-Code-style tab strip**, mounted-but-hidden so switching
  never tears down a pty; a `StatusBar.tsx` cwd/branch footer below; and an
  optional **per-tab `Timeline.tsx` split panel** toggled via
  `PanelRightOpen` next to `+` or `⌘\` — tethered visually to the terminal
  so its rows describe THAT session's hooks/skills/plan/loop/build) beside
  `components/Hud.tsx` (the DevTools-style widget HUD). The HUD tabs are
  **Context · Usage · Pulse · Skills · MCP** — `Widgets.tsx`
  (Context+Usage), `PulseChart.tsx`, `SkillsWidget.tsx`, `McpWidget.tsx` —
  with a `RadioBar.tsx` (Claude Radio play/pause, gateway-hosted YouTube
  iframe at `/radio/embed`) pinned at the HUD's bottom. The session-scoped
  tabs follow the **active terminal tab**. `SettingsView.tsx` is the tabbed
  Status/Config dialog (⌘,). Charts live in `components/charts/` (vendored
  Tremor `AreaChart`/`ProgressCircle`). Hooks `hooks/{useTheme,useTasks,
  useWidgets,usePulse,useUsage,useSessions,useTerminals,useSkills,useMcp,
  useConfig,useDoctor,useNativeNotifications}.ts`;
  `lib/{chartUtils,nativeNotify,appMenu,gateway}.ts`.

## Conventions
- **Semantic theme tokens only** — `bg-background`, `text-foreground`,
  `bg-card`, `border-border`, `text-muted-foreground`, `bg-term-bg`. Never
  hard-code `neutral-*`/hex in components. Light is default; dark via
  toggle. The terminal theme derives from the same tokens
  (`getTerminalTheme()`).
- **shadcn primitives** in `ui/src/components/ui/*` (`button`, `select`,
  `dropdown-menu`, `tabs`, …) — reach for these for any new control; the
  semantic token names match shadcn so they drop in cleanly.
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
`ACCEPTED_EDITIONS = {"v1"}`. License is **$39 one-time, lifetime 1.x,**
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
an end-of-list "[ See what Premium adds — $39 ]" footer. See
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
- ✅ Polar org `WhatMatters` configured; product `Conan Premium` ($39
  one-time) exists; webhook → `license.conan.sh/api/polar-webhook` with
  `order.created` + `order.refunded`; Organization Access Token created
  in **Settings → Preferences → Developers** section (scroll to bottom).
- ✅ **US-101** — `useTier()` hook + license loader/saver
  ([ui/src/hooks/useTier.ts](ui/src/hooks/useTier.ts), gateway routes
  `GET/PUT/DELETE /api/license`, storage at `$CONAN_DATA_DIR/license.jwt`,
  best-effort revocation list refresh from `license.conan.sh/revoked.json`).
- ✅ **US-106** — Settings ▸ License tab (banner, masked paste field with
  show/hide toggle, Apply button, inline error from `VerifyResult`, Remove
  button when Premium, Buy Premium button → `openExternal(BUY_PREMIUM_URL)`
  via Tauri shell plugin). `BUY_PREMIUM_URL` is stubbed at `https://conan.sh`
  in [SettingsView.tsx](ui/src/components/SettingsView.tsx); **swap to the
  real Polar checkout URL post-Go-Live approval.**

**Resume here (in order):**
1. **Polar Go Live + Stripe Connect onboarding** (~15–30 min KYC).
   Polar refuses test payments until this is done — that's what blocked
   the first real sandbox sale. Click "Go Live" banner in the Polar
   dashboard, walk through Stripe Identity verification, bank info,
   tax info. Required for **any** transaction (test or real).
2. **Real test sale via the checkout link** — `4242 4242 4242 4242`,
   any future expiry. Confirm: Vercel logs show
   `issued license lic_… for order …`; receipt email arrives.
3. **Customize Polar receipt email template** to embed
   `{{order.metadata.license}}` so the JWT lands in the customer's inbox.
4. **Generate the actual checkout link** (skipped tonight — there's no
   live checkout link yet for the in-app "Buy Premium" button).
   Save the URL for US-106.
5. **US-102** — Timeline insight gating: 50-row cap on the active
   session for Free; gate event-type rendering (PROMPT + tool calls +
   STOP + SESSION + Hooks chip free; SKILL? + PLAN + LOOP + BUILD +
   token chips + Plan/Loop/Build filter chips + click-to-expand
   payloads Premium). End-of-list footer:
   `Showing latest 50 rows · Premium reveals all activity + skill scoring,`
   `plan rows, tool payloads. [ See what Premium adds — $39 ]`. The gate
   reads `useTier()`. Filter chips for Premium-only kinds render with a
   small `[ Premium ]` chip when Free.
6. **US-103** — Pulse range cap: Free shows 15m + 1h tabs; 6h + 24h
   render disabled at 40% opacity with `[ Premium ]` chip. Click on a
   disabled range opens Settings ▸ License.
7. **US-104** — Skills tab insight gating: Free shows installed skills +
   descriptions + source badge; Premium adds `last fired` timestamps and
   transcript-derived firing history.
8. **US-105** — MCP auth watchdog: Premium-only background OAuth-token
   watchdog + native banner when token expires + one-click reconnect.
9. **Tag `v1.0.0`**, run `npm run release`, attach `Conan_1.0.0_aarch64.dmg`
   to a GitHub Release, point conan.sh's Buy button at the Polar link.

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
