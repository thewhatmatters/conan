/**
 * V2Transcript — Astryx-native message bubbles, metadata, and tool rollups.
 *
 * The gateway already folds tool results into their matching tool-use item and
 * timestamps every transcript item. This component stays presentation-only:
 * adjacent tool activity becomes one ChatToolCalls rollup, user prose uses a
 * filled bubble, and assistant prose stays unbubbled for a quieter reading
 * column (the Astryx AI-chat pattern).
 */
import * as stylex from "@stylexjs/stylex";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatTokenizedText,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import type { ChatItem } from "../lib/useV2Chat.ts";

export interface V2TranscriptProps {
  items: ChatItem[];
  /** True while a turn is in flight — drives Working… + aria-busy. */
  busy?: boolean;
}

type ToolActivity = Extract<ChatItem, { role: "tool" | "approval" }>;
type TranscriptEntry =
  | Exclude<ChatItem, ToolActivity>
  | { id: string; role: "tools"; items: ToolActivity[] };

function groupToolActivity(items: ChatItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const item of items) {
    if (item.role !== "tool" && item.role !== "approval") {
      entries.push(item);
      continue;
    }
    const previous = entries[entries.length - 1];
    if (previous?.role === "tools") {
      previous.items.push(item);
    } else {
      entries.push({ id: `tools-${item.id}`, role: "tools", items: [item] });
    }
  }
  return entries;
}

function timestamp(ts?: number | null) {
  if (ts == null) return undefined;
  const value = new Date(ts);
  const today = new Date();
  const isToday =
    value.getFullYear() === today.getFullYear() &&
    value.getMonth() === today.getMonth() &&
    value.getDate() === today.getDate();
  // Astryx Timestamp accepts Unix seconds; ChatItem stores epoch milliseconds.
  return <Timestamp value={ts / 1000} format={isToday ? "time" : "date_time"} />;
}

function toolTarget(input: unknown): string | undefined {
  let value: string | undefined;
  if (typeof input === "string") {
    value = input;
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "path", "file_path", "query", "url", "pattern"]) {
      if (typeof record[key] === "string" && record[key]) {
        value = record[key];
        break;
      }
    }
  } else {
    return undefined;
  }
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 95)}…` : normalized;
}

function toolDetail(input: unknown, result: string | null): string | undefined {
  let serializedInput: string | undefined;
  if (typeof input === "string") {
    serializedInput = input;
  } else if (input != null) {
    try {
      serializedInput = JSON.stringify(input, null, 2);
    } catch {
      serializedInput = String(input);
    }
  }
  const sections = [
    serializedInput ? `Input\n${serializedInput}` : null,
    result ? `Result\n${result}` : null,
  ].filter((section): section is string => section != null);
  return sections.length ? sections.join("\n\n") : undefined;
}

function toolCall(item: ToolActivity): ChatToolCallItem {
  if (item.role === "approval") {
    return {
      key: item.id,
      name: item.toolName || "approval",
      target: item.summary,
      status:
        item.resolution === "pending"
          ? "pending"
          : item.resolution === "decline" ||
              item.resolution === "cancel" ||
              item.resolution === "dismissed"
            ? "error"
            : "complete",
      errorMessage:
        item.resolution === "decline" ||
        item.resolution === "cancel" ||
        item.resolution === "dismissed"
          ? `Approval ${item.resolution}`
          : undefined,
    };
  }

  const detail = toolDetail(item.input, item.result);
  return {
    key: item.id,
    name: item.name,
    target: toolTarget(item.input),
    status: item.result == null ? "running" : item.isError ? "error" : "complete",
    errorMessage: item.isError ? item.result ?? "Tool call failed" : undefined,
    resultDetail: detail ? (
      <Text type="supporting" color="secondary" xstyle={styles.toolResult}>
        {detail}
      </Text>
    ) : undefined,
  };
}

function hasAssistantText(items: ChatItem[]): boolean {
  return items.some(
    (item) => item.role === "assistant" && Boolean(item.text?.length),
  );
}

const styles = stylex.create({
  // The chat column's measure — the SAME axis the composer sits on, so message
  // text and the input line up. Applied to ChatMessageList itself rather than a
  // wrapper: ChatLayout expects the list as its direct child (it owns the flex
  // spacer that pins messages to the bottom), and wrapping it strands the
  // messages above the viewport.
  measure: {
    marginInline: "auto",
    maxWidth: "var(--conan-chat-measure)",
    width: "100%",
  },
  toolResult: {
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  toolCalls: {
    maxWidth: "100%",
    minWidth: 0,
    width: "100%",
  },
  assistantContent: {
    display: "block",
    maxWidth: "100%",
    minWidth: 0,
    overflowWrap: "anywhere",
    width: "100%",
  },
});

export default function V2Transcript({
  items,
  busy = false,
}: V2TranscriptProps) {
  const showWorking = busy && !hasAssistantText(items);
  const entries = groupToolActivity(items);

  return (
    <ChatMessageList
      data-slot="v2-transcript"
      isStreaming={busy}
      density="balanced"
      xstyle={styles.measure}
    >
      {entries.map((item) => {
        if (item.role === "user") {
          if (!item.text) return null;
          return (
            <ChatMessage key={item.id} sender="user">
              <ChatMessageBubble
                variant="filled"
                data-slot="user-message-bubble"
                metadata={<ChatMessageMetadata timestamp={timestamp(item.ts)} />}
              >
                <ChatTokenizedText>{item.text}</ChatTokenizedText>
              </ChatMessageBubble>
            </ChatMessage>
          );
        }

        if (item.role === "assistant") {
          if (!item.text) return null;
          return (
            <ChatMessage
              key={item.id}
              sender="assistant"
              metadata={<ChatMessageMetadata timestamp={timestamp(item.ts)} />}
            >
              <ChatTokenizedText
                data-slot="assistant-message-content"
                xstyle={styles.assistantContent}
              >
                {item.text}
              </ChatTokenizedText>
            </ChatMessage>
          );
        }

        if (item.role === "tools") {
          const lastTimestamp = item.items[item.items.length - 1]?.ts;
          return (
            <ChatMessage
              key={item.id}
              sender="assistant"
              metadata={<ChatMessageMetadata timestamp={timestamp(lastTimestamp)} />}
            >
              <ChatToolCalls calls={item.items.map(toolCall)} xstyle={styles.toolCalls} />
            </ChatMessage>
          );
        }

        if (item.role === "reasoning" && item.text) {
          return (
            <ChatMessage key={item.id} sender="assistant">
              <ChatMessageBubble
                variant="ghost"
                metadata={<ChatMessageMetadata timestamp={timestamp(item.ts)} />}
              >
                <Text type="supporting" color="secondary">Thinking…</Text>
              </ChatMessageBubble>
            </ChatMessage>
          );
        }

        if (item.role === "error") {
          return (
            <ChatMessage key={item.id} sender="system">
              <Text type="supporting" color="secondary">{item.message}</Text>
            </ChatMessage>
          );
        }

        return null;
      })}

      {showWorking ? (
        <ChatMessage sender="assistant" data-slot="v2-working">
          <ChatMessageBubble variant="ghost">
            <Text type="supporting" color="secondary">Working…</Text>
          </ChatMessageBubble>
        </ChatMessage>
      ) : null}
    </ChatMessageList>
  );
}
