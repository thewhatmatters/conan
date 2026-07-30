/**
 * V2Transcript — plain-text streaming transcript for the p2a skeleton (US-202).
 *
 * Renders useV2Chat().items via Astryx ChatMessageList + ChatMessage +
 * ChatMessageBubble + ChatTokenizedText. Tool/plan/approval items get a
 * one-line placeholder (rich cards are p2b). Auto-scroll lives in ChatLayout.
 */
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatTokenizedText,
} from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import type { ChatItem } from "../lib/useV2Chat.ts";

export interface V2TranscriptProps {
  items: ChatItem[];
  /** True while a turn is in flight — drives Working… + aria-busy. */
  busy?: boolean;
}

function isRenderableText(item: ChatItem): item is ChatItem & {
  role: "user" | "assistant";
  text: string;
} {
  return (
    (item.role === "user" || item.role === "assistant") &&
    typeof (item as { text?: string }).text === "string" &&
    (item as { text: string }).text.length > 0
  );
}

function toolPlaceholder(item: ChatItem): string | null {
  switch (item.role) {
    case "tool":
      return item.name ? `ran a tool · ${item.name}` : "ran a tool";
    case "approval":
      return "ran a tool · approval";
    case "reasoning":
      // Hidden for providers that redact thought text; if present, one line.
      return item.text ? "thinking…" : null;
    case "error":
      return item.message;
    case "system":
    case "mode":
    case "result":
      return null;
    default:
      return null;
  }
}

function hasAssistantText(items: ChatItem[]): boolean {
  return items.some(
    (item) => item.role === "assistant" && Boolean(item.text?.length),
  );
}

export default function V2Transcript({
  items,
  busy = false,
}: V2TranscriptProps) {
  const showWorking = busy && !hasAssistantText(items);

  return (
    <ChatMessageList
      data-slot="v2-transcript"
      isStreaming={busy}
      density="balanced"
    >
      {items.map((item) => {
        if (isRenderableText(item)) {
          return (
            <ChatMessage key={item.id} sender={item.role}>
              <ChatMessageBubble>
                <ChatTokenizedText>{item.text}</ChatTokenizedText>
              </ChatMessageBubble>
            </ChatMessage>
          );
        }

        const placeholder = toolPlaceholder(item);
        if (!placeholder) return null;

        return (
          <ChatMessage key={item.id} sender="system">
            <Text type="supporting" color="secondary">
              {placeholder}
            </Text>
          </ChatMessage>
        );
      })}

      {showWorking ? (
        <ChatMessage sender="assistant" data-slot="v2-working">
          <ChatMessageBubble variant="ghost">
            <Text type="supporting" color="secondary">
              Working…
            </Text>
          </ChatMessageBubble>
        </ChatMessage>
      ) : null}
    </ChatMessageList>
  );
}
