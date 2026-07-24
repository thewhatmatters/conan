import http from "node:http";
import fs from "node:fs";
import { execFile } from "node:child_process";
import express from "express";
import { WebSocketServer } from "ws";
import { getDb, closeDb } from "../db/index.js";
import { AUTH_TOKEN, isAllowedOrigin, verifyUpgrade } from "./auth.js";
import {
  attachTerminal,
  closeAllTerminals,
  listTerminalSessions,
  injectContextRefresh,
  injectHandoff,
  autoRefreshContextOnStop,
  getContextAutoRefresh,
  setContextAutoRefresh,
  setUsageCapturedListener,
  setTerminalCwdListener,
  sampleCorrelationHealth,
} from "../terminal/index.js";
import { isCorrelationDegraded } from "../terminal/health.js";
import { readTasks, watchTasks } from "../tasks/index.js";
import { pulseSeries } from "../pulse/index.js";
import { readWidgets, gitStatus } from "../widgets/index.js";
import { usageStatus } from "../usage/index.js";
import {
  getCachedPlanUtilization,
  maybeProbe,
  getCapturedUsage,
  getGlobalUsageWindows,
  getLastProbeError,
} from "../usage/probe.js";
import { startOAuthUsagePoller, getOAuthPlanUtilization } from "../usage/oauthUsage.js";
import { getActiveCwd, onCwdChange, listEntries, searchFiles } from "../cwd/index.js";
import { listSessions, listEvents } from "../session/index.js";
import { readPlanState } from "../plan/index.js";
import { readSkills } from "../skills/index.js";
import { readCommands } from "../commands/index.js";
import { readAgents } from "../agents/index.js";
import { scoreSkills, topMatches, CONSIDERATION_TOP_N } from "../skills/match.js";
import {
  ensureSkillFiredWatcher,
  readSessionSkillFirings,
  scanRecentSkillFirings,
  stopAllSkillFiredWatchers,
  type SkillFiredRecord,
  type PlanRecord,
} from "../timeline/transcriptScan.js";
import { getMcpServers } from "../mcp/index.js";
import { startMcpAuth, reconnectMcp } from "../mcp/auth.js";
import { readClaudeConfig, configSchema, writeConfigKey } from "../config/index.js";
import { readUserThemes } from "../themes/index.js";
import { startReaper } from "../session/reaper.js";
import { recordContextGrowth } from "../context/autorefresh.js";
import { readTimeline, parseTouchedFiles } from "../timeline/index.js";
import { readAssistantTurnUsages, deriveSessionUsage } from "../transcript/index.js";
import { installBundledPlugins } from "../plugins/install.js";
import {
  getRadio,
  getStations,
  refreshClaudeFmDefault,
  setRadio,
} from "../radio/index.js";
import { detectClaude } from "../doctor/claude.js";
import { globalHooksStatus, installGlobalHooks } from "../hooks/install.js";
import { radioEmbedHtml, sanitizeEmbedVideoId } from "../radio/embed.js";
import { readLicense, writeLicense, deleteLicense } from "../license/index.js";
import { attachAgent, closeAllAgents } from "../agent/index.js";
import { listProviderStatuses } from "../agent/registry.js";
import {
  listChatProjects,
  upsertChatProject,
  deleteChatThread,
  getChatThread,
} from "../agent/threads.js";
import { readChatHistory } from "../agent/history.js";
import { detectEditors, openInEditor } from "../editor/index.js";
import { commitAll, createPullRequest, pushCurrentBranch } from "../git/index.js";
import {
  addProjectAction,
  deleteProjectAction,
  listProjectActions,
  runProjectAction,
  updateProjectAction,
} from "../actions/index.js";

const PORT = Number(process.env.CONAN_PORT ?? 3747);
// US-007: optional runtime override for the Buy Premium checkout URL the
// Settings ▸ License button opens. When unset, `buyUrl` is null and the UI
// falls back to its bundled Polar checkout link (BUY_PREMIUM_URL in
// SettingsView.tsx) — a non-null default here would shadow that link for
// every user, which is exactly the bug that shipped in 1.0.3.
const BUY_URL = process.env.CONAN_BUY_URL || null;
// Loopback-only (v4.2 Tauri-only): the gateway serves the desktop app's sidecar
// over 127.0.0.1 and is never exposed to the network. The browser/web-served +
// TLS/remote-access path was removed — the WS auth token + Origin validation in
// auth.ts (US-002) still gate every upgrade.
const HOST = "127.0.0.1";

const app = express();

// CORS reflector (v4.6 hotfix) — modern WKWebView treats the bundled-app
// fetch from `tauri://localhost` to `http://127.0.0.1:3747` as a cross-origin
// request and requires `Access-Control-Allow-Origin` on the response. Without
// it, /api/config returns 200 with the token but the webview rejects the body
// before App.tsx sees it, leaving the UI stuck on "connecting…". We reflect
// the Origin **only when allow-listed** (same set the WS upgrade checks via
// auth.ts's `isAllowedOrigin`) so a rogue cross-origin page still can't read
// the token. `Vary: Origin` prevents caches from leaking the per-origin header.
app.use((req, res, next) => {
  const origin = req.header("origin");
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, x-conan-token",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

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
  res.json({ token: AUTH_TOKEN, port: PORT, cwd: getActiveCwd(), buyUrl: BUY_URL });
});

// Build-loop progress (prd.json + progress.txt). Live updates arrive over /ws.
app.get("/api/tasks", (_req, res) => {
  res.json(readTasks());
});

