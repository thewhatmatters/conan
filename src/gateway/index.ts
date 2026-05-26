import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import express from "express";
import { WebSocketServer } from "ws";
import { getDb, closeDb } from "../db/index.js";
import { UI_DIST, PACKAGE_ROOT } from "../paths.js";
import { AUTH_TOKEN, verifyUpgrade } from "./auth.js";
import { resolveTlsConfig, assertRemoteSafe } from "./tls.js";
import { attachTerminal, closeAllTerminals } from "../terminal/index.js";
import { readTasks, watchTasks } from "../tasks/index.js";
import { readSkills } from "../skills/index.js";
import { readTranscript } from "../transcript/index.js";
import { readSubagents } from "../subagents/index.js";
import { pulseSeries } from "../pulse/index.js";
import { readWidgets } from "../widgets/index.js";
import { usageStatus } from "../usage/index.js";
import { getCachedPlanUtilization, maybeProbe } from "../usage/probe.js";
import { readStats } from "../stats/index.js";
import { readMcpStatus, liveSessionMcp } from "../mcp/index.js";
import { getActiveCwd, setActiveCwd, listDirs } from "../cwd/index.js";
import { readHooksStatus, readClaudeSettings, writeClaudeSetting } from "../settings/index.js";
import { readChangelog } from "../changelog/index.js";
import { readCheckpoints, readSnapshot } from "../checkpoints/index.js";
import { readHooksCoverage } from "../hooks-coverage/index.js";
import { readProjectMetrics } from "../project-metrics/index.js";
import { readPlugins } from "../plugins/index.js";
import { readAgents } from "../agents/index.js";
import { readBackgroundAgents } from "../background-agents/index.js";
import { readPromptHistory } from "../prompt-history/index.js";
import {
  installGlobalHooks,
  uninstallGlobalHooks,
  globalSettingsPath,
} from "../hooks/install.js";
import {
  startSession,
  sendPrompt,
  stopSession,
  resumeSession,
  decidePermission,
  listSessions,
  listEvents,
  listAllEvents,
  listPendingPermissions,
  onSessionEvent,
} from "../session/index.js";
import { startReaper } from "../session/reaper.js";

const PORT = Number(process.env.CONAN_PORT ?? 3747);
// Loopback by default — network exposure is opt-in (CONAN_HOST) and still
// gated by the WS auth token + Origin validation in auth.ts (US-002).
const HOST = process.env.CONAN_HOST ?? "127.0.0.1";

// Opt-in remote access over TLS (US-024). Off unless CONAN_TLS_CERT +
// CONAN_TLS_KEY are set; when on, the gateway runs as HTTPS and all WebSockets
// (app + terminal) are served over wss:// behind the same token/Origin checks.
const TLS = resolveTlsConfig();
// Binding to a non-loopback interface without TLS is refused outright, so the
// dashboard (and the pty terminal behind it) can never be exposed in cleartext.
assertRemoteSafe(HOST, TLS);
const SCHEME = TLS.enabled ? "https" : "http";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Open the database up front so a bad schema fails fast at boot (US-001).
const db = getDb();

// One-time backfill (US-012): observed sessions never had their model captured,
// so the Model & idle widget showed "unknown". The model has always been in the
// forwarded hook payloads — recover it for any session still missing one from
// its most recent payload that carries a model field. Future events set it at
// write time in POST /api/claude/events.
function backfillSessionModels(): void {
  const sessions = db
    .prepare("SELECT id FROM session WHERE model IS NULL")
    .all() as { id: string }[];
  const latest = db.prepare(
    `SELECT payload FROM event
       WHERE session_id = ? AND payload LIKE '%"model"%'
       ORDER BY ts DESC LIMIT 1`,
  );
  const setModel = db.prepare("UPDATE session SET model = ? WHERE id = ?");
  let filled = 0;
  for (const { id } of sessions) {
    const row = latest.get(id) as { payload: string } | undefined;
    if (!row) continue;
    try {
      const p = JSON.parse(row.payload) as Record<string, unknown>;
      if (typeof p.model === "string" && p.model) {
        setModel.run(p.model, id);
        filled++;
      }
    } catch {
      /* malformed payload — skip */
    }
  }
  if (filled > 0) console.log(`[conan] backfilled model for ${filled} session(s)`);
}
backfillSessionModels();

