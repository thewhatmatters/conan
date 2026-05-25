// US-007: normalize Claude Code's newline-delimited stream-json output into
// rows for the `event` table plus token/cost updates for the `session` row.
//
// The CLI is launched with `--output-format stream-json --verbose
// --include-partial-messages`, which emits these top-level message types:
//   - system/init       — model, tools, mcp_servers, plugins, plugin_errors
//   - system/api_retry   — surfaced when the API call is retried (rate limits)
//   - stream_event       — wraps a raw Anthropic streaming event (message_start,
//                          content_block_start/delta/stop, message_delta/stop)
//   - assistant / user   — full AssistantMessage / tool-result messages
//   - result             — final ResultMessage with usage + total_cost_usd
//
// This module is intentionally pure (no DB, no I/O) so it can be unit-tested
// against captured stream lines; the session manager does the persistence.

/** A normalized event ready to persist into the `event` table. */
export interface NormalizedEvent {
  /** Coarse stream classification, e.g. "system/init", "stream_event:content_block_delta". */
  streamType: string;
  /** null for stream-json rows (hook_event_name is for the US-004 hook path). */
  hookEventName: string | null;
  /** Tool name when the event concerns a tool_use block. */
  toolName: string | null;
  /** Preserved for subagent nesting (US-021). */
  parentToolUseId: string | null;
  /** JSON-serializable payload stored verbatim. */
  payload: unknown;
}

/** Token-usage / cost figures captured onto the session row. */
export interface UsageUpdate {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Context-window position = input + cache_read + cache_creation tokens. */
  contextTokens?: number;
  totalCostUsd?: number;
}

/** The result of parsing one stream-json line. */
export interface ParsedMessage {
  /** Session id, present only on system/init. */
  sessionId: string | null;
  /** Model slug, present only on system/init. */
  model: string | null;
  /** The row to persist, or null when the line carries nothing to store. */
  event: NormalizedEvent | null;
  /** Session-row token/cost update, or null when the line carries no usage. */
  usage: UsageUpdate | null;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Pull token figures out of an Anthropic-style `usage` object. */
function extractUsage(usage: unknown): UsageUpdate | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const out: UsageUpdate = {};
  const input = asNumber(u.input_tokens);
  const output = asNumber(u.output_tokens);
  const cacheRead = asNumber(u.cache_read_input_tokens);
  const cacheCreate = asNumber(u.cache_creation_input_tokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cacheRead !== undefined) out.cacheReadInputTokens = cacheRead;
  if (cacheCreate !== undefined) out.cacheCreationInputTokens = cacheCreate;
  // The context-window position is everything that went *in* to the model.
  const ctx = (input ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);
  if (ctx > 0) out.contextTokens = ctx;
  return Object.keys(out).length ? out : null;
}

/** First tool_use block's name within a message's content array, if any. */
function toolNameFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "tool_use"
    ) {
      return asString((block as Record<string, unknown>).name);
    }
  }
  return null;
}

/**
 * Parse one newline-delimited stream-json line into a normalized message.
 * Returns null for blank lines or unparseable JSON (callers skip those).
 */
