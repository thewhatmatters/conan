# Conan

> An always-on web dashboard that observes AND drives Claude Code — structured-stream-first UI plus an xterm.js live terminal.
>
> *Generated 2026-05-25 by generate-prd from in-session (research report + write/drive confirmation).*

## Problem

Claude Code is a terminal-bound, session-scoped tool. It runs where you launched it, in the foreground, and its state lives in a TUI and on-disk JSONL under `~/.claude`. That creates three concrete pains for anyone running it as a workhorse rather than an occasional assistant:

- **No persistent surface.** Close the terminal (or the laptop sleeps) and your view of what the agent is doing is gone. There is no always-available place to glance at "what are my agents doing right now."

- **No visual observability.** Tool calls, subagents, token burn, retries, and permission prompts scroll past as raw text. There is no timeline, no per-session status, no at-a-glance health.

- **No remote / multi-session control.** Driving several Claude Code sessions in parallel, or kicking one off and checking on it from another device, means juggling terminals and tmux by hand.

The Conan project already pivoted toward being a *dashboard layer over Claude Desktop* (read-only). This PRD deliberately expands that scope: the user has confirmed they want **write/drive capability** — the dashboard should not just observe Claude Code, it should launch, steer, approve, and resume it.

## Solution

An **always-on web dashboard that is a full UI/control layer over Claude Code**, served by the existing Conan gateway. It does two things at once:

1. **Structured-stream-first observability + control (primary surface).** The dashboard drives Claude Code through its programmatic surfaces — headless `claude -p --output-format stream-json`, the Agent SDK's partial-message stream, and the ~19 lifecycle hooks — and renders them as rich UI: a live session grid, an event timeline (prompts → tool calls → results), subagent trees, a token/cost/throughput pulse chart, and inline **approve/deny controls** for permission prompts. Users can start a new session, send a prompt, approve a tool, stop, or resume an existing session — all from the browser.

2. **Integrated live terminal (escape hatch, right-docked).** An xterm.js terminal backed by node-pty gives full-fidelity, raw interaction with a real `claude`/shell process when the structured UI isn't enough (interactive prompts, manual commands, debugging). It lives in a **collapsible, resizable dock on the right** of the interface, multi-tab, one tab per session. This ships in phase 1 alongside the structured UI, not later.

**Layout (phase 1):** the main content area carries a **hero row of metrics widgets** — a **context-window gauge** (percent-full + tokens; predicts compaction), **skill count** (available + loaded this session), **cost today** (aggregate `total_cost_usd`), and **active sessions** (with status breakdown) — above the session grid and live timeline. The right dock holds the terminal. A **pending-approvals** panel surfaces every permission prompt awaiting a decision across sessions. Deeper signals (MCP servers, plugins + load errors, model/idle, retry rate, top tools, git status) ship as **opt-in widgets** so the default view stays a clean snapshot rather than a wall of cards.

**Theming:** a single light/dark switcher (light default) drives the whole experience via semantic tokens, and the **terminal's xterm theme is derived from the same tokens** — so the dock is never a mismatched dark panel inside a light app. Toggling restyles the terminal too.

"Always-on" means the dashboard and its session manager run under a process supervisor (PM2/systemd) on the always-on Mac Mini, sessions survive disconnects, and a returning browser reconnects and replays missed output. The default session model is **stateless + resume**: the gateway persists `session_id`s and reattaches with `--resume` on demand, rather than holding every agent process open forever.

It is **additive to Conan** — it reuses the Express + WebSocket gateway on :3747, the Vite + React SPA, the shadcn base-nova / Tailwind v4 design system, and existing components (`ActivityTimeline`, `StatCard`, `AgentCard`, tool-call indicators).

## UX flow

**Primary flow — observe & drive a session:**

1. User opens the dashboard (`/claude` view). The **hero widget row** (context gauge, skill count, cost today, active sessions) sits at the top; below it a **session grid** shows every active and resumable session as a card: status dot (running / idle / error), model, cwd, last activity, token/cost, session color. The **terminal dock** is on the right (collapsed by default).

2. User clicks **New session** → picks cwd + model + permission mode → the gateway spawns `claude -p --output-format stream-json --verbose --include-partial-messages` and streams events back.

