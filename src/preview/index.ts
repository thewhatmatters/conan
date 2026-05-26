import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getActiveCwd, onCwdChange } from "../cwd/index.js";

/** The HMR shim config Vite is pointed at so hot-reload dials back via Conan. */
const PREVIEW_VITE_CONFIG = fileURLToPath(
  new URL("../../scripts/preview-vite-config.mjs", import.meta.url),
);

/**
 * Live-preview backend (US-010): run the active cwd's dev server on demand so
 * the project being edited can be previewed inside the dashboard. This module
 * mirrors the pty/TermSession abstraction in src/terminal/index.ts — a single
 * managed child process, a capped ring buffer of its stdout, and an onExit
 * handler — but for a long-lived dev server instead of an interactive pty.
 *
 * Scope (v1, per the PRD): run + discover + status. The reverse proxy that
 * actually surfaces the server at /preview/:id is US-011; the dock UI is US-012.
 *
 * Lifecycle is DECOUPLED from the pty layer (footgun #1): the preview is its own
 * managed child, not torn down by closeAllTerminals(), and it stops itself when
 * the active cwd changes (it belonged to the old project). It is killed only on
 * an explicit stop or graceful gateway shutdown (closePreview()).
 */

/** Ring-buffer cap for captured dev-server stdout (oldest chunks evicted). */
const RING_MAX_BYTES = clampEnvInt("CONAN_PREVIEW_RING_BYTES", 128 * 1024, 1, 16 * 1024 * 1024);

/** Candidate dev scripts, in the order we prefer them when none is specified. */
const CANDIDATE_SCRIPTS = ["dev", "start", "preview"] as const;

/**
 * Match the "Local:" URL most dev servers print once listening, so non-Vite
 * tools (where we can't pin the port) still surface their bound port. Accepts
 * localhost or a loopback IP, optional path, with or without ANSI color codes.
 */
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?/i;

export type PreviewRunState = "starting" | "running" | "exited" | "error";

/** One discovered candidate command the UI can pick from / override. */
export interface PreviewCandidate {
  /** The package.json script name (e.g. "dev"). */
  script: string;
  /** Its raw command string from package.json scripts. */
  command: string;
  /** True when the script invokes Vite, so the port can be pinned up front. */
  vite: boolean;
}

/** The discovery result for a cwd: which scripts exist and the default pick. */
export interface PreviewDiscovery {
  cwd: string;
  /** Candidate scripts present in package.json, in preference order. */
  candidates: PreviewCandidate[];
  /** The default script to run (first candidate), or null when none exist. */
  defaultScript: string | null;
  /** Set when package.json is missing/unreadable so the UI can explain itself. */
  error?: string;
}

/** Public status of the (single) preview process. */
export interface PreviewStatus {
  /** True while a preview process exists (starting or running). */
  active: boolean;
  /** Per-run id, used in --base /preview/<id>/ and the future proxy mount. */
  id: string | null;
  state: PreviewRunState | "idle";
  /** The cwd the preview was launched in. */
  cwd: string | null;
  /** The chosen script name. */
  script: string | null;
  /** The full resolved command line (incl. pinned-port flags). */
  command: string | null;
  /** The bound port: the pinned port for Vite, else scraped from stdout. */
  port: number | null;
  /** Whether the port was pinned up front (Vite) vs. scraped from stdout. */
  vite: boolean;
  /** Exit code once the process has exited, else null. */
  exitCode: number | null;
  /** Last error message (spawn failure / no dev command), else null. */
  error: string | null;
}

interface PreviewSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  script: string;
  command: string;
  vite: boolean;
  /** Pinned port (Vite) — known before the process confirms it's listening. */
  pinnedPort: number | null;
  /** The confirmed bound port (pinned, or scraped from stdout). */
  boundPort: number | null;
  state: PreviewRunState;
  exitCode: number | null;
  error: string | null;
  buffer: string[];
  bufferBytes: number;
}

/** The single active preview (one project previewed at a time). */
let current: PreviewSession | null = null;
let unsubscribeCwd: (() => void) | null = null;

/**
 * Read the active (or given) cwd's package.json and report which of the
 * candidate dev scripts exist, in preference order, plus the default pick.
 * A missing/unreadable package.json degrades to an empty list with an `error`.
 */
