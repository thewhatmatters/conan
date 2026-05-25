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
- Full spec: `prd-claude-code-dashboard.md`; research: `research-claude-code-always-on-dashboard.md`.

## Stack
- **Gateway** (`src/`): TypeScript ESM, Express 4 + `ws` + `better-sqlite3`.
  Run with `tsx`. Entry `src/gateway/index.ts`, port **3747**, loopback-only.
- **UI** (`ui/`): Vite + React 19 + TypeScript + Tailwind v4 (CSS-first,
  `@theme inline` + `.dark` in `ui/src/index.css`). Built to `ui/dist`, served
  by the gateway. xterm.js (`@xterm/*`) for the terminal.

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
  same-origin policy to WebSockets (CVE-2025-52882). The SPA reads the token
  from same-origin `/api/config`.
- Remote access (`src/gateway/tls.ts`, US-024): **opt-in, off by default.** Set
  `CONAN_TLS_CERT` + `CONAN_TLS_KEY` to run as HTTPS — all WS (app + terminal)
  then serve over `wss://` behind the same token/Origin checks. Binding a
  non-loopback `CONAN_HOST` without TLS is refused (no cleartext exposure, no raw
  shell port). See `docs/remote-access.md`.
- Terminal (`src/terminal/index.ts`): pty auto-launches `claude` (`mode=claude`,
  default) in the repo cwd via a login shell; `mode=shell` for a plain shell.
- DB (`src/db/`): SQLite WAL at `.data/conan.db`; tables `session`, `event`,
  `terminal_session`. Idempotent init on boot.
- Tasks (`src/tasks/index.ts`): reads prd.json/progress.txt + fs.watch -> WS broadcast.
- UI: `App.tsx` shell (hero-widget placeholders + cwd in toolbar),
  `components/Dock.tsx` (tabbed Terminal|Tasks, drag-resize), `components/Terminal.tsx`,
  `components/TaskChecklist.tsx`, `hooks/{useTheme,useTasks}.ts`,
  `lib/terminalTheme.ts`.

## Conventions
- **Semantic theme tokens only** — `bg-background`, `text-foreground`,
  `bg-card`, `border-border`, `text-muted-foreground`, `bg-term-bg`. Never
  hard-code `neutral-*`/hex in components. Light is default; dark via toggle.
  The terminal theme derives from the same tokens (`getTerminalTheme()`).
- shadcn-compatible token names so the component lib slots in later.
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

## Status (2026-05-25)
11/29 stories pass: US-001 (schema), US-002 (WS auth), US-003 (events ingest),
US-004 (hooks), US-005 (event broadcast), US-015 (pty service), US-016 (xterm pane),
US-025 (theme), US-027 (tabbed dock + Tasks tab), US-028 (resize + cwd), US-029 (toasts).
- **Hooks are installed** in `.claude/settings.json` (9 lifecycle events ->
  `scripts/hooks/send-event.mjs` -> `/api/claude/events`). Verified end-to-end with
  a real `claude -p` session. `conan-hooks.example.json` is the shareable template.
- App WS is consolidated in `ui/src/hooks/useTasks.ts` (`useGateway`) exposing
  `{tasks, lastEvent}`; powers Tasks tab + toasts, and will power the timeline.
- **Next: US-009/US-010/US-011** — session grid, hero widgets (Context/Skills/Cost/
  Active from event+session data), and the live ActivityTimeline. Then US-006/007/008
  (headless session manager) for autonomous sessions.
- Not committed to git yet.
