import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { getDb, closeDb } from "../db/index.js";
import { AUTH_TOKEN, verifyUpgrade } from "./auth.js";
import {
  attachTerminal,
  closeAllTerminals,
  listTerminalSessions,
  injectContextRefresh,
  injectUsageRefresh,
  injectHandoff,
  autoRefreshContextOnStop,
  getContextAutoRefresh,
  setContextAutoRefresh,
} from "../terminal/index.js";
import { readTasks, watchTasks } from "../tasks/index.js";
import { pulseSeries } from "../pulse/index.js";
import { readWidgets } from "../widgets/index.js";
import { usageStatus } from "../usage/index.js";
import { getCachedPlanUtilization, maybeProbe, getCapturedUsage } from "../usage/probe.js";
import { getActiveCwd } from "../cwd/index.js";
import { listSessions, listEvents } from "../session/index.js";
import { readPlanState } from "../plan/index.js";
import { readSkills } from "../skills/index.js";
import { getMcpServers } from "../mcp/index.js";
import { readClaudeConfig, configSchema, writeConfigKey } from "../config/index.js";
import { startReaper } from "../session/reaper.js";
import { recordContextGrowth } from "../context/autorefresh.js";

const PORT = Number(process.env.CONAN_PORT ?? 3747);
// Loopback-only (v4.2 Tauri-only): the gateway serves the desktop app's sidecar
// over 127.0.0.1 and is never exposed to the network. The browser/web-served +
// TLS/remote-access path was removed — the WS auth token + Origin validation in
// auth.ts (US-002) still gate every upgrade.
const HOST = "127.0.0.1";

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

// Same-origin bootstrap: the app reads the auth token here. Cross-origin pages
// cannot read this response (no CORS headers are set), so the token stays put.
// cwd is the app-wide active working directory (US-019); it survives a restart
// so reloads see the chosen directory.
app.get("/api/config", (_req, res) => {
  res.json({ token: AUTH_TOKEN, port: PORT, cwd: getActiveCwd() });
});

// Build-loop progress (prd.json + progress.txt). Live updates arrive over /ws.
app.get("/api/tasks", (_req, res) => {
  res.json(readTasks());
});