3. The **event timeline** fills live: `UserPromptSubmit` → `PreToolUse` (with per-tool Lucide icon) → `PostToolUse` result, subagents nested via `parent_tool_use_id`, a `system/api_retry` badge on retries, a compaction marker on `PreCompact`.

4. When `PreToolUse` / `Notification:permission_prompt` fires, an **Approve / Deny** control appears inline; the user's choice is sent back to the agent (deny > defer > ask > allow precedence).

5. User types a follow-up prompt in the session composer; the gateway routes it to the live session (or `--resume`s it if dormant).

6. User can **Stop**, **Resume**, or open the **transcript viewer** (full conversation from session JSONL).

**Secondary flow — drop to a terminal:** From a session card, **Open terminal** mounts an xterm.js pane into the **right dock** (collapsible/resizable) wired to a node-pty process over an authenticated WS. Tabs let multiple terminals run side by side. FitAddon keeps sizing correct.

**Reconnect flow:** Browser loses the WS → heartbeat detects it → auto-reconnect with backoff → the gateway replays the per-session **ring buffer** so the terminal and timeline catch up without losing output.

**Remote flow (later):** From another device, the user authenticates to the gateway (token) over `wss://` behind TLS, or via an encrypted relay (Happy model), and sees/controls the same sessions.

## Technical architecture

Three new pieces on the existing Conan gateway. **Structured-stream-first; the terminal is an isolated, authenticated add-on.**

**1. Event ingest (hooks → gateway).** Install the ~19 Claude Code hooks as async shell hooks that POST to a new gateway route. Async output (`{async:true}`) means logging never blocks the agent.

```
Claude Code session
  └─ hooks (PreToolUse, PostToolUse, SessionStart/End, SubagentStart/Stop,
            Notification, PreCompact, Stop, ...)
       └─ async POST /api/claude/events  (gateway :3747)
            └─ persist (SQLite, WAL)  ──►  broadcast over WebSocket  ──►  React UI
```

**2. Session manager (gateway module).** Launches and supervises Claude Code via the Agent SDK (TS) or `claude -p`. Tracks `session_id`s, parses the `stream-json` event stream (`system/init`, `stream_event` → `content_block_delta` text/tool deltas, `AssistantMessage`, `ResultMessage` with `total_cost_usd`), and multiplexes events to clients. Default model = **stateless + resume**:

```
startSession(cwd, model, permMode) -> spawn `claude -p --output-format stream-json
     --verbose --include-partial-messages` ; capture session_id
sendPrompt(session_id, text)        -> route to live proc, or `--resume <id>` if dormant
stopSession(session_id)             -> terminate child
resumeSession(session_id)           -> `claude -p --resume <id> ...`
```

Auth for headless/SDK uses `ANTHROPIC_API_KEY` (a real API key), **not** Claude Code OAuth tokens (blocked for third-party calls) — and `--bare` for reproducible scripted launches.

**3. Terminal service (xterm.js ⇆ WS ⇆ node-pty).**

```
browser  xterm.js + @xterm/addon-fit (+addon-webgl)
   │  term.onData(d) ──ws──► server: ptyProcess.write(d)
   │  resize → {cols,rows} ──ws──► server: ptyProcess.resize(cols,rows)
   ▼
server   pty = nodePty.spawn(shell|'claude', [], {cols,rows,cwd,env})
         pty.on('data', d => ws.send(d))   // → term.write(d)
         + per-session ring buffer for replay on reconnect
```

**Always-on supervision.** Gateway + session manager run under **PM2 or systemd** (restart on crash/reboot) on the always-on Mac Mini. Optional **tmux/screen-backed persistent ptys** only when raw-terminal continuity across a gateway restart is required; otherwise stateless+resume is preferred (crash-resilient, cheaper, scales).

**Security (hard requirement, grounded in CVE-2025-52882).** Claude Code itself shipped a CVSS-8.8 WebSocket auth bypass: an unauthenticated WS bound to localhost, exploitable because browsers ignore same-origin policy for WebSockets. Therefore: **(a)** authenticate every WS connection with a token (validated on connect *and* re-validated, not only on `Open`); **(b)** validate the `Origin` header server-side to block CSWSH; **(c)** bind to loopback by default, require explicit opt-in + `wss://`/TLS + reverse proxy to expose remotely; **(d)** for remote access use an authenticated end-to-end-encrypted relay (Happy model), never a raw exposed shell port; **(e)** scope the agent with `PreToolUse` hooks / `--permission-mode` / `--allowedTools`, consider containers/restricted file roots; **(f)** audit-log every command (free from Pre/PostToolUse hooks).

