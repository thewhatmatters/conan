# Conan

**A terminal-primary native desktop app that wraps and observes Claude Code.**
Conan puts Claude Code's `xterm.js` terminal front-and-center, with a
DevTools-style **widget HUD** — **Context** (session-scoped), **Usage** (plan +
session), and a **Pulse** activity graph — backed by one loopback Node gateway
packaged as a Tauri sidecar.

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
authenticated WebSockets, **loopback-only**. The trimmed v4.2 route surface is
exactly what the app calls:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| GET | `/api/config` | `{token, port, cwd}` |
| GET | `/api/tasks` | prd.json + progress.txt (build-loop backlog) |
| GET | `/api/terminals` | live terminals + their session labels |
| GET | `/api/claude/sessions` | the observed-sessions list |
| GET | `/api/claude/sessions/:id/widgets` | Context breakdown for a session |
| POST | `/api/claude/sessions/:id/context/refresh` | inject `/context` into the correlated pty + capture |
| POST | `/api/claude/sessions/:id/usage/refresh` | inject `/usage` into the correlated pty + capture |
| GET | `/api/claude/usage` (`+?probe=1`) | plan usage / rate-limit windows |
| GET | `/api/claude/pulse` | activity buckets for the Pulse chart |
| POST | `/api/claude/events` | hook ingestion |

Everything else — the launch/steer drive routes, the read-only catalog/config
routes (`/agents`, `/skills`, `/stats`, `/settings`, …), and the web-served +
TLS/remote-access + pm2 path — was removed in v4.2.

**WebSockets** — `/ws` (app events `{type:'event'}`, the build-loop trail
`{type:'tasks'}`, snapshot on connect) and `/ws/terminal` (a `node-pty` that
auto-launches `claude` in the active cwd). Both are **authenticated on upgrade**.

**Auth** (`src/gateway/auth.ts`) — a token (`CONAN_AUTH_TOKEN` | `.data/auth-token`
| generated) **plus an Origin allowlist** (incl. `tauri://localhost`), required
because browsers don't apply same-origin policy to WebSockets (CVE-2025-52882).
The app reads the token from same-origin `/api/config`. The gateway binds
**loopback-only** (127.0.0.1) — there is no TLS/remote-access path (Tauri-only).

**Multi-project** — a global `~/.claude` hook means any `claude` run anywhere
self-reports; the UI filters the firehose by the active cwd.

## UI / the HUD

The app is terminal-primary: the `xterm.js` terminal fills the main pane (its
dropdown shows the session name + short id), with a DevTools-style tabbed HUD and
a docked panel beside/below it.

- **Context** widget — the live session's `/context` breakdown (model header,
  total %, per-category tokens incl. Free space), rendered with a Tremor
  `ProgressCircle` gauge (destructive past 80%) over a hand-rolled breakdown bar.
- **Usage** widget — the `/usage` Session block (cost, durations, code changes,
  per-model usage) + all three rate-limit windows, captured from the live pty
  with the throwaway probe as fallback.
- **Pulse** — a Tremor `AreaChart` (stacked) of activity over 15m/1h/6h/24h.
- **Dock** — drag-resizable, tabbed **Terminal** | **Tasks** (when the cwd has a
  task source), with the Pulse strip pinned at the bottom of the column.
- **Native notifications** — in the Tauri app, a `Notification` hook event fires
  a native macOS banner with the prompt text; clicking it focuses Conan. The
  browser dev view falls back to the in-app Toaster.

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

## Backlog & build loop

Conan is built by an autonomous loop, and its own backlog lives in the repo:

- **`prd.json`** — the build backlog. Each story has `passes`, `priority`, and
  `acceptanceCriteria`. The loop picks the lowest-`priority` story with
  `passes:false`, implements only that one, verifies it, sets `passes:true`,
  and appends to `progress.txt`.
- **`progress.txt`** — the loop's timestamped activity trail (gitignored).
- **`run-tasks.sh`** — runs a fresh agent per story until all pass.
- **`CLAUDE.md`** — project context auto-loaded by every Claude Code session.

Validate the backlog after editing:

```bash
python3 ~/.claude/skills/decompose-prd/scripts/validate.py --in=prd.json
```

Current spec: `docs/v4.2-backlog.md` (+ `docs/v4.2-research.md`).

## Gotchas

- **node-pty spawn-helper** ships non-executable → `posix_spawnp failed`. Fixed
  by `scripts/fix-node-pty.mjs` (postinstall); re-run `npm install` if it recurs.
- **OAuth tokens (`sk-ant-oat*`) are blocked for third-party API calls.** The
  interactive terminal `claude` uses your normal CLI login (fine); any headless
  API path must use `ANTHROPIC_API_KEY`.
- **Dogfooding:** `npm run dev` (`tsx watch`) restarts on `src/**` edits and
  kills every pty — including an in-dock session making the edit. Build from a
  session run outside Conan, or use `npm start` (no watch).