// Live terminals + the Claude session running inside each (US-036). The Term ▾
// dropdown polls this to label tabs by session name + short id ("Conan:ca7cb3a8")
// instead of "Term N". Read-only, loopback-only like the other GET routes.
// correlationDegraded (1.0.2 US-004) flags when a terminal hosting a live
// claude has had no session correlation for >60s while sessions are running —
// the regression shape the 2.1.173 marker break took. False when healthy.
app.get("/api/terminals", (_req, res) => {
  res.json({
    terminals: listTerminalSessions(),
    correlationDegraded: isCorrelationDegraded(),
  });
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

// ── External editor launch ─────────────────────────────────────────────────
// Detection uses the user's interactive-login-shell PATH, since a packaged
// macOS app inherits a stripped PATH. Both routes sit behind the shared token
// check and the global CORS reflector above.
app.get("/api/editor/detect", async (req, res) => {
  if (!authed(req, res)) return;
  try {
    res.json({ editors: await detectEditors() });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/editor/open", async (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as { path?: unknown; editor?: unknown };
  if (typeof body.path !== "string" || !body.path.trim()) {
    res.status(400).json({ error: "path required" });
    return;
  }
  if (body.editor !== undefined && typeof body.editor !== "string") {
    res.status(400).json({ error: "editor must be a string" });
    return;
  }
  try {
    const result = await openInEditor(
      body.path.trim(),
      typeof body.editor === "string" ? body.editor : undefined,
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    const message = (error as Error).message;
    const status = message.startsWith("no such path") ? 404 : 400;
    res.status(status).json({ ok: false, error: message });
  }
});

// ── File Explorer (per-tab) ────────────────────────────────────────────────
// Read-only filesystem surface for the File Explorer panel. Token-gated; the
// CORS reflector + loopback bind apply globally. These let the panel browse the
// active terminal tab's cwd and highlight what Claude touched this session.

// Immediate contents (files + dirs) of a directory; unreadable paths degrade to
// an empty listing with an `error` (listEntries never throws).
app.get("/api/fs/list", (req, res) => {
  if (!authed(req, res)) return;
  const p = req.query.path;
  if (typeof p !== "string" || !p.trim()) {
    res.status(400).json({ error: "path required" });
    return;
  }
  res.json(listEntries(p));
});

// Bounded recursive file/folder search under a root (US-018) — powers the
// composer's `@` autocomplete, scoped to the thread's cwd. /api/fs/list is
// single-level; this walks breadth-first with hard depth/dir/result caps so
// a huge tree can't hang the request. Empty `q` returns the shallowest
// entries (the browse-from-@ case).
app.get("/api/fs/search", (req, res) => {
  if (!authed(req, res)) return;
  const p = req.query.path;
  if (typeof p !== "string" || !p.trim()) {
    res.status(400).json({ error: "path required" });
    return;
  }
  const q = req.query.q;
  res.json(searchFiles(p, typeof q === "string" ? q : ""));
});

// Git branch + dirty count for an arbitrary directory (US-011) — powers the
// chat surface's StatusBar, which follows the active thread's cwd rather than
// a correlated session. Degrades to {available:false} for non-repo paths.
app.get("/api/fs/git", (req, res) => {
  if (!authed(req, res)) return;
  const p = req.query.path;
  if (typeof p !== "string" || !p.trim()) {
    res.status(400).json({ error: "path required" });
    return;
  }
  gitStatus(p).then((g) => res.json(g));
});

// The files Claude Edited/Wrote/Read in a session, parsed from the persisted
// hook events' tool_input.file_path — powers the per-entry "Claude touched
// this" badges. A path that was both read and edited counts as edited.
app.get("/api/fs/touched", (req, res) => {
  if (!authed(req, res)) return;
  const session = req.query.session;
  if (typeof session !== "string" || !session) {
    res.status(400).json({ error: "session required" });
    return;
  }
  const rows = db
    .prepare(
      `SELECT tool_name, payload FROM event
         WHERE session_id = ? AND tool_name IN ('Edit', 'Write', 'Read')`,
    )
    .all(session) as { tool_name: string | null; payload: string | null }[];
  res.json(parseTouchedFiles(rows));
});

// Reveal a path in Finder (macOS `open -R`). Existence-checked; args passed as
// an array via execFile (no shell) so there's no injection surface.
app.post("/api/fs/reveal", (req, res) => {
  if (!authed(req, res)) return;
  const p = (req.body as { path?: unknown })?.path;
  if (typeof p !== "string" || !p.trim()) {
    res.status(400).json({ error: "path required" });
    return;
  }
  if (!fs.existsSync(p)) {
    res.status(404).json({ error: `no such path: ${p}` });
    return;
  }
  execFile("open", ["-R", p], (err) => {
    if (err) console.warn(`[fs] reveal failed for ${p}: ${err.message}`);
  });
  res.json({ ok: true });
});

// ── Git toolbar actions ───────────────────────────────────────────────────
// Mutating git operations for the chat toolbar. Status stays on GET
// /api/fs/git; these routes only perform commit/push/PR side effects.
app.post("/api/agent/git/commit", async (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as { cwd?: unknown; message?: unknown };
  if (typeof body.cwd !== "string" || !body.cwd.trim()) {
    res.status(400).json({ ok: false, error: "cwd required" });
    return;
  }
  if (typeof body.message !== "string" || !body.message.trim()) {
    res.status(400).json({ ok: false, error: "message required" });
    return;
  }
  res.json(await commitAll(body.cwd.trim(), body.message));
});

app.post("/api/agent/git/push", async (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as { cwd?: unknown };
  if (typeof body.cwd !== "string" || !body.cwd.trim()) {
    res.status(400).json({ ok: false, error: "cwd required" });
    return;
  }
  res.json(await pushCurrentBranch(body.cwd.trim()));
});

app.post("/api/agent/git/pr", async (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as {
    cwd?: unknown;
    title?: unknown;
    body?: unknown;
  };
  if (typeof body.cwd !== "string" || !body.cwd.trim()) {
    res.status(400).json({ ok: false, error: "cwd required" });
    return;
  }
  if (typeof body.title !== "string" || !body.title.trim()) {
    res.status(400).json({ ok: false, error: "title required" });
    return;
  }
  res.json(
    await createPullRequest(
      body.cwd.trim(),
      body.title,
      typeof body.body === "string" ? body.body : "",
    ),
  );
});

// ── Chat persistence (US-014) ──────────────────────────────────────────────
// The sidebar's projects + threads, backed by the US-013 tables. Token-gated;
// the global CORS reflector + loopback bind cover WKWebView like every route.

// Which agent CLIs are installed (T3-1 US-003) — the composer's provider chip.
// Probes the login-shell PATH (packaged-app gotcha), cached with a TTL; an
// uninstalled provider is a plain installed:false, never an error.
app.get("/api/agent/providers", async (req, res) => {
  if (!authed(req, res)) return;
  res.json({ providers: await listProviderStatuses() });
});

// Projects with their threads, newest activity first — the sidebar's source of
// truth across reloads and gateway restarts.
app.get("/api/agent/projects", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ projects: listChatProjects() });
});

// Upsert a project by path (US-025's add-project flow). The same folder twice
// returns the one existing row, so ids stay stable for the sidebar.
app.post("/api/agent/projects", (req, res) => {
  if (!authed(req, res)) return;
  const b = (req.body ?? {}) as { path?: unknown; name?: unknown };
  if (typeof b.path !== "string" || !b.path.trim()) {
    res.status(400).json({ error: "path required" });
    return;
  }
  const dir = b.path.trim();
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    res.status(400).json({ error: `not a directory: ${dir}` });
    return;
  }
  res.json(upsertChatProject(dir, typeof b.name === "string" ? b.name : undefined));
});

