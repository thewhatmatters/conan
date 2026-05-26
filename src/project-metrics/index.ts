// US-010: per-project metrics — surface the last-session cost/tokens/lines/model
// that Claude Code already records on disk but Conan ignored.
//
// Claude Code writes these under ~/.claude.json `projects[<cwd>]` after each run,
// keyed by the absolute project path:
//   lastCost, lastTotalInputTokens, lastTotalOutputTokens,
//   lastTotalCacheCreationInputTokens, lastTotalCacheReadInputTokens,
//   lastLinesAdded, lastLinesRemoved, lastDuration, lastSessionId, and
//   lastModelUsage — a per-model split { <model>: {inputTokens, outputTokens,
//   cacheReadInputTokens, cacheCreationInputTokens, costUSD, …} }.
//
// This module is read-only and never throws: a missing ~/.claude.json, an
// unknown project (cwd with no entry), or malformed JSON all yield a safe shape
// with `found:false` and null metrics. The ~/.claude.json path is overridable
// for tests via CONAN_CLAUDE_JSON (the same override the settings/changelog/mcp
// readers use).

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";
import { getActiveCwd } from "../cwd/index.js";

/** Per-model token/cost split from `lastModelUsage`. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

export interface ProjectMetrics {
  /** The project path these metrics describe (resolved absolute). */
  cwd: string;
  /** Whether ~/.claude.json had an entry for this cwd. */
  found: boolean;
  lastCost: number | null;
  lastTotalInputTokens: number | null;
  lastTotalOutputTokens: number | null;
  lastTotalCacheCreationInputTokens: number | null;
  lastTotalCacheReadInputTokens: number | null;
  lastLinesAdded: number | null;
  lastLinesRemoved: number | null;
  lastDuration: number | null;
  lastSessionId: string | null;
  /** Per-model split (empty when absent). */
  lastModelUsage: ModelUsage[];
}

/** The ~/.claude.json file (overridable for tests via CONAN_CLAUDE_JSON). */
function dotClaudeJson(): string {
  return process.env.CONAN_CLAUDE_JSON ?? path.join(HOME, ".claude.json");
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Coerce to a finite number, else null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Normalize the `lastModelUsage` map into a stable, sorted array. */
function parseModelUsage(raw: unknown): ModelUsage[] {
  if (!raw || typeof raw !== "object") return [];
  const out: ModelUsage[] = [];
  for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
    const m = (v ?? {}) as Record<string, unknown>;
    out.push({
      model,
      inputTokens: num(m.inputTokens) ?? 0,
      outputTokens: num(m.outputTokens) ?? 0,
      cacheReadInputTokens: num(m.cacheReadInputTokens) ?? 0,
      cacheCreationInputTokens: num(m.cacheCreationInputTokens) ?? 0,
      webSearchRequests: num(m.webSearchRequests) ?? 0,
      costUSD: num(m.costUSD) ?? 0,
    });
  }
  // Costliest model first for a stable, useful order.
  out.sort((a, b) => b.costUSD - a.costUSD || a.model.localeCompare(b.model));
  return out;
}

/** A blank, found:false payload for an unknown/missing project. */
function emptyMetrics(cwd: string): ProjectMetrics {
  return {
    cwd,
    found: false,
    lastCost: null,
    lastTotalInputTokens: null,
    lastTotalOutputTokens: null,
    lastTotalCacheCreationInputTokens: null,
    lastTotalCacheReadInputTokens: null,
    lastLinesAdded: null,
    lastLinesRemoved: null,
    lastDuration: null,
    lastSessionId: null,
    lastModelUsage: [],
  };
}

export interface ReadProjectMetricsOptions {
  /** Override the ~/.claude.json path (tests). */
  claudeJsonPath?: string;
}

/**
 * Read the last-session metrics Claude Code recorded for `cwd` (defaults to the
 * active cwd). Unknown project / missing file / malformed JSON all degrade to a
 * safe `found:false` shape — never throws.
 */
export function readProjectMetrics(
  cwd?: string,
  opts: ReadProjectMetricsOptions = {},
): ProjectMetrics {
  const resolved = path.resolve(
    cwd && cwd.trim() ? cwd.trim() : getActiveCwd(),
  );
  const obj = readJson(opts.claudeJsonPath ?? dotClaudeJson());
  const projects = obj?.projects;
  if (!projects || typeof projects !== "object") return emptyMetrics(resolved);

  const entry = (projects as Record<string, unknown>)[resolved];
  if (!entry || typeof entry !== "object") return emptyMetrics(resolved);

  const e = entry as Record<string, unknown>;
  return {
    cwd: resolved,
    found: true,
    lastCost: num(e.lastCost),
    lastTotalInputTokens: num(e.lastTotalInputTokens),
    lastTotalOutputTokens: num(e.lastTotalOutputTokens),
    lastTotalCacheCreationInputTokens: num(e.lastTotalCacheCreationInputTokens),
    lastTotalCacheReadInputTokens: num(e.lastTotalCacheReadInputTokens),
    lastLinesAdded: num(e.lastLinesAdded),
    lastLinesRemoved: num(e.lastLinesRemoved),
    lastDuration: num(e.lastDuration),
    lastSessionId: typeof e.lastSessionId === "string" ? e.lastSessionId : null,
    lastModelUsage: parseModelUsage(e.lastModelUsage),
  };
}