## Data model

Persisted in SQLite (WAL mode) on the gateway. Core entities:

```
session
  id              TEXT PK     -- Claude Code session_id
  title           TEXT
  cwd             TEXT
  model           TEXT
  permission_mode TEXT         -- default | acceptEdits | dontAsk
  status          TEXT         -- running | idle | error | dormant
  color           TEXT         -- UI session color
  created_at      INTEGER
  last_activity   INTEGER
  total_cost_usd  REAL

event
  id              INTEGER PK
  session_id      TEXT FK -> session.id
  parent_tool_use_id TEXT      -- for subagent nesting
  hook_event_name TEXT         -- PreToolUse | PostToolUse | Notification | ...
  stream_type     TEXT         -- system/init | stream_event | result | api_retry
  tool_name       TEXT
  payload         TEXT         -- JSON blob (tool_input, result, deltas, etc.)
  ts              INTEGER

terminal_session
  id              TEXT PK
  session_id      TEXT FK
  pid             INTEGER
  cols            INTEGER
  rows            INTEGER
  ring_buffer     BLOB         -- recent output for reconnect replay (capped)
```

Full conversation transcripts are read from the existing Claude Code JSONL under `~/.claude` (not duplicated) for the transcript viewer.

## Pricing / cost

Internal/self-hosted tool — no end-user pricing. The relevant cost is **Anthropic API/usage cost**, which becomes material for an always-on system:

- From **June 15, 2026**, Agent SDK and `claude -p` usage on subscription plans draws from a *separate monthly Agent SDK credit*. An always-on dashboard that fires many headless calls must model this.

- Mitigations to build in: surface `total_cost_usd` per session and in aggregate on the pulse chart; throttling / concurrency caps; a configurable cost ceiling with alerting.

## Roadmap

**Phase 1 (v0) — observe + drive + integrated terminal + hero widgets, local only.**

- Hooks → `/api/claude/events` → SQLite → WS broadcast (US-001→005).

- Session manager: start / parse stream-json / sendPrompt / stop / resume (US-006→008).

- UI: `/claude` layout shell with **right-docked collapsible terminal** + session grid (`StatCard`/`AgentCard`); **hero widget row** — context-window gauge, skill count, cost today, active sessions (US-009→010).

- Live `ActivityTimeline`; inline permission approve/deny; **pending-approvals** panel; transcript viewer (US-011→014).

- **Integrated terminal:** node-pty service + xterm.js pane in the right dock, FitAddon + webgl, multi-tab, authenticated WS (US-015→016).

- WS auth token + `Origin` validation + loopback binding (security baseline from day one — US-002).

**v1 — always-on hardening + trends + deeper signals.**

- Reconnection with ring-buffer replay + heartbeat/backoff; PM2/systemd supervision (US-017→019).

- Pulse/throughput time-series chart with `api_retry` indicators (US-020).

- Subagent tree view via `parent_tool_use_id` (US-021).

- **Opt-in secondary widgets:** MCP servers, plugins + load errors, model/idle, retry rate, top tools, git status (US-022).

- Cost ceiling + alerting (US-023).

**later — remote + teams.**

- Remote access via TLS + auth or encrypted relay (Happy model) (US-024).

- Visualize native Claude Code **agent teams** / worktree parallelism rather than reinventing orchestration.

- Visualize native Claude Code **agent teams** / worktree parallelism rather than reinventing orchestration.

- Optional tmux-backed persistent ptys for raw-terminal continuity.

- Multi-user / multi-tenant (auth, session isolation) if needed.

## Risks

- **Security is the gating risk.** A browser-reachable shell/agent is a remote-code-execution surface; the CVE-2025-52882 pattern (unauth WS on localhost) is exactly the trap to avoid. Auth + Origin validation + loopback default are non-negotiable in v0.

- **Raw terminal ≠ structured data.** If the terminal becomes the primary surface, cards/charts/permission controls can't be built. Keep stream-json/SDK parsing as the primary path.

- **Terminal resize bug.** Without FitAddon + `pty.resize`, line-wrapping breaks — the classic xterm failure; wire it early.

- **Output volume / jank.** Claude Code is verbose; needs a perf renderer addon + server-side buffering/rate-limiting.