app.get("/api/agent/projects/:id/actions", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ actions: listProjectActions(req.params.id) });
});

app.post("/api/agent/projects/:id/actions", (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as { name?: unknown; command?: unknown; kind?: unknown };
  const result = addProjectAction({
    projectId: req.params.id,
    name: typeof body.name === "string" ? body.name : "",
    command: typeof body.command === "string" ? body.command : "",
    kind: body.kind === "prompt" ? "prompt" : "shell",
  });
  if ("error" in result) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, action: result });
});

app.put("/api/agent/projects/:id/actions/:actionId", (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as { name?: unknown; command?: unknown; kind?: unknown };
  const result = updateProjectAction(req.params.id, req.params.actionId, {
    name: typeof body.name === "string" ? body.name : "",
    command: typeof body.command === "string" ? body.command : "",
    kind: body.kind === "prompt" ? "prompt" : body.kind === "shell" ? "shell" : undefined,
  });
  if ("error" in result) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, action: result });
});

app.delete("/api/agent/projects/:id/actions/:actionId", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ deleted: deleteProjectAction(req.params.id, req.params.actionId) });
});

app.post("/api/agent/projects/:id/actions/:actionId/run", async (req, res) => {
  if (!authed(req, res)) return;
  res.json(await runProjectAction(req.params.id, req.params.actionId));
});

// Close-X on a thread row: the row goes away; its project persists.
app.delete("/api/agent/threads/:sessionId", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ deleted: deleteChatThread(req.params.sessionId) });
});

