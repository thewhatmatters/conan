import { execFile } from "node:child_process";
import type { AgentCapabilities, AgentDriver, AgentEvent } from "./driver.js";
import { CLAUDE_CAPABILITIES, ClaudeDriver } from "./claude.js";
import { CODEX_CAPABILITIES, CodexDriver } from "./codex.js";
import { GROK_CAPABILITIES, GrokDriver } from "./grok.js";
import { readChatHistory, type ChatHistory } from "./history.js";
import { readCodexHistory } from "./codexHistory.js";
import { readGrokHistory } from "./grokHistory.js";

// Each provider's capability descriptor lives beside its driver (claude.ts /
// codex.ts / grok.ts); the registry re-exports them as the one lookup surface.
export { CODEX_CAPABILITIES, GROK_CAPABILITIES };

/**
 * Provider registry (T3-1 US-003) — the one table mapping a provider id to
 * everything Conan needs to offer it: display identity for the composer chip
 * and sidebar avatar, the binary to probe for, the VERIFIED capability
 * descriptor (US-001 matrix, `fixtures/README.md`), and the driver factory the
 * WS handler builds sessions from (US-007).
 *
 * This is a data table, not a plugin framework — adding a provider means
 * adding one entry here plus its driver module, nothing else.
 *
 * Install detection mirrors `src/doctor/claude.ts`: macOS apps launched from
 * Finder get a stripped env that never sources `~/.zshrc`, so `~/.local/bin`
 * (where codex/grok/claude actually live) is missing from a naive PATH check.
 * We probe through an interactive login shell so the answer matches what the
 * user's real terminal would find. Cached with a TTL; a missing binary is a
 * plain `installed: false`, never an error or a hang.
 */

export type ProviderId = "claude" | "codex" | "grok";

export interface ProviderEntry {
  id: ProviderId;
  /** Display name for the composer's provider chip. */
  name: string;
  /** Single letter for the sidebar thread avatar (C/X/G). */
  avatarLetter: string;
  /** Binary probed on the login-shell PATH. */
  binary: string;
  /** The provider's verified headless capabilities (US-001). */
  capabilities: AgentCapabilities;
  /** Build a driver for one chat session (US-007 wires this into /ws/agent). */
  createDriver: (
    emit: (e: AgentEvent) => void,
    fallbackCwd: () => string | null,
  ) => AgentDriver;
  /** Reconstruct a saved thread's transcript from this provider's own on-disk
   *  session record (US-015 reopen). Each provider persists its own format —
   *  keeping the reader on the entry means the transcript route never branches
   *  on provider name, and adding a provider stays "one entry + one driver
   *  module". `cwd` narrows the store lookup where the provider shards by
   *  working directory; readers that don't need it ignore it. */
  readHistory: (sessionId: string, cwd: string | null) => ChatHistory;
}

export const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "claude",
    name: "Claude Code",
    avatarLetter: "C",
    binary: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    createDriver: (emit, fallbackCwd) => new ClaudeDriver(emit, fallbackCwd),
    readHistory: (sessionId, cwd) => readChatHistory(sessionId, cwd),
  },
  {
    id: "codex",
    name: "Codex",
    avatarLetter: "X",
    binary: "codex",
    capabilities: CODEX_CAPABILITIES,
    createDriver: (emit, fallbackCwd) => new CodexDriver(emit, fallbackCwd),
    // Codex rollouts are date-sharded by session id, never by cwd.
    readHistory: (sessionId) => readCodexHistory(sessionId),
  },
  {
    id: "grok",
    name: "Grok",
    avatarLetter: "G",
    binary: "grok",
    capabilities: GROK_CAPABILITIES,
    createDriver: (emit, fallbackCwd) => new GrokDriver(emit, fallbackCwd),
    readHistory: (sessionId, cwd) => readGrokHistory(sessionId, cwd),
  },
];

export function getProvider(id: string): ProviderEntry | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ── Install probe ──────────────────────────────────────────────────────────

/** One probed answer per provider, cached. */
export interface ProviderInstall {
  installed: boolean;
  /** Semver parsed from `--version` output, or null (not installed / unparseable). */
  version: string | null;
  /** Epoch ms the result was cached. */
  checkedAt: number;
}

/** What `GET /api/agent/providers` returns per provider. */
export interface ProviderStatus {
  id: ProviderId;
  name: string;
  avatarLetter: string;
  /** The CLI this provider launches — surfaced so the UI can name the real
   *  process instead of hardcoding one agent's binary. */
  binary: string;
  installed: boolean;
  version: string | null;
  capabilities: AgentCapabilities;
}

