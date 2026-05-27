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
  schema_valid                INTEGER          -- 1 valid, 0 invalid, null = not applicable
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
