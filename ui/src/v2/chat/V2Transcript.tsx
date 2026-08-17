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
  ChatSystemMessage,
  ChatTokenizedText,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import type { ChatItem } from "../lib/useV2Chat.ts";
import V2BashView, { bashCommand } from "../components/V2BashView.tsx";
import V2AssistantContent from "./V2AssistantContent.tsx";
import V2ThinkingOrb from "./V2ThinkingOrb.tsx";

export interface V2TranscriptProps {
  items: ChatItem[];
  /** True while a turn is in flight — drives Working… + aria-busy. */
  busy?: boolean;
}

type ToolActivity = Extract<ChatItem, { role: "tool" | "approval" }>;
type TranscriptEntry =
  | Exclude<ChatItem, ToolActivity>
  | { id: string; role: "tools"; items: ToolActivity[] };

type TranscriptRow =
  | TranscriptEntry
  | { id: string; role: "date-divider"; label: string };

function localDayKey(ts?: number | null): string | null {
  if (ts == null) return null;
  const value = new Date(ts);
  return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
}

function groupToolActivity(items: ChatItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const item of items) {
    if (item.role !== "tool" && item.role !== "approval") {
      entries.push(item);
      continue;
    }
    const previous = entries[entries.length - 1];
    if (
      previous?.role === "tools" &&
      localDayKey(previous.items[previous.items.length - 1]?.ts) ===
        localDayKey(item.ts)
    ) {
      previous.items.push(item);
    } else {
      entries.push({ id: `tools-${item.id}`, role: "tools", items: [item] });
    }
  }
  return entries;
}

function entryTimestamp(item: TranscriptEntry): number | null | undefined {
  return item.role === "tools" ? item.items[0]?.ts : item.ts;
}

function isVisibleEntry(item: TranscriptEntry): boolean {
  if (
    item.role === "user" ||
    item.role === "assistant" ||
    item.role === "reasoning"
  ) {
    return Boolean(item.text);
  }
  return item.role === "tools" || item.role === "error";
}

function calendarDayNumber(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
}

function dateDividerLabel(ts: number, now: Date): string {
  const value = new Date(ts);
  const dayDifference =
    (calendarDayNumber(now) - calendarDayNumber(value)) / 86_400_000;
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(value.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(value);
}

function transcriptRows(items: ChatItem[], now = new Date()): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let previousDay: string | null = null;

  const visibleItems = items.filter((item, index) => {
    if (item.role !== "reasoning") return true;
    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      const later = items[cursor];
      if (later?.role === "user") return true;
      if (later?.role === "assistant" && later.text) return false;
    }
    return true;
  });

  for (const item of groupToolActivity(visibleItems).filter(isVisibleEntry)) {
    const ts = entryTimestamp(item);
    const day = localDayKey(ts);
    if (ts != null && day != null && day !== previousDay) {
      rows.push({
        id: `date-${day}-${item.id}`,
        role: "date-divider",
        label: dateDividerLabel(ts, now),
      });
      previousDay = day;
    }
    rows.push(item);
  }

  return rows;
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

function bashToolDetail(item: Extract<ChatItem, { role: "tool" }>) {
  const command = bashCommand(item.input);
  if (!command) return null;

  return (
    <div data-slot="v2-bash-tool-detail" {...stylex.props(styles.bashDetail)}>
      <ChatTokenizedText xstyle={styles.bashHeading}>Input</ChatTokenizedText>
      <V2BashView command={command} />
      {item.result ? (
        <div {...stylex.props(styles.bashResult)}>
          <ChatTokenizedText xstyle={styles.bashHeading}>Result</ChatTokenizedText>
          <V2AssistantContent text={item.result} />
        </div>
      ) : null}
    </div>
  );
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

  const richBashDetail = item.name === "Bash" ? bashToolDetail(item) : null;
  const detail = richBashDetail ? undefined : toolDetail(item.input, item.result);
  return {
    key: item.id,
    name: item.name,
    target: toolTarget(item.input),
    status: item.result == null ? "running" : item.isError ? "error" : "complete",
    errorMessage: item.isError ? item.result ?? "Tool call failed" : undefined,
    resultDetail:
      richBashDetail ?? (detail ? <V2AssistantContent text={detail} /> : undefined),
  };
}

