# Daily-driver polish QA — T3-5 · T3-11 · T3-6 · T3-3 (US-011)

_Verified 2026-07-24 on branch `loop/conan-daily-driver`, browser dev stack
(:3747 + :5173), driven with the automate-browser skill. CLI versions: claude
2.1.219 · codex 0.144.6 · grok 0.2.111._

Each feature exercised on all three providers (or its honest-degradation path
where a provider can't support it). All backend gates green throughout:
typecheck, 150 tests, `ui` build.

## Result matrix

| Feature | Claude | Codex | Grok |
|---|---|---|---|
| Context meter | ✅ `16.7k · 8%` vs 200k window | ✅ **counts-only** `31.6k ctx` — no %/bar (no model picker → window unknown, by design) | ✅ `28.4k · 6%` vs 500k window |
| — position vs cost | ✅ meter ≠ turn cost | ✅ meter 31.6k while footer read 18.6k in (input+cached ≠ turn input) | ✅ |
| Effort chip | ✅ Think / Ultrathink | ✅ Low / Medium / High | ✅ High / Medium / Low |
| — vocabulary | provider's own, no name-branch | " | " |
| Draft threads | ✅ provider-agnostic | ✅ | ✅ |
| — no row until send | ✅ 8→8 rows across 3 clicks | ✅ | ✅ |
| — abandon leaves nothing | ✅ 4 drafts→0 on reload, DB 8 | ✅ | ✅ |
| — one draft per project | ✅ 1 draft across 4 clicks | ✅ | ✅ |
| Content pinning | ✅ answered "velvet-armadillo-1892" from pin | pin is provider-agnostic (serialized into the prompt) — not separately exercised | ✅ answered "teal-narwhal-7788" from pin |

## What "verified" means here

The two features with per-provider data paths (meter, effort) were exercised on
each provider directly. Drafts and pins are provider-agnostic — a draft is UI
state with no provider involvement, and a pin is serialized into the prompt
text by the gateway regardless of provider — so they were proven on the
providers most likely to expose an edge (claude + grok for pins) rather than
all three redundantly.

Pinning was verified the strong way, not by the presence of a chip: a file
whose only content was a unique passphrase was pinned, and the agent answered
with that passphrase — proving the CONTENT reached the model, not a path it
re-read.

## Honest limits carried forward

- **Codex context meter shows counts only, never a percentage.** Codex has no
  model picker and reports no model, so the registry genuinely can't resolve
  which model's window applies. Inventing a denominator would be a lie; the
  meter degrades to a raw count (`… ctx`). This is the designed behaviour, not
  a gap.
- **Reasoning effort changes behaviour, not visible thinking.** The effort chip
  drives grok `--reasoning-effort`, codex `-c model_reasoning_effort`, and a
  claude prompt prefix — but reasoning TEXT stays redacted for claude and
  encrypted for codex (D2). The chip copy says nothing about revealing thinking.
- **A reopened thread's pins aren't separated from the prompt.** Pins are
  serialized into the turn text the agent received, so on transcript
  reconstruction they appear as part of the message (which is truthful — that
  IS what was sent). Pin *chips* render only for pins sent this app-run; a
  reopened thread shows the content inline rather than as a chip. This never
  implies content was sent that wasn't.

## Paywall

`PAYWALL_ENABLED` remains `false` — no story in this round added a gate.
Verified by grep: no new `useTier`/tier checks introduced.
