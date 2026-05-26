// US-013: background agents — surface Claude Code's live background-agent
// sessions by shelling out to `claude agents --json`, which (confirmed at build
// time, claude 2.1.150) prints a JSON array of live sessions and exits without
// needing a TTY. Each element looks like:
//   { pid, cwd, kind, startedAt, sessionId, status? }
// where `status` is only present on some sessions (e.g. "idle"). The CLI also
// accepts `--cwd <path>` to show only sessions started under a directory.
//
// This module shells out with a bounded timeout, normalizes the raw array into a
// stable payload, and never throws: a non-zero exit, a timeout, missing binary,
// or unparseable output all degrade to an empty list with `available:false` and
// a short error string. The `claude` binary is overridable via CONAN_CLAUDE_BIN
// (matching the terminal + usage probe), which also lets tests point at a fake.

import { execFile } from "node:child_process";

/** One live background-agent session, normalized to a stable shape. */
export interface BackgroundAgent {
  /** OS process id of the agent, or null when absent/unparseable. */
  pid: number | null;
  /** Working directory the session was started under. */
  cwd: string | null;
  /** Session kind as reported by the CLI (e.g. "interactive"). */
  kind: string | null;
  /** Claude Code session id. */
  sessionId: string | null;
  /** When the session started (epoch ms), or null. */
  startedAt: number | null;
  /** Reported status (e.g. "idle"); null when the CLI omits it. */
  status: string | null;
}

export interface BackgroundAgentsResult {
  /** The live background agents (empty when none / unavailable). */
  agents: BackgroundAgent[];
  /** True when the CLI ran and produced a parseable JSON array. */
  available: boolean;
  /** A short reason when unavailable; null on success. */
  error: string | null;
}

/** The `claude` binary to invoke; override with CONAN_CLAUDE_BIN (tests/parity). */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

/** Hard ceiling on the shell-out; killed at the deadline. */
function timeoutMs(): number {
  const raw = Number(process.env.CONAN_AGENTS_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 60_000) return raw;
  return 8_000;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Normalize the raw `claude agents --json` array into stable BackgroundAgent
 * rows. Pure (no I/O) so it can be unit-tested directly; non-array / non-object
 * input yields an empty list. Sorted newest-first by startedAt.
 */
export function normalizeAgents(raw: unknown): BackgroundAgent[] {
  if (!Array.isArray(raw)) return [];
  const agents: BackgroundAgent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    agents.push({
      pid: asNumberOrNull(o.pid),
      cwd: asStringOrNull(o.cwd),
      kind: asStringOrNull(o.kind),
      sessionId: asStringOrNull(o.sessionId),
      startedAt: asNumberOrNull(o.startedAt),
      status: asStringOrNull(o.status),
    });
  }
  agents.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return agents;
}

export interface ReadBackgroundAgentsOptions {
  /** When set, only sessions started under this path (CLI `--cwd`). */
  cwd?: string;
  /** Override the `claude` binary (tests). */
  bin?: string;
}

/**
 * Shell out to `claude agents --json` (bounded timeout) and return the live
 * background-agent list. Never throws: any failure resolves to an empty list
 * with available:false and a short error.
 */
export function readBackgroundAgents(
  opts: ReadBackgroundAgentsOptions = {},
): Promise<BackgroundAgentsResult> {
  const bin = opts.bin ?? CLAUDE_BIN;
  const args = ["agents", "--json"];
  if (opts.cwd) args.push("--cwd", opts.cwd);

  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs(), maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        // A non-empty stdout that parses to an array is usable even if the
        // process later exits non-zero, so try to parse before bailing on err.
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(stdout ?? "").trim() || "null");
        } catch {
          resolve({
            agents: [],
            available: false,
            error: err ? short(err) : "unparseable output",
          });
          return;
        }
        if (!Array.isArray(parsed)) {
          resolve({
            agents: [],
            available: false,
            error: err ? short(err) : "no agents array",
          });
          return;
        }
        resolve({ agents: normalizeAgents(parsed), available: true, error: null });
      },
    );
  });
}

/** A short, single-line description of an exec error. */
function short(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === "ENOENT") return "claude binary not found";
  if (e?.code === "ETIMEDOUT" || (e as { killed?: boolean })?.killed) return "timed out";
  return (e?.message ?? "exec failed").split("\n")[0]!.slice(0, 200);
}