/**
 * Has THIS turn produced assistant text yet?
 *
 * Scoped to everything after the last user message on purpose. The original
 * scanned the whole list with `.some()`, which meant that once a thread held
 * any assistant reply the thinking indicator could never show again — it
 * appeared on a thread's first turn and never afterwards. The old "Working…"
 * line was quiet enough that the gap went unnoticed; an orb would have made it
 * obvious. Found while verifying WHA-90 in the browser: the indicator never
 * rendered on a resumed thread, and a MutationObserver confirmed it was absent
 * rather than merely brief.
 */
function hasAssistantText(items: ChatItem[]): boolean {
  // Walk back to the last user message rather than `findLastIndex`, which this
  // project's TS lib target does not include (vitest runs it fine; tsc does not
  // — widening the lib for one call would be a repo-wide change for no gain).
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  const thisTurn = lastUser === -1 ? items : items.slice(lastUser + 1);
  return thisTurn.some(
    (item) => item.role === "assistant" && Boolean(item.text?.length),
  );
}

/** The only assistant row eligible for progressive Markdown rendering. */
function liveAssistantId(items: ChatItem[]): string | null {
  let candidate: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role === "user") return candidate;
    if (candidate == null && item?.role === "assistant" && item.text) {
      candidate = item.id;
    }
  }
  return null;
}

const styles = stylex.create({
  bashDetail: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--conan-space-2)",
    maxWidth: "100%",
    minWidth: 0,
    width: "100%",
  },
  bashHeading: {
    color: "var(--conan-text-muted)",
    fontSize: 11,
    fontWeight: 600,
  },
  bashResult: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--conan-space-2)",
    maxWidth: "100%",
    minWidth: 0,
    width: "100%",
  },
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
  toolCalls: {
    maxWidth: "100%",
    minWidth: 0,
    width: "100%",
  },
});

export default function V2Transcript({
  items,
  busy = false,
}: V2TranscriptProps) {
  const showWorking = busy && !hasAssistantText(items);
  const rows = transcriptRows(items);
  const streamingAssistantId = busy ? liveAssistantId(items) : null;

  return (
    <ChatMessageList
      data-slot="v2-transcript"
      isStreaming={busy}
      density="balanced"
      xstyle={styles.measure}
    >
      {rows.map((item) => {
        if (item.role === "date-divider") {
          return (
            <ChatSystemMessage
              key={item.id}
              variant="divider"
              data-slot="date-divider"
            >
              {item.label}
            </ChatSystemMessage>
          );
        }

        if (item.role === "user") {
          if (!item.text) return null;
          return (
            <ChatMessage key={item.id} sender="user">
              <ChatMessageBubble
                variant="filled"
                data-slot="user-message-bubble"
                metadata={<ChatMessageMetadata timestamp={timestamp(item.ts)} />}
              >
                <V2AssistantContent
                  text={item.text}
                  slot="user-message-content"
                />
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
              <V2AssistantContent
                text={item.text}
                isStreaming={item.id === streamingAssistantId}
              />
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
          // Unbubbled for the same reason as the working row above: a ghost
          // bubble's padding aligns to the user's filled bubble, not to the
          // assistant column this row belongs to. Metadata moves onto
          // ChatMessage, exactly as the assistant and tool rows already do.
          return (
            <ChatMessage
              key={item.id}
              sender="assistant"
              metadata={<ChatMessageMetadata timestamp={timestamp(item.ts)} />}
            >
              <Text type="supporting" color="secondary">Thinking…</Text>
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

      {/* WHA-90: the thinking state occupies the NEXT assistant-message slot,
          so when the first token lands the real message replaces it in place
          and nothing jumps.

          NO BUBBLE, deliberately. Astryx documents `ghost` as "no background,
          but keeps padding for consistent alignment" — that padding exists to
          line a ghost bubble up with a FILLED one, i.e. with the user's own
          message. Assistant prose here is UNBUBBLED, so wrapping the orb put
          it 16px (`--spacing-4` at balanced density) to the right of the text
          that replaces it, and the "nothing jumps" above was not true: it
          jumped left, every turn. Randy caught it twice. */}
      {showWorking ? (
        <ChatMessage sender="assistant" data-slot="v2-working">
          <V2ThinkingOrb />
        </ChatMessage>
      ) : null}
    </ChatMessageList>
  );
}