// Reopen a saved thread (US-015): reconstruct its transcript from Claude
// Code's own JSONL session record. `found:false` (JSONL gone — trashed, or
// another machine) degrades the UI to metadata-only; a new turn still works.
app.get("/api/agent/threads/:sessionId/transcript", (req, res) => {
  if (!authed(req, res)) return;
  const row = getChatThread(req.params.sessionId);
  res.json(readChatHistory(req.params.sessionId, row?.cwd));
});

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

  // The hook reports the pid of the claude process that fired it (US-002
  // v1.0.2) for marker-independent pty↔session correlation. COALESCE keeps the
  // last known pid when an event omits it.
  const claudePid =
    typeof b.claudePid === "number" && Number.isInteger(b.claudePid) && b.claudePid > 0
      ? b.claudePid
      : null;

  db.prepare(
    `INSERT INTO session (id, cwd, model, claude_version, claude_pid, status, created_at, last_activity)
       VALUES (@id, @cwd, @model, @claudeVersion, @claudePid, @status, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       last_activity = @now,
       status = @status,
       cwd = COALESCE(excluded.cwd, session.cwd),
       model = COALESCE(excluded.model, session.model),
       claude_version = COALESCE(excluded.claude_version, session.claude_version),
       claude_pid = COALESCE(excluded.claude_pid, session.claude_pid)`,
  ).run({
    id: sessionId,
    cwd: typeof b.cwd === "string" ? b.cwd : null,
    model,
    claudeVersion,
    claudePid,
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

  const event: {
    id: number;
    session_id: string;
    parent_tool_use_id: string | null;
    hook_event_name: string | null;
    stream_type: string;
    tool_name: string | null;
    payload: string;
    ts: number;
    /** Per-turn token total for Stop events — same enrichment the Timeline's
     *  REST backfill applies, mirrored here so live STOP rows arriving over
     *  WS render the `+Nk` badge without needing a refetch. */
    tokens?: number;
  } = {
    id: Number(info.lastInsertRowid),
    session_id: sessionId,
    parent_tool_use_id: typeof b.parent_tool_use_id === "string" ? b.parent_tool_use_id : null,
    hook_event_name: hookEvent,
    stream_type: "hook",
    tool_name: typeof b.tool_name === "string" ? b.tool_name : null,
    payload: JSON.stringify(b.payload ?? b),
    ts: now,
  };
  // On Stop, pull the just-ended turn's usage from the JSONL transcript. The
  // assistant message + its usage block lands in the transcript before the
  // Stop hook fires, so the last entry is the right one to attach. Empty/null
  // when the transcript isn't readable — UI just omits the badge in that case.
  if (hookEvent === "Stop") {
    const usages = readAssistantTurnUsages(
      sessionId,
      typeof b.cwd === "string" ? b.cwd : null,
    );
    const last = usages[usages.length - 1];
    if (last) event.tokens = last.totalTokens;
  }
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

  // US-002 (v4.5): idempotently start a tail of the session's JSONL so each new
  // Skill tool_use broadcasts as a `{type:'skill-fired'}` row over /ws (kept
  // SEPARATE from {type:'event'} so existing consumers don't have to parse the
  // new kind). Prefer the transcript_path the hook payload carries; fall back
  // to resolving by cwd via transcriptPath() when missing.
  const transcriptPathHint =
    payload && typeof payload.transcript_path === "string"
      ? payload.transcript_path
      : null;
  const sessionCwdForScan =
    (typeof b.cwd === "string" ? b.cwd : null) ?? null;
  ensureSkillFiredWatcher(
    sessionId,
    {
      transcriptPath: transcriptPathHint,
      cwd: sessionCwdForScan,
    },
    (record) => emitSkillFired(sessionId, record),
    // US-006 (v4.5): also broadcast TodoWrite + ExitPlanMode blocks as
    // `{type:'plan'}` envelopes — separate from `{type:'event'}`,
    // `{type:'skill-fired'}`, and `{type:'skill-considered'}` so consumers can
    // subscribe granularly.
    (record) => emitPlan(sessionId, record),
  );

  // US-003 (v4.5): on a new prompt, heuristically score every installed skill
  // against the prompt text + persist the top N into prompt_consideration.
  // Broadcast each as a `{type:'skill-considered'}` envelope (separate kind
  // from {type:'event'} so existing consumers don't have to parse it). Honest
  // by construction — labelled as a heuristic in the UI (US-004), never as
  // Claude's real internal scoring.
  if (hookEvent === "UserPromptSubmit" && payload) {
    const promptText =
      typeof payload.prompt === "string" ? payload.prompt : "";
    if (promptText) {
      considerSkillsForPrompt(sessionId, event.id, now, promptText);
    }
  }

  // US-003 (v4.5): at turn end, reconcile prompt_consideration for the latest
  // prompt: any considered skill whose name shows up in the transcript JSONL
  // slice since the prompt is flipped to fired=1 + a fired reason. The
  // skill-fired broadcast itself comes from US-002's live watcher; this step
  // keeps the persisted state honest for backfill (timeline reads).
  if (hookEvent === "Stop") {
    reconcileFiredForLatestPrompt(sessionId, sessionCwdForScan);
  }

  res.json({ ok: true, id: event.id });
});

/**
 * Score every installed skill against the prompt text, persist the top N rows
 * into prompt_consideration keyed by the prompt's event id, and broadcast each
 * as a `{type:'skill-considered'}` envelope. The active cwd's project skills
 * are included (Claude considers them in this run too) — this mirrors what the
 * routing layer actually has visibility into.
 */