app.get("/api/health", (_req, res) => {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => (r as { name: string }).name);
  res.json({ status: "ok", port: PORT, tables });
});

// Same-origin bootstrap: the SPA reads the auth token here. Cross-origin pages
// cannot read this response (no CORS headers are set), so the token stays put.
// cwd is the app-wide active working directory (US-019), which the toolbar
// picker can change; it survives a restart so reloads see the chosen directory.
app.get("/api/config", (_req, res) => {
  res.json({ token: AUTH_TOKEN, port: PORT, cwd: getActiveCwd() });
});

// Active working-directory picker (US-019). The toolbar cwd is no longer a
// static label: GET reports the current active cwd (+ the repo-root default),
// PUT changes it (token-gated; rejects anything that isn't an accessible
// directory). Changing it re-scopes new terminals + the Tasks reader; existing
// ptys keep their own cwd. The choice persists across reloads.
app.get("/api/cwd", (_req, res) => {
  res.json({ cwd: getActiveCwd(), default: PACKAGE_ROOT });
});

app.put("/api/cwd", (req, res) => {
  if (!authed(req, res)) return;
  const result = setActiveCwd((req.body ?? {}).cwd);
  if (!result.ok) {
    res.status(400).json({ error: result.error ?? "invalid directory" });
    return;
  }
  res.json({ ok: true, cwd: result.cwd });
});

// Directory browser backing the toolbar picker (US-019). Lists the immediate
// subdirectories of ?path= (defaults to the active cwd), token-gated since it
// exposes the local filesystem layout. Unreadable targets degrade to an empty
// listing carrying an `error` the UI surfaces.
app.get("/api/fs/dirs", (req, res) => {
  if (!authed(req, res)) return;
  const path = typeof req.query.path === "string" ? req.query.path : undefined;
  res.json(listDirs(path));
});

// Build-loop progress (prd.json + progress.txt). Live updates arrive over /ws.
app.get("/api/tasks", (_req, res) => {
  res.json(readTasks());
});

