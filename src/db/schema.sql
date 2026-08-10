-- Conan dashboard schema (US-001).
-- Applied idempotently on gateway startup. SQLite runs in WAL mode (set in code).

-- One row per Claude Code session the dashboard observes or drives.
CREATE TABLE IF NOT EXISTS session (
  id              TEXT PRIMARY KEY,            -- Claude Code session_id
  title           TEXT,
  cwd             TEXT,
  model           TEXT,
  permission_mode TEXT,                        -- default | acceptEdits | dontAsk
  claude_version  TEXT,                         -- Claude Code version from SessionStart (US-001 v4.4); null if unknown
  status          TEXT NOT NULL DEFAULT 'idle',-- running | idle | error | dormant
  color           TEXT,                        -- UI session color
  created_at      INTEGER NOT NULL,            -- epoch ms
  last_activity   INTEGER NOT NULL,            -- epoch ms
  total_cost_usd  REAL NOT NULL DEFAULT 0,
  -- Token/context figures from the stream-json parser (US-007). Latest turn.
  input_tokens                INTEGER,         -- prompt tokens (last turn)
  output_tokens               INTEGER,         -- completion tokens (last turn)
  cache_read_input_tokens     INTEGER,
  cache_creation_input_tokens INTEGER,
  context_tokens              INTEGER,         -- context-window position (input+cache)
  -- Worktree isolation for driven sessions (US-043). When a session is launched
  -- into a fresh git worktree, we record its path and the base ref it was cut
  -- from so parallel runs are visible and traceable; null for normal launches.
  worktree_path               TEXT,
  worktree_base_ref           TEXT,
  -- Typed structured output for driven sessions (US-044). When a session is
  -- launched with --json-schema, we record the schema, the final structured
  -- result, and whether it validated against the schema; null for normal runs.
  json_schema                 TEXT,            -- JSON schema the result is checked against
  structured_result           TEXT,            -- JSON of the captured final result
  schema_valid                INTEGER,         -- 1 valid, 0 invalid, null = not applicable
  -- Live claude process pid reported by the hooks (US-002 v1.0.2). Used for
  -- marker-independent pty↔session correlation; null until a hook reports it.
  claude_pid                  INTEGER
);