export function discoverCommands(cwd?: string): PreviewDiscovery {
  const dir = cwd ?? getActiveCwd();
  let scripts: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (pkg.scripts && typeof pkg.scripts === "object") scripts = pkg.scripts;
  } catch {
    return { cwd: dir, candidates: [], defaultScript: null, error: "no package.json" };
  }

  const candidates: PreviewCandidate[] = [];
  for (const name of CANDIDATE_SCRIPTS) {
    const command = scripts[name];
    if (typeof command === "string" && command.trim()) {
      candidates.push({ script: name, command, vite: /\bvite\b/.test(command) });
    }
  }
  return {
    cwd: dir,
    candidates,
    defaultScript: candidates[0]?.script ?? null,
  };
}

/** Find an OS-assigned free TCP port on the loopback interface. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("could not determine a free port"));
      });
    });
  });
}

export interface StartPreviewOptions {
  /** Override the script to run; defaults to the discovered preference order. */
  script?: string;
}

export interface StartPreviewResult {
  ok: boolean;
  status?: PreviewStatus;
  error?: string;
}

/**
 * Start a dev server for the active cwd. Picks the requested script (or the
 * discovery default), pins a free port for Vite-style commands (so the proxy
 * has a stable target and the bound port is known without scraping), and
 * captures stdout/stderr into the ring buffer. Stops any existing preview first
 * — only one runs at a time. Best-effort by nature: a spawn failure resolves to
 * { ok:false } with a clear message rather than throwing.
 */
