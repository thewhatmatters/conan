import fs from "node:fs";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { getDb, closeDb } from "../db/index.js";
import { UI_DIST, PACKAGE_ROOT } from "../paths.js";
import { AUTH_TOKEN, verifyUpgrade } from "./auth.js";
import { attachTerminal, closeAllTerminals } from "../terminal/index.js";
import { readTasks, watchTasks } from "../tasks/index.js";
import { readSkills } from "../skills/index.js";
import { readTranscript } from "../transcript/index.js";
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

const PORT = Number(process.env.CONAN_PORT ?? 3747);
// Loopback by default — network exposure is opt-in (CONAN_HOST) and still
// gated by the WS auth token + Origin validation in auth.ts (US-002).
const HOST = process.env.CONAN_HOST ?? "127.0.0.1";

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

// Every permission prompt awaiting a decision across all live sessions, for the
// cross-session pending-approvals widget (US-013). Read-only; the widget
// refetches as control_request/control_cancel events arrive over /ws. Each item
// is answered via the US-012 POST /sessions/:id/permission route.
app.get("/api/claude/permissions", (_req, res) => {
  res.json(listPendingPermissions());
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

const server = http.createServer(app);

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

// Live-stream parser-persisted events (US-007) to app clients so headless
// sessions surface in the timeline (US-011) the same way hook events do.
onSessionEvent((row) => broadcast({ type: "event", payload: row }));

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
  console.log(`[conan] gateway listening on http://${HOST}:${PORT}`);
});

function shutdown(): void {
  stopWatching();
  closeAllTerminals();
  server.close();
  eventsWss.close();
  terminalWss.close();
  closeDb();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
