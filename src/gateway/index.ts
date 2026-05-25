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
import { pulseSeries } from "../pulse/index.js";
import { readWidgets } from "../widgets/index.js";
import { budgetStatus, canLaunchSession } from "../budget/index.js";
import { usageStatus } from "../usage/index.js";
import { readStats } from "../stats/index.js";
import { updateBudgetSettings } from "../settings/index.js";
import {
  startSession,
  sendPrompt,
  stopSession,
  resumeSession,
  decidePermission,
  listSessions,
  listEvents,
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
app.get("/api/config", (_req, res) => {
  res.json({ token: AUTH_TOKEN, port: PORT, cwd: PACKAGE_ROOT });
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

  db.prepare(
    `INSERT INTO session (id, cwd, status, created_at, last_activity)
       VALUES (@id, @cwd, @status, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       last_activity = @now,
       status = @status,
       cwd = COALESCE(excluded.cwd, session.cwd)`,
  ).run({
    id: sessionId,
    cwd: typeof b.cwd === "string" ? b.cwd : null,
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

// Cost-ceiling status for the always-on budget guard (US-023): the configured
// per-day / per-session ceilings plus the cost recorded against them, and
// whether anything is over budget. Read-only; the widget refetches as events
// arrive over /ws (cost is folded onto sessions by the US-007 parser).
app.get("/api/claude/budget", (_req, res) => {
  res.json(budgetStatus());
});

// Usage monitor for the hero widget (US-030): cost + tokens recorded today,
// plus a rate-limited state and reset time parsed from recent api_retry events.
// Read-only; the widget refetches as events arrive over /ws and ticks the
// countdown client-side. The dashboard counterpart to run-tasks.sh's backoff.
app.get("/api/claude/usage", (_req, res) => {
  res.json(usageStatus());
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

// Update the cost ceilings (US-023). Token-gated like the other mutations.
// Accepts any subset of { daily_cost_ceiling_usd, per_session_cost_ceiling_usd,
// throttle_over_budget }; a null/0/absent ceiling means "no limit".
app.put("/api/claude/settings/budget", (req, res) => {
  if (!authed(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if ("daily_cost_ceiling_usd" in b) patch.dailyCostCeilingUsd = b.daily_cost_ceiling_usd;
  if ("per_session_cost_ceiling_usd" in b)
    patch.perSessionCostCeilingUsd = b.per_session_cost_ceiling_usd;
  if ("throttle_over_budget" in b) patch.throttleOverBudget = b.throttle_over_budget;
  const settings = updateBudgetSettings(patch);
  res.json({ ok: true, settings });
});

// --- Session control plane (US-008): start / sendPrompt / stop / resume.
// All behind the same auth token as the WS layer.

app.post("/api/claude/sessions", async (req, res) => {
  if (!authed(req, res)) return;
  // Throttling cap (US-023): refuse a new launch while over the daily ceiling
  // and throttling is enabled. No-op unless the operator opted in.
  const gate = canLaunchSession();
  if (!gate.allowed) {
    res.status(429).json({ error: "over_budget", reason: gate.reason });
    return;
  }
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
// sessions surface in the timeline (US-011) the same way hook events do. After
// each event (cost is folded onto the session row here), re-check the budget;
// when it newly crosses a ceiling, surface it on the Notification channel as a
// synthetic event so the toast fires and the budget widget refetches (US-023).
let wasOverBudget = budgetStatus().overBudget;
onSessionEvent((row) => {
  broadcast({ type: "event", payload: row });
  const status = budgetStatus();
  if (status.overBudget && !wasOverBudget) {
    broadcast({
      type: "event",
      payload: {
        id: -1,
        session_id: row.session_id,
        hook_event_name: "Notification",
        stream_type: "budget_alert",
        tool_name: status.dailyOver
          ? `Daily cost ceiling reached ($${status.costToday.toFixed(2)})`
          : `Session cost ceiling reached`,
        parent_tool_use_id: null,
        payload: JSON.stringify(status),
        ts: Date.now(),
      },
    });
  }
  wasOverBudget = status.overBudget;
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
