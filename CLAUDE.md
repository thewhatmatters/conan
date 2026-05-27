# Conan — project context for Claude Code

Conan is an **always-on web dashboard that observes AND drives Claude Code**:
a structured-stream UI plus an integrated xterm.js terminal, served by one
Node gateway. This file is auto-loaded by every Claude Code session (interactive
or `run-tasks.sh` iterations) — keep it accurate.

## Source of truth for work
- **`prd.json`** — the build backlog. Each story has `passes` (true/false),
  `priority` (run order), and `acceptanceCriteria`. **Pick the lowest-priority
  story with `passes:false`**, implement *only* that one, verify, then set
  `passes:true` and append a line to `progress.txt`.
- **`progress.txt`** — the loop's timestamped activity trail (gitignored).
- **`run-tasks.sh`** — autonomous loop: a fresh agent per story until all pass.
- Validate after editing the backlog:
  `python3 ~/.claude/skills/decompose-prd/scripts/validate.py --in=prd.json`
- Current spec: `docs/v4.2-backlog.md`; charting research: `docs/v4.2-research.md`.

## Stack
- **Gateway** (`src/`): TypeScript ESM, Express 4 + `ws` + `better-sqlite3`.
  Run with `tsx`. Entry `src/gateway/index.ts`, port **3747**, loopback-only.
- **UI** (`ui/`): Vite + React 19 + TypeScript + Tailwind v4 (CSS-first,
  `@theme inline` + `.dark` in `ui/src/index.css`). Loaded by the Tauri webview
  (bundled frontend); dev uses the Vite server (:5173). The gateway is JSON-API +
  WebSockets only — it does **not** serve the UI to a browser (v4.2 Tauri-only).
  xterm.js (`@xterm/*`) for the terminal.

## Run / build / verify
```bash
npm install                 # postinstall fixes node-pty's spawn-helper perms
npm run dev                 # gateway, tsx WATCH, :3747   (see footgun #1!)
npm start                   # gateway, NO watch (safer when self-editing)
cd ui && npm run dev        # Vite dev :5173, proxies /api + /ws -> :3747
npm run build               # root: typecheck + build ui   (CI gate)
npm run typecheck           # tsc --noEmit (gateway)
```
- **Every story must `npm run typecheck` clean** (gateway) and `cd ui && npm run build` clean.
- **Verify UI changes in a browser** with the `automate-browser` skill
  (screenshots, real interaction) — UI stories aren't done until visually checked.

## Architecture (current)
- **Glossary — "Session":** one Claude Code *run* (an agent conversation/instance),
  keyed by `session_id`. Conan tracks its events, tool calls, token/cost, and
  status (running/idle/error). Sessions are **observed** (any hooked `claude` in
  this repo self-reports) or **driven** (launched by the session manager). NOT a
  browser/login session. The Sessions grid should carry an info-icon tooltip with
  this one-liner so users aren't confused.
- Routes: `GET /api/health`, `GET /api/config` (`{token, port, cwd}`),
  `GET /api/tasks` (prd.json + progress.txt).
- WS: `/ws` (app events + `{type:'tasks'}` broadcast, snapshot on connect),
  `/ws/terminal` (node-pty). **Both authenticated on upgrade.**
- Auth (`src/gateway/auth.ts`): token (`CONAN_AUTH_TOKEN` | `.data/auth-token` |
  generated) + **Origin allowlist** — required because browsers don't apply
  same-origin policy to WebSockets (CVE-2025-52882). The app reads the token
  from same-origin `/api/config`. The gateway binds **loopback-only**; there is
  no TLS/remote-access path (removed in v4.2 — Tauri-only over 127.0.0.1).
- Terminal (`src/terminal/index.ts`): pty auto-launches `claude` (`mode=claude`,
  default) in the repo cwd via a login shell; `mode=shell` for a plain shell.
- DB (`src/db/`): SQLite WAL at `.data/conan.db`; tables `session`, `event`,
  `terminal_session`. Idempotent init on boot.
