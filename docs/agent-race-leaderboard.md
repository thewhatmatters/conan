# Agent race leaderboard

Running tally for head-to-head Astryx v2 build rounds.

| Round | Story | Winner | Branch / commit | Base commit after promotion | Preview | Notes |
|-------|-------|--------|-----------------|-----------------------------|---------|-------|
| T101 | US-101 a11y milestone | Integration (Claude + Codex + Grok) | `thewhatmatters/v2-t101-integration` @ `5e824f7` | `loop/conan-v2-astryx` @ `24ab095` / tag `checkpoint/v2-t101` | http://127.0.0.1:5198 | Three-agent parts merged; title injection + ProjectTree icon alignment fix; 46 tests; typecheck/build clean. |
| T0 | US-001 v2 shell foundation | Claude | `thewhatmatters/v2-t0-claude` @ `8d949a3` | `loop/conan-v2-astryx` @ `e57dd39` / tag `checkpoint/v2-t0` | http://127.0.0.1:5199 | Promoted; PRD merged w/ detailed RJ-0 node map; NewChatButton removed from sidebar footer; Vitest harness + 24 tests added. |

## Scoring

- 1 point per round win.
- Winner is chosen by manual review of the three previews against the PRD / Paper design.
- No auto-merging; the winning branch is promoted only after explicit approval and a clean commit.