// Live terminals + the Claude session running inside each (US-036). The Term ▾
// dropdown polls this to label tabs by session name + short id ("Conan:ca7cb3a8")
// instead of "Term N". Read-only, loopback-only like the other GET routes.
app.get("/api/terminals", (_req, res) => {
  res.json({ terminals: listTerminalSessions() });
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

/** Byte size of a value as it contributes to context (string as-is, else JSON). */
function valueBytes(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return Buffer.byteLength(v);
  try {
    return Buffer.byteLength(JSON.stringify(v));
  } catch {
    return 0;
  }
}

/**
 * Output bytes a hook payload contributes to the session's context (US-002):
 * the tool_response (the bulk of context growth) plus any assistant message
 * text the payload carries. Used to drive the adaptive /context auto-refresh.
 */
function payloadOutputBytes(payload: Record<string, unknown>): number {
  return valueBytes(payload.tool_response) + valueBytes(payload.message);
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

  // Capture Claude Code's version from the SessionStart payload (US-001 v4.4)
  // so the session header can display it (US-008). The hook forwards the whole
  // payload, and SessionStart carries `version` (e.g. "2.1.152"). COALESCE keeps
  // a known version when a later event omits it; never fabricated (null when
  // absent).
  const claudeVersion =
    payload && typeof payload.version === "string" ? payload.version : null;

  db.prepare(
    `INSERT INTO session (id, cwd, model, claude_version, status, created_at, last_activity)
       VALUES (@id, @cwd, @model, @claudeVersion, @status, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       last_activity = @now,
       status = @status,
       cwd = COALESCE(excluded.cwd, session.cwd),
       model = COALESCE(excluded.model, session.model),
       claude_version = COALESCE(excluded.claude_version, session.claude_version)`,
  ).run({
    id: sessionId,
    cwd: typeof b.cwd === "string" ? b.cwd : null,
    model,
    claudeVersion,
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

  // Feed the adaptive /context auto-refresh accumulator (US-002): tool outputs
  // are the dominant driver of context growth between turns, so we size each
  // PostToolUse's tool_response (+ any assistant message text the payload
  // carries). The Stop handler then decides — from this delta plus a time
  // floor/ceiling — whether context has likely moved enough to be worth a
  // (token-costly) /context inject, instead of refreshing on every turn.
  if (hookEvent === "PostToolUse" && payload) {
    recordContextGrowth(sessionId, payloadOutputBytes(payload));
  }

  // On turn completion, adaptively refresh the live /context capture so the
  // Context widget stays current with the exact (1M-aware) window + breakdown —
  // delta-triggered (US-002), and safe when the session has no live pty.
  if (hookEvent === "Stop") autoRefreshContextOnStop(sessionId);

  res.json({ ok: true, id: event.id });
});

// Session grid data (US-009): every persisted session, newest activity first.
// Read-only, like /api/tasks.
app.get("/api/claude/sessions", (_req, res) => {
  res.json(listSessions());
});

// Time-series throughput for the Pulse chart (US-020): events-per-minute,
// token/cost burn, and api_retry markers bucketed across all sessions over a
// configurable window (?minutes=, default 60, clamped 5..1440). Read-only; the
// chart refetches as events arrive over /ws.
app.get("/api/claude/pulse", (req, res) => {
  const raw = Number(req.query.minutes);
  const minutes = Number.isFinite(raw)
    ? Math.min(1440, Math.max(5, Math.round(raw)))
    : 60;
  res.json(pulseSeries(minutes * 60_000));
});

// Per-session Context widget data (US-022): the latest assistant turn's context
// consumption + the on-disk per-category breakdown (System/Tools/MCP/Memory/
// Skills/Messages), plus MCP servers and the session cwd's git status. Read-only.
app.get("/api/claude/sessions/:id/widgets", async (req, res) => {
  res.json(await readWidgets(req.params.id));
});

// Per-session plan-state (US-003): the active session's plan reduced from the
// hook event stream — latest-wins TodoWrite checklist + the last ExitPlanMode
// plan markdown, with a build-loop fallback. Token-gated; rehydrated from the
// persisted event table so a reconnecting client restores the current plan. The
// build loop counts as active when the tasks reader still has a failing story.
app.get("/api/claude/sessions/:id/plan", (req, res) => {
  if (!authed(req, res)) return;
  const tasks = readTasks();
  const buildLoopActive = tasks.exists && tasks.currentId !== null;
  res.json(readPlanState(req.params.id, buildLoopActive));
});

// Installed skills for the Skills HUD tab (US-005): user + project + plugin
// skills with their SKILL.md frontmatter descriptions (descriptions aren't in
// /context — they live in each SKILL.md). Token-gated, read-only. Built-in
// harness slash-commands have no on-disk SKILL.md and aren't enumerable from the
// gateway, so none are listed (the reader supports them name-only when supplied).
app.get("/api/claude/skills", (req, res) => {
  if (!authed(req, res)) return;
  res.json(readSkills(getActiveCwd()));
});

// Mirror of Claude Code's /config (US-007): the confidently-mapped settings rows
// read from ~/.claude/settings.json, <cwd>/.claude/settings.json, and the
// CLI-state ~/.claude.json — each value tagged with the file it came from
// (project > user precedence). US-002 also returns `schema`: the editable-key
// type metadata (kind + enum allowed-values extracted from the claude binary) so
// the Settings UI can render the right control per key. Token-gated.
app.get("/api/claude/config", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ ...readClaudeConfig(getActiveCwd()), schema: configSchema() });
});

// Editable Claude-config write (US-002): write a single key via read-modify-write
// to ~/.claude/settings.json (settings keys) or ~/.claude.json (global keys),
// preserving every other key. Token-gated. Rejects unknown keys and
// type-mismatched values with a 4xx; never writes a key outside the editable
// schema. Changes apply to Claude's config (may only take effect next session).
app.post("/api/claude/config", (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = writeConfigKey(body.key, body.value);
  res.status(result.status).json(result);
});

// On-demand /context refresh (US-009): inject `/context` into the session's
// correlated live pty so its rendered frame is captured passively and surfaces
// in the next widgets fetch. Token-gated (it types into a terminal). Returns
// {ok:false} when no live pty is correlated — the widget then keeps the estimate.
app.post("/api/claude/sessions/:id/context/refresh", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ ok: injectContextRefresh(req.params.id) });
});

// Adaptive /context auto-refresh toggle (US-006): the runtime-settable gate for
// autoRefreshContextOnStop, lifting the CONAN_CONTEXT_AUTOREFRESH env var to a UI
// control so the user owns the observer-effect tradeoff (Auto spends context to
// measure context). GET reads the flag; POST {enabled:boolean} sets it. The flag
// lives in gateway memory and defaults from the env var on boot, so a UI reload
// re-reads the same value. Token-gated.
app.get("/api/claude/context/autorefresh", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ enabled: getContextAutoRefresh() });
});
app.post("/api/claude/context/autorefresh", (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ ok: false, error: "`enabled` must be a boolean" });
    return;
  }
  setContextAutoRefresh(body.enabled);
  res.json({ ok: true, enabled: getContextAutoRefresh() });
});

