/**
 * Chat domain model — the types and resolution helpers BOTH trees share.
 *
 * Before this module existed, v1 declared these as file-local interfaces
 * inside components (unexported, so unimportable) and v2 redeclared them —
 * which is how the provider union forked and silently dropped `kimi`. One
 * declaration here, consumed by v1 and v2 alike: a new thread field or
 * provider is one edit that the compiler propagates to both trees.
 *
 * `ProviderId` itself is declared in `src/agent/driver.ts` (the gateway seam
 * both tsconfig programs type-import) — this module re-exports it and owns
 * the UI-side narrowing from the DB's free-string column.
 */
import type { ProviderId } from "../../../src/agent/driver.ts";

export type { ProviderId };

/** Every registered provider id. `Record<ProviderId, true>` (not an array
 *  literal) so adding a provider to the union without updating this map is a
 *  compile error — the exact drift that once cost kimi its sidebar glyph. */
const PROVIDER_ID_SET: Record<ProviderId, true> = {
  claude: true,
  codex: true,
  grok: true,
  kimi: true,
};

export const PROVIDER_IDS = Object.keys(PROVIDER_ID_SET) as ProviderId[];

/** Narrow the gateway's free-string provider column (null on pre-migration
 *  rows, which it coalesces to claude) to the real union — once, here. */
export function asProviderId(value: string | null | undefined): ProviderId {
  return value != null && value in PROVIDER_ID_SET ? (value as ProviderId) : "claude";
}

/** First-class project: a chosen folder that chats live inside (US-025).
 *  Ids come from the gateway's project table (stable across reloads). */
export interface Project {
  id: string;
  /** Absolute path of the project folder — every thread's cwd. */
  path: string;
  /** Display name: the folder basename. */
  name: string;
  /** Creation time — the "Created" project sort key (US-005). */
  createdAt: number;
  /** Git repo root containing the folder (gateway-computed) — the
   *  group-by-repository key. Null/absent = not in a repo (groups by path). */
  repoRoot?: string | null;
}

/** A persisted `chat_thread` row from GET /api/agent/projects (US-014). */
export interface SavedThread {
  sessionId: string;
  cwd: string;
  model: string | null;
  /** Agent provider that drove the thread (T3-1 US-006/008) — a `ProviderId`;
   *  the gateway coalesces pre-migration nulls to 'claude'. Kept as the wire's
   *  free string here; narrow with `asProviderId`. */
  provider: string | null;
  effort: string | null;
  title: string | null;
  /** PD-1: last assistant response / prompt preview — the row's description. */
  lastMessage: string | null;
  createdAt: number;
  lastActivity: number;
}

/** One reconstructed history entry from GET /api/agent/threads/:id/transcript
 *  (mirrors the gateway's HistoryItem in src/agent/history.ts). */
export type HistoryItem =
  | { role: "user" | "assistant" | "reasoning"; text: string; ts?: number | null }
  | {
      role: "tool";
      id: string;
      name: string;
      input: unknown;
      result: string | null;
      isError: boolean;
      ts?: number | null;
    };

/** The slice of a thread's live state the sidebar pill derives from. Both
 *  trees' fuller per-thread UI states satisfy this structurally. */
export interface ThreadPillState {
  status: "connecting" | "open" | "closed";
  busy: boolean;
  awaitingApproval: boolean;
}

/** Sidebar status pill, derived from the thread's reported state. */
export type Pill = "working" | "awaiting" | "ready" | "idle";

export function pillOf(s: ThreadPillState | undefined): Pill {
  if (!s) return "idle";
  if (s.awaitingApproval) return "awaiting";
  if (s.busy) return "working";
  if (s.status === "open") return "ready";
  return "idle";
}

/** Compact byte size for pin chips and tooltips. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
