# Research: An "Always-On" Web Dashboard as a UI Layer for Claude Code

**Type:** feature / feasibility · **Depth:** standard+ · **Date:** 2026-05-25
**Question:** Build an always-on web dashboard that acts as a UI layer for Claude Code (à la OpenClaw, Hermes Agent), using xterm.js for a live terminal and shadcn/Tailwind for UI. Is it feasible, and what should a PRD cover?

---

## TL;DR

**Feasible — and well-trodden.** Every component you need already exists in shipping open-source projects, and Claude Code exposes first-class programmatic surfaces designed for exactly this: a non-interactive `-p` mode with newline-delimited `stream-json` output, session resumption via `--resume <id>`, the Agent SDK (TS/Python) with partial-message streaming, and ~19 lifecycle **hooks** purpose-built for observability ([SDK streaming docs](https://code.claude.com/docs/en/agent-sdk/streaming-output), [headless docs](https://code.claude.com/docs/en/headless), [hooks docs](https://code.claude.com/docs/en/agent-sdk/hooks)). The live-terminal piece (xterm.js ⇆ WebSocket ⇆ node-pty) is a solved pattern with public tutorials ([xterm+node-pty walkthrough](https://ashishpoudel.substack.com/p/web-terminal-with-xtermjs-node-pty)), and at least one Claude Code web UI already ships it ([siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)).

The genuinely hard parts are not technical novelty — they are **(1) security** (a browser-reachable shell is a remote code execution surface; Claude Code itself shipped a critical WebSocket auth-bypass CVE in 2025), **(2) process supervision** for true "always-on" multi-instance operation, and **(3) the architectural choice** between a *raw terminal* (xterm/pty — full fidelity, hard to make pretty) and a *structured stream UI* (parse `stream-json`/SDK events into rich cards — beautiful, but you rebuild the TUI). The strongest products do **both**: structured UI as the default surface, raw terminal as an escape hatch.

This maps cleanly onto your existing Conan stack (Vite + React SPA, Express + WS gateway on :3747, shadcn base-nova, Tailwind v4) — you already have the gateway, WebSocket plumbing, and dashboard shell. This is an additive feature, not a rewrite.

---

## 1. Existing landscape — who is already building this

The space splits into four buckets:

### A. Always-on agent *harnesses* (the OpenClaw / Hermes model)
These are not "UIs over Claude Code" so much as **autonomous daemons** that may *delegate to* Claude Code as one of several skills.

- **OpenClaw** (formerly Clawdbot/Moltbot; MIT core gateway) — an "always-on daemon infrastructure" with a persistent **gateway**, **scheduling/cron**, and **persistent memory** so agents act on schedules or external events rather than only on user prompts. Its primary *interface* is messaging apps (WhatsApp, Telegram, Slack, Discord, Signal, iMessage), not a terminal ([Milvus guide](https://milvus.io/blog/openclaw-formerly-clawdbot-moltbot-explained-a-complete-guide-to-the-autonomous-ai-agent.md), [Dustin Davis: One Week with OpenClaw](https://dustindavis.me/blog/one-week-with-openclaw)). The architectural lesson: "always-on" = a supervised gateway daemon + scheduler + memory, with the agent runtime (Claude Code) invoked underneath.
- **Hermes Agent** (Nous Research) — a CLI-first agent that can **delegate coding to the Claude Code CLI** as a bundled skill, with a community **web UI** ([hermes-webui](https://github.com/nesquena/hermes-webui), [docs: delegate to Claude Code](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-claude-code)).
- Production-deployment writeups compare the Claude Code vs. Hermes operating models directly ([Ken Huang, Ch.10](https://kenhuangus.substack.com/p/chapter-10-production-deployment)).

**Takeaway:** "OpenClaw-style" really means *gateway daemon + scheduler + memory + multi-channel I/O*. Your Conan memory already reflects this exact pivot (gateway on :3747, heartbeat/brain pipeline, autonomous tasks). The dashboard is the missing *visual* channel.

### B. Web UIs *directly over* the Claude Code CLI (closest to your goal)
- **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** ("Cloud CLI") — React + Vite + Tailwind front end, Node.js server. It **reads/writes the same `~/.claude` config** Claude Code uses natively and **auto-discovers every session** from the `~/.claude` folder so you can resume/manage them. Critically, it ships a **Web Terminal plugin using xterm.js with multi-tab support** — i.e., the exact xterm pattern you proposed. A hosted "Cloud" tier keeps agents running when your machine is offline; the self-hosted version "requires your machine to stay on" — an explicit statement of the always-on tradeoff.
- **[sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui)** — TypeScript (Deno *or* Node ≥20), Vite + React. Wraps the **CLI as a subprocess** and streams responses live into a **custom chat interface** (no xterm/pty) with session history/restore. Demonstrates the "structured stream UI" alternative to a raw terminal.
- **[slopus/happy](https://github.com/slopus/happy)** — mobile + web client for Claude Code (and Codex). Users run `happy claude` instead of `claude`; a **CLI wrapper + "Happy Agent" + backend sync server** let you "take control from phone or desktop with one keypress," with **end-to-end encryption** ("code never leaves your devices unencrypted") and persistent session state synced across devices. The reference design for *remote* always-on access done safely.
- Adjacent: [open-webui integration discussion](https://github.com/open-webui/open-webui/discussions/23866), [claude-code-router](https://github.com/musistudio/claude-code-router) (model routing), [claudecodeui.com](https://www.claudecodeui.com).

### C. Observability dashboards (the "dashboard" half, done right)
- **[disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)** — the canonical pattern. 12 hook scripts in `.claude/hooks/` POST events to a **Bun + TypeScript server → SQLite (WAL) → WebSocket → Vue 3 + Vite + Tailwind client**. The dashboard renders a real-time timeline with dual-color (app + session) borders, a live pulse chart, filtering, and a transcript viewer. Event pipeline: `Claude Agents → Hook Scripts → HTTP POST → Bun Server → SQLite → WebSocket → Vue Client`. **This is your observability blueprint** — swap Vue for your React/shadcn shell.

### D. Native Claude Code multi-session orchestration
Anthropic now ships **[agent teams](https://code.claude.com/docs/en/agent-teams)** for orchestrating multiple Claude Code sessions, plus community patterns for [parallel sessions](https://www.mindstudio.ai/blog/claude-code-parallel-sessions) and [parallelization via worktrees](https://ona.com/stories/parallelize-claude-code). Relevant because your dashboard may *visualize* teams rather than reinvent orchestration.

---

## 2. Claude Code's programmatic surface (what you build against)

Claude Code is explicitly designed to be driven programmatically — you do **not** need to screen-scrape a TUI.

### Headless / non-interactive (`claude -p`)
- `claude -p "<prompt>"` runs non-interactively; **all CLI flags work with `-p`** ([headless docs](https://code.claude.com/docs/en/headless)).
- `--output-format`: `text` (default), `json` (result + `session_id` + metadata incl. `total_cost_usd`), or **`stream-json`** (newline-delimited JSON, one event per line) for real-time streaming.
- Real-time token streaming: `claude -p "..." --output-format stream-json --verbose --include-partial-messages`. Each line is a JSON event; filter `stream_event` / `text_delta` with jq.
- **Session resumption:** `--continue` resumes the most recent conversation; `--resume "<session_id>"` resumes a specific one. Capture the id from `--output-format json | jq -r '.session_id'`. **This is the key to "always-on" continuity** — persist session IDs and reattach.
- `--bare` skips auto-discovery (hooks, skills, MCP, CLAUDE.md) for fast, reproducible scripted calls (will become the `-p` default). Note: bare mode requires `ANTHROPIC_API_KEY`/`apiKeyHelper`, **not** OAuth.
- Other useful flags: `--allowedTools "Bash,Read,Edit"`, `--permission-mode acceptEdits|dontAsk`, `--append-system-prompt`, `--mcp-config`, `--agents`, `--max-turns`.
- **Billing note (matters for "always-on"):** starting **June 15, 2026**, Agent SDK and `claude -p` usage on subscription plans draws from a *separate monthly Agent SDK credit* ([headless docs](https://code.claude.com/docs/en/headless)). An always-on system that fires many headless calls needs cost modeling.

### Stream event types (what your UI parses)
From `--output-format stream-json` / SDK partial messages ([SDK streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output)):
- `system/init` (first event) — model, tools, MCP servers, loaded plugins.
- `system/api_retry` — `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` category (`rate_limit`, `server_error`, …). **Surface this as a retry indicator.**
- `stream_event` wrapping raw API events: `message_start`, `content_block_start` (text or `tool_use`), `content_block_delta` (`text_delta` for text, `input_json_delta` for tool args), `content_block_stop`, `message_delta`, `message_stop`.
- Complete `AssistantMessage` after each turn; final `ResultMessage` (+ `total_cost_usd`).

### Agent SDK (TS / Python) — the richer path
- `includePartialMessages: true` (TS) / `include_partial_messages=True` (Py) yields `SDKPartialAssistantMessage` (`type: "stream_event"`) / `StreamEvent` with `{ uuid, session_id, event, parent_tool_use_id }`. The `parent_tool_use_id` lets you attribute streamed output to **subagents** — useful for a tree view.
- Caveat: setting `maxThinkingTokens` *disables* partial streaming; structured output only appears in the final `ResultMessage.structured_output`.

### Hooks — the observability backbone (~19 events)
Hooks fire on lifecycle events and can run shell commands (settings files) or SDK callbacks ([hooks docs](https://code.claude.com/docs/en/agent-sdk/hooks)). Every input carries `session_id`, `cwd`, `hook_event_name`. Events:

| Event | Use for your dashboard |
|---|---|
| `SessionStart` / `SessionEnd` (TS) | Create/close a session card; init telemetry |
| `UserPromptSubmit` | Log prompt, render in timeline |
| `PreToolUse` | Show "about to run X"; gate dangerous ops (deny/ask/allow/defer) |
| `PostToolUse` / `PostToolUseFailure` | Render tool result / error in timeline; audit trail |
| `Notification` | Stream `permission_prompt`, `idle_prompt`, `auth_success` to UI / Slack |
| `SubagentStart` / `SubagentStop` | Build a subagent tree (`agent_id`, `agent_transcript_path`) |
| `PreCompact` | Flag "context compacted" boundary |
| `Stop` | Mark session idle/done |
| `TeammateIdle`, `TaskCompleted`, `WorktreeCreate/Remove`, `ConfigChange`, `Setup` (TS) | Team/worktree visualizations |

Hooks support **async output** (`{ async: true }`) for fire-and-forget logging — ideal for POSTing events to your gateway without blocking the agent. Matchers (regex on tool name, e.g. `"Write|Edit"`, `"^mcp__"`) scope hooks. The disler project (§1C) is a working reference for wiring these into a dashboard.

---

## 3. Live terminal: xterm.js ⇆ WebSocket ⇆ node-pty

A solved, well-documented pattern ([tutorial](https://ashishpoudel.substack.com/p/web-terminal-with-xtermjs-node-pty), [xterm.js repo](https://github.com/xtermjs/xterm.js), [@xterm/xterm npm](https://www.npmjs.com/package/@xterm/xterm)):

**Data flow (bidirectional):**
1. Backend: `const ptyProcess = pty.spawn(shell, [], { name, cols, rows, cwd, env })` — `bash`/`zsh` on Unix, `powershell.exe` on Windows. Spawn `claude` inside it (or spawn `claude` directly as the pty command).
2. PTY → browser: `ptyProcess.on("data", d => ws.send(d))` → client `term.write(d)`.
3. Browser → PTY: `term.onData(d => ws.send(d))` → server `ptyProcess.write(d)`.
4. **Resize:** client uses the **FitAddon** to fit the container, sends `{cols, rows}` on resize → server `ptyProcess.resize(cols, rows)`. (The basic tutorial omits this — it's the #1 gotcha; without it, line-wrapping breaks.)

**Recommended addons:** `@xterm/addon-fit` (sizing), `@xterm/addon-web-links`, `@xterm/addon-search`, `@xterm/addon-webgl` or `addon-canvas` (perf for high-throughput output — Claude Code emits a lot).

**Key design decision — what runs in the pty:**
- Option A: pty runs the **full interactive `claude` TUI** → maximum fidelity, you see exactly what a terminal user sees, but you can't easily extract structured data for cards/charts.
- Option B: pty runs a plain shell as an **escape hatch**, while the *primary* agent interaction goes through `claude -p --output-format stream-json` parsed into structured UI. **This is the stronger architecture** (matches siteboon = terminal *plus* structured UI; sugyan = structured only).

---

## 4. "Always-on" process supervision

"Always-on" is the part with the least turnkey tooling — it's ops, not a library.

- **Process manager:** Run the gateway and any long-lived Claude Code sessions under **PM2**, **systemd**, or a supervisor so they restart on crash/reboot. (Your Conan setup already treats the Mac Mini as always-on production — same principle.)
- **Session persistence model — two strategies:**
  1. **Stateless + resume (recommended default):** don't keep `claude` processes alive indefinitely. Persist `session_id`s; spin up `claude -p --resume <id>` on demand. Cheaper, crash-resilient, scales horizontally. This is how siteboon "auto-discovers sessions from `~/.claude`."
  2. **Persistent pty sessions:** keep `claude` running in long-lived ptys, optionally wrapped in **tmux/screen** so a backend restart can re-attach rather than lose state ([tmux persistence](https://oneuptime.com/blog/post/2026-03-02-how-to-use-screen-and-tmux-for-persistent-terminal-sessions-on-ubuntu/view)). Needed only if you want true raw-terminal continuity across reconnects.
- **Browser reconnection:** WebSockets drop. Implement heartbeat ping/pong, exponential-backoff reconnect, and **server-side output buffering** (a ring buffer per session) so a reconnecting client can replay missed output. xterm.js has no built-in replay — you own this.
- **Multiple concurrent instances:** model each Claude Code session as a supervised child keyed by `session_id`; the gateway multiplexes many sessions over one WS (or one WS per session). Native [agent teams](https://code.claude.com/docs/en/agent-teams) and worktree-based parallelism are the upstream features to visualize. Watch resource ceilings — each session is a Node/Claude process plus token spend.

---

## 5. UI patterns for agent observability (shadcn / Tailwind)

You already have the stack and conventions (shadcn base-nova, Tailwind v4 CSS-first theme, your `ActivityTimeline`, `StatCard`, two-tier card pattern). Concretely, an agent-observability dashboard wants:

- **Session list / grid** — one card per active or resumable session (`StatCard`/`AgentCard` pattern): status dot (running/idle/error), model, cwd, token/cost, last activity. Color-code by session (the disler "session color" idea).
- **Live event timeline** — your `ActivityTimeline` driven by hook/stream events: prompt → tool calls (per-tool Lucide icons, you already do this in `ToolCallHistory`) → results → result/cost. Subagent events nest as a tree via `parent_tool_use_id`.
- **Live terminal pane** — xterm.js in a shadcn `Sheet`/`Dialog` or a resizable panel; tabbed for multiple sessions (siteboon's multi-tab terminal).
- **Pulse / throughput chart** — events-per-minute, token burn, retry events (`system/api_retry`) — reuse your dashboard chart.
- **Permission prompts** — when `PreToolUse`/`Notification:permission_prompt` fires, surface an approve/deny control in the UI (deny > defer > ask > allow precedence).
- **Transcript viewer** — render the full conversation from the session JSONL in `~/.claude`.

For visual references on agent-dashboard layouts, `/source-ui` (Mobbin/Refero) is the right follow-up during design.

---

## 6. Security (the section that decides whether this is safe to ship)

A browser-reachable terminal/agent is a **remote code execution surface**. Treat it as hostile-by-default.

- **Learn from Claude Code's own CVE.** **[CVE-2025-52882](https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882)** (CVSS 8.8): Claude Code IDE extensions ran a **WebSocket server with no client authentication**, bound to `localhost`. Because **browsers do not apply same-origin policy to WebSocket connections**, any malicious website could probe localhost ports, connect, and send JSON-RPC to read files / execute code — **no user interaction beyond visiting the page**. Fix (v1.0.24+): an **auth token in a local lock file** validated on every connection. **Direct lesson: localhost binding + port obscurity is NOT security.**
- **Must-dos** ([OWASP WebSocket cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html), [Ably WebSocket security](https://ably.com/topic/websocket-security)):
  - **Authenticate every WS connection** with a token (not just the HTTP upgrade) — and re-validate, not only on `Open`.
  - **Validate the `Origin` header** server-side to block **CSWSH** (cross-site WebSocket hijacking).
  - **Bind to loopback by default**; require explicit opt-in + auth to expose on a network; front with TLS (`wss://`) and a reverse proxy if remote.
  - **For remote access, copy Happy's model:** an authenticated relay/sync server with **end-to-end encryption**, rather than exposing the raw shell port.
  - **Scope the agent:** use `PreToolUse` hooks / `--permission-mode`/`--allowedTools` to gate destructive operations; consider running sessions in containers or with restricted file roots.
  - Audit-log every command (you get this free from `PreToolUse`/`PostToolUse` hooks).

---

## 7. Build vs. buy

| Approach | Verdict |
|---|---|
| **Fork an existing UI** (siteboon/claudecodeui, sugyan) | Fastest to a demo. But siteboon is Vue-adjacent tooling/own stack and sugyan is chat-only — neither matches your shadcn/React/Tailwind-v4 + Conan gateway. Good as **reference**, weak as a base to inherit. |
| **Adopt an observability repo** (disler) | Excellent *pattern* to copy (hooks → server → WS → dashboard). Vue client, Bun server — port the concept, not the code. |
| **Build on your Conan gateway** (recommended) | You already have Express + WS on :3747, a React/shadcn SPA, an `ActivityTimeline`, tool-call indicators, and an always-on Mac Mini. Adding (a) a hooks→gateway event ingest, (b) a `claude -p stream-json` session manager, and (c) an xterm/node-pty pane is **additive** and stays on-brand. |
| **Buy/host** (siteboon Cloud, Happy) | Solves always-on + remote without you owning supervision/security. Reasonable if hosted-by-someone-else is acceptable; conflicts with a self-hosted dashboard goal. |

---

## 8. Gotchas (hidden costs / failure modes)

- **Raw terminal ≠ structured data.** If you only run the TUI in xterm, you can't build cards/charts/permission controls. Plan for the parsed `stream-json`/SDK path as the primary surface from day one.
- **Terminal resize** is the classic xterm bug — wire FitAddon + `pty.resize` early (§3).
- **Output volume.** Claude Code is verbose; use a perf renderer addon and server-side rate-limiting/buffering or the browser tab will jank.
- **Reconnection replay** is yours to build — xterm won't restore scrollback after a WS drop.
- **OAuth vs API key.** Your memory already records that `sk-ant-oat*` OAuth tokens are blocked for third-party API calls (Jan 2026) and `--bare` needs `ANTHROPIC_API_KEY`. An always-on headless fleet should authenticate with a real API key, not Claude Code OAuth. ([[anthropic-oauth-blocking]])
- **Cost model.** Post-June 15 2026 the Agent SDK / `claude -p` credit is separate from interactive limits — an always-on system that polls/fires frequently can burn it fast (§2).
- **Security is not optional** (§6) — the one place where "ship it and harden later" is the wrong call.
- **`maxThinkingTokens` kills streaming** — don't set it if you want live token streaming.

---

## 9. Recommendation & feasibility verdict

**Build it, on the Conan gateway, with a structured-stream-first + terminal-as-escape-hatch architecture.** Feasibility is high; nothing here is unproven. Concretely:

1. **Event ingest:** install the ~19 hooks (async POST to a new `/api/claude/events` route on :3747) → persist to SQLite/your store → broadcast over the existing WS. (Pattern: disler.)
2. **Session manager:** a gateway module that launches/`--resume`s `claude -p --output-format stream-json`, tracks `session_id`s, multiplexes events to the UI. Default to **stateless+resume**; add tmux-backed persistent ptys only if you need raw-terminal continuity.
3. **UI:** new dashboard views in your React/shadcn shell — session grid (`StatCard`/`AgentCard`), live `ActivityTimeline` from events, a pulse chart, permission-approval controls, transcript viewer.
4. **Terminal pane:** xterm.js + `@xterm/addon-fit` (+ webgl) in a resizable panel, backed by node-pty over an **authenticated** WS; multi-tab per session.
5. **Always-on:** PM2/systemd supervision (you already run the Mini always-on); ring-buffer + backoff reconnect.
6. **Security first:** WS auth token + `Origin` validation + loopback-by-default; for remote, an authenticated encrypted relay (Happy model), never a raw exposed port. Gate destructive tools via `PreToolUse`.

This is a clean PRD. Proceed to `/generate-prd` using §2 (surfaces), §3–§5 (architecture/UI), §6 (security requirements), and §9 (phasing) as the source material.

---

## Open questions (for the PRD phase)

1. **Single-user or multi-user/multi-tenant?** Changes auth, session isolation, and supervision dramatically.
2. **Local-only or remote access?** If remote, do you adopt Happy's encrypted-relay model or self-host TLS + auth? (Decides §6 scope.)
3. **Visualize Anthropic's native [agent teams](https://code.claude.com/docs/en/agent-teams), or build your own multi-session orchestration?** (Avoid reinventing what's now native.)
4. **Persistent ptys vs. stateless `--resume`** as the default session model — depends on whether raw-terminal continuity across reconnects is a hard requirement.
5. **Cost ceiling for always-on headless usage** post-June-15-2026 Agent SDK credit split — what's the budget and throttling policy?
6. **Does this extend the current Conan dashboard, or stand alone?** Your memory shows a 2026-03-28 pivot to "dashboard layer over Claude Desktop" reading `~/.claude` read-only — this proposal *adds write/drive capability*, which is a scope expansion worth confirming.

---

### Sources

1. [Claude Agent SDK — Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output) — Anthropic docs
2. [Claude Code — Run programmatically (headless)](https://code.claude.com/docs/en/headless) — Anthropic docs
3. [Claude Agent SDK — Hooks](https://code.claude.com/docs/en/agent-sdk/hooks) — Anthropic docs
4. [Orchestrate teams of Claude Code sessions (agent teams)](https://code.claude.com/docs/en/agent-teams) — Anthropic docs
5. [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) — React/Vite/Tailwind + xterm.js web UI over `~/.claude`
6. [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui) — CLI-subprocess streaming chat UI (Deno/Node)
7. [slopus/happy](https://github.com/slopus/happy) — mobile/web client, encrypted relay, session handoff
8. [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) — hooks→Bun→SQLite→WS→Vue dashboard
9. [Web Terminal with xterm.js, node-pty & WebSockets](https://ashishpoudel.substack.com/p/web-terminal-with-xtermjs-node-pty) — tutorial
10. [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) / [@xterm/xterm](https://www.npmjs.com/package/@xterm/xterm) — terminal lib
11. [CVE-2025-52882: WebSocket auth bypass in Claude Code](https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882) — Datadog Security Labs
12. [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
13. [Ably — WebSocket security](https://ably.com/topic/websocket-security)
14. [What Is OpenClaw? Complete Guide](https://milvus.io/blog/openclaw-formerly-clawdbot-moltbot-explained-a-complete-guide-to-the-autonomous-ai-agent.md) — Milvus
15. [One Week with OpenClaw — a Claude Code user's perspective](https://dustindavis.me/blog/one-week-with-openclaw)
16. [Hermes Agent — delegate coding to Claude Code CLI](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-claude-code) / [hermes-webui](https://github.com/nesquena/hermes-webui)
17. [Production Deployment Patterns: Claude Code vs Hermes](https://kenhuangus.substack.com/p/chapter-10-production-deployment)
18. [tmux for persistent terminal sessions](https://oneuptime.com/blog/post/2026-03-02-how-to-use-screen-and-tmux-for-persistent-terminal-sessions-on-ubuntu/view)
19. [Claude Code parallel sessions](https://www.mindstudio.ai/blog/claude-code-parallel-sessions) / [Parallelize Claude Code (Ona)](https://ona.com/stories/parallelize-claude-code)