export async function startPreview(opts: StartPreviewOptions = {}): Promise<StartPreviewResult> {
  if (current) stopPreview();

  const cwd = getActiveCwd();
  const discovery = discoverCommands(cwd);
  const script = opts.script ?? discovery.defaultScript;
  if (!script) {
    return { ok: false, error: `no dev command in ${cwd} (looked for ${CANDIDATE_SCRIPTS.join(", ")})` };
  }
  const candidate = discovery.candidates.find((c) => c.script === script);
  if (!candidate) {
    return { ok: false, error: `script '${script}' is not a known dev command in ${cwd}` };
  }

  const id = crypto.randomUUID();
  const isVite = candidate.vite;

  // Vite-style: pin a free port + base path up front (research: port-pinning
  // beats stdout scraping). --strictPort makes Vite fail rather than drift to
  // another port, so the bound port is exactly what we passed. Non-Vite tools
  // get no extra flags and we fall back to the stdout "Local:" regex.
  //
  // HMR (US-011): the page is served same-origin through Conan's /preview/<id>/
  // reverse proxy, so the Vite HMR client must dial back via Conan's port + a
  // /preview/ path — otherwise it silently connects straight to the dev-server
  // port, bypassing the proxy/auth and breaking when framed. We can't pass HMR
  // settings as CLI flags, so we point Vite at a shim config (scripts/
  // preview-vite-config.mjs) that loads the project's own config and merges a
  // server.hmr overlay; the values travel via env. The user's config is never
  // edited.
  let pinnedPort: number | null = null;
  const extraArgs: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (isVite) {
    pinnedPort = await findFreePort();
    extraArgs.push(
      "--port",
      String(pinnedPort),
      "--strictPort",
      "--base",
      `/preview/${id}/`,
      "--host",
      "127.0.0.1",
      "--config",
      PREVIEW_VITE_CONFIG,
    );
    const conanPort = Number.parseInt(process.env.CONAN_PORT ?? "3747", 10) || 3747;
    const tls = Boolean(process.env.CONAN_TLS_CERT && process.env.CONAN_TLS_KEY);
    env.CONAN_PREVIEW_ROOT = cwd;
    env.CONAN_PREVIEW_CLIENT_PORT = String(conanPort);
    // Relative path: Vite joins it under the --base (/preview/<id>/), so the HMR
    // client dials ws://<conan>/preview/<id>/__hmr — which the gateway's
    // /preview/ upgrade branch proxies back to the dev server.
    env.CONAN_PREVIEW_HMR_PATH = "__hmr";
    env.CONAN_PREVIEW_HMR_PROTOCOL = tls ? "wss" : "ws";
  }

  const args = ["run", script, ...(extraArgs.length ? ["--", ...extraArgs] : [])];
  const command = `npm ${args.join(" ")}`;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("npm", args, {
      cwd,
      env,
      // Own process group so we can signal the whole dev-server tree on stop.
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const session: PreviewSession = {
    id,
    child,
    cwd,
    script,
    command,
    vite: isVite,
    pinnedPort,
    boundPort: null,
    state: "starting",
    exitCode: null,
    error: null,
    buffer: [],
    bufferBytes: 0,
  };
  current = session;

  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    pushBuffer(session, text);
    // Detect the listening port to confirm the server is up. For Vite the port
    // is already pinned; the URL match just promotes us to "running".
    if (session.state === "starting") {
      const m = LOCAL_URL_RE.exec(text);
      if (m) {
        const scraped = m[1] ? Number.parseInt(m[1], 10) : null;
        session.boundPort = session.pinnedPort ?? scraped;
        if (session.boundPort) session.state = "running";
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("error", (err) => {
    session.state = "error";
    session.error = err.message;
  });
  child.on("exit", (code) => {
    session.state = "exited";
    session.exitCode = code;
    // A clean teardown nulls `current` first; if we're still it, the server
    // died on its own — keep the session around so status can report the exit.
  });

  return { ok: true, status: toStatus(session) };
}

/** Cap the ring buffer to RING_MAX_BYTES, evicting oldest chunks first. */
function pushBuffer(s: PreviewSession, chunk: string): void {
  s.buffer.push(chunk);
  s.bufferBytes += Buffer.byteLength(chunk);
  while (s.bufferBytes > RING_MAX_BYTES && s.buffer.length > 1) {
    const evicted = s.buffer.shift()!;
    s.bufferBytes -= Buffer.byteLength(evicted);
  }
}

/** Recent captured dev-server output (for the UI log panel / debugging). */
export function previewOutput(): string {
  return current ? current.buffer.join("") : "";
}

export interface StopPreviewResult {
  ok: boolean;
  /** True when a running preview was actually stopped. */
  stopped: boolean;
}

/** Stop the active preview, signalling its whole process group when possible. */
export function stopPreview(): StopPreviewResult {
  const session = current;
  current = null;
  if (!session) return { ok: true, stopped: false };
  killTree(session.child);
  return { ok: true, stopped: true };
}

/** Kill a dev server and its children (dev servers fork workers). */
function killTree(child: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform !== "win32" && typeof child.pid === "number") {
      // Negative pid → signal the whole process group we created with detached.
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Group gone / never started — fall back to a direct kill, ignore failures.
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/**
 * The reverse-proxy target for the live preview (US-011), or null when nothing
 * is up yet. The gateway's /preview/:id mount and its WS-upgrade branch use this
 * to route requests to the dev server's bound loopback port. Only surfaced once
 * a port is known (Vite's pinned port is known immediately; non-Vite tools wait
 * for the stdout scrape), so the proxy never targets a dead port.
 */
export function previewProxyTarget(): { id: string; port: number } | null {
  if (
    current &&
    current.boundPort &&
    (current.state === "running" || current.state === "starting")
  ) {
    return { id: current.id, port: current.boundPort };
  }
  // Vite's port is pinned up front even before the "Local:" line confirms it.
  if (current && current.pinnedPort && current.state === "starting") {
    return { id: current.id, port: current.pinnedPort };
  }
  return null;
}

/** Current preview status (idle shape when nothing has been started). */
export function previewStatus(): PreviewStatus {
  if (!current) {
    return {
      active: false,
      id: null,
      state: "idle",
      cwd: null,
      script: null,
      command: null,
      port: null,
      vite: false,
      exitCode: null,
      error: null,
    };
  }
  return toStatus(current);
}

function toStatus(s: PreviewSession): PreviewStatus {
  return {
    active: s.state === "starting" || s.state === "running",
    id: s.id,
    state: s.state,
    cwd: s.cwd,
    script: s.script,
    command: s.command,
    port: s.boundPort,
    vite: s.vite,
    exitCode: s.exitCode,
    error: s.error,
  };
}

/**
 * Wire the preview manager to active-cwd changes. A running preview belongs to
 * the cwd it was launched in, so when the dashboard switches projects we stop
 * it (the user can start the new project's server on demand). Idempotent —
 * calling twice keeps a single subscription. Returns nothing; teardown is via
 * closePreview() on shutdown.
 */
export function initPreview(): void {
  if (unsubscribeCwd) return;
  unsubscribeCwd = onCwdChange(() => {
    if (current) stopPreview();
  });
}

/** Graceful shutdown: stop the preview and drop the cwd subscription. */
export function closePreview(): void {
  stopPreview();
  if (unsubscribeCwd) {
    unsubscribeCwd();
    unsubscribeCwd = null;
  }
}

function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
