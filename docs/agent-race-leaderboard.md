# Agent race leaderboard

Running tally for head-to-head Astryx v2 build rounds.

| Round | Story | Winner | Branch / commit | Base commit after promotion | Preview | Notes |
|-------|-------|--------|-----------------|-----------------------------|---------|-------|
| T0 | US-001 v2 shell foundation | Claude | `thewhatmatters/v2-t0-claude` @ `8d949a3` | `loop/conan-v2-astryx` @ `5960920` | http://127.0.0.1:5199 | Promoted; resolved PRD merge conflict in favor of Claude’s detailed RJ-0 node map. Codex and Grok T0s remain on their branches. |

## Scoring

- 1 point per round win.
- Winner is chosen by manual review of the three previews against the PRD / Paper design.
- No auto-merging; the winning branch is promoted only after explicit approval and a clean commit.
