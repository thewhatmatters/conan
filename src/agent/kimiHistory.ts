import type { ChatHistory } from "./history.js";

/**
 * Kimi chat-history adapter — the Kimi counterpart to `history.ts` (Claude),
 * `codexHistory.ts` (Codex), and `grokHistory.ts` (Grok).
 *
 * v1: transcript reconstruction is NOT implemented. Kimi stores sessions under
 * `~/.kimi-code/` (per-workspace `wd_*` dirs + `session_index.jsonl`), but that
 * on-disk format isn't decoded yet — so a reopened Kimi thread degrades exactly
 * like a reopened Codex/Grok thread today: `found:false` shows the "history
 * couldn't be found" banner and starts a fresh transcript. Continuity still
 * works: the saved session id is re-applied with `kimi -r`, so the model keeps
 * the server-side context (verified: a resumed turn answered a back-reference
 * correctly). Full transcript reconstruction is a tracked follow-up.
 */
export function readKimiHistory(_sessionId: string, _cwd: string | null): ChatHistory {
  return { found: false, items: [] };
}
