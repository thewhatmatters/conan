# Timeline — Hook + Skill firing per-terminal split panel

_PRD · 2026-05-28 · `loop/conan-v4.5-timeline` (proposed)_

## Background

Conan already ingests every Claude Code hook event over `POST /api/claude/events`
into the `event` table, broadcasts each one live to UI clients as
`{type:"event"}` on `/ws`, and tails `progress.txt` for the build-loop trail as
`{type:"tasks"}`. The HUD aggregates this stream (Pulse: throughput bars; Context:
`/context` capture), but **the granular per-event log isn't surfaced anywhere** —
you can't watch what fired during a turn without `tail -f`-ing the gateway log.

The single most opaque thing about Skills is **why a skill *didn't* fire**:
"automate-browser was installed, the prompt was about UI, but it never triggered
— why?" Claude Code doesn't emit a per-prompt "skills scored" event, so the
answer isn't directly observable. We can compute an honest approximation.

The Timeline is the surface for both: a chronological per-session log of hook
events + loop iterations + skills (fired and considered), rendered as a vertical
split tethered to its terminal tab so the relationship "this timeline belongs to
this session" is visual, not inferred.

## Goal

A live, per-terminal-tab split panel showing:

1. **Hook events** for the tab's correlated session — `SessionStart`,
   `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`,
   `SessionEnd` — with type pill, title, brief detail.
2. **Loop events** from the `progress.txt` trail — `iteration N → US-X`,
   `US-X PASS` — for the tab's correlated session/cwd.
3. **Skill firing** ground truth, derived from the session JSONL transcript's
   `Skill` tool_use blocks.
4. **Skills *considered but didn't fire*** for each user prompt, computed by a
   lightweight BM25 scorer over each available skill's `description` against the
   prompt text plus a small categorical-reason rule layer. Labelled **honestly
   as a heuristic** in the UI — not the model's real internal scoring.

The Skills HUD tab gains a `last fired` stamp per skill row as a free side-effect
of the transcript scan.

## UX (locked by the prototype + earlier decisions)

- **Per-terminal vertical split** (already prototyped in `TerminalPane.tsx`): a
  toggle on the tab strip (right of `+`, `PanelRightOpen`/`PanelRightClose`)
  opens/closes the Timeline for the **active tab only**; different tabs hold
  independent state. A 1px draggable col-resize divider; min 320px width;
  default 480px. Closing a tab cleans up its split state.
- **Header reads `Timeline · Term N`** — the tether is visual, no session
  picker. Small `×` collapses the split. Filter chips: **All · Hooks · Skills ·
  Loop** (functional, multi-select OK; "All" clears).
- **Rows** are flush, dense (~28–32px tall), with a left rail + dot:
  - Time `HH:MM:SS` (tabular-nums), then a colored dot on the rail
    (hook=`chart-2`, skill-fired=`chart-1`, skill-considered=`muted-foreground`,
    loop=`chart-4`), then a small uppercase pill (`PROMPT / PRETOOL / POSTTOOL /
    STOP / NOTIF / SKILL / LOOP`), title, muted detail.
  - **`PROMPT` rows expand a nested card** listing every available skill with
    `✓ fired` or `○ considered` + the one-line reason — the headline payoff.
- **Live append at the top** (timeline is descending). Auto-scroll only when the
  user is already at the top; preserve scroll position otherwise so a fresh
  event doesn't jump them mid-read.
- **Empty state**: "No activity yet for this terminal — the timeline fills as
  Claude Code emits hook events."

## Data sources (what already exists vs the new pieces)

