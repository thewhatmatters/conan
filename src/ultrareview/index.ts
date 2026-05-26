// US-046: ultrareview trigger + findings.
//
// A token-gated, user-explicit action that launches a cloud code review for the
// active repo by shelling out to `claude ultrareview` (optionally for a specific
// GitHub PR #) and streaming its output back to the dashboard so the findings
// render live in a panel. Unlike the one-shot `claude doctor` shell-out (US-045),
// an ultrareview is long-running, so this module tracks a single in-memory run
// with a status lifecycle (running → done | error), appends streamed stdout/
// stderr into a capped, ANSI-stripped buffer, and emits an update on every change
// so the gateway can broadcast it over /ws. Read-only callers get the current
// snapshot; the start/stop mutations are token-gated at the route.
//
// Nothing here throws: a missing binary, a non-zero exit, or a timeout all land
// the run in status:'error' with a short, single-line reason the UI surfaces. The
// `claude` binary is overridable via CONAN_CLAUDE_BIN (matching usage/doctor/
// background-agents), which also lets tests point at a fake review script.

import { spawn, type ChildProcess } from "node:child_process";

export type UltrareviewStatus = "idle" | "running" | "done" | "error";

/** What's being reviewed: the active repo's current branch, or a GitHub PR #. */
export interface UltrareviewTarget {
  kind: "branch" | "pr";
  /** PR number (kind:'pr') or null for the current branch (kind:'branch'). */
  ref: string | null;
}

/** One ultrareview run, tracked in memory and streamed to the dashboard. */
export interface UltrareviewRun {
  /** Opaque id for this run (changes each launch). */
  id: string;
  status: UltrareviewStatus;
  target: UltrareviewTarget;
  /** The working directory the review ran in. */
  cwd: string | null;
  /** When the run was launched (epoch ms). */
  startedAt: number;
  /** When it finished (epoch ms), or null while running. */
  endedAt: number | null;
  /** Streamed, ANSI-stripped, length-capped review output rendered in the panel. */
  output: string;
  /** Best-effort count of findings parsed from a summary line, or null. */
  findingsCount: number | null;
  /** Process exit code once finished, or null. */
  exitCode: number | null;
  /** A short, single-line reason when status is 'error'; null otherwise. */
  error: string | null;
}

/** The `claude` binary to invoke; override with CONAN_CLAUDE_BIN (tests/parity). */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

/** Cap on the streamed output buffer; older bytes are trimmed from the front. */
const OUTPUT_CAP = 256 * 1024;

