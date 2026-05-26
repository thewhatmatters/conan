# Conan v3 — backlog to research & decompose into a PRD later

## Decisions locked (2026-05-26)
- **Project scope → MULTI-PROJECT (global hook).** Install a user-level `~/.claude`
  hook so ANY `claude` run anywhere self-reports to Conan; the UI filters/switches by
  cwd. Adds: a global-hook-install story; cwd switching that re-scopes
  Tasks/terminals/git/skills; observed-session filtering by cwd. (Resolves item 18.)
- **Nav/IA → SEPARATE Agents + Skills pages.** Nav becomes **Overview · Agents ·
  Skills · Settings** — a deliberate expansion beyond v2's 2-item cap. (Resolves
  items 17 + 21; the sidebar/routing from v2 US-006 extends to 4 items.)
- **Run scope → EVERYTHING in one PRD.** All 21 items + additive stories from the
  item-14 capability audit, in a single v3 backlog/loop (expect 30–40+ stories).


Running capture of post-v2 refinements (v2 shipped 20/20: IA rework + real Claude
Code data). Same flow as v2: capture raw to-dos here → research open questions →
fold into the PRD → decompose into a fresh `prd.json` → run the loop.

Newest items appended at the bottom. Each entry: the ask in the user's words +
any open question to research before it becomes a story.

---

## To-dos

1. **Widgets row — settings cog + single-row horizontal carousel.** Refines v2's
   US-010 widget picker.
   - Replace the widgets **dropdown** with a **settings cog icon** placed next to the
     "Widgets" heading/label (the cog opens the show/hide widget picker).
   - The widgets area spans **exactly 1 row** with **horizontal overflow** (no
     wrapping to a second row).
   - **Viewport shows only 4 widgets** at a time.
   - **Right trigger** (arrow, click/scroll) appears when there are more widgets off
     the right edge; advances the row.
   - **Left trigger** is conditionally enabled only once the row has scrolled right
     (i.e. there are widgets overflowed off the left); scrolls back.
   - Net: a 4-up horizontal carousel with prev/next chevrons + a cog for
     configuration, replacing the dropdown picker.

2. **Usage widget — wire REAL `/usage` details (currently shows nothing).** User
   wants the actual `/usage` breakdown (used %, resets-at, weekly/5h windows) in the
   widget. v2 made it an approximation on purpose; v2's widget reads empty when no
   headless session is active. **The hard constraint (recap):** `/usage` is a TUI
   slash command; its live numbers come from `anthropic-ratelimit-unified-*` HTTP
   response headers held in the claude process memory — not on disk, not in
   stream-json — so a plain shell-out can't read them. **Research these real paths
   before this becomes a story:**
   - **(A) `--debug api` log parse (most promising).** Run a claude session with
     `--debug api --debug-file <path>` (interactive/OAuth session = real Max-plan
     limits) and parse `anthropic-ratelimit-unified-status` / `-reset` /
     `-utilization` out of the debug log. Verify the headers actually land in the
     debug file and the format. This yields the REAL login-session numbers.
   - **(B) PTY `/usage` scrape.** Conan already drives node-pty claude sessions —
     spawn/hidden-run `/usage` in a PTY, capture the rendered TUI frame, parse
     "N% used · resets <time>" + weekly line. Brittle (TUI layout) but it's the
     literal on-screen data. (This is the OpenClaw-style screen-scrape.)
   - **(C) Quick win so it's never blank:** populate the widget from data we already
     have — `~/.claude/stats-cache.json` (today/recent tokens via the v2
     `/api/claude/stats` endpoint) + DB `total_cost_usd` — as the baseline, then
     layer (A) or (B)'s real limit % on top when available.
   - **RESEARCH VERDICT (2026-05-26, live-tested):**
     - **Path A (debug-log headers) — FAILED the live test.** A real
       `printf 'hi' | claude -p --debug api --debug-file <tmp>` logged response headers
       (`request-id`, `anthropic-billing-header`, `anthropic-agent-skills`) but **zero
       `anthropic-ratelimit-unified-*`**. The CLI binary contains the parser + keys
       (`five_hour`/`seven_day` `-utilization`/`-reset`, `-status`), but a headless `-p`
       turn doesn't surface them — they likely ride the interactive SSE response or only
       appear near a limit. NOT reliable as-is; keep as a deferred spike (try
       `--debug-to-stderr`, non-streaming, or an interactive-session debug log).
     - **Path B (PTY `/usage` scrape) — the real-data path.** `/usage` renders the true
       "N% used · resets <time>" + weekly line; Conan already runs claude in node-pty.
       Build a controlled probe (spawn PTY → send `/usage` → capture frame → strip ANSI
       → parse two windows). Brittle across versions but the only confirmed real source.
     - **Path C (baseline) — ship always.** US-004's 5h/7d token trend + reactive
       `rateLimited`/`resetAt` + stats-cache tokens so the widget is never blank.
     - **Plan:** ship C baseline + B (PTY scrape) for real %; A is a research spike.

