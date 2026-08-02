# Agent race leaderboard

Running tally for head-to-head Astryx v2 build rounds.

> The promote target was renamed `loop/conan-v2-astryx` → **`main-v2`** on
> 2026-08-02. Rows below keep the old name on purpose: they record where each
> round actually landed at the time, and the commits and tags they cite are
> unchanged. Only the *current* target moved.

| Round | Story | Winner | Branch / commit | Base commit after promotion | Preview | Notes |
|-------|-------|--------|-----------------|-----------------------------|---------|-------|
| p2b + US-503 | US-601/604/605 rich transcript + approval card; US-503 rename dialog | — (not a race: single-agent, Booker) | `booker/plan-approval-card` @ `8c8e420` | `loop/conan-v2-astryx` @ `8c8e420` / tags `checkpoint/v2-p2b-us-604`, `checkpoint/v2-p2b-us-503` | http://127.0.0.1:5220 | Sequential single-agent build with Nash as verification gate, not a head-to-head round — **no point scored**. Landed over af23281 → 611c894 → 8c8e420: tool rollups, timestamps, 800px measure, four-state thread status, approval card with the plan rendered inside it, permission-mode chip, and the rename dialog replacing v2's last `window.prompt`. UI 129/129, root 207/207, typechecks + build clean at the tip. US-604 and US-503 verified live on throwaway stacks; US-601/US-502 flags deliberately left false — code landed, no story-level browser pass. Known caveat: the flyout hover highlight was approved visually by Randy; Nash's headless pixel comparison could not detect it. |
| p2c | US-301..US-305 Full composer | Codex (Lane A single-agent run) | `randydaniel/p2c-lane-a` @ `c7c996d` | `loop/conan-v2-astryx` @ `c7c996d` / tag `checkpoint/v2-p2c` | http://127.0.0.1:5208 | Lane A completion: pins drawer, branch chip, provider·model·effort picker, @// input + paste/drop, assembled composer; 99/99 vitest; typecheck/build clean; v1 untouched. US-304b picker ↑↓/↵ navigation intentionally deferred. |
| p2a | US-201..US-204 Chat core walking skeleton | Grok | `thewhatmatters/v2-p2a-grok` @ `3fb6668` | `loop/conan-v2-astryx` @ `3fb6668` / tag `checkpoint/v2-p2a` | http://127.0.0.1:5204 | Full live turn (prompt → Working… → streamed reply) on :3804/:5204; 56/56 vitest; typecheck/build clean; v1 untouched. Claude didn't reply; ChatGPT/Codex rendered tool output in a bubble instead of the pattern. |
| T101 | US-101 a11y milestone | Integration (Claude + Codex + Grok) | `thewhatmatters/v2-t101-integration` @ `5e824f7` | `loop/conan-v2-astryx` @ `a627cef` / tag `checkpoint/v2-t101` | http://127.0.0.1:5198 | Three-agent parts merged; title injection + ProjectTree icon alignment fix; 46 tests; typecheck/build clean. |
| T0 | US-001 v2 shell foundation | Claude | `thewhatmatters/v2-t0-claude` @ `8d949a3` | `loop/conan-v2-astryx` @ `e57dd39` / tag `checkpoint/v2-t0` | http://127.0.0.1:5199 | Promoted; PRD merged w/ detailed RJ-0 node map; NewChatButton removed from sidebar footer; Vitest harness + 24 tests added. |

## Scoring

- 1 point per round win.
- Winner is chosen by manual review of the three previews against the PRD / Paper design.
- No auto-merging; the winning branch is promoted only after explicit approval and a clean commit.