| Lane | Source today | New work |
|---|---|---|
| Hook events | `event` table (`POST /api/claude/events` ingest) + live broadcast `{type:"event"}` over `/ws` ([src/gateway/index.ts:140](../src/gateway/index.ts#L140), `:212`) | Read endpoint + a normalized `TimelineRow` envelope (US-T01) |
| Loop events | `progress.txt` tailed by `watchTasks` + `{type:"tasks"}` broadcast ([src/tasks/index.ts:125](../src/tasks/index.ts#L125), `gateway:451`) | Extract per-iteration lines from `TasksState.activity` into timeline rows (US-T01) |
| Skills fired | Transcript JSONL `Skill` tool_use blocks ([src/transcript/index.ts:27](../src/transcript/index.ts#L27)); the `UserPromptSubmit` hook payload carries `transcript_path` directly — no path inference needed | Scan + watch JSONL for `Skill` blocks; emit `skill-fired` rows (US-T02) |
| Skills considered | **Not captured today.** No hook emits scoring; not directly observable | BM25-scored description match + categorical rules → `prompt_consideration` table keyed to the `UserPromptSubmit` event (US-T03) |
| Skill metadata | `readSkills` walks User / Project / Plugin / Built-in ([src/skills/index.ts:25](../src/skills/index.ts#L25)) | Used as-is for scoring; reused for the Skills tab `lastFiredAt` stamp (US-T04) |

### The transcript path is in the payload
A real `UserPromptSubmit` payload carries:
```
{ session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt }
```
So we don't have to re-derive the JSONL path from the cwd → encoded-folder
mapping for hooked sessions. We only fall back to `transcriptPath()` for
sessions that pre-date the hook.

## The "considered but not fired" capture — honest design

This is the headline feature and the most novel piece, so it gets its own
section. The constraint: **Claude doesn't tell us which skills it considered**,
so we **must** be honest that this is a heuristic, not ground truth.

### Pipeline
1. On `UserPromptSubmit` ingest, the gateway:
   - Reads `payload.prompt`.
   - Calls `scoreSkills(prompt, availableSkills)` from a new
     `src/skills/match.ts`. The available skill set is `readSkills(cwd)`.
2. The scorer returns each skill with a numeric score and a categorical
   `reason` (see Rules below). The **top N** (default 8) are persisted to a new
   `prompt_consideration` table keyed by `event_id` + `skill_name`.
3. On `Stop` (turn end), a background pass reads the session's JSONL since the
   prompt, finds `Skill` tool_use blocks, and flips those skills' rows in the
   table from `considered:true / fired:false` to `fired:true`. The reason on a
   fired row is replaced with the skill description snippet that matched.
4. Both states are surfaced in the timeline payload, with a `"heuristic"` flag
   the UI uses to render an honest "Heuristic match" badge over the considered
   block.

### Scoring — BM25 over descriptions + rule layer
- **BM25** (k1=1.2, b=0.75) over each skill's `description` (lower-cased,
  stop-word-stripped, single-word tokens) vs the prompt's tokens. ~50 LOC,
  zero deps. Stable, well-understood, no embedding model required.
- **Categorical rules** convert the score + a few cheap regexes into the
  human-readable reason — this is what the user actually reads in the UI:
  - `score >= HIGH` → `"strong description match (terms: a, b, c)"`
  - `score in [LOW, HIGH)` → `"partial match (terms: …)"`
  - prompt mentions the skill by name → `"prompt mentions this skill"`
  - skill description contains `"verify"` / `"browser"` / `"UI"` and prompt
    contains a UI verb (`render`, `screenshot`, `click`, `style`, …) →
    `"UI keyword match"`
  - description domain is `diagram` / `chart` / `flowchart` and prompt mentions
    it → `"diagram intent"`
  - none of the above + low BM25 → `"no description match (top terms: …)"`
- Stop-word + token list shared with the Conan `search` skill memory's BM25
  (50 docs in 17ms, zero deps) so we don't fork the lexicon.

### Honesty pass — what the UI claims
- A small badge over the considered card: **"Heuristic match"** with a tooltip:
  *"Claude doesn't expose its real skill scoring. These are computed from a BM25
  match of each skill's description against your prompt — useful as a hint, not
  ground truth."*
- The fired rows are **NOT** labelled heuristic — those come from the JSONL.

## Scope / non-goals (this loop)

- **Pass-1 visualization only** — no clicking a row to drill into the full
  payload (deferred to a v0.3 "transcript search" candidate already in the v0.2
  memory).
- **No analytics** (per-skill fire rate, per-prompt token spend) — additive
  later on the same rows.
- **No multi-session view** — Timeline is per-terminal-tab; comparing sessions
  is out of scope.
- **No editing of `prompt_consideration` rows** — purely derived state.

## Themed items (rough story breakdown — pre-decompose)

### US-T01 · Timeline read endpoint + normalized envelope
Backend foundation. New `GET /api/claude/timeline?session=…&since=…&limit=…`
that returns rows from the `event` table (hooks) plus per-session loop lines
extracted from `progress.txt` (filtered by the session's cwd), as a flat list
of `TimelineRow` envelopes:
```ts
type TimelineRow =
  | { kind: "hook";  ts: number; eventId: number; subtype: string; title: string; detail?: string; payload?: object }
  | { kind: "loop";  ts: number; subtype: "iteration" | "pass" | "trail"; title: string; detail?: string }
  | { kind: "skill-fired"; ts: number; eventId: number; skill: string; promptEventId: number; detail: string }
  | { kind: "skill-considered"; ts: number; eventId: number; skill: string; promptEventId: number; reason: string; heuristic: true };
```
The UI consumes the **existing** `{type:"event"}` and `{type:"tasks"}` WS
broadcasts for live updates — no new WS plumbing this story. Acceptance:
typecheck + a unit test for envelope shape + a stale-session empty-list check.

### US-T02 · Transcript-derived skills-fired feed (+ Skills tab "last fired")
Backend + a UI follow-on. Add `src/timeline/transcriptScan.ts` that reads a
session's JSONL (via `transcript_path` from the latest hook payload, falling
back to `transcriptPath()`), extracts `Skill` tool_use blocks as
`{skill, ts, promptEventId}` rows, and watches the file for size growth
(`fs.watch` + `tail` since last offset) to push `skill-fired` rows over `/ws`
on a new `{type:"skill-fired", payload}` message — kept separate from
`{type:"event"}` so existing WS consumers don't have to parse the new kind.
Also exposes `lastFiredAt: number | null` on each `SkillEntry` in
`GET /api/claude/skills`, rendered as a `last fired Xm ago` stamp on each row
of the Skills HUD tab. Acceptance: a unit test on the JSONL scanner (real
fixture); the Skills tab shows correct relative timestamps; typecheck + UI
build clean; verify with `automate-browser`.

### US-T03 · Skill-consideration scorer + persistence
The new piece. Add `src/skills/match.ts` (BM25 + rule layer described above),
a `prompt_consideration` table (`event_id, skill, score, reason, fired,
created_at`; PK `(event_id, skill)`), and a hook into the
`POST /api/claude/events` ingest path: on `UserPromptSubmit`, score
`readSkills(activeCwd())` against `payload.prompt`, persist the top N, broadcast
`{type:"skill-considered", payload}` rows over `/ws`. On `Stop`, run the
US-T02 scanner over the JSONL slice since the prompt and `UPDATE …
SET fired=1, reason=<fired_reason>` the rows whose skill matched. Acceptance:
- Unit tests on `scoreSkills` (BM25 ranking + each rule's classification).
- An integration test: post a fake `UserPromptSubmit` event, assert the
  expected `prompt_consideration` rows + `skill-considered` WS broadcast.
- An integration test: a `Stop` after a transcript `Skill` block flips the
  matching row to `fired=1`.
- Typecheck + `npm test` green.

### US-T04 · Replace `TimelineMock` with live `Timeline.tsx`
Wire the prototype to the route. Drop the sample data and the "Mockup" footer.
The filter chips become functional (multi-select, "All" clears). Auto-scroll
to top on new event **only if the user is already at the top**; otherwise
keep their scroll position + show a "↑ N new" pill that scrolls them up on
click. Honest "Heuristic match" badge over the considered card. Rail-
alignment math fixed (`left-[98px]` per the px-4/w-16/gap-3/w-3 stack — flagged
in the prototype). Acceptance: typecheck + UI build clean; `automate-browser`
verifies live append + filter behavior + the considered badge tooltip in both
light and dark.

### US-T05 · Persist per-tab Timeline split state (+ keyboard shortcut)
sessionStorage `conan.terms.timeline` (Set of tids with the split open) and
`conan.terms.timeline.w` (per-tid width). Survives a reload like `conan.terms`
does today. Add ⌘\ keyboard shortcut to toggle the active tab's split (matches
VS Code's "Split Editor" affordance). Closing the tab cleans up both keys (the
prototype already drops the in-memory state — extend to storage). Acceptance:
typecheck + UI build; verify reload survives + ⌘\ works via
`automate-browser`.

## References / anchors

- Prototype: [ui/src/components/TimelineMock.tsx](../ui/src/components/TimelineMock.tsx),
  [ui/src/components/TerminalPane.tsx](../ui/src/components/TerminalPane.tsx) (split
  layout + toggle), the `PanelRightOpen` button next to `+`.
- Hook ingest + broadcast: `POST /api/claude/events`
  ([src/gateway/index.ts:140](../src/gateway/index.ts#L140)),
  `broadcast({type:"event"})` (`:212`); the `event` table insert (`:189`).
- Loop trail: `watchTasks` + `progress.txt`
  ([src/tasks/index.ts:125](../src/tasks/index.ts#L125)),
  `{type:"tasks"}` broadcast (`gateway:451`).
- Transcript: `transcriptPath` + `TranscriptMessage`/`tool_use` blocks
  ([src/transcript/index.ts](../src/transcript/index.ts)); hook payload carries
  `transcript_path` directly.
- Skill metadata: `readSkills` / `SkillEntry` / `frontmatterDescription`
  ([src/skills/index.ts](../src/skills/index.ts)); roots: User
  `~/.claude/skills`, Project `<cwd>/.claude/skills`, Plugin, Built-in.
- BM25 lexicon precedent: the Conan `search` skill's native BM25 (50 docs in
  17ms, zero deps) — share the stop-word/token list.
- v0.2 candidates memory mentions Transcript Search as the flagship v0.2 — the
  Timeline's `skill-fired` row payload is the natural drill-in target.