3. **Widget-data QA — make sure every widget returns real data.** Several widgets are
   under-reporting or blank. Specific fixes found:
   - **MCP Servers shows 1, should show ~10.** ROOT CAUSE FOUND: v2's US-003 only read
     `~/.claude/settings.json` `mcpServers` (which has just `obsidian`). The real
     source is **`~/.claude.json`** — global `mcpServers` (`paper`) **plus per-project
     `mcpServers`** under `projects[<path>].mcpServers` (observed: `figma`,
     `figma-remote-mcp`, `linear-server`, `mobbin`, `notion`, `refero`, `vercel`,
     `XcodeBuildMCP`, `xcodebuild`). **Fix:** read `~/.claude.json` (global + union of
     project-scoped) as the configured set, minus `mcp-needs-auth-cache.json`, and
     still enrich with a live session's `system/init` mcp_servers. Decide whether the
     count is global or scoped to the active cwd's project.
   - **Remove the "Cost today" widget.** Irrelevant on a token-based plan (Claude Max);
     same rationale as killing the cost ceiling in v2. (DB still tracks `total_cost_usd`
     for headless `result` events, but don't surface a $ widget.)
   - **Model widget not showing the current model's name.** US-012 wiring shows idle
     state but not the model name. Fix: surface the active session's real model
     (e.g. "Opus 4.7"); handle the no-active-session case. Investigate why the model
     field is empty (session row not populated, or field mapping off).
   - **General:** audit the remaining widgets (Context, Usage, Git, Stats/heatmap,
     Pulse) to confirm each returns real data in the live UI, not just in isolated
     verification.

4. **Distinguish widget scope — session vs cwd vs global.** Right now widgets sit in
   one undifferentiated row, but they have different natural scopes. Make scope
   explicit (grouping, a small scope badge, or session-scoped ones visibly bound to
   the `session ▾` picker). Proposed taxonomy:
   - **Session-scoped** (follow the selected session from the timeline's `session ▾`):
     **Context**, **Model & idle**, **Skills**. (v2 already reads these off the active
     session, but implicitly — make the binding visible so it's clear they change with
     the dropdown.)
   - **CWD/project-scoped** (track a directory, not a session): **Git** (repo at a
     working dir) and **MCP** (per-project in `~/.claude.json`). Open question for the
     PRD: with the v3 cwd picker, do these follow the **app's active cwd** or the
     **selected session's cwd**? (They can differ.)
   - **Global** (no session/cwd): **Stats/heatmap**, **Usage** (plan limits),
     **Active sessions** count, **Pulse**. CONFIRMED `src/pulse/index.ts` aggregates the
     `event` table across **all** sessions (no session filter) — US-016's stacked
     categories are event-type bands, not per-session. So Pulse is **global today**.
     v3 decision (lean: keep global by default — it's the one widget that's most
     useful *not* tied to a session, answering "is anything happening at all"):
     optionally add a per-session filter that follows `session ▾` when a session is
     selected (global ↔ per-session toggle).

5. **Activity log — sort order toggle (asc/desc by timestamp).** Add a control to
   sort the activity timeline ascending or descending by timestamp (newest-first ↔
   oldest-first). Combines with the existing session ▾ + activity-type filters
   (v2 US-007/US-008). Decide the default (likely newest-first) and make sure
   live-appended events insert at the correct end for the chosen order.

6. **Pin the widget area on scroll (sticky/fixed).** The widgets row should stay
   visible as the main content (activity log) scrolls beneath it, so environment
   context (Usage, Context, MCP, Pulse, etc.) is always in view — don't let it scroll
   away. Implement as a sticky/pinned header (position: sticky within the scroll
   container, or fixed) above the scrolling timeline. Works with item 1's single-row
   carousel and item 4's scope grouping; mind the sidebar + toolbar offsets so it
   pins to the right place and doesn't overlap.

7. **Settings page mirrors Claude Code's real `/settings`.** Instead of only Conan's
   own config (v2 US-020 = hooks/remote/theme), the Settings view should reflect
   Claude Code's actual settings, rendering the right control per value type:
   **boolean → true/false toggle**, **enum → dropdown** (e.g. Default permission mode,
   Auto-update channel, Theme), string → text. Mirror the TUI's **searchable filter**
   ("Search settings…"). The `/settings` TUI also has tabs (Settings · Status ·
   Config · Usage · Stats) — consider mirroring that structure (Usage/Stats already
   have Conan widgets/endpoints to back them).
   - **Research before story:** where each setting actually lives and its type —
     `~/.claude/settings.json` + `settings.local.json` (project + user) and global
     flags in `~/.claude.json` (e.g. autoUpdates, theme, permission mode). Enumerate
     the editable set + allowed values per key.
   - **Sensitivity flag:** writing these = modifying Claude Code's own config (the
     v1 `.claude/settings.json` write was permission-gated). Decide read-only mirror
     vs. read-write with guardrails; if writable, validate against a known schema and
     never clobber unknown keys. Token-gate the write endpoint like other mutations.

8. **Height drag handle for the activity log / Terminal panel.** Add a vertical-resize
   (height) drag handle, mirroring the dock's existing left-edge **width** handle
   (v1 Dock.tsx). Persist the height like the width is persisted (localStorage).
   - **Clarify in PRD (ambiguous):** which boundary? Most likely a horizontal handle
     that splits the **activity log (top) and a Terminal panel stacked below it** so
     the user can grow/shrink the terminal vs the log. (Alternative reading: within
     the right dock, resize Terminal vs Tasks height.) Confirm the intended layout —
     today Terminal is in the right-side dock (width-resizable only), so this implies
     either a stacked terminal-under-activity layout or a new in-main terminal pane.

9. **Tasks tab is conditional — only when tasks exist in the CWD.** Show the Tasks
   tab/panel only when the active cwd actually has a task source (a `prd.json`, or
   `progress.txt` with content). Hide it entirely otherwise — no empty Tasks tab.
   Ties into the v3 cwd picker (item from v3-backlog / v2 US-019): when the cwd
   changes, re-evaluate whether Tasks should appear, scoped to that directory.

10. **Terminal dropdown reflects the claude session name + shows session ID.** When a
    session is `/rename`d (or `claude -n <name>`), the `Term ▾` dropdown (v2 US-018)
    should show that name instead of the generic "Term 1", with the short session ID
    appended — e.g. **`Conan:ca7cb3a8`** (name : first 8 of sessionId). Fall back to
    "Term N" when the session has no name.
    - CONFIRMED: the name persists on disk — `~/.claude/sessions/<pid>.json` gains a
      `"name"` field when renamed (e.g. pid 15062 → `{"sessionId":"1b4c047c…",
      "name":"conan", ...}`), keyed by pid → sessionId.
    - **Research/build:** correlate a Conan terminal (node-pty) to the claude session
      running in it. The pty exposes its child pid; walk the process tree to find the
      descendant `claude` pid, then read that pid's `sessions/<pid>.json` for
      `name` + `sessionId` (fallback: match by cwd + most-recent live session). Poll
      or watch the file so a mid-session `/rename` updates the label live.
    - **Bonus:** this same pty→sessionId correlation lets Conan link a docked terminal
      to its observed session row (unifies the driven/observed session model — a
      terminal you typed in becomes a first-class session in the timeline/dropdown).

11. **Move toast notifications to bottom-right.** Toaster currently renders top-right
    (`fixed right-4 top-16` in Toaster.tsx). Relocate to bottom-right (standard toast
    position), stacking upward as new toasts arrive. Mind not overlapping the dock /
    bottom controls.

12. **Show/hide Terminal must NOT kill the session.** CONFIRMED current behavior:
    App.tsx renders `{dockOpen && <Dock/>}`, so hiding **unmounts** the dock → closes
    the terminal WS → backend schedules `destroySession` after `DETACH_GRACE_MS`
    (default **30s**, `src/terminal/index.ts:243`). Result: re-show within 30s and the
    pty survives (reattach + ring-buffer replay); hidden >30s and the pty is **killed**.
    The 30s grace was meant for reloads/network blips (US-017/018), not an intentional
    hide. **Wrong behavior** — hiding a panel shouldn't kill a running session (hide
    the terminal during the build loop, come back in 2 min, it's dead).
    - **Fix:** make hide non-destructive. Either keep the Dock **mounted but
      CSS-hidden** when `dockOpen` is false (WS stays open, no detach at all), or treat
      a hide as a no-kill detach (persist indefinitely; only an explicit tab-close —
      the `close` frame — kills the pty). Prefer mounted-but-hidden for simplicity.

13. **Session ID placement — DECIDED: not in the global top nav.** Question was whether
    to show the current session ID next to "gateway :3760". Decision: **no.** The
    gateway indicator is global connection status ("is the backend up"); Conan is
    multi-session, so a single session ID in global chrome is ambiguous (selected
    timeline session vs focused terminal — they differ) and mixes two unrelated
    concerns. Session identity lives where it has context instead:
    - the timeline `session ▾` dropdown, showing `name:shortID` (item 10);
    - the terminal dropdown label (item 10);
    - optionally a selected-session chip docked **next to the `session ▾` control**
      (not the gateway status) if an always-visible "what's selected" cue is wanted.
    Keep the top nav as global app chrome (gateway health · theme · show/hide terminal).

14. **ANCHOR RESEARCH: full Claude Code capability audit + Conan gap analysis.**
    Goal: "Conan leverages everything Claude Code can do." Two-part deep dive that will
    likely spawn several new stories beyond items 1–13.
    - **(I) Capability surface — enumerate what Claude Code can do** (from `claude --help`,
      subcommands, docs, the TUI slash commands, settings). Known surface to cover:
      - Subcommands: `agents` (background agents), `auth`, `auto-mode` (classifier),
        `doctor`, `mcp`, `plugin`, `project` (project state), `setup-token`,
        `ultrareview` (cloud multi-agent review), `update`.
      - Sessions/run modes: `-p` stream-json, `--output-format json`, `--json-schema`
        (structured output), `--resume`/`--continue`/`--fork-session`/`--from-pr`,
        `--bare`, `--max-budget-usd`, `--fallback-model`, `--effort`, `--model`,
        `--include-hook-events`, `--input-format stream-json`.
      - Agentic features: **agent teams / worktree parallelism**, subagents
        (`parent_tool_use_id` — Conan has US-021 tree view), custom `--agents`,
        **checkpoints / rewind code**, **remote control** (`--remote-control`),
        **Chrome integration** (`--chrome`).
      - Ecosystem: hooks (~19 events — Conan wires 9), MCP servers/tools, plugins,
        skills (`/skill-name`), slash commands (`/usage`,`/stats`,`/context`,`/effort`,
        `/rewind`,`/resume`,`/passes`,`/team-onboarding`…), output styles, IDE integ.
    - **(II) Introspective gap analysis — what Conan should improve/add.** For each
      capability: does Conan surface/observe/drive it today? Candidate gaps to assess:
      agent-teams visualization, checkpoint/rewind surfacing, plugin management, a
      slash-command palette, structured-output (`--json-schema`) flows, background-agent
      orchestration view, `from-pr` / worktree parallelism view, richer hook coverage
      (all 19), remote-control bridging. Output: a prioritized list of additive
      stories, folded into this backlog before decomposition.
    - This is the centerpiece of the v3 research pass; run it alongside the open
      questions already flagged (items 2 `/usage` paths, 7 settings schema, etc.).

15. **Claude Code "what's new" / updates feed.** Keep users abreast of Claude Code
    updates + new features from Anthropic, surfaced in Conan (e.g. a news feed / "What's
    New" panel or a badge when an update lands).
    - CLEAN SOURCE FOUND (on disk, no scraping): **`~/.claude/cache/changelog.md`**
      (~326KB) is the full changelog as structured markdown — `## <version>` headers
      with bullet lists (e.g. "## 2.1.149 — /usage now shows a per-category breakdown…").
      Parse into a versioned feed. `~/.claude.json` has `changelogLastFetched` +
      version/`autoUpdates`/`Auto-update channel`; installed version is in
      `sessions/<pid>.json` `version` and the CLI symlink path.
    - **Build sketch:** `GET /api/claude/changelog` parses changelog.md → entries
      `{version, date?, items[]}`; UI shows a "What's New" feed, **highlighting entries
      newer than the installed version** (current-vs-latest diff). Optional: a small
      nav badge when newer entries exist; optional network refresh from the upstream
      changelog for items not yet cached locally (keep local-first).
    - Open question for research pass: does changelog.md carry dates per version, or
      only version + bullets? (affects feed sorting/labeling.)

16. **Activity timeline event icon — opaque background (rail shows through).** The
    event icon circles (e.g. "Session started" play icon) are transparent, so the
    timeline connector rail/line is visible behind/through the icon. Give the icon
    container a **solid/opaque background** (e.g. `bg-background` or `bg-card`) so it
    masks the rail and reads as a full-color node. Small CSS fix in
    `ActivityTimeline.tsx` (icon dot styling). Verify in both light + dark.

17. **Agents — breakdown + case for a dedicated Agents page.** Four distinct "agent"
    concepts in Claude Code:
    1. **Subagents (in-session)** — Task/Agent-tool spawns, `parent_tool_use_id`.
       Conan ALREADY visualizes (v2 US-021 timeline tree). Ephemeral, parent-scoped.
    2. **Custom agent definitions** — reusable personas in `~/.claude/agents/<name>/`
       (e.g. `chief-of-staff` present) + project `.claude/agents/`; `--agent` selects,
       `--agents` JSON defines. A registry of agent types — Conan surfaces none.
    3. **Background agents** — `claude agents` subcommand manages detached/async
       sessions. **`claude agents --json` prints live sessions as a JSON array**
       (+ `--cwd` filter, effort/permission flags) — a CLEAN scriptable source, no
       scraping. Conan surfaces none.
    4. **Agent teams / worktree parallelism** — native multi-session orchestration
       across worktrees (PRD source #4); the item-14 gap. Not visualized.
    - **RECOMMENDATION: yes, a dedicated Agents page** — cheap because
      `claude agents --json` gives live data directly. Scope: (a) **registry** from
      `~/.claude/agents/`; (b) **live background agents** with dispatch/stop controls
      (Conan *driving*, not just observing); (c) **team/worktree view** (item-14 gap).
      Subagent trees stay in the timeline.
    - **IA note:** this adds a **3rd nav item** beyond v2's deliberate Overview+Settings
      cap — justify as an earned exception (orchestration ≠ observation), contingent on
      committing to the background-agent/team capability. If only subagents matter, the
      timeline tree suffices and a page is overkill. Decide in PRD.

18. **ARCHITECTURE DECISION: single-project cockpit vs multi-project observatory.**
    Conan is *partly* CWD-bound today, inconsistently — needs a deliberate decision
    that underpins items 4, 9, and the cwd picker (v2 US-019).
    - **CWD-anchored now** (to the gateway's launch dir, `~/Development/conan`):
      Tasks (`prd.json`/`progress.txt` from gateway cwd), new terminals (ptys spawn in
      gateway cwd), toolbar cwd label, Git widget. **Observed sessions are
      project-scoped too** — hooks live in `~/Development/conan/.claude/settings.json`
      and POST to the gateway, so **only `claude` runs inside this repo self-report**;
      Conan only *sees* sessions in repos where the hook is installed + pointed at it.
    - **NOT cwd-bound** (global `~/.claude/`): stats/heatmap, session liveness
      (`sessions/*.json`), usage, changelog, custom agents. MCP is per-project in
      `~/.claude.json` (a third case).
    - **The decision:** single-project cockpit (anchored to one repo — basically today)
      vs multi-project observatory (switch repos, observe many). The cwd picker +
      cwd-scoped widgets + conditional Tasks all assume cwd *changes* — but that only
      half-works because **observing another repo's sessions needs the hook installed
      there**. If multi-project: need a story for global/multi-repo hook install (or a
      user-level `~/.claude/settings.json` hook that reports cwd, so ANY claude run
      self-reports and the UI filters by cwd) + cwd switching that re-scopes Tasks/
      terminals/git. If single-project: simplify — drop/relabel the cwd picker, make
      the anchor explicit. **Resolve this before items 4/9/19 are decomposed.**

19. **Create + maintain a README.** No `README.md` exists yet. Create one covering:
    what Conan is (always-on web UI that observes + drives Claude Code), the stack,
    run/build/verify commands, architecture overview, and how the backlog/loop works.
    **Standing process:** keep it updated after completing capture-worthy work — fold
    README updates into the "beautiful sequence" (CLAUDE.md + memory + README +
    commit & push). Likely written/refreshed as part of the v3 build wrap-up so it
    reflects the shipped state, not the in-flight one.

20. **Adopt shadcn properly + componentize reusable patterns.** CONFIRMED: shadcn is
    NOT actually in use despite memory/notes implying it. No `radix`/`cva`/`clsx`/
    `tailwind-merge`/`lucide`/`cmdk` deps, no `components.json`, no `components/ui/`,
    no `cn()` util — all 15 UI components are hand-rolled raw Tailwind using
    shadcn-compatible *tokens* only (so the lib can slot in). Dropdowns/tooltips
    (Term ▾, session ▾, MCP tooltip) are bespoke divs, not Radix-backed.
    - **Do it now, before the v3 UI work** — v3 is dropdown/control/tooltip-heavy
      (widget carousel item 1, settings toggles/dropdowns item 7, Agents page item 17,
      sort/filter controls), i.e. shadcn's sweet spot; hand-rolling re-solves a11y/
      keyboard/focus that Radix gives free.
    - **Story shape:** (a) init shadcn — deps + `components.json` + `cn()` util, React
      19 + Tailwind v4 compatible (use `render` not `asChild` per prior notes; map our
      existing semantic tokens to shadcn's so theming carries over); (b) add the
      primitives v3 needs (button, dropdown-menu, popover, tooltip, select, switch,
      tabs, badge, card, dialog, command); (c) build new v3 surfaces on them; (d)
      migrate existing bespoke components opportunistically.
    - **Componentize shared patterns** into reusables: status dot/pip, badge, the
      two-tier card, filter chips, the ring/gauge, time-ago label, scope badge
      (item 4). Reduce per-component re-inlining.
    - **Doc fix:** CLAUDE.md/memory claim "shadcn base-nova" is misleading (compatible,
      not used) — correct it (note as part of the beautiful sequence).

21. **Dedicated Skills view — global + project skills.** v2 only has a Skills *count*
    hero widget (`/api/claude/skills`). Add a browsable view listing skills with name,
    description, and scope (global vs project), reading both:
    - **Global:** `~/.claude/skills/*/SKILL.md`
    - **Project/CWD:** `<cwd>/.claude/skills/*/SKILL.md`
    Each `SKILL.md` has frontmatter (name + description) to surface; show the body /
    allowed-tools on expand. (decompose-prd's `list_skills.py` already enumerates both
    scopes — reuse that approach, or read the files directly.) Indicate which are
    *loaded* in the active session (the count widget already knows this).
    - **CWD-dependent** (project skills follow the active cwd) — ties into item 18's
      single-vs-multi-project decision.
    - **IA:** could be its own nav page, or fold with Agents (item 17) into a shared
      "Library"/capabilities area (skills + agents + MCP are all "what this environment
      can do"). Decide in PRD — mind v2's minimal-nav cap.
   - Design decision to settle in the PRD: how to present scope — separate labeled
     groups, a per-widget scope badge, or session-widgets physically docked next to
     the `session ▾` control. Ties into item 1's widget-row layout.
