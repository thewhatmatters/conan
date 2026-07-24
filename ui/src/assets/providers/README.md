# Provider avatar icons

Drop the three provider SVGs here, named by **provider id** (from
`src/agent/registry.ts`):

- `claude.svg`  — Anthropic Claude
- `codex.svg`   — OpenAI Codex
- `grok.svg`    — X / xAI Grok

Used by the sidebar `AgentAvatar` (ChatSurface.tsx) and the future unified
provider/model picker, replacing the C/X/G letter fallback. Author them to
inherit color where possible (`fill="currentColor"` / no hard-coded hex) so
they read in light + dark; the letter avatar stays as the fallback for a
provider with no icon.