function considerSkillsForPrompt(
  sessionId: string,
  promptEventId: number,
  promptTs: number,
  promptText: string,
): void {
  const skills = readSkills(getActiveCwd());
  if (skills.length === 0) return;
  const scored = scoreSkills(promptText, skills);
  const top = topMatches(scored, CONSIDERATION_TOP_N);
  if (top.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO prompt_consideration
       (event_id, skill, score, reason, fired, created_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(event_id, skill) DO UPDATE SET
       score = excluded.score,
       reason = excluded.reason,
       created_at = excluded.created_at`,
  );
  const persist = db.transaction((rows: typeof top) => {
    for (const r of rows) {
      insert.run(promptEventId, r.skill, r.score, r.reason, promptTs);
    }
  });
  persist(top);

  for (const r of top) {
    broadcast({
      type: "skill-considered",
      sessionId,
      payload: {
        kind: "skill-considered",
        ts: promptTs,
        eventId: promptEventId,
        skill: r.skill,
        promptEventId,
        reason: r.reason,
        heuristic: true,
      },
    });
  }
}

/**
 * Stop-time reconciliation: find the latest UserPromptSubmit event for the
 * session, read the transcript JSONL for any Skill tool_use blocks whose ts
 * lands after that prompt, and UPDATE prompt_consideration SET fired=1 +
 * reason='<fired_reason>' WHERE event_id=<prompt> AND skill IN (<fired set>).
 * Best-effort: a session with no transcript / no preceding prompt / no fired
 * skills is a no-op. The matching rows' kind in subsequent timeline reads
 * flips from skill-considered to skill-fired (Timeline excludes fired=1 rows).
 */
function reconcileFiredForLatestPrompt(
  sessionId: string,
  cwd: string | null,
): void {
  const latestPrompt = db
    .prepare(
      `SELECT id, ts FROM event
        WHERE session_id = ?
          AND stream_type = 'hook'
          AND hook_event_name = 'UserPromptSubmit'
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionId) as { id: number; ts: number } | undefined;
  if (!latestPrompt) return;

  const firings = readSessionSkillFirings(sessionId, cwd);
  if (firings.length === 0) return;
  const firedSinceLatest = firings.filter((f) => f.ts > latestPrompt.ts);
  if (firedSinceLatest.length === 0) return;
  const firedSet = new Set(firedSinceLatest.map((f) => f.skill));
  if (firedSet.size === 0) return;

  const update = db.prepare(
    `UPDATE prompt_consideration
        SET fired = 1, reason = ?
      WHERE event_id = ? AND skill = ?`,
  );
  const apply = db.transaction((skillNames: string[]) => {
    for (const name of skillNames) {
      update.run("fired (matched transcript tool_use)", latestPrompt.id, name);
    }
  });
  apply(Array.from(firedSet));
}

/**
 * Resolve the latest UserPromptSubmit event id whose ts < the firing's ts,
 * scoped to this session. Used to link a skill-fired broadcast back to the
 * prompt that triggered it; null when no preceding prompt exists.
 */
function latestPromptEventIdBefore(
  sessionId: string,
  ts: number,
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM event
        WHERE session_id = ?
          AND stream_type = 'hook'
          AND hook_event_name = 'UserPromptSubmit'
          AND ts < ?
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionId, ts) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Broadcast one new Skill firing over the app WS as a TimelineRow envelope.
 * Kept separate from `{type:'event'}` so existing consumers don't have to parse
 * the new kind (US-002 acceptance).
 */
function emitSkillFired(sessionId: string, record: SkillFiredRecord): void {
  const promptEventId = latestPromptEventIdBefore(sessionId, record.ts);
  broadcast({
    type: "skill-fired",
    sessionId,
    payload: {
      kind: "skill-fired",
      ts: record.ts,
      skill: record.skill,
      ...(promptEventId !== null ? { promptEventId } : {}),
      detail: `Skill: ${record.skill}`,
    },
  });
}

/**
 * Broadcast one new Plan record (TodoWrite or ExitPlanMode) over the app WS as
 * a TimelineRow envelope (US-006). promptEventId is resolved the same way as
 * the skill-fired path — latest UserPromptSubmit for this session before the
 * block's ts. Kept on its own `{type:'plan'}` channel so existing
 * {type:'event'}/{type:'skill-fired'}/{type:'skill-considered'} consumers don't
 * have to parse the new kind.
 */
function emitPlan(sessionId: string, record: PlanRecord): void {
  const promptEventId = latestPromptEventIdBefore(sessionId, record.ts);
  const idFields =
    promptEventId !== null ? { eventId: promptEventId, promptEventId } : {};
  const payload =
    record.subtype === "todo-write"
      ? {
          kind: "plan" as const,
          ts: record.ts,
          subtype: "todo-write" as const,
          ...idFields,
          items: record.items,
        }
      : {
          kind: "plan" as const,
          ts: record.ts,
          subtype: "plan-mode" as const,
          ...idFields,
          plan: record.plan,
        };
  broadcast({ type: "plan", sessionId, payload });
}

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
  // US-002 (v4.5): enrich each entry with `lastFiredAt` from a bounded scan of
  // recent transcripts. The skill name in `input.skill` is matched against the
  // installed skill name (frontmatter or dir basename) — never fabricated; null
  // when no firing was found in the scan window.
  const skills = readSkills(getActiveCwd());
  const fired = scanRecentSkillFirings();
  const enriched = skills.map((s) => ({
    ...s,
    lastFiredAt: fired.get(s.name) ?? null,
  }));
  res.json(enriched);
});

// Slash commands for the composer's `/` autocomplete (US-020): custom command
// files (user ~/.claude/commands + project <cwd>/.claude/commands, cwd from the
// query so each thread scopes to ITS project) plus the empirically-verified
// headless-safe built-in subset (see src/commands/index.ts — most built-ins are
// TUI-only and excluded). Token-gated, read-only.
app.get("/api/claude/commands", (req, res) => {
  if (!authed(req, res)) return;
  const cwd = req.query.cwd;
  res.json(readCommands(typeof cwd === "string" && cwd.trim() ? cwd : getActiveCwd()));
});