// Shared bearer check for the control-plane routes: the same auth token the WS
// layer uses (US-002), presented as the x-conan-token header.
function authed(req: express.Request, res: express.Response): boolean {
  if (req.header("x-conan-token") !== AUTH_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

// Await a session_id without blocking the response forever: resolves with the
// captured id, or null if the stream doesn't surface system/init in time.
function awaitSessionId(p: Promise<string>, ms: number): Promise<string | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// Ingest a Claude Code lifecycle event (US-003). Posted by the hook scripts in
// .claude/hooks; persisted to SQLite and broadcast over /ws (US-005).
const IDLE_EVENTS = new Set(["Stop", "SessionEnd"]);
app.post("/api/claude/events", (req, res) => {
  if (!authed(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const sessionId = b.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    res.status(400).json({ error: "session_id required" });
    return;
  }

  const now = Date.now();
  const hookEvent = typeof b.hook_event_name === "string" ? b.hook_event_name : null;
  const status = hookEvent && IDLE_EVENTS.has(hookEvent) ? "idle" : "running";

  // Capture the model from the hook payload (SessionStart and most events carry
  // it, e.g. "claude-opus-4-7[1m]") so observed sessions populate the Model &
  // idle widget (US-012). COALESCE keeps a known model when a later event omits
  // it. The model is nested in the forwarded hook payload, not at body top-level.
  const payload = (b.payload ?? null) as Record<string, unknown> | null;
  const model =
    payload && typeof payload.model === "string" ? payload.model : null;

  db.prepare(
    `INSERT INTO session (id, cwd, model, status, created_at, last_activity)
       VALUES (@id, @cwd, @model, @status, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       last_activity = @now,
       status = @status,
       cwd = COALESCE(excluded.cwd, session.cwd),
       model = COALESCE(excluded.model, session.model)`,
  ).run({
    id: sessionId,
    cwd: typeof b.cwd === "string" ? b.cwd : null,
    model,
    status,
    now,
  });

  const info = db
    .prepare(
      `INSERT INTO event
         (session_id, parent_tool_use_id, hook_event_name, stream_type, tool_name, payload, ts)
       VALUES (?, ?, ?, 'hook', ?, ?, ?)`,
    )
    .run(
      sessionId,
      typeof b.parent_tool_use_id === "string" ? b.parent_tool_use_id : null,
      hookEvent,
      typeof b.tool_name === "string" ? b.tool_name : null,
      JSON.stringify(b.payload ?? b),
      now,
    );

  const event = {
    id: Number(info.lastInsertRowid),
    session_id: sessionId,
    parent_tool_use_id: typeof b.parent_tool_use_id === "string" ? b.parent_tool_use_id : null,
    hook_event_name: hookEvent,
    stream_type: "hook",
    tool_name: typeof b.tool_name === "string" ? b.tool_name : null,
    payload: JSON.stringify(b.payload ?? b),
    ts: now,
  };
  broadcast({ type: "event", payload: event });
  res.json({ ok: true, id: event.id });
});

// Install/remove Conan's GLOBAL hooks into the user-level ~/.claude/settings.json
// (US-002), so every `claude` run on this machine self-reports — not just runs
// inside this repo. Token-gated (mutates the user's settings file). Idempotent
// and non-destructive: merges, preserves unknown keys, backs up before writing.
// `?remove=1` (or {remove:true}) uninstalls.
app.post("/api/claude/hooks/install-global", (req, res) => {
  if (!authed(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const remove = b.remove === true || req.query.remove === "1";
  try {
    const result = remove ? uninstallGlobalHooks() : installGlobalHooks();
    res.json({ ok: true, ...result });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err), path: globalSettingsPath() });
  }
});

// Skills hero widget data (US-010): total skills available on this machine,
// plus how many the given session loaded (from its system/init event).
// Read-only, like /api/tasks.
app.get("/api/claude/skills", (req, res) => {
  const sessionId =
    typeof req.query.session_id === "string" ? req.query.session_id : undefined;
  res.json(readSkills(sessionId));
});

// Session grid data (US-009): every persisted session, newest activity first.
// Read-only, like /api/tasks — the mutating routes below stay token-gated.
app.get("/api/claude/sessions", (_req, res) => {
  res.json(listSessions());
});

// A session's event history for the ActivityTimeline (US-011). Read-only; live
// updates arrive over /ws as {type:'event'}. Newest activity is appended there.
app.get("/api/claude/sessions/:id/events", (req, res) => {
  res.json(listEvents(req.params.id));
});

// The timeline's "All sessions" view (US-007): recent events across every
// session, oldest-first. Read-only; live updates arrive over /ws. Optional
// `?cwd=` scopes to one working directory (US-002 multi-project observatory).
app.get("/api/claude/events", (req, res) => {
  const cwd = typeof req.query.cwd === "string" && req.query.cwd ? req.query.cwd : undefined;
  res.json(listAllEvents(1000, cwd));
});

// A session's full conversation transcript (US-014), read straight from the
// Claude Code JSONL under ~/.claude (not duplicated into SQLite). The cwd lets
// us resolve the per-project transcript folder; a missing file degrades to
// { found:false, messages:[] }. Read-only.
app.get("/api/claude/sessions/:id/transcript", (req, res) => {
  const row = db
    .prepare("SELECT cwd FROM session WHERE id = ?")
    .get(req.params.id) as { cwd?: string } | undefined;
  res.json(readTranscript(req.params.id, row?.cwd ?? null));
});

// A session's subagent tree (US-014), reconstructed from disk under
// ~/.claude/projects/<enc-cwd>/<session-id>/subagents/ — works for any session
// (past/observed), not just live ones tracked via parent_tool_use_id. The cwd
// helps resolve the project folder; absent subagents degrade to
// { found:false, subagents:[] }. Read-only.
app.get("/api/claude/sessions/:id/subagents", (req, res) => {
  const row = db
    .prepare("SELECT cwd FROM session WHERE id = ?")
    .get(req.params.id) as { cwd?: string } | undefined;
  res.json(readSubagents(req.params.id, row?.cwd ?? null));
});

// Time-series throughput for the Pulse chart (US-020): events-per-minute,
// token/cost burn, and api_retry markers bucketed across all sessions over a
// configurable window (?minutes=, default 60, clamped 5..1440). Read-only; the
// chart refetches as events arrive over /ws. Distinct from the snapshot hero
// cards (US-010) — this is history, not "now".
app.get("/api/claude/pulse", (req, res) => {
  const raw = Number(req.query.minutes);
  const minutes = Number.isFinite(raw)
    ? Math.min(1440, Math.max(5, Math.round(raw)))
    : 60;
  res.json(pulseSeries(minutes * 60_000));
});

// Opt-in secondary widgets for one session (US-022): MCP servers + health,
// plugins + plugin_errors, most-used tools, api_retry rate, and git branch +
// dirty-file count for the session cwd. Read-only; the UI fetches this only for
// widgets the user has enabled, so the default view stays lean.
app.get("/api/claude/sessions/:id/widgets", async (req, res) => {
  res.json(await readWidgets(req.params.id));
});

// Every permission prompt awaiting a decision across all live sessions, for the
// cross-session pending-approvals widget (US-013). Read-only; the widget
// refetches as control_request/control_cancel events arrive over /ws. Each item
// is answered via the US-012 POST /sessions/:id/permission route.
app.get("/api/claude/permissions", (_req, res) => {
  res.json(listPendingPermissions());
});

// Usage monitor for the hero widget (US-004, was US-030): plan-usage framing for
// a token-based Claude Max plan — a rate-limited state + reset time parsed from
// recent api_retry events, plus token consumption over rolling windows (5h/7d).
// Cost-today is reported as informational only, NOT a ceiling. Read-only; the
// widget refetches as events arrive over /ws and ticks the countdown
// client-side. The dashboard counterpart to run-tasks.sh's backoff.
//
// US-005: also surfaces planUtilization — the REAL 5-hour/7-day "% used" + reset
// times scraped from Claude Code's `/usage` TUI (the only confirmed live source;
// the ratelimit-unified headers aren't readable from outside the claude process).
// Always returns the last cached probe (or null); never blocks on a scrape. A
// token-gated `?probe=1` requests a fresh, bounded PTY probe on demand (throttled
// to once per TTL) — that's how the widget refreshes when the dashboard opens.
app.get("/api/claude/usage", async (req, res) => {
  const base = usageStatus();
  let planUtilization = getCachedPlanUtilization();
  if (req.query.probe === "1") {
    if (!authed(req, res)) return; // a probe spawns a process — token-gate it
    planUtilization = await maybeProbe();
  }
  res.json({ ...base, planUtilization });
});

// Claude Code's own usage rollup for the Stats / contribution-heatmap widget
// (US-002 → US-015): a normalized read of ~/.claude/stats-cache.json — a
// contiguous (zero-filled) day calendar plus computed headline stats (streaks,
// favorite model/hour, total tokens). Read-only and access-modeled like the
// other /api/claude/* GET routes (loopback-only; the SPA reads it same-origin);
// returns a safe empty shape when stats-cache.json is absent.
app.get("/api/claude/stats", (_req, res) => {
  res.json(readStats());
});

// MCP server status for the MCP widget (US-003 → US-004 → US-011). Claude Code
// keeps no live MCP registry on disk, so we infer connected/needs-auth from the
// user's configured servers — unioned across ~/.claude.json (global mcpServers
// + projects[*].mcpServers, where most live), ~/.claude/settings.json, and the
// project .mcp.json — minus the needs-auth cache, then override per-server with
// the most-recent live session's captured system/init mcp_servers (true signal).
// Read-only and access-modeled like the other /api/claude/* GET routes;
// degrades to a safe empty shape when the config files are absent.
app.get("/api/claude/mcp", (_req, res) => {
  res.json(readMcpStatus({ sessionMcp: liveSessionMcp() }));
});

// Read-only settings surface for the Settings view (US-020): which Claude Code
// lifecycle hooks are wired (so observed sessions self-report) and the
// remote-access (TLS) posture. NO cost-ceiling/budget here — removed in
// US-004/US-014; the plan is token-based, not dollar-metered. Theme + usage
// preferences live client-side. Access-modeled like the other GET routes.
app.get("/api/settings", (_req, res) => {
  res.json({
    hooks: readHooksStatus(),
    remote: {
      tlsEnabled: TLS.enabled,
      scheme: SCHEME,
      host: HOST,
      loopbackOnly: !TLS.enabled,
    },
  });
});

// Claude Code settings mirror for the Settings page (US-006 → US-029). GET
// reads the real values from ~/.claude/settings.json (+ settings.local.json
// overrides + a couple of ~/.claude.json flags), reporting each known setting's
// value, type, allowed values, default, and source file. Setting definitions
// come from the bundled canonical schema (json.schemastore.org), not guesses.
// Read-only and access-modeled like the other GET routes.
app.get("/api/claude/settings", (_req, res) => {
  res.json(readClaudeSettings());
});

// Changelog feed for the "What's New" view (US-007 → US-030). Parses
// ~/.claude/cache/changelog.md into newest-first {version, items} entries (no
// dates in the source → date null), reports the installed version (from a live
// sessions/<pid>.json, else lastReleaseNotesSeen) and flags entries newer than
// lastReleaseNotesSeen as `new` (semver-tuple compare). changelogLastFetched is
// the file mtime for staleness. Read-only; safe empty shape if the file is gone.
app.get("/api/claude/changelog", (_req, res) => {
  res.json(readChangelog());
});

// Checkpoints (US-008): list Claude Code's per-session file-history snapshots
// (~/.claude/file-history/<session>/<hash>@vN), grouped/sorted per session.
// Read-only and access-modeled like the other GET routes; safe empty shape when
// file-history is absent.
app.get("/api/claude/checkpoints", (_req, res) => {
  res.json(readCheckpoints());
});

// Fetch a single snapshot's content for preview (read-only). The snapshot is
// located by scanning the session dir for the requested hash/version, so user
// input is never joined into a filesystem path. 404 when not found.
app.get("/api/claude/checkpoints/:sessionId/content", (req, res) => {
  const { sessionId } = req.params;
  const hash = typeof req.query.hash === "string" ? req.query.hash : "";
  const versionRaw = typeof req.query.version === "string" ? req.query.version : "";
  const version = versionRaw ? parseInt(versionRaw, 10) : null;
  const snap = readSnapshot(sessionId, hash, Number.isFinite(version as number) ? version : null);
  if (!snap) {
    res.status(404).json({ error: "snapshot not found" });
    return;
  }
  res.json(snap);
});

// Hooks-coverage (US-009): the full known Claude Code hook-event set (from the
// bundled canonical schema), each marked consumed-by-Conan and wired/unwired per
// scope (user ~/.claude/settings.json + the active project's .claude/settings.json).
// Surfaces the events Conan doesn't consume yet (SubagentStart, PermissionRequest,
// …). Read-only and access-modeled like the other GET routes; safe empty-ish
// shape when schema/settings are absent.
app.get("/api/claude/hooks-coverage", (_req, res) => {
  res.json(readHooksCoverage());
});

// Per-project metrics (US-010): the last-session cost/tokens/lines/model-split
// Claude Code records under ~/.claude.json projects[<cwd>]. Accepts a ?cwd=
// param (defaults to the active cwd); unknown project / missing file degrade to
// a safe found:false shape. Read-only and access-modeled like the other GET routes.
app.get("/api/claude/project-metrics", (req, res) => {
  const cwd = typeof req.query.cwd === "string" ? req.query.cwd : undefined;
  res.json(readProjectMetrics(cwd));
});

// Installed plugins (US-011): the plugins on this machine, the marketplaces they
// came from, and which are enabled — read from ~/.claude/plugins/*.json plus the
// enabledPlugins map in settings.json. Read-only; missing files degrade to empty.
app.get("/api/claude/plugins", (_req, res) => {
  res.json(readPlugins());
});

// Custom-agents catalog (US-012): the agent definitions the user has defined,
// scanned from ~/.claude/agents/ (user scope) + the active project's
// .claude/agents/ (project scope), parsed from each manifest's frontmatter
// (SOUL.md / <name>.md). Read-only; missing dirs degrade to an empty list.
app.get("/api/claude/agents", (_req, res) => {
  res.json(readAgents());
});

// Live background agents (US-013): shells out to `claude agents --json` (bounded
// timeout) and returns the parsed live background-agent list. Token-gated — it
// spawns a process — and accepts an optional ?cwd= filter (CLI `--cwd`). A
// non-zero exit / empty list / missing binary degrade to a safe empty payload.
app.get("/api/claude/background-agents", async (req, res) => {
  if (!authed(req, res)) return;
  const cwd = typeof req.query.cwd === "string" ? req.query.cwd : undefined;
  res.json(await readBackgroundAgents({ cwd }));
});

// Prompt history (US-015): the user's Claude Code prompt history from
// ~/.claude/history.jsonl, newest-first, with optional ?q= text search,
// ?project= filter, and ?limit=/?offset= pagination. Read-only and
// access-modeled like the other GET routes; missing file → empty result.
app.get("/api/claude/prompt-history", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const project = typeof req.query.project === "string" ? req.query.project : undefined;
  const limit =
    typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  const offset =
    typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) : undefined;
  res.json(
    await readPromptHistory({
      q,
      project,
      limit: Number.isFinite(limit as number) ? limit : undefined,
      offset: Number.isFinite(offset as number) ? offset : undefined,
    }),
  );
});

