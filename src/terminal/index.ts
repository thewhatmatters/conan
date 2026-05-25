import crypto from "node:crypto";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { getDb } from "../db/index.js";
import { PACKAGE_ROOT } from "../paths.js";

const DEFAULT_SHELL =
  process.env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");

/** The `claude` binary to auto-launch; override with CONAN_CLAUDE_BIN. */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

/**
 * Resolve what the pty runs. `mode=claude` (default) launches Claude Code so the
 * terminal *is* a Claude session; `mode=shell` drops to a plain shell.
 * For claude we go through a login shell so PATH/nvm/aliases resolve, and fall
 * back to an interactive shell when claude exits (so the dock stays usable).
 */
function resolveCommand(mode: string): { file: string; args: string[] } {
  if (mode === "shell") return { file: DEFAULT_SHELL, args: [] };
  return {
    file: DEFAULT_SHELL,
    args: ["-l", "-c", `${CLAUDE_BIN}; exec ${DEFAULT_SHELL} -i`],
  };
}

/** Build a clean string env for the pty (drops undefined values). */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

interface ClientMessage {
  type: "input" | "resize";
  data?: string;
  cols?: number;
  rows?: number;
}

/**
 * Attach a node-pty session to an (already authenticated) WebSocket (US-015).
 * Output frames are sent raw; the client sends JSON control frames
 * ({type:'input'|'resize'}). The pty is cleaned up on socket close or exit.
 */
export function attachTerminal(ws: WebSocket, req: IncomingMessage): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const cols = clampInt(url.searchParams.get("cols"), 80, 1, 1000);
  const rows = clampInt(url.searchParams.get("rows"), 24, 1, 1000);
  const cwd = url.searchParams.get("cwd") ?? PACKAGE_ROOT;
  const mode = url.searchParams.get("mode") ?? "claude";
  const { file, args } = resolveCommand(mode);

  const id = crypto.randomUUID();
  let term: pty.IPty;
  try {
    term = pty.spawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: ptyEnv(),
    });
  } catch (err) {
    ws.send(`\r\n[conan] failed to start terminal: ${(err as Error).message}\r\n`);
    ws.close();
    return;
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO terminal_session (id, session_id, pid, cols, rows, created_at)
     VALUES (?, NULL, ?, ?, ?, ?)`,
  ).run(id, term.pid, cols, rows, Date.now());

  const onData = term.onData((d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  const onExit = term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n[conan] process exited (${exitCode})\r\n`);
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      term.write(msg.data);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      term.resize(msg.cols, msg.rows);
      db.prepare(`UPDATE terminal_session SET cols = ?, rows = ? WHERE id = ?`).run(
        msg.cols,
        msg.rows,
        id,
      );
    }
  });

  ws.on("close", () => {
    onData.dispose();
    onExit.dispose();
    try {
      term.kill();
    } catch {
      /* already gone */
    }
    db.prepare(`DELETE FROM terminal_session WHERE id = ?`).run(id);
  });
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