export function parseStreamMessage(raw: string): ParsedMessage | null {
  const line = raw.trim();
  if (!line) return null;

  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Record<string, unknown>;
  const type = m.type;
  const parentToolUseId = asString(m.parent_tool_use_id);

  // --- system/* -----------------------------------------------------------
  if (type === "system") {
    const subtype = asString(m.subtype) ?? "unknown";
    if (subtype === "init") {
      return {
        sessionId: asString(m.session_id),
        model: asString(m.model),
        event: {
          streamType: "system/init",
          hookEventName: null,
          toolName: null,
          parentToolUseId,
          payload: {
            model: m.model,
            tools: m.tools,
            mcp_servers: m.mcp_servers,
            plugins: m.plugins,
            plugin_errors: m.plugin_errors,
            slash_commands: m.slash_commands,
            permissionMode: m.permissionMode,
          },
        },
        usage: null,
      };
    }
    // api_retry and any other system subtype: store the whole message.
    return {
      sessionId: null,
      model: null,
      event: {
        streamType: `system/${subtype}`,
        hookEventName: null,
        toolName: null,
        parentToolUseId,
        payload: m,
      },
      usage: null,
    };
  }

  // --- stream_event (partial messages) ------------------------------------
  if (type === "stream_event") {
    const ev = (m.event ?? {}) as Record<string, unknown>;
    const inner = asString(ev.type) ?? "unknown";
    let toolName: string | null = null;
    let usage: UsageUpdate | null = null;
    let payload: unknown = ev;

    if (inner === "content_block_start") {
      const cb = (ev.content_block ?? {}) as Record<string, unknown>;
      if (cb.type === "tool_use") toolName = asString(cb.name);
      payload = { type: inner, index: ev.index, content_block: cb };
    } else if (inner === "content_block_delta") {
      // Criterion: extract text_delta and input_json_delta from the delta.
      const delta = (ev.delta ?? {}) as Record<string, unknown>;
      payload = { type: inner, index: ev.index, delta };
    } else if (inner === "message_delta") {
      usage = extractUsage(ev.usage);
      payload = { type: inner, delta: ev.delta, usage: ev.usage };
    } else if (inner === "message_start") {
      const message = (ev.message ?? {}) as Record<string, unknown>;
      usage = extractUsage(message.usage);
    }

    return {
      sessionId: null,
      model: null,
      event: {
        streamType: `stream_event:${inner}`,
        hookEventName: null,
        toolName,
        parentToolUseId,
        payload,
      },
      usage,
    };
  }

  // --- assistant / user messages ------------------------------------------
  if (type === "assistant" || type === "user") {
    const message = (m.message ?? {}) as Record<string, unknown>;
    return {
      sessionId: null,
      model: null,
      event: {
        streamType: type,
        hookEventName: null,
        toolName: toolNameFromContent(message.content),
        parentToolUseId,
        payload: message,
      },
      usage: extractUsage(message.usage),
    };
  }

  // --- control protocol (headless permission prompts, US-012) -------------
  // In stream-json mode Claude Code asks for tool permission by emitting a
  // control_request{subtype:"can_use_tool"} and blocking on stdin for our
  // control_response. We surface it as an event so the timeline can render an
  // inline Approve/Deny control; control_cancel_request supersedes a prompt.
  if (type === "control_request") {
    const request = (m.request ?? {}) as Record<string, unknown>;
    const subtype = asString(request.subtype) ?? "unknown";
    const requestId = asString(m.request_id) ?? asString(request.request_id);
    if (subtype === "can_use_tool") {
      return {
        sessionId: null,
        model: null,
        event: {
          streamType: "control_request:can_use_tool",
          hookEventName: null,
          toolName: asString(request.tool_name),
          parentToolUseId,
          payload: {
            request_id: requestId,
            tool_name: request.tool_name,
            input: request.input,
            permission_suggestions: request.permission_suggestions,
          },
        },
        usage: null,
      };
    }
    return {
      sessionId: null,
      model: null,
      event: {
        streamType: `control_request:${subtype}`,
        hookEventName: null,
        toolName: null,
        parentToolUseId,
        payload: { request_id: requestId, ...request },
      },
      usage: null,
    };
  }
  if (type === "control_cancel_request") {
    return {
      sessionId: null,
      model: null,
      event: {
        streamType: "control_cancel_request",
        hookEventName: null,
        toolName: null,
        parentToolUseId,
        payload: { request_id: asString(m.request_id) },
      },
      usage: null,
    };
  }

  // --- result (final message) ---------------------------------------------
  if (type === "result") {
    const usage = extractUsage(m.usage) ?? {};
    const total = asNumber(m.total_cost_usd);
    if (total !== undefined) usage.totalCostUsd = total;
    return {
      sessionId: null,
      model: null,
      event: {
        streamType: "result",
        hookEventName: null,
        toolName: null,
        parentToolUseId,
        payload: m,
      },
      usage: Object.keys(usage).length ? usage : null,
    };
  }

  // --- anything else: persist generically so nothing is silently dropped ---
  return {
    sessionId: null,
    model: null,
    event: {
      streamType: asString(type) ?? "unknown",
      hookEventName: null,
      toolName: null,
      parentToolUseId,
      payload: m,
    },
    usage: null,
  };
}