- **Reconnection replay is custom.** xterm has no built-in scrollback restore after a WS drop — the ring buffer is the team's to build.

- **Auth model.** `--bare` and an always-on headless fleet need `ANTHROPIC_API_KEY`, not OAuth (blocked for third-party calls since Jan 2026).

- **`maxThinkingTokens` disables partial streaming** — don't set it if live token streaming is wanted.

- **Cost runaway** from frequent always-on headless calls post-June-15-2026 credit split.

## Open questions

- **Single-user or multi-user/multi-tenant?** Changes auth, session isolation, and supervision.

- **Local-only or remote in v1?** If remote, adopt Happy's encrypted-relay model or self-host TLS + auth?

- **Persistent ptys vs. stateless `--resume`** as the default — depends on whether raw-terminal continuity across reconnects is a hard requirement (current default: stateless+resume).

- **Visualize native agent teams or build own orchestration?**

- **Cost ceiling + throttling policy** for always-on headless usage after the June-15-2026 Agent SDK credit split?

- **Relationship to the existing read-only "dashboard over Claude Desktop"** — does this replace it, sit beside it, or merge? (This PRD expands scope to write/drive.)

- **Agent SDK (TS) vs raw `claude -p` subprocess** as the session-manager implementation — SDK gives typed events + callbacks; subprocess is simpler to start.

## v2 — IA rework + real Claude Code data (2026-05-25)

v1 shipped all 30 stories (US-001→030). v2 is a **deliberate simplification + a push
to surface real out-of-the-box Claude Code data** instead of placeholders/estimates.
Decomposed into a fresh `prd.json` (v1 stories archived, not carried). Source backlog:
`docs/v2-backlog.md`.

### What Claude Code exposes, and how we consume it (research verdicts)

`/usage`, `/stats`, `/context` are **interactive TUI slash commands — there is no
`claude usage`/`claude stats` CLI subcommand** (confirmed: `claude --help` Commands =
agents, auth, auto-mode, doctor, install, mcp, plugin, project, setup-token,
ultrareview, update). So each is consumed by reading where it *sources* data:

- **`/stats` → `~/.claude/stats-cache.json`** ✅ on-disk, static read, no auth. Keys:
  `dailyActivity[]` (`{date, messageCount, sessionCount, toolCallCount}` — **sparse,
  only active days; zero-fill for a heatmap**), `dailyModelTokens[]`
  (`{date, tokensByModel}`), `modelUsage` (lifetime per-model tokens — favorite model;
  **`costUSD` is 0, plan has no per-token billing → use Conan's DB `total_cost_usd`
  for cost, not this**), `totalSessions`, `totalMessages`, `longestSession`,
  `hourCounts` (hour→count, "favorite hour"), `firstSessionDate`. Range here:
  2025-12-31 → present. → **Stats / heatmap widget** (GitHub-style contribution grid,
  total tokens, active days, streaks, favorite model/hour).
- **`/context` → reconstructable from transcript JSONL** ✅ the latest assistant
  message's `usage` block (`input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens`) = current context size; the message's `model` gives
  the window (e.g. Opus 4.7 = 1M). Context % = used / window. → **Context widget**
  wired to real per-session usage (replaces the placeholder gauge).
