# Conan

**A terminal-primary native desktop app that wraps and observes Claude Code.**
Conan puts Claude Code's `xterm.js` terminal front-and-center — with a cwd/branch
**status bar** and an optional **per-terminal split panel** that toggles between a
**File Explorer** (the tab's live cwd, with "Claude touched this" badges) and a
**Timeline** showing hooks, skill firing (and the heuristic *considered but didn't
fire* reasons), plan rows, `/loop` cadence, and the build-loop trail — beside a DevTools-style
**widget HUD** (**Context · Usage · Pulse · Skills · MCP**) and a **Claude
Radio** play/pause toolbar, all backed by one loopback Node gateway packaged as
a Tauri sidecar.

- **Terminal** — a live `node-pty` running `claude` in the active cwd, the main
  surface of the app.
- **Observe** — any hooked `claude` run in a watched directory self-reports its
  events, tool calls, and status over a live WebSocket, feeding the HUD and the
  Pulse graph. (The earlier launch/steer "drive" surface was removed in v4.2 —
  Conan observes the pty, it doesn't drive headless sessions through the gateway.)
- **Exact captures** — the Context and Usage widgets capture the real `/context`
  and `/usage` frames from the correlated live pty (passive when you run them, or
  via a Refresh button), falling back to an honest on-disk estimate / throwaway
  probe when there's no live session.

## Stack

- **Gateway** (`src/`): TypeScript ESM — Express 4 + [`ws`](https://github.com/websockets/ws)
  + [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) + `node-pty`.
  Run with [`tsx`](https://github.com/privatenumber/tsx). Entry
  `src/gateway/index.ts`, port **3747**, **loopback-only**. JSON API + two
  WebSockets only — it does **not** serve the UI to a browser (v4.2 Tauri-only).
- **UI** (`ui/`): Vite + React 19 + TypeScript + Tailwind v4 (CSS-first,
  `@theme inline` + `.dark` in `ui/src/index.css`), on a real shadcn foundation
  with semantic theme tokens. `xterm.js` (`@xterm/*`) for the terminal. **Charts
  ride [Tremor Raw](https://tremor.so)** (recharts-based, Tailwind-v4-native
  copy-in components vendored under `ui/src/components/charts/`) — *not*
  `@tremor/react`. Loaded by the Tauri webview; dev uses the Vite server (:5173).
- **Desktop** (`src-tauri/`): a Tauri v2 crate that opens a native window onto the
  React + `xterm.js` UI and spawns the gateway as a bundled-node **sidecar**.
- **Storage**: SQLite (WAL) at `.data/conan.db` — tables `session`, `event`,
  `terminal_session`, initialised idempotently on boot.

## Run / build / verify

```bash
npm install                 # postinstall fixes node-pty's spawn-helper perms
npm start                   # gateway, NO watch (safer when self-editing)
npm run dev                 # gateway, tsx WATCH, :3747   (restarts kill ptys — see Gotchas)
cd ui && npm run dev        # Vite dev :5173, proxies /api + /ws -> :3747

npm run build               # root: typecheck + build ui   (CI gate)
npm run typecheck           # tsc --noEmit (gateway)
npm test                    # tsx unit/integration suites under scripts/
```

For development, run the gateway with `npm start` and the UI on the Vite dev
server, then open <http://localhost:5173> (the gateway no longer serves a
browser UI). The shipped product is the **Tauri app** (see below).

The gateway is **single-instance on :3747** — if the port is already bound it
exits with a clear message instead of an `EADDRINUSE` stack. Override with
`CONAN_PORT`.

## Architecture

A single Node gateway (`src/gateway/index.ts`) serves the REST API and two
authenticated WebSockets, **loopback-only**. The route surface — trimmed hard in
v4.2, then grown back deliberately in v4.3/v4.4 — is exactly what the app calls:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| GET | `/api/config` | `{token, port, cwd}` |
| GET | `/api/tasks` | build-loop trail for projects that ship a `prd.json`/`progress.txt` |
| GET | `/api/terminals` | live terminals + their session labels |
| GET | `/api/claude/sessions` | the observed-sessions list |
| GET | `/api/claude/sessions/:id/widgets` | Context breakdown for a session |
| POST | `/api/claude/sessions/:id/context/refresh` | inject `/context` into the correlated pty + capture |
| POST | `/api/claude/sessions/:id/usage/refresh` | inject `/usage` into the correlated pty + capture |
| POST | `/api/claude/sessions/:id/handoff` | inject `/handoff` (Context-pressure Compact) |
| GET/POST | `/api/claude/context/autorefresh` | the adaptive `/context` auto-refresh gate |
| GET | `/api/claude/usage` (`+?probe=1`) | plan usage / rate-limit windows |
| GET | `/api/claude/pulse` | activity buckets for the Pulse chart |
| GET | `/api/claude/skills` | installed skills (name + description + source + `lastFiredAt`) |
| GET | `/api/claude/mcp` (`+?force=1`) | configured MCP servers + health (`claude mcp list`) |
| GET/POST | `/api/claude/config` | Claude config mirror (read) + single-key edit (write) |
| GET | `/api/claude/timeline?session=…&since=…&limit=…` | the chronological per-session log (hook + build + skill-fired + skill-considered + plan + loop rows) |
| POST | `/api/claude/events` | hook ingestion |
| GET | `/api/fs/list?path=…` | File Explorer: immediate contents (files + dirs) of a directory |
| GET | `/api/fs/touched?session=…` | the files Claude Edited/Wrote/Read in a session (powers the "Claude touched this" badges) |
| POST | `/api/fs/reveal` | reveal a path in Finder (macOS `open -R`, existence-checked, no shell) |

Still gone (removed in v2/v4.2): the launch/steer drive routes, the read-only
catalog routes (`/agents`, `/stats`, …), and the web-served + TLS/remote-access +
pm2 path. The `/skills`, `/mcp`, and `/config` routes here are the new, focused
read/write surface the HUD + Settings actually use — not the old catalog.

**WebSockets** — `/ws` carries `{type:'event'}` hook events, `{type:'tasks'}` the
build-loop trail, plus `{type:'skill-fired'}`, `{type:'skill-considered'}`, and
`{type:'plan'}` broadcasts (added in v4.5-timeline US-002/003/006), plus
`{type:'cwd'}` (the focused-only app-wide cwd → StatusBar) and
`{type:'terminal-cwd', payload:{tid,cwd}}` (any tab's own cwd changes, focused or
not → the per-tab File Explorer re-lists); snapshot on connect. `/ws/terminal`
(a `node-pty` that auto-launches `claude` in the active cwd). Both are
**authenticated on upgrade**.

**Auth** (`src/gateway/auth.ts`) — a token (`CONAN_AUTH_TOKEN` | `.data/auth-token`
| generated) **plus an Origin allowlist** (incl. `tauri://localhost`), required
because browsers don't apply same-origin policy to WebSockets (CVE-2025-52882).
The app reads the token from same-origin `/api/config`. The gateway binds
**loopback-only** (127.0.0.1) — there is no TLS/remote-access path (Tauri-only).

**Multi-project** — a global `~/.claude` hook means any `claude` run anywhere
self-reports; the UI filters the firehose by the active cwd.

## UI / the HUD

The app is terminal-primary: the `xterm.js` terminal fills the main pane behind a
**VS-Code-style tab strip** (multiple terminals, each its own pty; switching never
tears one down), with a cwd/branch **status bar** below it and an optional
**per-terminal split panel** to its right (toggle next to `+` or `⌘\`) tethered
per-terminal — it hosts two views you switch between per tab, **Files** and
**Timeline** (each tab remembers its choice). A drag-resizable, width-persisted
HUD docks to the right of all that. The HUD's session-scoped tabs follow the
**active terminal tab**.

- **Files** — a File Explorer for THIS tab's live working directory (it re-lists
  the instant you `cd` inside the tab). Files + directories (dirs first), with
  per-entry **"Claude touched this"** badges — *edited* (Edit/Write) outranks
  *read* (Read) — derived from the session's hook events, plus a
  reveal-in-Finder action.
- **Timeline** — a per-tab vertical split that lists THIS terminal's session as a
  chronological log: hook events, **skills fired** + the heuristic *considered
  but didn't fire* reasons per prompt (BM25-scored against each skill's
  description — labelled "Heuristic match"), TodoWrite/ExitPlanMode **plan**
  rows, Claude Code `/loop` skill activity, and (when running our autonomous
  build workflow) the build trail. Filter chips are dynamic — a chip only
  appears when this session has at least one row of that kind.
- **Context** tab — the live session's `/context` breakdown (model header, total %,
  per-category tokens incl. Free space) with a Tremor `ProgressCircle` gauge, an
  **Auto** auto-refresh toggle + manual `↻ /context`, and a top-pinned
  **context-pressure toolbar** (Remind-me-later snooze 80–95%, Compact → `/handoff`
  at ≥95%).
- **Usage** tab — the `/usage` Session block + all three rate-limit windows,
  captured from the live pty with the throwaway probe as fallback.
- **Pulse** tab — a Tremor `AreaChart` (stacked) of activity over 15m/1h/6h/24h.
- **Skills** tab — installed skills (name + description from SKILL.md, plus a
  `last fired` timestamp derived from the transcript scan), grouped
  **User / System**.
- **MCP** tab — configured MCP servers + live health from `claude mcp list`
  (connected / failed / needs-auth), with a refresh.
- **Claude Radio** — a play/pause toolbar at the HUD's bottom streaming a YouTube
  live stream as ambient audio (offscreen YouTube IFrame player).
- **Settings** (⌘,) — a tabbed **Status** (read-only mirror) / **Config**
  (editable: toggles, dropdowns, inputs → `/api/claude/config`) dialog.
- **Native notifications** — in the Tauri app, a `Notification` hook event fires a
  native macOS banner; clicking it focuses Conan + the prompting tab. The browser
  dev view falls back to the in-app Toaster.

> **"Session"** in Conan means one Claude Code _run_ (an agent conversation),
> keyed by `session_id` — observed (self-reporting over the WS). Not a
> browser/login session.

## Desktop app (Tauri)

The shipped product is a native macOS app: `src-tauri/` (a Tauri v2 crate at the
repo root) opens a 1400×900 window onto the React + `xterm.js` UI and spawns the
**gateway sidecar** on launch (`CONAN_PORT=3747`), killing it on quit so the
single-instance port frees for the next run. The gateway is packaged as a
bundled-node launcher (`src-tauri/binaries/conan-gateway-<triple>` + a `runtime/`
tree carrying Node and the `better-sqlite3` / `node-pty` native addons as real
files — the reliable route for native modules). A **stdin-EOF watchdog**
(`CONAN_SIDECAR=1`) self-terminates the gateway if the Rust kill doesn't land on
an Apple-event quit.

```bash
npm run tauri:dev              # dev: Vite (:5173) + native window + live sidecar
npm run build:sidecar          # (re)build the gateway sidecar binary + runtime/
npm run test:sidecar           # prove better-sqlite3 + node-pty work from the binary
CI=true npm run tauri:build    # bundle Conan.app + .dmg (CI=true for headless DMG)
```

Artifacts land in `src-tauri/target/release/bundle/{macos,dmg}/`. The local build
is **ad-hoc signed**; the Developer-ID sign + notarize path for distribution and
the `CI=true` headless-DMG note are in **`docs/tauri-desktop.md`**.

## Roadmap

- **`docs/v4.7-licensing-design.md`** — Ed25519 JWT licensing (offline
  verification, Polar.sh issuance).
- **`docs/v4.7-update-design.md`** — Tauri-plugin-updater + minisign signing +
  Cloudflare R2 hosting.

## Gotchas

- **node-pty spawn-helper** ships non-executable → `posix_spawnp failed`. Fixed
  by `scripts/fix-node-pty.mjs` (postinstall); re-run `npm install` if it recurs.
- **OAuth tokens (`sk-ant-oat*`) are blocked for third-party API calls.** The
  interactive terminal `claude` uses your normal CLI login (fine); any headless
  API path must use `ANTHROPIC_API_KEY`.
- **Dogfooding:** `npm run dev` (`tsx watch`) restarts on `src/**` edits and
  kills every pty — including an in-dock session making the edit. Build from a
  session run outside Conan, or use `npm start` (no watch).
