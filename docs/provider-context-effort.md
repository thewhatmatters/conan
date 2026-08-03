# Provider context and reasoning-effort facts

Verified on 2026-07-24 with Claude Code 2.1.219, Codex CLI 0.144.6, and
Grok 0.2.111. The live probes ran from throwaway directories with the prompt
`Reply with exactly: ok`.

## Context windows

| Provider | Model | Context window | Evidence |
|---|---|---:|---|
| Claude | Standard Claude models | 200,000 | Product limit recorded by the daily-driver PRD probe |
| Claude | Long-context Claude models | 1,000,000 | Product limit recorded by the daily-driver PRD probe |
| Claude | `opus` (v2 picker alias) | 1,000,000 | v2 model picker advertises "Opus 5 · 1M context"; corrected from 200k after live CLI probe |
| Claude | `fable` (v2 picker alias) | 1,000,000 | v2 model picker advertises "Fable 5 · 1M context" |
| Claude | `sonnet` (v2 picker alias) | 200,000 | v2 model picker advertises "Sonnet 5 · 200k context" |
| Claude | `haiku` (v2 picker alias) | 200,000 | v2 model picker advertises "Haiku 4.5 · 200k context" |
| Claude | `claude-opus-5` | 1,000,000 | Live CLI `system/init` reports `claude-opus-5[1m]`; bracket suffix denotes the 1M window |
| Claude | `claude-sonnet-5` | 200,000 | Inferred from bracket suffix `[200k]` and matching v2 picker label |
| Claude | `claude-fable-5` | 1,000,000 | v2 model picker advertises "Fable 5 · 1M context" |
| Claude | `claude-haiku-4-5` | 200,000 | v2 model picker advertises "Haiku 4.5 · 200k context" |
| Claude | `claude-3-opus-20240229` | 200,000 | Anthropic Claude 3 Opus product limit |
| Claude | `claude-3-5-sonnet-20241022` | 200,000 | Anthropic Claude 3.5 Sonnet product limit |
| Codex | `gpt-5.6-sol` | 272,000 | CLI model cache; the CLI exposes 258,400 usable tokens after its 95% allowance |
| Codex | `gpt-5.6-terra` | 272,000 | CLI model cache; 95% usable |
| Codex | `gpt-5.6-luna` | 272,000 | CLI model cache; 95% usable |
| Codex | `gpt-5.5` | 272,000 | CLI model cache; 95% usable |
| Codex | `gpt-5.4` | 272,000 | CLI model cache; 1,000,000 is advertised as a maximum, not the active window |
| Codex | `gpt-5.4-mini` | 272,000 | CLI model cache; 95% usable |
| Codex | `gpt-5.3-codex-spark` | 128,000 | CLI model cache; 95% usable |
| Codex | `codex-auto-review` | 272,000 | CLI model cache; 1,000,000 is advertised as a maximum, not the active window |
| Codex | Any other model | **UNKNOWN** | No verified model entry |
| Grok | `grok-4.5` | 500,000 | CLI model cache and per-session `contextWindowTokens` telemetry |
| Grok | Any other model | **UNKNOWN** | No verified model entry |

The application must return `null` for every `UNKNOWN` entry. It must not use
a provider-wide fallback when the selected model is unverified.

## Reasoning effort

| Provider | Mechanism verified for this round | Values |
|---|---|---|
| Claude | No mechanism used by Conan; apply prompt-level phrasing | Provider vocabulary defined by the driver |
| Codex | `-c model_reasoning_effort=<level>`; accepted with `--strict-config` | `low`, `medium`, `high` |
| Grok | `--reasoning-effort <level>` (alias `--effort`); invalid values are rejected client-side | `high`, `medium`, `low` |

The installed Claude Code 2.1.219 help now advertises an `--effort` option,
but the locked daily-driver contract was verified against an earlier CLI and
requires prompt-level phrasing. Conan therefore keeps Claude effort at the
prompt seam for this round rather than silently changing the agreed mechanism.

## Per-turn usage fields

| Provider | Reported fields |
|---|---|
| Claude | `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens` |
| Codex | `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` |
| Grok | `input_tokens`, `cache_read_input_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens` |

Context position is the latest turn's input plus cached input. It is not the
same quantity as the turn's total token cost.