// Token-gated safe write: persists ONE allowlisted preference key to
// settings.json (atomic, preserving unknown keys). Refuses unknown / risky keys
// (permissions.*, hooks, mcpServers) and rejects invalid values with a clear
// error. Never writes ~/.claude.json.
app.put("/api/claude/settings", (req, res) => {
  if (!authed(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = writeClaudeSetting(b.key, b.value);
  if (!result.ok) {
    res.status(result.status ?? 400).json({ error: result.error ?? "write failed" });
    return;
  }
  res.json({ ok: true, key: b.key, value: result.value });
});

// --- Session control plane (US-008): start / sendPrompt / stop / resume.
// All behind the same auth token as the WS layer.

app.post("/api/claude/sessions", async (req, res) => {
  if (!authed(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = startSession({
    cwd: typeof b.cwd === "string" ? b.cwd : undefined,
    model: typeof b.model === "string" ? b.model : undefined,
    permissionMode: typeof b.permission_mode === "string" ? b.permission_mode : undefined,
    bare: b.bare === true,
    prompt: typeof b.prompt === "string" ? b.prompt : undefined,
  });
  const sessionId = await awaitSessionId(result.sessionId, 3000);
  res.json({ ok: true, launchId: result.launchId, sessionId });
});

app.post("/api/claude/sessions/:id/prompt", async (req, res) => {
  if (!authed(req, res)) return;
  const text = (req.body ?? {}).text;
  if (typeof text !== "string" || text.length === 0) {
    res.status(400).json({ error: "text required" });
    return;
  }
  try {
    const result = await sendPrompt(req.params.id, text);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Answer a tool-permission prompt from the timeline (US-012). Routes the
// allow/deny choice to the live session via the stream-json control protocol.
app.post("/api/claude/sessions/:id/permission", (req, res) => {
  if (!authed(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (b.decision !== "allow" && b.decision !== "deny") {
    res.status(400).json({ error: "decision must be 'allow' or 'deny'" });
    return;
  }
  const result = decidePermission(
    req.params.id,
    typeof b.request_id === "string" ? b.request_id : null,
    {
      decision: b.decision,
      message: typeof b.message === "string" ? b.message : undefined,
    },
  );
  res.json({ ok: true, ...result });
});

app.post("/api/claude/sessions/:id/stop", (req, res) => {
  if (!authed(req, res)) return;
  const stopped = stopSession(req.params.id);
  res.json({ ok: true, stopped });
});

app.post("/api/claude/sessions/:id/resume", async (req, res) => {
  if (!authed(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = resumeSession(req.params.id, {
    model: typeof b.model === "string" ? b.model : undefined,
    permissionMode: typeof b.permission_mode === "string" ? b.permission_mode : undefined,
    prompt: typeof b.prompt === "string" ? b.prompt : undefined,
  });
  const sessionId = await awaitSessionId(result.sessionId, 3000);
  res.json({ ok: true, launchId: result.launchId, sessionId });
});

// Serve the built UI in production; in dev the Vite server runs separately.
if (fs.existsSync(UI_DIST)) {
  app.use(express.static(UI_DIST));
  app.get("*", (_req, res) => {
    res.sendFile("index.html", { root: UI_DIST });
  });
}

const server = TLS.enabled
  ? https.createServer(TLS.options!, app)
  : http.createServer(app);

// Two WS endpoints, both authenticated (token + Origin) on upgrade.
// `noServer` lets us run the auth check before accepting the socket.
const eventsWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });

eventsWss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "hello", ts: Date.now() }));
  // Send the current task snapshot immediately so the Tasks tab fills on open.
  socket.send(JSON.stringify({ type: "tasks", payload: readTasks() }));

  // Client control frames (US-018):
  //  - {type:'ping'}      -> {type:'pong'}; the client's heartbeat declares the
  //    socket dead and reconnects if a pong doesn't come back in time.
  //  - {type:'subscribe', sessions:[…]} -> ack, then replay each session's
  //    recent events so a reconnecting client re-syncs the timeline across the
  //    gap (the app WS broadcast is global, so this is purely catch-up).
  socket.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    } else if (msg.type === "subscribe") {
      const ids = Array.isArray(msg.sessions)
        ? msg.sessions.filter((x): x is string => typeof x === "string").slice(0, 20)
        : [];
      socket.send(JSON.stringify({ type: "subscribed", sessions: ids }));
      for (const id of ids) {
        // De-duped client-side by event id, so re-sending recent history is safe.
        for (const ev of listEvents(id).slice(-30)) {
          socket.send(JSON.stringify({ type: "replay", payload: ev }));
        }
      }
    }
  });
});
terminalWss.on("connection", (socket, req) => {
  attachTerminal(socket, req);
});

// Broadcast build-loop progress to all app clients whenever prd.json /
// progress.txt change (e.g. while run-tasks.sh is iterating).
function broadcast(message: unknown): void {
  const data = JSON.stringify(message);
  for (const client of eventsWss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}
const stopWatching = watchTasks((state) => broadcast({ type: "tasks", payload: state }));

// Session-liveness reaper (US-001): reconcile the session table against process
// ground truth at boot and on an interval, so the Active Sessions count reflects
// only sessions that are actually alive — not killed headless runs frozen at
// status='running'. The session grid (GET /api/claude/sessions) reads the table,
// so its reconciled status flows to the UI on the next refetch.
const stopReaper = startReaper();

// Live-stream parser-persisted events (US-007) to app clients so headless
// sessions surface in the timeline (US-011) the same way hook events do. Cost is
// folded onto the session row by the parser; usage is now framed around plan
// limits + token consumption (US-004), not a dollar ceiling.
onSessionEvent((row) => {
  broadcast({ type: "event", payload: row });
});

server.on("upgrade", (req, socket, head) => {
  const auth = verifyUpgrade(req);
  if (!auth.ok) {
    console.warn(`[conan] WS rejected: ${auth.reason}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const { pathname } = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (pathname === "/ws") {
    eventsWss.handleUpgrade(req, socket, head, (ws) =>
      eventsWss.emit("connection", ws, req),
    );
  } else if (pathname === "/ws/terminal") {
    terminalWss.handleUpgrade(req, socket, head, (ws) =>
      terminalWss.emit("connection", ws, req),
    );
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[conan] gateway listening on ${SCHEME}://${HOST}:${PORT}`);
  if (TLS.enabled) {
    console.log(
      `[conan] remote TLS mode ON (cert ${TLS.certPath}) — WebSockets served over wss://`,
    );
  }
});

function shutdown(): void {
  stopWatching();
  stopReaper();
  closeAllTerminals();
  server.close();
  eventsWss.close();
  terminalWss.close();
  closeDb();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