- **`/usage` (live limit % + reset) → NOT obtainable headlessly.** It's parsed from
  `anthropic-ratelimit-unified-*` HTTP response headers **in the `claude` process's
  memory** — Conan only shells out to `claude` (stream-json), never calls the API, so
  the headers are invisible. → **Usage widget stays an honest approximation**:
  rate-limited state + best-effort reset countdown from `system/api_retry` stream
  events (current behavior), **reframed around plan usage** + a token-consumption
  trend Conan *can* compute from its own DB. **Dollar cost-ceiling (US-023) is
  removed** — the plan is token/subscription-based (Claude Max), not $-metered, so a
  dollar budget is the wrong model. (A real % would require an opt-in
  `ANTHROPIC_API_KEY` probe whose headers reflect that key's limits, not the login
  session's — explicitly out of scope.)
- **Session liveness → `~/.claude/sessions/<pid>.json`** ✅ Claude Code writes one
  file per live process (`{pid, sessionId, cwd, status, updatedAt, kind, entrypoint,
  version}`). **Ground truth for "active" is: file exists AND `pid` is alive** —
  `updatedAt` *freezes* when a session goes idle (it's last-state-change, not a
  heartbeat), and a killed headless `claude -p` never fires its `Stop`/`SessionEnd`
  hook, which is why our DB shows ~53 stale `running` rows with 0 actually active.
  → **Stale-session fix**: reaper derives active from pid-liveness + recent
  `last_activity`; GC dead test/verification rows.
- **MCP status → inferred, no live registry on disk.** File-configured servers live in
  `~/.claude/settings.json` `mcpServers`; `~/.claude/mcp-needs-auth-cache.json` is the
  negative signal (servers needing (re)auth). The only true connected/failed state is
  the per-run `system/init` event's `mcp_servers` array, which Conan already captures
  for sessions it launches. → **MCP widget**: connected count + tooltip of names,
  inferred (configured − needs-auth), enriched by `system/init` when a live session
  exists.

### IA rework (confirms `project_conan_layout_ia`)

- **Collapsible sidebar, two items only: Overview + Settings** (pushState routing, no
  react-router). Terminal + Tasks stay in the right dock (not nav items).
- **Overview = timeline-primary.** The activity log is the home surface, driven by a
  **`session ▾` dropdown** (whose events to view) + **activity-type filters**
  (All/Bash/Read/Edit/Write/Skill/…). **The per-session card grid is removed** — the
  5 lifecycle actions (stop/resume/send/open/new) become inline controls on the
  dropdown. **Transcript view (US-014) is kept** as the paired Activity↔Transcript
  toggle off the dropdown.
- **Hero-widget overhaul** (top section, behind a dropdown showing ~5 at a time so it
  can't overflow): **remove** Plugins, API-retry-rate, Top-tools; **wire** MCP
  (count + connected tooltip), Model & idle, Git status; **add** Stats/heatmap,
  Context (real), Usage (plan-framed). **Pending Approvals renders only when a
  decision is waiting.**
- **Pulse/throughput viz** — replace the bar graph with a hand-rolled SVG
  **stacked-area / streamgraph** time-series (rejected Sankey: no time axis, wrong for
  a small hero tile; reserve Sankey for a future full-width flow panel). Charting:
  **zero new deps** — hand-rolled SVG + a CSS-grid heatmap, themed via new
  `--color-chart-1..5` semantic tokens in `index.css`.
- **Dock: Term tabs → `Term ▾` dropdown** with "+ New terminal" inside it (the
  horizontal strip overflows past ~4 tabs). **Toolbar cwd → directory picker** to
  change the active working directory.

## v3 — multi-project, full capability coverage, real /usage (2026-05-26)

v2 shipped 20/20. v3 = "Conan leverages everything Claude Code can do." Decomposed
into a fresh `prd.json` (v2 archived). Source backlog + full research verdicts:
`docs/v3-backlog.md`.

### Locked decisions
- **Multi-project (global hook).** Install a user-level `~/.claude` hook so ANY
  `claude` run self-reports; the UI filters/switches by cwd. (Today Conan only sees
  sessions in repos whose project hook points at it.)
- **Nav → Overview · Agents · Skills · Settings.** Deliberate expansion past v2's
  2-item cap; agents/skills are distinct enough surfaces to earn pages.
- **Everything in one PRD** (~40+ stories), built on a proper **shadcn** foundation
  (v1/v2 never actually installed it — only used shadcn-compatible tokens).

### Research verdicts (what's readable, and how)
- **Real `/usage` % — via PTY scrape, not headers.** Live-tested: `claude -p
  --debug api` does NOT surface `anthropic-ratelimit-unified-*` headers (only
  request-id/billing/skills). So the real plan-utilization comes from **scraping the
  `/usage` TUI in a node-pty session** (the only confirmed source), layered over the
  always-on token-trend baseline (US-004) so the widget is never blank. Debug-log
  header parsing is a deferred spike.
- **Settings** persist to `~/.claude/settings.json` (user scope); most TUI toggles
  are unmaterialized defaults until changed → treat missing-key as default. Authoritative
  key/type/enum list = `json.schemastore.org/claude-code-settings.json`. Safe to edit:
  theme, verbose, thinking mode, editor mode, agent push, auto-compact threshold;
  gate `permissions.defaultMode` (no casual `bypassPermissions`) and `~/.claude.json`
  writes. Atomic write, preserve unknown keys.
- **MCP** servers live in `~/.claude.json` (global `mcpServers` + per-project union),
  not just `settings.json` — v2 counted 1 because it only read settings.json.
- **Changelog** (`~/.claude/cache/changelog.md`): uniform `## <version>` + flat
  bullets, no dates → `{version, items[]}`; "what's new" = entries newer than
  `~/.claude.json` `lastReleaseNotesSeen`.
- **New on-disk capability sources** (capability audit): live-session registry
  (`~/.claude/sessions/<pid>.json`), checkpoints/rewind (`~/.claude/file-history/`),
  per-project metrics (`~/.claude.json` projects[]), plugins (`plugins/installed_plugins.json`),
  custom agents (`~/.claude/agents/`), background agents (`claude agents --json`),
  subagent transcripts (`projects/<cwd>/<id>/subagents/agent-*.jsonl`), prompt history
  (`history.jsonl`), full hook set vs the 9 Conan wires.

### Scope (grouped; see prd.json for the ordered stories)
- **Foundation:** shadcn init + reusable primitives; multi-project global hook + cwd
  ingestion; active-cwd state + directory picker backend.
- **Backend data:** MCP fix; real-/usage PTY scrape; settings mirror (read+safe write);
  changelog; checkpoints; hooks-coverage; per-project metrics; plugins; custom-agents;
  background-agents; subagent reconstruction; prompt-history; skills list.
- **Shell/IA:** 4-item sidebar + routing.
- **Overview:** widget carousel + cog (4-up, chevrons); scope grouping
  (session/cwd/global); sticky-on-scroll; sort toggle; timeline-icon opaque fix;
  widget wiring (MCP/Model/Usage), remove Cost-today, per-project widget.
- **Pages:** Agents, Skills, Settings-mirror, What's-New feed, Checkpoints/rewind,
  Plugins, Hooks-coverage, Prompt-history, past-session subagent tree.
- **Dock/terminal:** term dropdown shows session name+ID; non-destructive show/hide;
  height drag handle; cwd-conditional Tasks; cwd picker UI; toasts bottom-right.
- **Drive expansion:** `--effort`/`--fork-session`/`--from-pr`; worktree-isolated
  sessions; `--json-schema` typed outputs; doctor/update banner; ultrareview trigger;
  remote-control/Chrome.
- **Docs:** README.

## Sources

1. [Claude Agent SDK — Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output) — Anthropic docs
2. [Claude Code — Run programmatically (headless)](https://code.claude.com/docs/en/headless) — Anthropic docs
3. [Claude Agent SDK — Hooks](https://code.claude.com/docs/en/agent-sdk/hooks) — Anthropic docs
4. [Orchestrate teams of Claude Code sessions (agent teams)](https://code.claude.com/docs/en/agent-teams) — Anthropic docs
5. [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) — React/Vite/Tailwind + xterm.js web UI over `~/.claude`
6. [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui) — CLI-subprocess streaming chat UI
7. [slopus/happy](https://github.com/slopus/happy) — mobile/web client, encrypted relay, session handoff
8. [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) — hooks→Bun→SQLite→WS→Vue dashboard
9. [Web Terminal with xterm.js, node-pty & WebSockets](https://ashishpoudel.substack.com/p/web-terminal-with-xtermjs-node-pty) — tutorial
10. [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) / [@xterm/xterm](https://www.npmjs.com/package/@xterm/xterm)
11. [CVE-2025-52882: WebSocket auth bypass in Claude Code](https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882) — Datadog Security Labs
12. [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
13. [Ably — WebSocket security](https://ably.com/topic/websocket-security)
14. [What Is OpenClaw? Complete Guide](https://milvus.io/blog/openclaw-formerly-clawdbot-moltbot-explained-a-complete-guide-to-the-autonomous-ai-agent.md) — Milvus
15. [One Week with OpenClaw](https://dustindavis.me/blog/one-week-with-openclaw)
16. [Hermes Agent — delegate coding to Claude Code CLI](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-claude-code) / [hermes-webui](https://github.com/nesquena/hermes-webui)
17. [tmux for persistent terminal sessions](https://oneuptime.com/blog/post/2026-03-02-how-to-use-screen-and-tmux-for-persistent-terminal-sessions-on-ubuntu/view)

*Full research report: [research-claude-code-always-on-dashboard.md](research-claude-code-always-on-dashboard.md)*