-- Lifecycle + stream events for a session (from hooks and the stream-json parser).
CREATE TABLE IF NOT EXISTS event (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  parent_tool_use_id TEXT,                     -- for subagent nesting
  hook_event_name    TEXT,                     -- PreToolUse | PostToolUse | Notification | ...
  stream_type        TEXT,                     -- system/init | stream_event | result | api_retry
  tool_name          TEXT,
  payload            TEXT,                      -- JSON blob (tool_input, result, deltas, etc.)
  ts                 INTEGER NOT NULL           -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_event_session_ts ON event (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_event_parent ON event (parent_tool_use_id);

-- One row per live browser-attached terminal (node-pty) bound to a session.
CREATE TABLE IF NOT EXISTS terminal_session (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES session(id) ON DELETE CASCADE,
  pid         INTEGER,
  cols        INTEGER,
  rows        INTEGER,
  ring_buffer BLOB,                            -- recent output for reconnect replay (capped)
  created_at  INTEGER NOT NULL
);

-- Chat V1 (US-013): projects + lightweight thread metadata so the sidebar's
-- project grouping and thread resume survive restarts. The project OWNS the
-- path (US-025 model) — threads reference it by id, never re-derived from a
-- basename. No message/turn columns: transcripts are reconstructed from
-- Claude's own JSONL (+ claude --resume), not stored here.
CREATE TABLE IF NOT EXISTS project (
  id         TEXT PRIMARY KEY,                  -- UI-generated project id
  path       TEXT NOT NULL UNIQUE,              -- absolute working directory
  name       TEXT NOT NULL,                     -- display name (defaults to basename)
  created_at INTEGER NOT NULL                   -- epoch ms
);

CREATE TABLE IF NOT EXISTS chat_thread (
  session_id    TEXT PRIMARY KEY,               -- Claude Code session_id (resume key)
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  cwd           TEXT NOT NULL,                  -- launch cwd (the project path at creation)
  model         TEXT,                           -- --model alias; null = default
  provider      TEXT,                           -- agent provider id (T3-1 US-006: claude|codex|grok); null reads as 'claude'
  effort        TEXT,                           -- provider-owned reasoning-effort launch id
  title         TEXT,                           -- first-prompt-derived display title
  last_message  TEXT,                           -- PD-1: last assistant response (or prompt) preview
  created_at    INTEGER NOT NULL,               -- epoch ms
  last_activity INTEGER NOT NULL                -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_chat_thread_project ON chat_thread (project_id, last_activity);

-- Per-project custom toolbar actions (loop/conan-thread-toolbar US-004).
CREATE TABLE IF NOT EXISTS project_action (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  command    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_action_project ON project_action (project_id, created_at);

-- US-003 (v4.5): the "skills considered but didn't fire" heuristic. One row per
-- (UserPromptSubmit event, candidate skill) — the top N scoring skills from
-- src/skills/match.ts. Reconciled at Stop time: any skill whose name shows up
-- in the transcript JSONL slice since the prompt has fired=1 + a fired reason.
-- Honest by construction: never labelled as Claude's real scoring (the UI
-- displays a "Heuristic match" badge alongside it).
CREATE TABLE IF NOT EXISTS prompt_consideration (
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  skill      TEXT NOT NULL,
  score      REAL NOT NULL,
  reason     TEXT NOT NULL,
  fired      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, skill)
);
CREATE INDEX IF NOT EXISTS idx_prompt_consideration_event ON prompt_consideration (event_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- WHA-125 (fleet phase 1b): the lineage tables.
-- Contract: docs/conan-fleet-phase0-freeze.md (§2 containment, §4 verdict state
-- machine, §5 evidence object). Phase 1a shipped `attempt`; this widens that
-- spine with the entities a run is made of. Same database, same module, no
-- second persistence path.
--
-- NAMING: new tables carry a `fleet_` prefix even though `attempt` does not.
-- `run`, `task`, `decision` and `ticket` are words this codebase already uses
-- for unrelated things (`GET /api/tasks` is the prd.json build trail), and a
-- bare `task` table would eventually collide with one of them. `attempt` keeps
-- its bare name because renaming a shipped table is a destructive migration.
--
-- ON DELETE POLICY, decided once and applied consistently:
--   * CASCADE  — rows with no meaning apart from their parent (an evidence
--                command, a binding without its principal, the session bridge).
--   * RESTRICT — every lineage edge. This is an audit ledger: deleting a ticket
--                that has runs, or an attempt that produced evidence, is an
--                error to be surfaced, never a silent cascade that quietly
--                erases who did what.
--   * SET NULL — attributions to mutable app tables (`attempt.project_id`,
--                WHA-136's precedent), where losing the pointer is acceptable
--                but losing the lineage row is not.

-- WHO. Freeze §3: identity is the PAIR (principal, runtime instance) — not a
-- provider and not a model, both of which two agents can share while still
-- being independent. The self-verify ban is a statement about these two ids.
CREATE TABLE IF NOT EXISTS fleet_principal (
  principal_id TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('agent', 'human')),
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL             -- epoch ms
);

-- A runtime instance a principal runs as. `containment_observed` is nullable
-- here ON PURPOSE (WHA-125 Decisions, carried from WHA-124 P1-8): a binding may
-- be pinned to a class up front (the critic's read-only codex), but containment
-- is only truly known once a mode is resolved at spawn, which is why the
-- authoritative record stays on the attempt row. The column exists so a future
-- pinned floor has somewhere to live instead of being assumed.
CREATE TABLE IF NOT EXISTS fleet_binding (
  binding_id           TEXT PRIMARY KEY,
  principal_id         TEXT NOT NULL REFERENCES fleet_principal(principal_id) ON DELETE CASCADE,
  provider             TEXT NOT NULL,
  model                TEXT,
  permission_mode      TEXT,
  containment_observed TEXT CHECK (
    containment_observed IS NULL
    OR containment_observed IN ('none', 'prompt-gated', 'fail-closed-cancel', 'os-sandbox')
  ),
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fleet_binding_principal ON fleet_binding (principal_id);

-- WHAT. AC 5: the internal `ticket_id` is the key everything else references;
-- `linear_key` is a nullable mirror of the external id. Deliberate: lineage
-- must be writable before any Linear credential exists, and a ticket that was
-- never mirrored is still a real ticket. UNIQUE permits many NULLs in SQLite,
-- so "unique when present" needs no partial index.
CREATE TABLE IF NOT EXISTS fleet_ticket (
  ticket_id  TEXT PRIMARY KEY,
  linear_key TEXT UNIQUE,                   -- 'WHA-125'; NULL until mirrored
  title      TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open'
             CHECK (state IN ('open', 'in-progress', 'blocked', 'done', 'abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One pass of the Sagan loop over a ticket. `lane` is an open set on purpose —
-- .sagan/sagan.yaml owns the lane vocabulary (correctness, quality, …) and the
-- database has no business going stale against it.
--
-- There is NO `round` column: the current round is MAX(round) over the run's
-- critiques. A stored copy is a derived value that can disagree with the rows
-- it summarises, and the round cap must count what actually happened.
CREATE TABLE IF NOT EXISTS fleet_run (
  run_id     TEXT PRIMARY KEY,              -- e.g. 'run-20260810-152812'
  ticket_id  TEXT NOT NULL REFERENCES fleet_ticket(ticket_id) ON DELETE RESTRICT,
  lane       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'running'
             CHECK (state IN ('running', 'complete', 'escalated', 'abandoned')),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fleet_run_ticket ON fleet_run (ticket_id, started_at);

-- One dispatchable unit of work inside a run. `state` is LIFECYCLE ONLY —
-- whether the work has been handed out, not what anyone thought of it. The
-- verdict vocabulary lives on fleet_critique and is not duplicated here; two
-- columns that can disagree about the same fact is how ledgers start lying.
CREATE TABLE IF NOT EXISTS fleet_task (
  task_id    TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES fleet_run(run_id) ON DELETE RESTRICT,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending'
             CHECK (state IN ('pending', 'dispatched', 'done', 'abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fleet_task_run ON fleet_task (run_id, created_at);

-- WHO does WHAT: one principal+binding per role per task (UNIQUE), which is the
-- data the self-verify ban is checked against.
--
-- `containment_floor` is a JSON ARRAY of allowed classes, never a threshold —
-- freeze §2 is explicit that the classes are not totally ordered, so a `>=`
-- column would encode a comparison that does not exist. Contents are validated
-- against CONTAINMENT_CLASSES at the write boundary (src/fleet/lineage.ts);
-- json_valid() here stops a non-JSON string from ever reaching a reader.
CREATE TABLE IF NOT EXISTS fleet_role_assignment (
  assignment_id     TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES fleet_task(task_id) ON DELETE RESTRICT,
  role              TEXT NOT NULL,          -- matches .sagan/roles/<role>.md
  principal_id      TEXT NOT NULL REFERENCES fleet_principal(principal_id) ON DELETE RESTRICT,
  binding_id        TEXT NOT NULL REFERENCES fleet_binding(binding_id) ON DELETE RESTRICT,
  containment_floor TEXT CHECK (containment_floor IS NULL OR json_valid(containment_floor)),
  assigned_at       INTEGER NOT NULL,
  UNIQUE (task_id, role)
);

-- WHA-129 (fleet phase 1a): one row per agent process actually spawned, written
-- by the single dispatch seam (src/fleet/dispatch.ts). This is the first brick of
-- the fleet lineage model — see docs/conan-fleet-phase0-freeze.md.
--
-- `context` is the freeze doc's DispatchContext discriminant: 'chat' for ordinary
-- interactive turns (no ticket, no AC, fleet predicates skipped), 'fleet-attempt'
-- for a task attempt under lineage. One seam, two policies.
--
-- `session_id` is the PROVIDER's session id (the chat_thread key), not session(id)
-- from the hooks table, and is NULL until the provider reports it at init — a
-- process is spawned before it has a name. Deliberately no FK: a thread row only
-- exists when the client supplied a projectId, but every spawn gets an attempt.
--
-- `containment_observed` is the class resolved from (provider, permission_mode) at
-- spawn. Recorded per attempt rather than per binding because claude's permission
-- mode is live-switchable mid-session, so the configured floor is not necessarily
-- what the attempt ran under.
--
-- `project_id` (WHA-136) is resolved ONCE at spawn from the cwd, symlinks and
-- monorepo nesting collapsed (src/fleet/project.ts) — never re-derived later by
-- matching `cwd` strings, which would read one checkout as several projects.
-- Nullable: a chat can start in a folder the sidebar never adopted. ON DELETE
-- SET NULL rather than CASCADE, so deleting a project keeps its lineage.
--
-- WHA-125: the six lineage columns below are ALL nullable, and an ordinary chat
-- turn leaves every one of them null (AC 2) — `context = 'chat'` means there is
-- no ticket, no task and no role, and writing a placeholder would make the
-- ledger claim a run that never happened. They are enforced null-for-chat at
-- the write boundary (src/fleet/attempts.ts) rather than by a CHECK, because
-- adding a table-level constraint to a shipped table means rewriting it, which
-- is exactly the destructive step this migration refuses to take.
CREATE TABLE IF NOT EXISTS attempt (
  id                   TEXT PRIMARY KEY,
  context              TEXT NOT NULL,             -- chat | fleet-attempt
  session_id           TEXT,                      -- provider session id, backfilled at init
  provider             TEXT NOT NULL,
  model                TEXT,                      -- launch model id; null = provider default
  permission_mode      TEXT,                      -- the id requested at spawn; null = provider default
  containment_observed TEXT NOT NULL,             -- none | prompt-gated | fail-closed-cancel | os-sandbox
  cwd                  TEXT,
  project_id           TEXT REFERENCES project(id) ON DELETE SET NULL,
  started_at           INTEGER NOT NULL,          -- epoch ms
  ended_at             INTEGER,                   -- epoch ms; null while the process is live
  cost_usd             REAL,
  duration_ms          INTEGER,
  -- WHA-125 lineage attribution; null for every `chat` attempt.
  run_id               TEXT REFERENCES fleet_run(run_id) ON DELETE RESTRICT,
  ticket_id            TEXT REFERENCES fleet_ticket(ticket_id) ON DELETE RESTRICT,
  task_id              TEXT REFERENCES fleet_task(task_id) ON DELETE RESTRICT,
  role                 TEXT,                      -- .sagan/roles/<role>.md
  principal_id         TEXT REFERENCES fleet_principal(principal_id) ON DELETE RESTRICT,
  binding_id           TEXT REFERENCES fleet_binding(binding_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_attempt_session ON attempt (session_id);
CREATE INDEX IF NOT EXISTS idx_attempt_started ON attempt (started_at);
-- `idx_attempt_project` is DELIBERATELY NOT HERE, and adding it back bricks
-- every existing install. This file runs as one `exec` BEFORE `migrate()`, and
-- `CREATE TABLE IF NOT EXISTS attempt` is a no-op against a database whose
-- attempt table predates WHA-136 — so indexing `project_id` here throws
-- "no such column: project_id" and the gateway can never reach the ALTER that
-- would have added it. The index is created in `migrate()` instead, right
-- after the column is guaranteed. Any future column added to an existing table
-- has to follow the same rule: column in this file for fresh databases, column
-- AND its index in `migrate()` for the ones already on disk.
--
-- WHA-125 follows that rule exactly: `run_id`/`ticket_id`/`task_id`/`role`/
-- `principal_id`/`binding_id` are declared above for fresh databases and ALTERed
-- in `migrate()` for existing ones, and `idx_attempt_task` / `idx_attempt_ticket`
-- are created ONLY in `migrate()`, after the ALTERs. Do not "tidy" them up here.
--
-- The lineage tables below need no such care — they are NEW tables, and this
-- whole file is exec'd on every boot, so `CREATE TABLE IF NOT EXISTS` creates
-- them on an existing database too. Only pre-existing tables need `migrate()`.

-- WHA-125: every provider session id an attempt has ever answered to.
-- `attempt.session_id` holds the CURRENT one and is overwritten; `--resume`
-- forks into a new session id mid-attempt (src/agent/index.ts adoptChatThread),
-- so the column alone loses the earlier name and any lookup by the old id
-- silently finds nothing. The bridge keeps all of them. CASCADE: a session
-- binding is a detail of its attempt and means nothing without it.
CREATE TABLE IF NOT EXISTS attempt_session (
  attempt_id TEXT NOT NULL REFERENCES attempt(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,                  -- provider session id (chat_thread key)
  bound_at   INTEGER NOT NULL,               -- epoch ms
  PRIMARY KEY (attempt_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_attempt_session_bridge ON attempt_session (session_id);

-- What an attempt produced, at an exact state. `sha` is a git sha for a commit
-- or a content digest for anything else — one column, because every consumer
-- asks the same question of it ("is this still the state I approved?").
--
-- `artifact_class` is the distinction freeze §4 actually branches on when
-- deciding whether APPROVED can be reached on read: a doc can be accepted by
-- reading it, an executable needs evidence, a user-visible change may need a
-- human eye (§6.3). Storing the class rather than a file extension keeps that
-- decision out of a regex.
CREATE TABLE IF NOT EXISTS fleet_artifact (
  artifact_id    TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES fleet_task(task_id) ON DELETE RESTRICT,
  attempt_id     TEXT REFERENCES attempt(id) ON DELETE RESTRICT,
  artifact_class TEXT NOT NULL
                 CHECK (artifact_class IN ('read-verifiable', 'executable', 'user-visible')),
  path           TEXT,                       -- repo-relative, when it is a file
  sha            TEXT NOT NULL CHECK (length(sha) > 0),  -- git sha or content digest
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fleet_artifact_task ON fleet_artifact (task_id, created_at);

-- AC 3 / freeze §5: the evidence object, first-class columns.
--
-- `sha` is copied from the artifact at recording time rather than joined. That
-- is a deliberate denormalisation and it is load-bearing: freeze §6.1 says
-- evidence is invalidated when the tip drifts, and the only way to SEE drift is
-- to keep the state the evidence was taken against next to the state the
-- artifact is in now.
CREATE TABLE IF NOT EXISTS fleet_evidence (
  evidence_id         TEXT PRIMARY KEY,
  artifact_id         TEXT NOT NULL REFERENCES fleet_artifact(artifact_id) ON DELETE RESTRICT,
  sha                 TEXT NOT NULL CHECK (length(sha) > 0),  -- sha|digest it applies to
  attempt_id          TEXT NOT NULL REFERENCES attempt(id) ON DELETE RESTRICT,
  runner_principal_id TEXT NOT NULL REFERENCES fleet_principal(principal_id) ON DELETE RESTRICT,
  runner_binding_id   TEXT NOT NULL REFERENCES fleet_binding(binding_id) ON DELETE RESTRICT,
  harness             TEXT NOT NULL CHECK (length(harness) > 0),  -- 'npm test', …
  observation_method  TEXT NOT NULL
                      CHECK (observation_method IN
                        ('exit-code', 'screenshot', 'capture', 'human-read', 'log-read')),
  recorded_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fleet_evidence_artifact ON fleet_evidence (artifact_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_fleet_evidence_attempt ON fleet_evidence (attempt_id);

-- `commands[]` from freeze §5, as rows rather than a JSON blob: the promote gate
-- asks "did anything exit non-zero", and a query beats parsing a string in
-- application code. CASCADE — a command has no life without its evidence.
CREATE TABLE IF NOT EXISTS fleet_evidence_command (
  evidence_id   TEXT NOT NULL REFERENCES fleet_evidence(evidence_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL CHECK (seq >= 0),   -- run order, 0-based
  cmd           TEXT NOT NULL CHECK (length(cmd) > 0),
  cwd           TEXT,
  exit_code     INTEGER,                     -- null = did not complete
  stdout_digest TEXT,
  duration_ms   INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  PRIMARY KEY (evidence_id, seq)
);

-- AC 4 / freeze §4: one verdict per artifact per lane per round.
--
-- The bind list is stored as columns rather than reached through `evidence_id`
-- because binding means SNAPSHOT: what this verdict was granted against, frozen
-- at decision time. A later edit to the evidence row must not be able to
-- retroactively change what somebody approved.
--
-- Two CHECKs carry invariants that would otherwise be comments:
--   * APPROVED cannot exist without bound evidence and its producer — freeze
--     §4's "no approve-by-side-effect", made unrepresentable. REVISE and
--     ESCALATE are deliberately NOT constrained: a critic can legitimately send
--     work back before any evidence exists.
--   * The critic's attempt cannot be the evidence producer's attempt — §4's
--     "a fresh critic attempt (not the builder, not the evidence producer)".
--     The builder half of that rule needs the task's role assignments and is
--     WHA-126's dispatch-time predicate; this half is a property of one row and
--     so belongs here.
CREATE TABLE IF NOT EXISTS fleet_critique (
  critique_id           TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES fleet_task(task_id) ON DELETE RESTRICT,
  artifact_id           TEXT NOT NULL REFERENCES fleet_artifact(artifact_id) ON DELETE RESTRICT,
  lane                  TEXT NOT NULL,
  round                 INTEGER NOT NULL CHECK (round >= 1),
  verdict               TEXT NOT NULL
                        CHECK (verdict IN ('NEEDS_EVIDENCE', 'APPROVED', 'REVISE', 'ESCALATE')),
  findings              INTEGER NOT NULL DEFAULT 0 CHECK (findings >= 0),
  -- bind list (AC 4)
  evidence_id           TEXT REFERENCES fleet_evidence(evidence_id) ON DELETE RESTRICT,
  evidence_sha          TEXT,
  evidence_attempt_id   TEXT REFERENCES attempt(id) ON DELETE RESTRICT,
  evidence_principal_id TEXT REFERENCES fleet_principal(principal_id) ON DELETE RESTRICT,
  evidence_binding_id   TEXT REFERENCES fleet_binding(binding_id) ON DELETE RESTRICT,
  rubric_version        TEXT NOT NULL,
  critic_model          TEXT NOT NULL,
  critic_attempt_id     TEXT NOT NULL REFERENCES attempt(id) ON DELETE RESTRICT,
  created_at            INTEGER NOT NULL,
  UNIQUE (artifact_id, lane, round),
  CHECK (
    verdict <> 'APPROVED'
    OR (evidence_id IS NOT NULL
        AND evidence_sha IS NOT NULL
        AND evidence_principal_id IS NOT NULL
        AND evidence_binding_id IS NOT NULL)
  ),
  CHECK (evidence_attempt_id IS NULL OR evidence_attempt_id <> critic_attempt_id)
);
CREATE INDEX IF NOT EXISTS idx_fleet_critique_task ON fleet_critique (task_id, round);

-- Gates: what was asked of a decider and what came back. A dispatch REFUSAL is
-- recorded here too (gate 'dispatch', decision 'refuse') — a refusal is a fact
-- about the run, and a ledger that only records what was allowed cannot answer
-- "why did nothing happen for an hour".
--
-- `reason_code` is the machine-readable half (self-verify, floor-violation, …)
-- and `reason` the human half; a refusal must carry the code, enforced below.
CREATE TABLE IF NOT EXISTS fleet_decision (
  decision_id             TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES fleet_run(run_id) ON DELETE RESTRICT,
  task_id                 TEXT REFERENCES fleet_task(task_id) ON DELETE RESTRICT,
  gate                    TEXT NOT NULL,      -- dispatch | promote | … (open set)
  state                   TEXT NOT NULL CHECK (state IN ('needed', 'made')),
  decision                TEXT CHECK (
                            decision IS NULL
                            OR decision IN ('approve', 'revise', 'promote', 'escalate', 'refuse')
                          ),
  reason_code             TEXT,
  reason                  TEXT,
  critique_id             TEXT REFERENCES fleet_critique(critique_id) ON DELETE RESTRICT,
  attempt_id              TEXT REFERENCES attempt(id) ON DELETE RESTRICT,
  decided_by_principal_id TEXT REFERENCES fleet_principal(principal_id) ON DELETE RESTRICT,
  created_at              INTEGER NOT NULL,
  CHECK (state = 'needed' OR decision IS NOT NULL),
  CHECK (decision IS NULL OR decision <> 'refuse' OR reason_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_fleet_decision_run ON fleet_decision (run_id, created_at);