// Installed agents for the Agents HUD tab: user + project + plugin subagent
// `.md` files with their frontmatter descriptions. Token-gated, read-only, no
// firing enrichment — agent definitions are static files.
app.get("/api/claude/agents", (req, res) => {
  if (!authed(req, res)) return;
  res.json(readAgents(getActiveCwd()));
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

// Premium license (US-101): pure persistence of the user's saved JWT to the
// data dir's `license.jwt`. All verification happens in the UI against the
// bundled Ed25519 public key (ui/src/lib/license.ts) — keeping the gateway
// agnostic of license claims means a future key rotation only touches the
// UI build. Token-gated. Absence of the file = Free tier.
app.get("/api/license", (req, res) => {
  if (!authed(req, res)) return;
  res.json(readLicense());
});
app.put("/api/license", (req, res) => {
  if (!authed(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const jwt = typeof body.jwt === "string" ? body.jwt : null;
  if (!jwt) {
    res.status(400).json({ error: "missing jwt in body" });
    return;
  }
  try {
    res.json(writeLicense(jwt));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.delete("/api/license", (req, res) => {
  if (!authed(req, res)) return;
  res.json(deleteLicense());
});

// User themes (US-022): the validated palettes from ~/.conan/themes.json (or
// themes/*.json), CONAN_DATA_DIR-aware. The UI's useThemes hook merges these
// over the bundled built-ins by id. Each entry is strictly validated (known
// token keys + clean color literals only — see src/themes/index.ts) so a value
// can never inject raw CSS into the <html> custom properties. Token-gated; a
// missing/malformed file yields [] (never throws). Read-only.
app.get("/api/claude/themes", (req, res) => {
  if (!authed(req, res)) return;
  res.json(readUserThemes());
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
// measure context). OFF by default since 1.2.0 — env var "1" or the UI toggle
// opts in. GET reads the flag; POST {enabled:boolean} sets it. The flag lives
// in gateway memory and defaults from the env var on boot, so a UI reload
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
// per-model tokens) + all 3 windows, transcript-derived (deriveSessionUsage)
// with windows from the account-global slot (US-007: OAuth poller preferred,
// pty-capture fallback — see usageWindows below). Source precedence in the
// widget: liveUsage → planUtilization (probe windows) → the token-trend
// baseline. Pass ?session=<id> to bind the live block to that session.
// US-008: usageSource ("oauth" | "pty-probe" | null) tags which path produced
// planUtilization/usageWindows, so the UI can badge freshness instead of
// rendering two data sources — one passive/~60s, one throttled/5min — as
// visually identical.
app.get("/api/claude/usage", async (req, res) => {
  const base = usageStatus();
  let planUtilization = getCachedPlanUtilization();
  if (req.query.probe === "1") {
    if (!authed(req, res)) return; // a probe spawns a process — token-gate it
    planUtilization = await maybeProbe();
  }
  // US-004: on macOS, prefer the passive OAuth-endpoint poller's latest
  // PlanUtilization over the pty-probe result when it has data — no pty
  // spawn needed. Falls back to the pty-probe result above untouched when
  // the OAuth path hasn't produced a usable snapshot yet (Keychain read
  // failed, endpoint call failed, or no window came back non-null).
  const oauthPlanUtilization = getOAuthPlanUtilization();
  if (oauthPlanUtilization) {
    planUtilization = oauthPlanUtilization;
  }
  // US-008: tag which path produced the rate-limit windows so the UI can show
  // an "oauth" vs "pty fallback" badge instead of two indistinguishable-
  // looking data sources with very different freshness/cost characteristics.
  const usageSource: "oauth" | "pty-probe" | null = oauthPlanUtilization
    ? "oauth"
    : planUtilization
      ? "pty-probe"
      : null;
  const sessionId = typeof req.query.session === "string" ? req.query.session : null;
  const captured = sessionId ? getCapturedUsage(sessionId) : null;
  // US-006: the rate-limit windows are account-global — serve the single
  // global slot (latest capture from ANY session's pty or the probe) to every
  // requesting session; only the Session block below stays per-session. The
  // slot carries capturedAt + fromSessionId so the UI can render freshness.
  // US-007: prefer the OAuth poller's windows here too (same precedence as
  // planUtilization above) — the per-session Session block used to only ever
  // see pty-captured windows, so it stayed stale until someone ran /usage.
  const usageWindows = oauthPlanUtilization
    ? {
        fiveHour: oauthPlanUtilization.fiveHour,
        sevenDay: oauthPlanUtilization.sevenDay,
        sevenDaySonnet: oauthPlanUtilization.sevenDaySonnet,
        status: oauthPlanUtilization.status,
        capturedAt: oauthPlanUtilization.probedAt,
        fromSessionId: null,
      }
    : getGlobalUsageWindows();
  // Prefer derived-from-transcript Session block when available — it's
  // always fresh (the transcript writes after every assistant turn), so
  // the HUD refresh no longer needs to pop the /usage modal in the live
  // pty just to capture data we already have on disk. Fall back to the
  // captured frame for sessions whose transcript isn't readable (rare).
  let liveUsage = captured;
  if (liveUsage && usageWindows) {
    liveUsage = {
      ...liveUsage,
      fiveHour: usageWindows.fiveHour,
      sevenDay: usageWindows.sevenDay,
      sevenDaySonnet: usageWindows.sevenDaySonnet,
      status: usageWindows.status,
    };
  }
  if (sessionId) {
    const row = getDb()
      .prepare("SELECT cwd FROM session WHERE id = ?")
      .get(sessionId) as { cwd?: string } | undefined;
    const derived = deriveSessionUsage(sessionId, row?.cwd ?? null);
    if (derived) {
      liveUsage = {
        // Windows from the account-global slot (US-006) — any session's
        // capture serves every tab; null stand-ins only before first capture.
        fiveHour: usageWindows?.fiveHour ?? null,
        sevenDay: usageWindows?.sevenDay ?? null,
        sevenDaySonnet: usageWindows?.sevenDaySonnet ?? null,
        status: usageWindows?.status ?? "ok",
        insights: captured?.insights ?? [],
        skills: captured?.skills ?? [],
        capturedAt: Date.now(),
        session: {
          totalCostUsd: derived.totalCostUsd,
          apiDurationMs: derived.apiDurationMs,
          wallDurationMs: derived.wallDurationMs,
          linesAdded: derived.linesAdded,
          linesRemoved: derived.linesRemoved,
          byModel: derived.byModel,
        },
      };
    }
  }
  // US-005 (1.0.2): when the most recent probe attempt failed (and nothing
  // fresher has landed since), say WHY instead of a silent planUtilization:
  // null. The last good cache above is never clobbered by a failed probe.
  res.json({
    ...base,
    planUtilization,
    liveUsage,
    usageWindows,
    usageSource,
    probeError: getLastProbeError(),
  });
});

// Per-session Timeline feed (US-001 v4.5): the chronological log the Timeline
// split panel backfills from on mount. Returns hook rows (from the persisted
// `event` table, mapped to short titles by hook_event_name) merged with
// build-loop activity rows (from progress.txt, when the session's cwd matches
// the active project). Descending by ts. `since` filters strictly greater than;
// `limit` clamps to [1, 500] (default 200). Skill rows (skill-fired /
// skill-considered) are part of the envelope contract but US-002/US-003 wire up
// the actual data. Token-gated.
app.get("/api/claude/timeline", (req, res) => {
  if (!authed(req, res)) return;
  const session = typeof req.query.session === "string" ? req.query.session : null;
  const sinceRaw = Number(req.query.since);
  const since = Number.isFinite(sinceRaw) ? sinceRaw : undefined;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
  res.json(readTimeline(session, { since, limit }));
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

// MCP one-click Authenticate (US-013). Starts the throwaway-pty auth driver
// (US-011) + completion poll (US-012) for the named server as one fire-and-forget
// flight and returns its in-flight state. Token-gated (it spawns a process and
// drives the /mcp TUI). A second authenticate while one is already pending for
// the same server is debounced — 409 with the live flight state, no second pty.
app.post("/api/claude/mcp/:name/authenticate", (req, res) => {
  if (!authed(req, res)) return;
  const result = startMcpAuth(req.params.name);
  res.status(result.started ? 200 : 409).json(result.state);
});

// MCP Reconnect (US-013). Forces a re-health-check (re-dials the server),
// escalating to the authenticate flow ONLY when the refreshed status is
// auth-shaped (needs-authentication). A plain `failed` server just returns its
// refreshed status — reconnect can't fix a down server. Token-gated; an
// escalation that hits an already-pending auth is debounced (409).
app.post("/api/claude/mcp/:name/reconnect", async (req, res) => {
  if (!authed(req, res)) return;
  const result = await reconnectMcp(req.params.name);
  res.status(result.escalated && result.alreadyInFlight ? 409 : 200).json(result);
});

// Claude Code install detection (the "doctor"). Probes the user's PATH via
// an interactive login shell — same env the pty would launch into — so we
// don't false-positive "not installed" when the Finder-launched .app has a
// stripped env. Cached 10min in src/doctor/claude.ts; cheap to call. Token-
// gated like the rest of the control plane.
app.get("/api/claude/doctor", async (req, res) => {
  if (!authed(req, res)) return;
  res.json(await detectClaude());
});

// Global-hook status (US-023). Reports whether ~/.claude/settings.json (or
// CONAN_GLOBAL_SETTINGS) forwards every observed lifecycle event to Conan's
// send-event.mjs — the onboarding hard-gate reads this, since the activity
// spine/skills need hooks and the chat-primary shell has no terminal fallback.
// Pure read (dry-run merge), token-gated like the rest of the control plane.
app.get("/api/claude/hooks", (req, res) => {
  if (!authed(req, res)) return;
  res.json(globalHooksStatus());
});

// One-click "Set up observability" (US-023): idempotently merges Conan's
// forwarder into the user-level settings via installGlobalHooks (backs up the
// file once, preserves foreign hooks/keys). Token-gated — it writes to the
// user's home directory.
app.post("/api/claude/hooks/install", (req, res) => {
  if (!authed(req, res)) return;
  try {
    const result = installGlobalHooks();
    res.json({ ...result, status: globalHooksStatus() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Claude Radio state — read the current { videoId, title } the UI's player is
// pointed at. Bundled `/conan-change-radio` skill POSTs to the sibling route
// to swap streams. In-memory, session-only — gateway restart reverts to default.
app.get("/api/claude/radio", (req, res) => {
  if (!authed(req, res)) return;
  res.json(getRadio());
});

// Radio embed-host page (v4.6 WKWebView fix). RadioBar.tsx loads this in an
// offscreen <iframe> so the YouTube player runs at this *http* loopback origin
// instead of the bundled app's `tauri://localhost` scheme — which YouTube
// refuses to embed (onError 153), the root cause of "the radio won't play in
// the packaged app". Unauthenticated on purpose: it exposes nothing sensitive
// (just plays a public, query-supplied YouTube id) and an <iframe> navigation
// can't carry the x-conan-token header. `?v=` is validated/normalised, falling
// back to the default station. `frame-ancestors` lets only the app origins
// embed it; YouTube needs frame-src + script/connect to its hosts.
app.get("/radio/embed", (req, res) => {
  const videoId = sanitizeEmbedVideoId(req.query.v);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Embed page changes routinely (player tweaks for YT IFrame quirks),
  // and the iframe lives across gateway restarts when the UI doesn't
  // reload. `no-store` guarantees the iframe always fetches the current
  // server-side HTML on its next mount, so debug iterations land.
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'unsafe-inline' https://www.youtube.com https://s.ytimg.com",
      "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
      "connect-src https://www.youtube.com https://*.googlevideo.com https://*.ytimg.com",
      "img-src https://*.ytimg.com https://*.youtube.com data:",
      "style-src 'unsafe-inline'",
      "frame-ancestors tauri://localhost http://tauri.localhost https://tauri.localhost http://localhost:5173 http://127.0.0.1:3747",
    ].join("; "),
  );
  res.send(radioEmbedHtml(videoId));
});

// Curated station list — the authoritative named set, compiled into the
// gateway sidecar (not a skill-side file), so it ships inside the signed Tauri
// app. The `/conan-change-radio` skill GETs this and picks from it (random / by
// vibe / by name), then POSTs the chosen id to the sibling route.
app.get("/api/claude/radio/stations", (req, res) => {
  if (!authed(req, res)) return;
  res.json({ stations: getStations() });
});

// Set the radio to a new YouTube URL or 11-char video ID. Resolves the title
// via YouTube oEmbed (best-effort), then broadcasts the new state so any open
// HUD repaints its player without a refetch. Returns 400 when the URL/ID can't
// be parsed.
app.post("/api/claude/radio", async (req, res) => {
  if (!authed(req, res)) return;
  const url = req.body?.url;
  if (typeof url !== "string" || !url.trim()) {
    res.status(400).json({ error: "url required" });
    return;
  }
  try {
    const next = await setRadio(url);
    broadcast({ type: "radio", payload: next });
    res.json(next);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// The Tauri webview loads the bundled frontend and dev uses the Vite server
// (:5173), so the gateway is JSON-API + WebSockets only — it no longer serves
// the built UI to a browser (v4.2 Tauri-only).
const server = http.createServer(app);

// Two WS endpoints, both authenticated (token + Origin) on upgrade.
// `noServer` lets us run the auth check before accepting the socket.
const eventsWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
// Level-2 chat spike: headless agent sessions (`/ws/agent`), the programmatic
// peer of the pty-backed `/ws/terminal`. One connection = one `claude -p`
// stream-json process driving a custom transcript. See src/agent/.
const agentWss = new WebSocketServer({ noServer: true });

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
agentWss.on("connection", (socket, req) => {
  socket.on("error", () => {}); // see eventsWss: never let a bad frame crash us
  attachAgent(socket, req);
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

// US-004: start the passive OAuth-endpoint usage poller (macOS-only, no-op
// elsewhere — see startOAuthUsagePoller's platform guard).
startOAuthUsagePoller();

// Wire the live /usage capture broadcast: when the terminal's passive scanner
// lands a fresh frame, push `{type:'usage-captured', sessionId}` over /ws so
// the HUD's useUsage hook re-pulls. Slash commands don't fire hook events on
// their own — without this the cached capture would sit unused until the user
// clicked ↻ /usage. Cheap, one broadcast per capture (deduped at scan time).
setUsageCapturedListener((sessionId) =>
  broadcast({ type: "usage-captured", sessionId }),
);

// Wire the live active-cwd broadcast (US-004): when the focused terminal's OSC 7
// (US-002) or process-cwd poll (US-003) adopts a new directory, setActiveCwd
// fires onCwdChange — push `{type:'cwd', payload}` over /ws so the StatusBar's
// directory updates live without re-polling /api/config (which is fetched once
// at boot). New terminals already spawn in getActiveCwd(), so this just keeps
// the visible footer in sync with where the user is working.
onCwdChange((cwd) => broadcast({ type: "cwd", payload: cwd }));

// Wire the per-terminal cwd broadcast (File Explorer): every tab tracks its own
// cwd via OSC 7 / the process-cwd poll, focused or not. Push
// `{type:'terminal-cwd', payload:{tid,cwd}}` so the File Explorer panel bound to
// a given tab re-lists when you `cd` inside it — distinct from the focused-only
// `{type:'cwd'}` above, which drives the app-wide StatusBar.
setTerminalCwdListener((tid, cwd) =>
  broadcast({ type: "terminal-cwd", payload: { tid, cwd } }),
);

// Bundled plugins: symlink CONAN_PLUGIN_DIR/<name>/ into ~/.claude/plugins/<name>/
// on boot so Claude Code discovers them with the same plugin source path it
// uses for any third-party plugin. Best-effort; logs a warning on failure but
// doesn't block the gateway from starting.
installBundledPlugins();

// Warm the Claude-installed detection cache at boot so the UI's first /doctor
// request returns instantly (the shell-init probe is bounded but takes ~200ms).
// Fire-and-forget — failures are stored in the cache as error: <message>.
void detectClaude();

// Session-liveness reaper (US-001): reconcile the session table against process
// ground truth at boot and on an interval, so the Active Sessions count reflects
// only sessions that are actually alive — not killed headless runs frozen at
// status='running'. The session grid (GET /api/claude/sessions) reads the table,
// so its reconciled status flows to the UI on the next refetch.
// The correlation-health guard (1.0.2 US-004) samples on the reaper tick —
// piggybacking the existing 30s cadence instead of adding another timer.
const stopReaper = startReaper({ onTick: sampleCorrelationHealth });

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
  } else if (pathname === "/ws/agent") {
    agentWss.handleUpgrade(req, socket, head, (ws) =>
      agentWss.emit("connection", ws, req),
    );
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[conan] gateway listening on http://${HOST}:${PORT}`);
  // Claude FM is a live stream whose video id changes per broadcast; resolve the
  // current broadcast so the radio plays a live id instead of the pinned (and
  // eventually-dead) fallback. Fire-and-forget + best-effort: a connected HUD
  // picks up the swap via the WS broadcast; failure silently keeps the fallback.
  void refreshClaudeFmDefault()
    .then((next) => {
      if (next) {
        broadcast({ type: "radio", payload: next });
        console.log(`[conan] Claude FM resolved to live broadcast ${next.videoId}`);
      }
    })
    .catch(() => {});
});

function shutdown(): void {
  stopWatching();
  stopReaper();
  stopAllSkillFiredWatchers();
  closeAllTerminals();
  closeAllAgents();
  server.close();
  eventsWss.close();
  terminalWss.close();
  agentWss.close();
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
