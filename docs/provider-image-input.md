# Provider image-input probes

Verified on 2026-07-24 with a real 68-byte, 1×1 PNG from a throwaway
`/tmp/conan-image-probe.*` directory. Probe prompts asked only
`Reply with exactly: ok`.

| Provider | Version | Headless image input | Verified shape | Multiple images | Provider size cap |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 2.1.219 | Yes | A stream-JSON user message content block: `{type:"image",source:{type:"base64",media_type:"image/png",data:"..."}}`, alongside the text block | Shape permits multiple blocks; not separately load-tested | **UNKNOWN** |
| Codex | 0.144.6 | Yes | Repeated `-i <FILE>` options on `codex exec`; paths are read by the spawned turn | Yes; two real PNG paths succeeded | **UNKNOWN** |
| Grok | 0.2.111 | Yes | `--prompt-json` with ACP blocks: `{type:"image",data:"...",mimeType:"image/png"}` plus `{type:"text",text:"..."}` | Yes; two real image blocks succeeded | **UNKNOWN** |

## Evidence

### Claude Code

The exact request is pinned in
`src/agent/fixtures/claude-image-user-message.json`. Piping that envelope to:

```text
claude --print --output-format stream-json --input-format stream-json --verbose
```

produced a normal `system/init`, an assistant text block containing `ok`, and
a successful result. The bytes remain base64 inline; no file path is needed.

### Codex

The exact argv is pinned in `src/agent/fixtures/codex-image-argv.json`. Two
repeated `-i` options produced a normal `thread.started` / `turn.completed`
run and the answer `ok`.

The drafted PRD described `-i` as initial-prompt-only. That is no longer true
in Codex 0.144.6: `codex exec resume --help` advertises `-i, --image <FILE>`,
and a real resumed turn with an image completed successfully while retaining
the same thread id. Conan runs one Codex process per turn, so both initial and
resumed turns attach images to that turn's process.

The CLI exposes no trustworthy maximum image size. Conan must enforce its own
limit rather than inventing a provider cap.

### Grok

The Claude-style nested `source` shape was rejected with:

```text
Invalid ACP content blocks: missing field `data`
```

The ACP shape pinned in `src/agent/fixtures/grok-image-prompt-json.json`
succeeded and returned `ok`. A second run with two image blocks also
succeeded. Grok therefore supports headless image input, but through
`--prompt-json`, not `-p`.

The CLI exposes no trustworthy maximum image size. Conan must enforce its own
limit.