- Tasks (`src/tasks/index.ts`): reads prd.json/progress.txt + fs.watch -> WS broadcast.
- Preview (`src/preview/index.ts`, US-010–012): runs the active cwd's dev server
  on demand so the project being edited renders live inside the dock. Mirrors the
  TermSession abstraction (one managed child, capped stdout ring buffer, onExit)
  but for a long-lived dev server. Discovers candidate commands from the cwd's
  `package.json` scripts (`dev` → `start` → `preview`). Vite-style commands spawn
  with `--base /preview/<id>/ --strictPort --host 127.0.0.1` on a pinned free port
  (with a `Local: http://…` stdout regex as the non-Vite fallback). Lifecycle is
  **decoupled** from the pty layer and the gateway watch restart (footgun #1): it
  stops itself on `onCwdChange` and is killed only on explicit stop / graceful
  shutdown. REST: `GET /api/preview/status` (discovery + run state), `POST
  /api/preview/start|stop`, `GET /api/preview/log`.
  - **Reverse proxy** (US-011): `http-proxy-middleware` mounts `/preview/:id` →
    `http://127.0.0.1:<devport>`. In `proxyRes` it deletes `x-frame-options` and
    strips `frame-ancestors` from CSP so the page frames in an iframe. The proxy
    runs with `ws:true`; a `pathname.startsWith('/preview/')` branch in the
    `server.on('upgrade')` router (before the catch-all `socket.destroy()`) routes
    HMR upgrades through it, inheriting the existing `verifyUpgrade` auth+Origin
    gate. Vite HMR is pointed back through Conan's port via
    `scripts/preview-vite-config.mjs` (`server.hmr.clientPort`/`path`, `wss` under
    TLS) injected by flags/env — never by editing the user's vite config.
  - **Security floor:** the `/preview/` HTTP path is *not* token-checked per
    request (an iframe `src` can't send `x-conan-token`); it relies on same-origin
    + loopback + the Origin-checked WS upgrade. Documented in `src/gateway/index.ts`
    around the proxy mount.
- UI: `App.tsx` shell (hero-widget placeholders + cwd in toolbar),
  `components/Dock.tsx` (tabbed Terminal|Tasks|Preview + bottom Pulse strip,
  drag-resize), `components/Terminal.tsx`, `components/Preview.tsx`,
  `components/TaskChecklist.tsx`, `hooks/{useTheme,useTasks}.ts`,
  `lib/terminalTheme.ts`.

## Conventions
- **Semantic theme tokens only** — `bg-background`, `text-foreground`,
  `bg-card`, `border-border`, `text-muted-foreground`, `bg-term-bg`. Never
  hard-code `neutral-*`/hex in components. Light is default; dark via toggle.
  The terminal theme derives from the same tokens (`getTerminalTheme()`).
- **shadcn adopted; migration completed in v4** — bespoke buttons/selects/tabs
  across Dock, SessionBar, and Sidebar now ride `ui/*` primitives (`button`,
  `select`, `dropdown-menu`, `tabs`). Reach for `ui/*` for any new control; the
  semantic token names match shadcn so the components drop in cleanly.
- Auth/Origin checks apply to **every** new WS endpoint.
- **Gateway is single-instance on :3747.** On startup, if the port is already
  bound, exit immediately with a clear message (e.g. "Conan gateway already
  running on :3747 — stop it first, or set CONAN_PORT") — never crash with a raw
  `EADDRINUSE` stack. This stops a human-run dashboard and the build loop's UI
  verification (which boots its own gateway on :3747) from clobbering each other.
- **The main-area timeline (US-009–US-013, esp. US-011) must auto-surface
  activity so nobody needs a terminal `tail`.** It should render, live over the
  app WS: (a) Claude Code hook events (`{type:'event'}`), and (b) the build-loop
  trail from `progress.txt` (already broadcast as `{type:'tasks'}` → `activity`).
  Entries are timestamped and labeled by source. Treat "would I otherwise tail a
  file to watch this?" as a signal it belongs in the timeline.

## Gotchas
- **node-pty spawn-helper** ships non-executable → `posix_spawnp failed`. Fixed
  by `scripts/fix-node-pty.mjs` (postinstall). Re-run `npm install` if it recurs.
- **OAuth tokens (`sk-ant-oat*`) are blocked for third-party API calls.** The
  *interactive* terminal `claude` uses your normal CLI login (fine). The future
  *headless* path (`claude -p`, US-006) must use `ANTHROPIC_API_KEY`.
- Don't set `maxThinkingTokens` if you want partial streaming (US-007).

## ⚠️ Dogfooding footguns (running Claude inside Conan to build Conan)
1. **Gateway under `tsx watch` (`npm run dev`) restarts on `src/**` edits and
   kills ALL ptys — including the in-dock session making the edit.** If you must
   build from inside the dock, run the gateway with `npm start` (no watch) and
   **avoid editing `src/gateway/*` or `src/terminal/*` from the in-dock session.**
2. **Hiding the dock / reloading the UI / UI HMR currently kills the pty**
   (WS-close -> `term.kill()`). pty-survival + reattach is US-017/US-018; until
   then, don't reload while a session is mid-task.
3. Safest model for now: run the *building* session externally (or a separate
   Conan instance on another port) and use this dashboard to **observe**.

## Status (2026-05-27)
**v4.2 in progress (`loop/conan-v4.2`).** Two themes: an aggressive Tauri-only
cleanup (trim the gateway to the routes the app calls; drop the web-served/TLS/pm2
path, the drive route surface, and the v1→v4 planning history) and adopting
**Tremor Raw** (recharts-based, Tailwind-v4-native — NOT `@tremor/react`) as the
charting standard. Backlog: `docs/v4.2-backlog.md`; charting research:
`docs/v4.2-research.md`.

**v4.1 done (`loop/conan-v4.1`).** Pivoted Conan from a web dashboard to a
**terminal-primary native desktop app shipped via Tauri v2**. Reshaped to a
terminal-primary layout with a DevTools-style HUD (Context + Usage widgets + the
Pulse graph); scaffolded `src-tauri/` (Tauri v2 at repo root) with a Tauri-aware
absolute gateway-base resolver (`ui/src/lib/gateway.ts`), the WS Origin allowlist
+ CSP extended for `tauri://localhost`; packaged the Node gateway as a
**bundled-node sidecar** (`scripts/build-sidecar.mjs` → a relocatable C launcher +
`runtime/` tree with Node + `better-sqlite3`/`node-pty` as real files, ad-hoc
codesigned), spawned/killed from `src-tauri/src/lib.rs`; and **bundled
`Conan.app` + `.dmg`** (`bundle.resources` copies `runtime/` into
`Contents/Resources`; `CI=true npm run tauri:build` for headless DMG). The
gateway carries a **stdin-EOF watchdog** (`CONAN_SIDECAR=1`) so it self-terminates
and frees :3747 when the app quits without the `ExitRequested` kill landing
(observed on macOS Apple-event quit). Build/run + Developer-ID sign + notarize:
`docs/tauri-desktop.md`.

**Earlier (v1–v4, in git history).** v1 shipped the dashboard + hooks
(`.claude/settings.json`, 9 events → `scripts/hooks/send-event.mjs` →
`/api/claude/events`; `conan-hooks.example.json` is the shareable template). v2
reworked the IA + real Claude Code data (session-liveness reaper via
`~/.claude/sessions/<pid>.json` pid-liveness; cost-ceiling removed since Claude Max
is token-based → Usage reframed to plan-usage). v3 added multi-project global hook
+ a real shadcn foundation. v4 finished the shadcn migration and made the Context
widget honest (pty-correlated live session + total % + on-disk category breakdown)
with keystroke injection to answer interactive TUI prompts via the correlated pty.
- **Data-source verdicts**: `/usage`, `/stats`, `/context` are TUI-only slash
  commands (no `claude usage` CLI). Live `/usage` % is unreadable headlessly (it's
  in `anthropic-ratelimit-unified-*` response headers, in the claude process
  memory) → Usage stays an honest approximation until captured from a live pty.