/** Hard ceiling on a single review; killed at the deadline (default 20 min). */
function timeoutMs(): number {
  const raw = Number(process.env.CONAN_ULTRAREVIEW_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 3_600_000) return raw;
  return 20 * 60_000;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[A-Za-z]/g;
/** Strip ANSI escape sequences so a TUI-styled review dump renders as text. */
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * Best-effort findings count: the last "<n> findings/issues/comments" mentioned
 * in the output (case-insensitive). Returns null when no such summary appears,
 * so the UI can render the raw output without inventing a number.
 */
export function parseFindingsCount(output: string): number | null {
  const re = /(\d+)\s+(findings?|issues?|comments?|problems?)\b/gi;
  let last: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const n = parseInt(m[1]!, 10);
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

// --- single in-memory run + subscribers ------------------------------------

let current: UltrareviewRun | null = null;
let child: ChildProcess | null = null;
let killTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<(run: UltrareviewRun) => void>();

/** Subscribe to run updates (status changes + streamed output). */
export function onUltrareviewUpdate(cb: (run: UltrareviewRun) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function emit(): void {
  if (!current) return;
  const snapshot = { ...current };
  for (const cb of subscribers) {
    try {
      cb(snapshot);
    } catch {
      /* a bad subscriber must not break the stream */
    }
  }
}

function append(chunk: string): void {
  if (!current) return;
  let next = current.output + stripAnsi(chunk);
  if (next.length > OUTPUT_CAP) next = next.slice(next.length - OUTPUT_CAP);
  current.output = next;
  current.findingsCount = parseFindingsCount(current.output);
}

/** The current run snapshot (null when none has been launched this process). */
export function readUltrareview(): { run: UltrareviewRun | null } {
  return { run: current ? { ...current } : null };
}

export interface StartUltrareviewOptions {
  /** Working directory for the review (the active repo). */
  cwd?: string;
  /** A GitHub PR number to review instead of the current branch. */
  pr?: string;
  /** Override the `claude` binary (tests). */
  bin?: string;
}

export type StartUltrareviewResult =
  | { ok: true; run: UltrareviewRun }
  | { ok: false; error: string };

/**
 * Launch `claude ultrareview` for the active repo (current branch, or a PR # when
 * `pr` is given) and stream its output into a single tracked run. Refuses to
 * start a second run while one is in flight. Spawn failures (e.g. missing binary)
 * and non-zero exits land the run in status:'error' rather than throwing.
 */
export function startUltrareview(opts: StartUltrareviewOptions = {}): StartUltrareviewResult {
  if (current?.status === "running") {
    return { ok: false, error: "a review is already running" };
  }
  const bin = opts.bin ?? CLAUDE_BIN;
  const pr = typeof opts.pr === "string" ? opts.pr.trim() : "";
  const target: UltrareviewTarget = pr
    ? { kind: "pr", ref: pr }
    : { kind: "branch", ref: null };

  // `/ultrareview <PR#>` maps to a positional PR argument; the no-arg form
  // bundles the local branch (see CLAUDE.md session guidance).
  const args = ["ultrareview"];
  if (pr) args.push(pr);

  const run: UltrareviewRun = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    status: "running",
    target,
    cwd: opts.cwd ?? null,
    startedAt: Date.now(),
    endedAt: null,
    output: "",
    findingsCount: null,
    exitCode: null,
    error: null,
  };
  current = run;

  let proc: ChildProcess;
  try {
    proc = spawn(bin, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    finish("error", null, short(err));
    return { ok: true, run: { ...run } };
  }
  child = proc;

  proc.stdout?.on("data", (d: Buffer) => {
    append(d.toString());
    emit();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    append(d.toString());
    emit();
  });
  proc.on("error", (err) => {
    finish("error", null, short(err));
  });
  proc.on("close", (code) => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    // A preset error (set just before we killed the process — timeout or an
    // explicit stop) wins over the exit code so the reason stays accurate.
    const preset = current?.error;
    if (preset === "timed out" || preset === "stopped") {
      finish("error", code, preset);
    } else if (code === 0) {
      finish("done", code, null);
    } else {
      finish("error", code, `exited with code ${code}`);
    }
  });

  killTimer = setTimeout(() => {
    if (current?.status === "running") {
      current.error = "timed out";
      proc.kill("SIGTERM");
    }
  }, timeoutMs());

  emit();
  return { ok: true, run: { ...run } };
}

function finish(status: UltrareviewStatus, code: number | null, error: string | null): void {
  if (!current) return;
  current.status = status;
  current.exitCode = code;
  current.error = error;
  current.endedAt = Date.now();
  child = null;
  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = null;
  }
  emit();
}

/** Stop the in-flight review (no-op when nothing is running). */
export function stopUltrareview(): { ok: true; stopped: boolean } {
  if (current?.status === "running" && child) {
    current.error = "stopped";
    child.kill("SIGTERM");
    return { ok: true, stopped: true };
  }
  return { ok: true, stopped: false };
}

/** A short, single-line description of a spawn error. */
function short(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === "ENOENT") return "claude binary not found";
  return (e?.message ?? "review failed").split("\n")[0]!.slice(0, 200);
}

/** Test-only: reset the in-memory run + subscribers between cases. */
export function _resetForTest(): void {
  if (child) child.kill("SIGKILL");
  if (killTimer) clearTimeout(killTimer);
  child = null;
  killTimer = null;
  current = null;
  subscribers.clear();
}
