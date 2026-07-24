export interface AgentFileAttachment {
  type: "file";
  path: string;
  content: string;
  truncated: boolean;
  originalBytes: number;
  sentBytes: number;
  /** Pins are per-turn unless a composer explicitly retains one. */
  keep?: boolean;
}

/** One browser-supplied image, normalized at the gateway boundary.
 *
 * `data` is the original bounded base64 payload used by providers with an
 * inline image wire shape. `stagedPath` points at the same bytes in Conan's
 * managed temporary directory for CLIs that accept filesystem paths.
 */
export interface AgentImageAttachment {
  type: "image";
  mediaType: string;
  data: string;
  bytes: number;
  stagedPath: string;
}

export interface AgentTurn {
  text: string;
  attachments: AgentFileAttachment[];
  /** Additive so callers that only send text/files retain their exact wire
   * shape. The gateway always supplies this once image staging is enabled. */
  images?: AgentImageAttachment[];
}

export const MAX_PIN_BYTES = 32 * 1024;
export const MAX_PIN_TOTAL_BYTES = 64 * 1024;
export const MAX_PIN_COUNT = 8;

/** Validate and bound untrusted attachment frames from the browser. */
export function prepareFileAttachments(value: unknown): AgentFileAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: AgentFileAttachment[] = [];
  let remaining = MAX_PIN_TOTAL_BYTES;
  for (const raw of value.slice(0, MAX_PIN_COUNT)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "file" || typeof item.path !== "string") continue;
    if (typeof item.content !== "string" || !item.path.trim()) continue;
    const source = Buffer.from(item.content, "utf8");
    const content = source.subarray(0, Math.min(MAX_PIN_BYTES, remaining)).toString("utf8");
    const sentBytes = Buffer.byteLength(content, "utf8");
    out.push({
      type: "file",
      path: item.path.trim(),
      content,
      truncated: sentBytes < source.byteLength,
      originalBytes: source.byteLength,
      sentBytes,
      ...(item.keep === true ? { keep: true } : {}),
    });
    remaining -= sentBytes;
  }
  return out;
}

/** Serialize the exact bounded pins after the user's ordinary prompt. */
export function serializeTurnPrompt(turn: AgentTurn): string {
  if (turn.attachments.length === 0) return turn.text;
  const blocks = turn.attachments.map((pin, index) => {
    const status = pin.truncated
      ? `TRUNCATED: sent ${pin.sentBytes} of ${pin.originalBytes} UTF-8 bytes`
      : `complete: ${pin.sentBytes} UTF-8 bytes`;
    return [
      `--- BEGIN PINNED FILE ${index + 1} ---`,
      `Path: ${JSON.stringify(pin.path)}`,
      `Status: ${status}`,
      pin.content,
      `--- END PINNED FILE ${index + 1} ---`,
    ].join("\n");
  });
  return `${turn.text}\n\n${blocks.join("\n\n")}`;
}