// On-demand /usage refresh (US-010): inject `/usage` into the session's live pty
// so its rendered frame (Session block + 3 windows) is captured passively and
// surfaces in the next usage fetch. Token-gated (it types into a terminal).
// {ok:false} when no live pty is correlated — the widget keeps the probe windows.
app.post("/api/claude/sessions/:id/usage/refresh", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ ok: injectUsageRefresh(req.params.id) });
});

// Context-pressure compact (US-013): inject `/handoff` into the session's live
// pty so the conversation checkpoints itself to HANDOFF.md before a /compact.
// Conan can't author the handoff (only the session knows its own state) — it
// types the command. Token-gated (it types into a terminal). Returns {ok:false}
// when no live pty is correlated — the UI disables Compact in that case.
app.post("/api/claude/sessions/:id/handoff", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ ok: injectHandoff(req.params.id) });
});

// Usage monitor for the hero widget (US-004, was US-030): plan-usage framing for
// a token-based Claude Max plan — a rate-limited state + reset time parsed from
// recent api_retry events, plus token consumption over rolling windows (5h/7d).
// Read-only; the widget refetches as events arrive over /ws and ticks the
// countdown client-side.
//
// US-005: also surfaces planUtilization — the REAL 5-hour/7-day "% used" + reset
// times scraped from Claude Code's `/usage` TUI (the only confirmed live source;
// the ratelimit-unified headers aren't readable from outside the claude process).
// Always returns the last cached probe (or null); never blocks on a scrape. A
// token-gated `?probe=1` requests a fresh, bounded PTY probe on demand (throttled
// to once per TTL) — that's how the widget refreshes when the dashboard opens.
// US-010: also surfaces liveUsage — the EXACT Session block (cost/durations/code/
// per-model tokens) + all 3 windows captured from the active session's correlated
// pty (passive when a user runs /usage, or via POST …/usage/refresh). Source
// precedence in the widget: liveUsage → planUtilization (probe windows) → the
// token-trend baseline. Pass ?session=<id> to bind the live block to that session.
app.get("/api/claude/usage", async (req, res) => {
  const base = usageStatus();
  let planUtilization = getCachedPlanUtilization();
  if (req.query.probe === "1") {
    if (!authed(req, res)) return; // a probe spawns a process — token-gate it
    planUtilization = await maybeProbe();
  }
  const sessionId = typeof req.query.session === "string" ? req.query.session : null;
  const liveUsage = sessionId ? getCapturedUsage(sessionId) : null;
  res.json({ ...base, planUtilization, liveUsage });
});

// Configured MCP servers + live health for the HUD's MCP tab (v4.4 fix). Sourced
// from `claude mcp list` (global, health-checked) because the data is NOT in any
// hook payload — see src/mcp/index.ts. Spawns a process, so token-gate it; cached
// (30s TTL) unless `?force=1`. Returns 200 with `error` set on failure (no throw).
app.get("/api/claude/mcp", async (req, res) => {
  if (!authed(req, res)) return;
  const result = await getMcpServers(req.query.force === "1");
  res.json(result);
});

// The Tauri webview loads the bundled frontend and dev uses the Vite server
// (:5173), so the gateway is JSON-API + WebSockets only — it no longer serves
// the built UI to a browser (v4.2 Tauri-only).
const server = http.createServer(app);

// Two WS endpoints, both authenticated (token + Origin) on upgrade.
// `noServer` lets us run the auth check before accepting the socket.
const eventsWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });

eventsWss.on("connection", (socket) => {
  // ws emits 'error' on a malformed frame / abrupt reset; with no listener Node
  // rethrows and crashes the whole gateway. Swallow per-socket errors — drop
  // that one client, never the process.
  socket.on("error", () => {});
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
  socket.on("error", () => {}); // see eventsWss: never let a bad frame crash us
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

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const reject = (reason: string): void => {
    console.warn(`[conan] WS rejected: ${reason}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  };

  const auth = verifyUpgrade(req);
  if (!auth.ok) return reject(auth.reason ?? "unauthorized");
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
  console.log(`[conan] gateway listening on http://${HOST}:${PORT}`);
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

// Stdin-EOF watchdog (Tauri sidecar belt-and-suspenders, research §2). When run
// as the Tauri-spawned gateway sidecar (CONAN_SIDECAR=1), the host pipes our
// stdin; if the desktop app dies/quits without RunEvent::ExitRequested landing a
// child.kill() (observed on macOS Apple-event quit), that pipe's write end closes
// and we get EOF here. Self-terminate so :3747 frees for the next launch (the
// gateway is single-instance and refuses to start on a bound port). Gated on the
// env so interactive runs (npm start, a TTY) are unaffected.
if (process.env.CONAN_SIDECAR === "1") {
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.resume();
}