/** Injectable shell runner so tests never spawn a real login shell. */
type ShellRun = (cmd: string) => Promise<string>;

const SHELL = process.env.SHELL ?? "/bin/zsh";
/** Bound: a slow shell startup shouldn't block the providers route forever. */
const PROBE_TIMEOUT_MS = 5_000;
/** Re-probe at most every 10 minutes — installs are rare; cache is cheap. */
const CACHE_TTL_MS = 10 * 60_000;

/** Run one command through the same interactive login shell the pty uses
 *  (mirrors `src/doctor/claude.ts`). Rejects on non-zero exit / timeout. */
function shellProbe(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      SHELL,
      ["-i", "-l", "-c", cmd],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** First semver anywhere in `--version` output — handles both bare versions
 *  ("0.2.111") and prefixed ones ("codex-cli 0.144.6"). */
export function parseVersion(out: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(out);
  return m?.[1] ?? null;
}

/**
 * Probe one binary on the login-shell PATH. Never throws: a missing binary
 * (`command -v` exits 1) or a failed shell is `installed: false`; a resolved
 * path whose `--version` fails is still installed (a partial CLI is more than
 * no CLI), just with `version: null`.
 */
export async function probeInstall(
  binary: string,
  run: ShellRun = shellProbe,
): Promise<{ installed: boolean; version: string | null }> {
  let path: string | null = null;
  try {
    const out = await run(`command -v ${binary}`);
    if (out) path = out.split("\n")[0]!.trim();
  } catch {
    return { installed: false, version: null };
  }
  if (!path) return { installed: false, version: null };
  try {
    const out = await run(`"${path}" --version`);
    return { installed: true, version: parseVersion(out) };
  } catch {
    return { installed: true, version: null };
  }
}

const installCache = new Map<ProviderId, ProviderInstall>();
const inFlight = new Map<ProviderId, Promise<ProviderInstall>>();

/** Probe one provider, memoized for `CACHE_TTL_MS`; concurrent callers share
 *  the in-flight probe. `run` is injectable for tests only. */
export async function detectProvider(
  id: ProviderId,
  run?: ShellRun,
): Promise<ProviderInstall> {
  const cached = installCache.get(id);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached;
  const pending = inFlight.get(id);
  if (pending) return pending;

  const entry = getProvider(id);
  if (!entry) return { installed: false, version: null, checkedAt: Date.now() };

  const probe = (async () => {
    const r = await probeInstall(entry.binary, run);
    const result: ProviderInstall = { ...r, checkedAt: Date.now() };
    installCache.set(id, result);
    inFlight.delete(id);
    return result;
  })();
  inFlight.set(id, probe);
  return probe;
}

/** Drop cached detections — forces a re-probe on the next call. */
export function clearProviderDetection(): void {
  installCache.clear();
  inFlight.clear();
}

/**
 * Resolve the provider a FRESH session explicitly asked for (US-007: the
 * launch frame's `provider` field). Unlike the resume path — where a stored
 * id the registry doesn't know falls back to claude so an old DB can't brick
 * a thread — an explicit request must be honored or refused loudly: an
 * unknown or uninstalled provider throws a human-readable error the WS
 * handler surfaces to the client, never a silent fallback to claude.
 * `run` is injectable for tests only.
 */
export async function resolveRequestedProvider(
  requested: string,
  run?: ShellRun,
): Promise<ProviderEntry> {
  const entry = getProvider(requested);
  if (!entry) {
    const known = PROVIDERS.map((p) => p.id).join(", ");
    throw new Error(`Unknown provider "${requested}" (available: ${known}).`);
  }
  const d = await detectProvider(entry.id, run);
  if (!d.installed) {
    throw new Error(
      `${entry.name} is not installed — "${entry.binary}" was not found on the login-shell PATH.`,
    );
  }
  return entry;
}

/** The `GET /api/agent/providers` payload: every registered provider with its
 *  install state and capabilities, probed in parallel. */
export async function listProviderStatuses(): Promise<ProviderStatus[]> {
  return Promise.all(
    PROVIDERS.map(async (p) => {
      const d = await detectProvider(p.id);
      return {
        id: p.id,
        name: p.name,
        avatarLetter: p.avatarLetter,
        binary: p.binary,
        installed: d.installed,
        version: d.version,
        capabilities: p.capabilities,
      };
    }),
  );
}
