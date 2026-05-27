# Conan

**An always-on web dashboard that observes _and_ drives Claude Code.** Conan is
a structured-stream UI plus an integrated `xterm.js` terminal, served by a single
Node gateway. It surfaces everything Claude Code knows — from disk and the CLI —
in one place, and can launch and steer Claude Code sessions on your behalf.

- **Observe** — any hooked `claude` run in a watched directory self-reports its
  events, tool calls, tokens/cost, and status over a live WebSocket.
- **Drive** — launch headless sessions with the full sweep of Claude Code flags
  (effort, fork-session, from-PR, worktree isolation, typed `--json-schema`
  output, ultrareview, remote-control, Chrome), then watch them stream in.

Conan reads broadly from `~/.claude` and the `claude` CLI to surface real usage,
settings, MCP servers, the changelog, checkpoints, plugins, agents, skills, and
prompt history — so you never have to `tail` a file to see what's happening.

## Stack

- **Gateway** (`src/`): TypeScript ESM — Express 4 + [`ws`](https://github.com/websockets/ws)
  + [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) + `node-pty`.
  Run with [`tsx`](https://github.com/privatenumber/tsx). Entry
  `src/gateway/index.ts`, port **3747**, loopback-only by default.
- **UI** (`ui/`): Vite + React 19 + TypeScript + Tailwind v4 (CSS-first,
  `@theme inline` + `.dark` in `ui/src/index.css`), built on a real shadcn
  foundation with semantic theme tokens. `xterm.js` (`@xterm/*`) for the terminal.
  Charts are hand-rolled SVG + CSS grid (zero new charting deps). Built to
  `ui/dist` and served by the gateway.
- **Storage**: SQLite (WAL) at `.data/conan.db` — tables `session`, `event`,
  `terminal_session`, initialised idempotently on boot.

## Run / build / verify

```bash
npm install                 # postinstall fixes node-pty's spawn-helper perms
npm run dev                 # gateway, tsx WATCH, :3747   (restarts kill ptys — see Footguns)
npm start                   # gateway, NO watch (safer when self-editing)
cd ui && npm run dev        # Vite dev :5173, proxies /api + /ws -> :3747

npm run build               # root: typecheck + build ui   (CI gate)
npm run typecheck           # tsc --noEmit (gateway)
npm test                    # tsx unit/integration suites under scripts/
```

Then open <http://localhost:3747>.

The gateway is **single-instance on :3747** — if the port is already bound it
exits with a clear message instead of an `EADDRINUSE` stack. Override with
`CONAN_PORT`.

## Architecture

A single Node gateway (`src/gateway/index.ts`) serves the built SPA, the REST
API, and two authenticated WebSockets.

**HTTP** — `GET /api/health`, `GET /api/config` (`{token, port, cwd}`),
`GET /api/tasks` (prd.json + progress.txt), `GET/POST /api/cwd`,
`GET /api/fs/dirs` (directory picker), `GET/POST /api/settings`, plus a broad
read-mostly `/api/claude/*` surface:

| Area | Routes |
| --- | --- |
| Sessions | `GET /sessions`, `:id/events`, `:id/transcript`, `:id/subagents`, `:id/widgets`; drive via `POST /sessions`, `:id/prompt`, `:id/resume`, `:id/stop`, `:id/permission` |
| Usage / metrics | `/usage` (real `/usage` via PTY scrape → planUtilization), `/stats`, `/pulse`, `/project-metrics` |
| Config from disk | `/settings`, `/mcp`, `/permissions`, `/hooks-coverage`, `POST /hooks/install-global` |
| Catalogs | `/agents`, `/background-agents`, `/skills`, `/skills/list`, `/plugins`, `/changelog`, `/checkpoints` (+ `/:sessionId/content`), `/prompt-history` |
| Ops | `/doctor`, `/ultrareview` (+ `/stop`), `POST /events` (hook ingestion) |

**WebSockets** — `/ws` (app events `{type:'event'}`, the build-loop trail
`{type:'tasks'}`, snapshot on connect) and `/ws/terminal` (a `node-pty` that
auto-launches `claude` in the active cwd). Both are **authenticated on upgrade**.

**Auth** (`src/gateway/auth.ts`) — a token (`CONAN_AUTH_TOKEN` | `.data/auth-token`
| generated) **plus an Origin allowlist**, required because browsers don't apply
same-origin policy to WebSockets (CVE-2025-52882). The SPA reads the token from
same-origin `/api/config`.

**Remote access** (`src/gateway/tls.ts`) — opt-in, off by default. Set
`CONAN_TLS_CERT` + `CONAN_TLS_KEY` to serve HTTPS/`wss://` behind the same
token + Origin checks. Binding a non-loopback `CONAN_HOST` without TLS is
refused (no cleartext exposure). See `docs/remote-access.md`.

**Multi-project** — a global `~/.claude` hook means any `claude` run anywhere
self-reports; the UI filters the firehose by the active cwd. Driven sessions can
be isolated in their own git worktree (`docs/worktree-sessions.md`) and launched
with Remote Control / Chrome integration (`docs/remote-control-sessions.md`).

## UI / navigation

The app shell is a collapsible sidebar over a timeline-primary Overview. The
nav routes are:

- **Overview** — the live activity timeline (hook events + build-loop trail),
  a sticky widget carousel (scope-grouped: session / cwd / global), the
  transcript viewer, and session drive controls.
- **Agents** — registry agents, background agents, and teams.
- **Skills** — browse global + project `SKILL.md`s, with loaded state.
- **Plugins** — installed plugins, marketplaces, and enabled state.
- **Checkpoints** — read-only file-history snapshot viewer / rewind.
- **Prompt History** — search `history.jsonl`.
- **Code Review** — ultrareview trigger + findings panel.
- **What's New** — changelog feed with a new-since-last-seen nav badge.
- **Settings** — mirrors Claude Code `/settings` with typed controls + search.

A docked panel (drag-resizable, non-destructive show/hide) carries tabbed
**Terminal** (`xterm.js`, dropdown shows session name + short id), **Tasks**
(shown when the cwd has a task source), and **Preview** (the live app for the
current cwd — see below), with the global **Pulse** activity strip pinned at the
bottom of the column. A cwd directory picker lives in the toolbar; toasts
surface bottom-right.

## Live preview

Conan can run the current cwd's dev server and render the result live inside the
dock, so you watch Claude's edits hot-reload in one window. Open the **Preview**
tab, pick a dev command (auto-discovered from the cwd's `package.json` scripts —
`dev` → `start` → `preview`, overridable), and hit start. Conan spawns the dev
server on a pinned loopback port and serves it **same-origin** at `/preview/:id`
via a reverse proxy, so it inherits Conan's auth, works under TLS, frames cleanly
(framing headers are stripped), and keeps Vite HMR alive through Conan's port.

The preview process is decoupled from the gateway's watch restart and stops
itself when you switch cwd. Endpoints: `GET /api/preview/status`,
`POST /api/preview/start|stop`, `GET /api/preview/log`. The `/preview/` HTTP path
isn't token-checked per request (an iframe `src` can't send a token) — it relies
on the same-origin + loopback + Origin-checked WS-upgrade floor the rest of Conan
uses. v1 scope is run + proxy + preview (no container sandbox); a spawned dev
server executes project code on the host, bounded by Conan being loopback-only.

> **"Session"** in Conan means one Claude Code _run_ (an agent conversation),
> keyed by `session_id` — observed (self-reporting) or driven (launched by
> Conan). Not a browser/login session.

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

Full spec: `prd-claude-code-dashboard.md`. Backlogs: `docs/v2-backlog.md`,
`docs/v3-backlog.md`, `docs/v4-backlog.md` (+ `docs/v4-research.md`).
Ops/PM2: `docs/ops.md`.

## Gotchas

- **node-pty spawn-helper** ships non-executable → `posix_spawnp failed`. Fixed
  by `scripts/fix-node-pty.mjs` (postinstall); re-run `npm install` if it recurs.
- **OAuth tokens (`sk-ant-oat*`) are blocked for third-party API calls.** The
  interactive terminal `claude` uses your normal CLI login (fine); any headless
  API path must use `ANTHROPIC_API_KEY`.
- **Dogfooding:** `npm run dev` (`tsx watch`) restarts on `src/**` edits and
  kills every pty — including an in-dock session making the edit. Build from a
  session run outside Conan, or use `npm start` (no watch).
