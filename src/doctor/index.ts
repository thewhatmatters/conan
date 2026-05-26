// US-045: Doctor + version/update status for the version/update banner.
//
// Two concerns, kept separate so the cheap part never blocks on the expensive
// one:
//   1. readDoctorStatus() — a pure, synchronous read: the installed Claude Code
//      version (reused from the US-007 changelog resolver), the newest version
//      the local changelog knows about, whether that's an update over what's
//      installed, and the auto-update posture from ~/.claude.json (autoUpdates +
//      autoUpdatesProtectedForNative). No process spawn, no network — safe to
//      serve unauthenticated like the other read-only /api/claude/* routes.
//   2. runDoctor() — an optional, token-gated, bounded shell-out to
//      `claude doctor` (the auto-updater health check). It's a TUI command, so
//      headless it often prints nothing; we treat empty/timeout/missing-binary
//      as "health unavailable" rather than an error. The `claude` binary is
//      overridable via CONAN_CLAUDE_BIN (matching usage/background-agents).
//
// Paths resolve from the same CONAN_CLAUDE_JSON override the changelog/settings
// modules use, so tests can point at a hermetic fixture. Nothing here throws.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { HOME } from "../paths.js";
import { readChangelog } from "../changelog/index.js";

export interface DoctorStatus {
  /** Installed Claude Code version (sessions/<pid>.json, else lastReleaseNotesSeen), or null. */
  installedVersion: string | null;
  /** Newest version the local changelog knows about, or null when absent. */
  latestVersion: string | null;
  /** True when latestVersion is strictly newer than installedVersion (both known). */
  updateAvailable: boolean;
  /** ~/.claude.json autoUpdates flag (null when unreadable / absent). */
  autoUpdates: boolean | null;
  /** ~/.claude.json autoUpdatesProtectedForNative flag (native-install guard), or null. */
  autoUpdatesProtectedForNative: boolean | null;
  /** changelog.md mtime in epoch ms (staleness signal), or null if absent. */
  changelogLastFetched: number | null;
}

export interface DoctorHealth {
  /** True when the `claude doctor` shell-out actually executed. */
  ran: boolean;
  /** True when it exited cleanly AND produced a usable health summary. */
  ok: boolean;
  /** The (bounded, ANSI-stripped) health text, or null when none was produced. */
  summary: string | null;
  /** A short reason when health is unavailable; null on success. */
  error: string | null;
}

export interface DoctorPayload extends DoctorStatus {
  /** Present only when a `?check=1` health run was requested; null otherwise. */
  health: DoctorHealth | null;
}

/** The ~/.claude.json file (overridable for tests via CONAN_CLAUDE_JSON). */
function dotClaudeJson(): string {
  return process.env.CONAN_CLAUDE_JSON ?? path.join(HOME, ".claude.json");
}

/** The `claude` binary to invoke; override with CONAN_CLAUDE_BIN (tests/parity). */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

/** Parse a version string into a numeric tuple for ordering (non-numeric → 0). */
function semverTuple(v: string): number[] {
  return v
    .trim()
    .split(".")
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** Compare two version strings as semver tuples. >0 when a is newer than b. */
function semverCompare(a: string, b: string): number {
  const ta = semverTuple(a);
  const tb = semverTuple(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const diff = (ta[i] ?? 0) - (tb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Read a boolean flag from ~/.claude.json (null when absent / not a boolean). */
function boolFlag(key: string): boolean | null {
  try {
    const json = JSON.parse(fs.readFileSync(dotClaudeJson(), "utf8")) as Record<string, unknown>;
    return typeof json[key] === "boolean" ? (json[key] as boolean) : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous version/update status. Reuses the changelog resolver for the
 * installed version + newest known release, computes updateAvailable from a
 * semver compare, and reads the auto-update flags from ~/.claude.json. Never
 * throws — a missing changelog / unreadable config degrades to nulls and
 * updateAvailable:false.
 */
export function readDoctorStatus(): DoctorStatus {
  const cl = readChangelog();
  const installedVersion = cl.installedVersion;
  const latestVersion = cl.entries[0]?.version ?? null;
  const updateAvailable =
    !!installedVersion &&
    !!latestVersion &&
    semverCompare(latestVersion, installedVersion) > 0;
  return {
    installedVersion,
    latestVersion,
    updateAvailable,
    autoUpdates: boolFlag("autoUpdates"),
    autoUpdatesProtectedForNative: boolFlag("autoUpdatesProtectedForNative"),
    changelogLastFetched: cl.changelogLastFetched,
  };
}

/** Hard ceiling on the `claude doctor` shell-out; killed at the deadline. */
function timeoutMs(): number {
  const raw = Number(process.env.CONAN_DOCTOR_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 60_000) return raw;
  return 10_000;
}

/** Strip ANSI escape sequences and trim, so a TUI health dump renders as text. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[A-Za-z]/g;
function clean(s: string): string {
  return s
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

export interface RunDoctorOptions {
  /** Override the `claude` binary (tests). */
  bin?: string;
}

/**
 * Token-gated, bounded one-shot of `claude doctor` (auto-updater health check).
 * Resolves a DoctorHealth: `ok` only when the process exited cleanly AND printed
 * a usable summary. Because `doctor` is a TUI command it frequently produces no
 * output headless — that, a timeout, or a missing binary all degrade to
 * ran:true/ok:false with a short error rather than throwing.
 */
export function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorHealth> {
  const bin = opts.bin ?? CLAUDE_BIN;
  return new Promise((resolve) => {
    execFile(
      bin,
      ["doctor"],
      { timeout: timeoutMs(), maxBuffer: 1 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const summary = clean(String(stdout ?? "") || String(stderr ?? ""));
        if (err) {
          const e = err as { code?: string; killed?: boolean; message?: string };
          let error = (e.message ?? "doctor failed").split("\n")[0]!.slice(0, 200);
          if (e.code === "ENOENT") error = "claude binary not found";
          else if (e.code === "ETIMEDOUT" || e.killed) error = "timed out";
          resolve({ ran: true, ok: false, summary: summary || null, error });
          return;
        }
        if (!summary) {
          resolve({
            ran: true,
            ok: false,
            summary: null,
            error: "no health output (claude doctor is interactive)",
          });
          return;
        }
        resolve({ ran: true, ok: true, summary, error: null });
      },
    );
  });
}
