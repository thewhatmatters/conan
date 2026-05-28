# Conan — project context for Claude Code

Conan is a **terminal-primary native desktop app (Tauri v2) that wraps and
observes Claude Code**: an `xterm.js` terminal as the main surface plus a
DevTools-style widget HUD (Context + Usage + the Pulse graph), backed by one
loopback Node gateway packaged as a Tauri sidecar. This file is auto-loaded by
every Claude Code session (interactive or `run-tasks.sh` iterations) — keep it
accurate.

## Source of truth for work
- **`prd.json`** — the build backlog. Each story has `passes` (true/false),
  `priority` (run order), and `acceptanceCriteria`. **Pick the lowest-priority
  story with `passes:false`**, implement *only* that one, verify, then set
  `passes:true` and append a line to `progress.txt`.
- **`progress.txt`** — the loop's timestamped activity trail (gitignored).
- **`run-tasks.sh`** — autonomous loop: a fresh agent per story until all pass.
- Validate after editing the backlog:
  `python3 ~/.claude/skills/decompose-prd/scripts/validate.py --in=prd.json`
- Current spec: `docs/timeline-prd.md` (v4.5-timeline, latest shipped loop).
  Prior loops: `docs/v4.4-backlog.md` and `docs/v4.x-backlog.md`; charting
  research in `docs/v4.2-research.md`.
- **Regression QA:** `docs/qa-checklist.md` — run it (mostly `automate-browser` at
  :5173, a few native-only) after each change set to catch regressions.

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
  status (running/idle/error). Sessions are **observed** — any hooked `claude` in
  this repo self-reports over the WS (the launch/steer "drive" route surface was
  removed in v4.2). NOT a browser/login session.
- Routes (only what the app calls — trimmed in v4.2, grown back deliberately in
  v4.3/v4.4/v4.5): `GET /api/health`, `GET /api/config` (`{token, port, cwd}`),
  `GET /api/tasks` (prd.json + progress.txt), `GET /api/terminals` (live
  terminals + their session labels), `GET /api/claude/sessions` (the sessions
  list), `GET /api/claude/sessions/:id/widgets` (Context breakdown),
  `POST /api/claude/sessions/:id/context/refresh` and `.../usage/refresh`
  (inject `/context`/`/usage` into the correlated pty and capture the rendered
  frame — US-009/US-010), `POST /api/claude/sessions/:id/handoff` (inject
  `/handoff` for the Context-pressure Compact — v4.3 US-013),
  `GET/POST /api/claude/context/autorefresh` (the adaptive auto-refresh gate —
  v4.4 US-006), `GET /api/claude/usage` (`+?probe=1`), `GET /api/claude/pulse`,
  `GET /api/claude/skills` (v4.3 US-006; carries `lastFiredAt` per skill from
  v4.5 US-002), `GET /api/claude/mcp` (`+?force=1`; shells `claude mcp list` —
  v4.4 US-007), `GET /api/claude/config` + `POST /api/claude/config`
  (read-only mirror + single-key read-modify-write with an editable-key type
  schema — v4.3 US-007/008, v4.4 US-002/010),
  `GET /api/claude/timeline?session=…&since=…&limit=…` (the chronological
  per-session log of hook + build + skill-fired + skill-considered + plan +
  loop rows — v4.5-timeline US-001), and `POST /api/claude/events` (hook
  ingestion). The drive surface, the web-serving/TLS/pm2 path, and the
  read-only catalog routes stay removed.
- WS: `/ws` carries app events + `{type:'tasks'}` (build-loop trail) +
  `{type:'skill-fired'}`, `{type:'skill-considered'}`, and `{type:'plan'}`
  broadcasts (v4.5-timeline US-002/003/006), snapshot on connect;
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
- pty↔session correlation (`src/terminal/correlate.ts`): maps the live `/ws/terminal`
  pty to its `session_id`, and carries the **keystroke-injection** path used to run
  TUI slash commands in the correlated session (answer interactive prompts; inject
  `/context` and `/usage` for the on-demand widget refresh).
- Usage / Context capture (`src/usage/probe.ts`): pure ANSI-strip + bounded scrape +
  testable frame parsers (`parseUsageFrame`, `parseContextFrame`). Two capture paths:
  a **throwaway probe** for the account-global `/usage` rate-limit windows
  (`/api/claude/usage?probe=1`), and **live-pty capture** for session-specific
  `/context` and `/usage` Session-block frames (passive when the user runs the command,
  or via the `.../context/refresh` and `.../usage/refresh` routes). Disk estimates
  (MCP/skills/memory size readers) are the labelled `≈ estimated` fallback.
