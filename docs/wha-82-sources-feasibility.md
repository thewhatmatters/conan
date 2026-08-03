# WHA-82 — Surfacing sources after an agent response

**Verdict: GO** for a Claude-first v1 labeled **Consulted**, derived purely from tool events already on the wire. Do **not** claim citations unless a second pass proves the assistant text referenced them.

**Ticket:** [WHA-82](https://linear.app/whatmatters/issue/WHA-82)  
**Repo path (Hermes):** `docs/wha-82-sources-feasibility.md`  
**Date:** 2026-08-02  
**Author:** Barkley (research; no product code)

---

## 1. Question

Can Conan surface, after an agent turn, the **web results / fetched pages / project files / vault notes** the agent used — honestly across Claude, Codex, and Grok — without inventing evidence or drowning the UI in tool noise?

## 2. What Conan already has

| Layer | Evidence | Relevance |
| --- | --- | --- |
| Normalized events | `AgentEvent` already has `tool-use` + `tool-result` (`src/agent/driver.ts`) | Derivation can sit **above** the driver — no new provider protocol |
| Claude live stream | `ClaudeStreamParser` emits every `tool_use` / `tool_result` | Best source of truth mid-turn |
| Codex live stream | `CodexStreamParser` maps `command_execution` + `file_change` only (`fixtures/README.md`, `codex-turn3-tools.jsonl`) | Commands + writes visible; reads/web often invisible live |
| Grok live stream | **Zero** tool events — only `thought` / `text` / `end` (verified: file written on disk with empty tool stream) | Live derivation **impossible** today |
| History adapters | Claude / Codex / Grok reconstruct `role: "tool"` cards on reopen (`history.ts`, `codexHistory.ts`, `grokHistory.ts`) | Grok tools **do** exist on disk even though the live stream hides them |
| UI | `useAgentChat` merges tool results by id; v2 `V2Transcript` already pulls targets from `command` / `path` / `file_path` / `query` / `url` / `pattern` | Half the presentation path exists as tool rollups — WHA-82 is a **post-turn summary**, not a new event type |
| Cost | Parse of events already in memory | **$0 API** for derivation |

---

## 3. Per-provider capability matrix

Evidence: Conan fixtures + live parsers (`docs` date 2026-07-23; CLI versions in `fixtures/README.md`), plus sampled local transcripts/rollouts on this machine (2026-08-02).

| Question | Claude (`stream-json`) | Codex (`exec --json` + rollout) | Grok (`streaming-json`) |
| --- | --- | --- | --- |
| Tool visibility **live** | Full `tool_use` / `tool_result` | `item.*` → `command_execution`, `file_change` only | **None** |
| Tool visibility **history** | Full JSONL | `function_call` / `custom_tool_call` (+ outputs); rollout also has `web_search_end`, `mcp_tool_call_end` (history adapter does **not** map web_search yet) | Full `tool_calls` + `tool_result` in `chat_history.jsonl` |
| Web search | `WebSearch` input `{query}`; result text includes `Links: [{title,url},…]` (verified live transcript) | `web_search_end` with `query` / `action` (`search` \| `open_page`) and optional `results[]` (seen in rollouts; **rare** vs shell tools) | Not observed in local Grok Build sessions (tool names: `read_file`, `grep`, `run_terminal_command`, …) |
| Fetch page | `WebFetch` input `{url, prompt}` | `open_page` action on `web_search_end` | Not observed |
| Project files | `Read`/`Glob`/`Grep` → `file_path` / `path` / `pattern` | Mostly shell via `Command` / `exec`; writes as `FileChange` paths | `read_file` → `target_file`; `grep` → `path` |
| Vault / second brain | Path prefix on tool targets (vault paths appear in real Claude transcripts) | Same if path/cmd hits vault | Same path-prefix if tools open vault paths |
| Structured “citations” on stream | **No** dedicated citation events in headless stream-json | **No** | **No** |
| Honest product claim | **Consulted** from tools; **Cited** only if assistant text matches | Same, thinner live data | **Consulted** only after history harvest (or future stream fix) |

### 3.1 Derivation from tool events (algorithm sketch)

Input: the turn’s ordered `tool-use`/`tool-result` pairs (live `ChatItem[]` or history tools between user and next user).

For each pair, classify:

| Kind | Match | Primary target | Secondary |
| --- | --- | --- | --- |
| `web-search` | name ∈ {`WebSearch`, …} or Codex `web_search*` | `input.query` | URLs parsed from result (`Links:[{url}]` or `https?://…`) |
| `web-page` | `WebFetch` or Codex `open_page` | `input.url` / action url | title/snippet if present |
| `project-file` | `Read`/`Glob`/`Grep`/`read_file`/…; path under thread `cwd` | absolute → display relative to cwd | optional line range |
| `vault-note` | path under configured vault root(s) | vault-relative path | project slug if under `projects/` |
| `other` | MCP / Skill / Bash / Command | omit from v1 sources **or** demote | — |

**Do not** treat `Edit`/`Write`/`FileChange` as “sources consulted” — those are mutations. Optionally a separate “Files touched” chip later.

### 3.2 Consulted vs cited (honest framing)

| Term | Definition | How to get it |
| --- | --- | --- |
| **Consulted** | Agent invoked a tool against this target | Tool events — **reliable** where tools are visible |
| **Cited** | Final answer actually references this target | Not on the wire. Options: (a) substring match URL/path in assistant text, (b) future provider citation blocks, (c) model-side footnotes Conan does not control |

**Product rule for v1:** UI copy = **“Consulted”** (or “Looked at”), never “Sources” alone if that implies citations. Optional v1.1: mark items also found in assistant text as **Cited**.

Falsely labeling every WebSearch hit as “cited” is a **trust bug** — search returns many links; the model often uses none of them in prose.

### 3.3 Vault-root detection

No Conan runtime vault module today. Feasible detectors (ordered):

1. **Explicit setting** — user-configured vault root(s) in Conan settings (most reliable; ship later if needed).
2. **`wire-vault` marker** in project `CLAUDE.md` — already present for Conan (`<!-- wire-vault:start -->` … path to `…/OBSDN/projects/conan/`). Regex/path extract is enough for project-scoped vault.
3. **Path heuristics** — known segments: `iCloud~md~obsidian`, `/OBSDN/`, `Documents/OBSDN`. Label `vault-note` when a Read/`read_file` path matches.
4. **House default** (Randy machine): `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/OBSDN` — useful as fallback, **not** as a shipped hardcode without (1) or (2).

v1: implement (2)+(3); treat unknown long absolute paths outside cwd as `project-file` only if under cwd, else `other`/omit.

### 3.4 Presentation & cost-noise heuristics

**Cost:** local pure function on existing events → no token spend, no extra process.

**Noise (real Claude sample, 80 transcripts):** Bash ≫ Edit ≫ Read ≫ MCP; WebSearch is sparse. A single coding turn can easily produce **tens** of Reads.

Recommended v1 filters:

| Heuristic | Rule |
| --- | --- |
| Cap | Max **8** items after ranking; “+N more” expandable |
| Dedupe | By normalized URL or resolved realpath |
| Rank | web-page > web-search (URL hits) > vault-note > project-file (unique paths) > bare search queries |
| Drop | Edit/Write/Bash/Command/approval/Skill unless they open an explicit path/url |
| Collapse | Multiple reads of same file → one row |
| Scope | Prefer paths under thread `cwd`; vault paths always keep absolute→vault-relative |
| Timing | Render chip **after** turn `result` (or when assistant text settles), not mid-stream thrash |
| Empty | Hide entire row if zero sources after filters — no “Consulted: nothing” |
| Provider honesty | If provider has no live tools (Grok mid-turn), either wait for history harvest or show nothing — **never** invent |

---

## 4. Go / no-go

### GO — with cut lines

| | |
| --- | --- |
| **Why go** | Claude already delivers the data; UI already folds tools; derivation is free and capability-shaped |
| **Why not full multi-provider parity** | Grok live stream is blind; Codex live stream misses reads/web; “cited” is not free |
| **Kill criteria (no-go later)** | If product insists every provider show identical live sources *before* history work, or insists on true citations without text matching |

### v1 cut line (ship this)

1. **Claude only** guaranteed path (Codex/Grok best-effort, degrade silently).
2. Derive from **existing** per-turn tool cards (live + history reopen).
3. Categories: web (search + page), project file, vault note.
4. Label: **Consulted**.
5. Cap 8, dedupe, hide Edit/Write/Bash noise.
6. Vault via path heuristic + optional `wire-vault` parse.
7. No new dependencies; no provider CLI changes; no network.

### Explicitly out of v1

- True “Cited” badges without text-match pass  
- Live Grok tool stream (blocked on Grok CLI)  
- Codex `web_search_end` live parsing (needs driver + fixture re-probe)  
- Opening sources in external apps beyond simple `file://` / https links  
- Showing full tool result bodies in the sources chip  
- MCP servers as first-class source types (Linear, browser) — follow-up  

### Follow-up implementation stories (if GO)

| Story | Scope | Size | Depends |
| --- | --- | --- | --- |
| **WHA-82-A** | Pure `deriveConsultedSources(tools, {cwd, vaultRoots})` + unit tests from real fixture shapes | S | — |
| **WHA-82-B** | v2 UI: collapsible **Consulted** row under last assistant message of the turn (Astryx tokens) | S–M | A |
| **WHA-82-C** | Vault roots: parse `wire-vault` + path heuristics + optional settings | S | A |
| **WHA-82-D** | Optional **Cited** mark when assistant text contains URL/path | S | A+B |
| **WHA-82-E** | Codex: map `web_search_end` / richer history types into tools or source events; re-probe live `exec --json` | M | A |
| **WHA-82-F** | Grok: after `result`/`exit`, harvest tools from `chat_history.jsonl` for that session id and merge into transcript sources | M | A+B |
| **WHA-82-G** | MCP / browser / Linear as source kinds (if product wants) | M | A+B |

Suggested build order: **A → B → C**, then D; E/F when multi-provider parity matters.

---

## 5. Risks & QA notes

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Mislabeling search hits as citations | Trust / S2 | “Consulted” copy only |
| Flooding UI with every Read | UX / S3 | Cap, rank, collapse |
| Grok empty sources while agent clearly read files | Honesty / S3 | History harvest (82-F) or copy “this provider doesn’t stream tools” only if user expands |
| Codex reads hidden in shell commands | Coverage / S3 | v1 omit; later optional parse `cat`/`sed -n` paths (fragile — low priority) |
| Vault path false positives | Low | Require known markers / prefix list |
| npm/lock / node version | Process | Unrelated; keep node 22 for any later impl |

**QA acceptance sketch for 82-A/B:** fixture turn with WebSearch + Read under cwd + Read under vault → chip shows 1 search (with parsed URLs capped), 1 project file, 1 vault note; Edit-only turn → no chip; Grok live-only fixture with no tools → no chip.

---

## 6. Evidence index

| Source | Path / note |
| --- | --- |
| Provider fixtures | `src/agent/fixtures/README.md` — Grok no live tools; Codex command/file items |
| Driver union | `src/agent/driver.ts` — `tool-use` / `tool-result` |
| Claude parser | `src/agent/claude.ts` — `classifyTool`; WebFetch = `other` today |
| Codex live parser | `src/agent/codex.ts` — command + file_change only |
| Grok history tools | `src/agent/grokHistory.ts` — `tool_calls` on assistant lines |
| Codex history | `src/agent/codexHistory.ts` — function/custom tools; not web_search_end |
| v2 tool targets | `ui/src/v2/chat/V2Transcript.tsx` — `query`/`url`/`file_path` already extracted |
| Live WebSearch shape | Local Claude JSONL: `Links:[{"title","url"}…]` in tool_result |
| Live WebFetch shape | `{url, prompt}` input |
| Codex web_search_end | Local `~/.codex/sessions` rollout sample |
| Vault wiring | Conan `CLAUDE.md` `wire-vault` block → OBSDN project path |

---

## 7. Recommendation (one line)

**Ship Claude-first “Consulted” sources from existing tool events (stories A–C); park true citations and Grok/Codex parity as follow-ups — not blockers.**
