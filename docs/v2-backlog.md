# Conan v2 — backlog to research & decompose into a PRD later

Running capture of post-loop ideas (the 30-story v1 loop is done). Decompose into
`prd.json` stories when the list is ready. Newest items appended at the bottom of
each section.

---

## Research findings — Claude Code data sources (already traced)

`/usage`, `/stats`, `/context` are **interactive TUI slash commands**, not headless
CLI subcommands. Where each sources its data decides how Conan can consume it:

1. **`/stats` → `~/.claude/stats-cache.json`** ✅ on disk, static read, no auth.
   - `dailyActivity[]` = `{date, messageCount, sessionCount, toolCallCount}` → heatmap
   - `dailyModelTokens[]`, `modelUsage` (favorite model + per-model tokens),
     `totalSessions`, `totalMessages`, `longestSession`, `hourCounts`, `firstSessionDate`
2. **`/usage` → `anthropic-ratelimit-unified-*` HTTP response headers** ⚠️ live,
   in-memory only, never written to disk. Parses `{utilization, resets_at}` for a
   `five_hour` and a `seven_day` window. Real %/reset only obtainable by reading the
   headers off an API response — our **headless sessions** (US-006, `ANTHROPIC_API_KEY`)
   get them; the interactive TUI's numbers we can't read from disk → stays estimated.
3. **`~/.claude/sessions/*.json` (PID-keyed)** ✅ Claude Code's own live session
   registry: `{status: idle|interactive, updatedAt, entrypoint, cwd, version}` —
   authoritative source for the stale-`running` fix (better than our hooks).

### Stories these imply (user greenlit, 2026-05-25)
- **Stats / heatmap widget** — GitHub-style contribution heatmap from `dailyActivity[]`
  + total tokens, active days, current/longest streak, favorite model. Unblocked.
- **Usage widget upgrade (US-030)** — wire real `utilization`/`resets_at` from
  rate-limit headers on headless calls; fall back to estimate when no fresh header.
- **Context widget (`/context`) — wire real per-session context usage.** `/context`
  is a TUI slash command; its data is reconstructable from disk: the **latest
  assistant message's `usage` block** in the transcript JSONL gives current context
  size (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`), and
  the message's `model` gives the window size (e.g. Opus 4.7 = 1M). Context % =
  used / window. Conan already reads these transcripts and `session.context_tokens`
  exists — replace the placeholder "current context" hero widget with the real
  colored-grid / gauge, per selected session.
- **Stale-session fix** — derive "active" from `sessions/*.json` `status`+`updatedAt`,
  not our hooks; GC dead rows.
  - **Confirmed in the wild 2026-05-25:** the **Active Sessions widget shows 53** —
    DB has 53 rows (28 `running`, 25 `idle`) but **0 active in the last 10 min**.
    Every one is stale: a killed `claude -p` (the loop's 30 build/verify runs) never
    fires `Stop`/`SessionEnd`, so `status='running'` is frozen forever, and the
    widget counts all rows. **Fix:** (a) reaper marks sessions `dormant` after an
    inactivity window on `last_activity`; (b) "Active" = `last_activity` within window
    AND/OR live presence in `sessions/*.json`; (c) GC dead test/verification rows
    (`sess-abc`, `demo-1`, etc.). Active-Sessions count must reflect *actually* active.

---

## UI / UX to-dos (from user, 2026-05-25)

0. **Kill "Cost Ceiling" (US-023) — reframe around plan usage, not dollars.** We're
   on **Claude Max** (plan/token-based, not $-metered API), so a dollar budget +
   cost-ceiling is the wrong model. Rip out US-023's cost-ceiling UI/logic. What we
   actually need is **plan-usage awareness**: how much of the **five-hour** and
   **seven-day** limit windows we've consumed (`utilization` + `resets_at` from the
   Usage-widget upgrade) and how full the **context** is (Context widget). Those two
   widgets *are* the replacement — surface "where am I against my limits + reset
   times," not "how many dollars left." Remove the cost-ceiling Settings section
   when folding Settings together.

1. **Term tabs → dropdown.** The horizontal Term tab strip overflows and breaks the
   UI once several terminals exist (already visible at Term 1–5 crowding the Tasks
   tab). Replace the tab strip with a **`Term ▾` dropdown** that lists open terminals
   and has an **"+ New terminal"** action **inside the dropdown itself**. Tasks stays
   as its own tab.

2. **Hero-widget overhaul (top section).** Audit of the current "+ Add widget"
   set — keep/wire/remove:
   - **MCP servers** — *wire it.* Show the **count of connected MCP servers**, with
     a **tooltip listing which MCPs are actually connected**. (Source: Claude Code
     MCP state — likely `~/.claude/settings.json` mcp config + `mcp-needs-auth-cache.json`
     for failed/needs-auth; confirm a live "connected" signal exists, else infer.)
   - **Plugins** — *remove.* Not needed now.
   - **Model & idle** — *wire it.* Currently a placeholder; show real active model +
     idle state per session.
   - **API retry rate** — *remove.*
   - **Top tools** — *remove.*
   - **Git status** — *wire it.* Currently a placeholder; show real repo git status.
   - Plus the new **Stats/heatmap**, **Usage** (plan limits), and **Context** widgets
     from the data-sources section above.
   - **Widget layout:** all widgets live in the **top section**, fronted by a
     **dropdown that shows ~5 at a time** (not an ever-growing row) — so the strip
     doesn't overflow the way the Term tabs do.

3. **Pending Approvals — make it conditional.** Only render the Pending Approvals
   panel when there's an actual decision waiting; hide it entirely when the queue is
   empty (no empty-state card taking up space).

4. **Pulse (Throughput) widget — rethink the visualization.** The current bar graph
   doesn't capture throughput well. **Research better charting** for it — user
   floated a **Sankey / flow diagram** (ref: Uila-style multi-stage flow:
   Host → … → Classifier with proportional ribbons) as one option; explore others
   (streamgraph, area/stream over time, etc.). Goal: a viz that actually conveys
   throughput/flow. Decide during the research/PRD pass — "do better."

5. **CWD picker — make the toolbar cwd switchable.** The toolbar shows the current
   working folder (`~/Development/conan`) as a static label. Make it a **directory
   picker**: click to change the active working directory from there. Implications to
   work out in the PRD — what re-scopes to the new cwd (new terminals/ptys, tasks
   `prd.json`/`progress.txt`, the project-context reads) vs. what's global; whether
   it's per-terminal or app-wide; persistence across reloads.

6. **Activity log = the home view; kill the session cards.** (Confirms the
   timeline-primary IA in memory `project_conan_layout_ia`.) The Overview's primary
   surface is a single **activity log/timeline**, driven by:
   - a **`session ▾` dropdown** (pick whose events to view) — replaces the grid of
     per-session tiles entirely;
   - **Activity-type filters** — `All` + tool types (`Bash`, `Read`, `Edit`,
     `Write`, `Skill`, …) so you can scope the log to what you care about;
   - **Transcript view stays (US-014)** — keep it; pairs with Activity as the two
     views of the selected session (Activity ↔ Transcript toggle off the dropdown).
   - **Remove the Session cards** — "ugly as a motherfucker," add no value, just
     complexity + bad UX. The `session ▾` dropdown + inline lifecycle actions
     (stop/resume/send/open/new) replace them.