- UI: `App.tsx` shell renders `components/TerminalPane.tsx` (the main surface — N
  `Terminal.tsx` tabs in a **real VS-Code-style tab strip** (v4.3 US-009, replacing
  the old `Term ▾` dropdown), mounted-but-hidden so switching never tears down a
  pty; a `StatusBar.tsx` cwd/branch footer below; and an optional **per-tab
  `Timeline.tsx` split panel** (v4.5-timeline) toggled via `PanelRightOpen` next
  to `+` or `⌘\` — tethered visually to the terminal so its rows describe THAT
  session's hooks/skills/plan/loop/build) beside `components/Hud.tsx` (the
  DevTools-style widget HUD). The HUD tabs are **Context · Usage · Pulse ·
  Skills · MCP** (Plan moved into the Timeline in v4.5-timeline US-007) —
  `Widgets.tsx` (Context+Usage), `PulseChart.tsx`, `SkillsWidget.tsx`,
  `McpWidget.tsx` — with a `RadioBar.tsx` (Claude Radio play/pause) pinned at
  the HUD's bottom (v4.4
  US-011). The session-scoped tabs follow the **active terminal tab** (v4.4
  US-003). `SettingsView.tsx` is the tabbed Status/Config dialog (⌘,). Charts live
  in `components/charts/` (vendored Tremor `AreaChart`/`ProgressCircle`); build-loop
  `tasks` feed `Toaster.tsx`. Hooks `hooks/{useTheme,useTasks,useWidgets,usePulse,
  useUsage,useSessions,useTerminals,useSkills,useMcp,useConfig,
  useNativeNotifications}.ts` (`usePlan.ts` deleted in v4.5-timeline US-007);
  `lib/{chartUtils,nativeNotify,appMenu,gateway}.ts`.

## Conventions
- **Semantic theme tokens only** — `bg-background`, `text-foreground`,
  `bg-card`, `border-border`, `text-muted-foreground`, `bg-term-bg`. Never
  hard-code `neutral-*`/hex in components. Light is default; dark via toggle.
  The terminal theme derives from the same tokens (`getTerminalTheme()`).
- **shadcn adopted; migration completed in v4** — bespoke buttons/selects/tabs
  across Dock, SessionBar, and Sidebar now ride `ui/*` primitives (`button`,
  `select`, `dropdown-menu`, `tabs`). Reach for `ui/*` for any new control; the
  semantic token names match shadcn so the components drop in cleanly.
- **Charts ride Tremor Raw (the charting standard since v4.2)** — recharts-based,
  Tailwind-v4-native copy-in components vendored under `ui/src/components/charts/`
  (`AreaChart`, `ProgressCircle`), themed through `ui/src/lib/chartUtils.ts` so
  colors resolve to the `--color-chart-1..5` CSS vars and honor light/dark. Use
  Tremor for any new chart; do **not** install `@tremor/react` (Tailwind v3 only).
  This replaces the old "zero charting deps, hand-rolled SVG" convention.
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

## Status (2026-05-28)
**v4.5-timeline done (`loop/conan-v4.5-timeline`, 7 stories + post-loop polish).**
A live, per-terminal **Timeline split panel** is now the per-session observation
surface — toggle right of `+` (or `⌘\`) for the active tab. Stories shipped:
**Timeline read endpoint** + `TimelineRow` envelope (US-001, `GET /api/claude/timeline`);
**transcript-derived skills-fired feed** + Skills tab `last fired` stamp via the
JSONL scanner (US-002); **the novel piece — BM25 skill-consideration scorer +
`prompt_consideration` table + Stop-time reconciliation** (US-003), labelled
honestly as a heuristic in the UI ("Heuristic match" badge) since Claude
doesn't expose its real internal scoring; **live `Timeline.tsx`** replacing the
mock with filter chips, live append, and an `↑ N new` pill (US-004); **per-tab
split persistence** (sessionStorage) + `⌘\` shortcut + View ▸ Split Timeline
menu (US-005); **scanner extended** to TodoWrite + ExitPlanMode (US-006);
**Plan HUD tab removed** — PLAN rows render in the Timeline + a Plan filter
chip; `PlanWidget.tsx` and `usePlan.ts` deleted (US-007). Post-loop polish:
**Loop/Build split** — old `kind:'loop'` (runner trail) renamed to `kind:'build'`
("Build" chip); new `kind:'loop'` for Claude Code's `/loop` skill (detected
from `UserPromptSubmit` prompts + `ScheduleWakeup`/`CronCreate` PreToolUse
hooks); **dynamic filter chips** — a chip only renders when this session has at
least one row of that kind; **dot centered on the rail** (`translate-x-px`).
Also fixed: the long-open **terminal reattach crash** (`attachTerminal` now
uses `INSERT OR REPLACE`).

**v4.4 done (`loop/conan-v4.4`, 11 stories + QA polish).** HUD/UX polish:
**Claude Code version capture** from the SessionStart hook (US-001, `claude_version`
column — backend only; the US-008 session header it fed was removed in QA as overkill,
the column stays for Settings/future use); an **editable Claude-config write route** + binary-extracted
enum schema (US-002, single-key read-modify-write preserving all other keys);
**session-scoped HUD widgets bound to the active terminal tab** (US-003, fixes the
"new terminal shows the old session" bug); a **slim status bar** (US-004, drop the
gateway chip, cwd-left/branch-right, VS-Code `*` dirty marker); **Pulse dark-mode
axis legibility** + dropped the redundant in-chart legend (US-005); a **Context
"Auto" toggle** for the adaptive `/context` auto-refresh (US-006); an **editable
tabbed (Status/Config) Settings dialog** (US-009/010); and **Claude Radio** — a
play/pause toolbar at the HUD's
bottom streaming a YouTube live stream (US-011). **MCP tab** (US-007) ships too, but
was **fixed post-loop** to source from `claude mcp list` (the per-session
`system/init` mcp_servers it was built against never arrives over hooks). Post-loop
QA polish: the Context-pressure bar became an always-on **top-pinned toolbar** with a
"Remind me later" snooze (armed 80–95%, Compact-only at ≥95%); Radio moved into the
HUD + height-matched to the status bar. Regression suite: `docs/qa-checklist.md`.
**Known open bug:** terminal **reattach** crashes the gateway (`UNIQUE constraint
failed: terminal_session.id` — `attachTerminal` needs `INSERT OR REPLACE`).

**v4.3 done (`loop/conan-v4.3`, 14 stories).** HUD/UX expansion: landed the
context-accuracy fixes (1M-window resolution; adaptive delta-triggered `/context`
auto-refresh); a conditional **Plan** tab (TodoWrite/ExitPlanMode/build-loop) and a
**Skills** tab (VS-Code-extensions-style, from SKILL.md frontmatter); a read-only
Settings mirror of Claude's `/config`; **real terminal tabs** (dropped the `Term ▾`
dropdown); a **bottom status bar** (cwd/branch/gateway, moved out of the HUD); a
**View ▸ Theme** submenu driving Conan's app theme; a **context-pressure action bar**
(Compact → `/handoff` in the correlated pty); and **flush/panel-native** widget
content (no card chrome). _Note: v4.3's Claude `/theme` mirror (US-012) was removed
in QA — config-write applied only next-session, so it never changed the live look._

**v4.2 done (`loop/conan-v4.2`, 12 stories).** Two themes shipped: an aggressive
Tauri-only cleanup (trimmed the gateway to only the routes the app calls; dropped
the web-served/TLS/pm2 path, the drive route surface, and the v1→v4 planning
history; rebuilt + re-verified the sidecar) and adopting **Tremor Raw**
(recharts-based, Tailwind-v4-native — NOT `@tremor/react`) as the charting standard
— the Pulse graph is now a Tremor `AreaChart` (stacked) and the Context gauge a
Tremor `ProgressCircle`. Also landed: **exact `/context`** (US-009) and **full
`/usage`** (US-010, Session block + all 3 rate-limit windows) captures from the
correlated live pty into the Context/Usage widgets (disk estimate stays the
labelled fallback), and **native macOS notifications** (US-011, Tauri notification
plugin) surfacing Claude's `Notification`-hook prompts with click-to-focus.
Backlog: `docs/v4.2-backlog.md`; charting research: `docs/v4.2-research.md`.

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
