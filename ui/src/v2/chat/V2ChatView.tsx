/**
 * V2ChatView — the content-well chat host (p2a walking skeleton).
 *
 * US-201: ChatLayout shell.
 * US-204: composes one useV2Chat with V2Transcript (message area) +
 * V2Composer (docked foot). Auto-scroll / jump-to-present come free from
 * ChatLayout.
 */
import * as stylex from "@stylexjs/stylex";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useV2Chat } from "../lib/useV2Chat.ts";
import type { ActiveThread } from "../lib/types.ts";
import V2Transcript from "./V2Transcript.tsx";
import V2Composer from "./V2Composer.tsx";

export interface V2ChatViewProps {
  /** Gateway auth token; null until /api/config resolves — no socket then. */
  token: string | null;
  /** Sidebar selection; null until the user picks a thread. */
  activeThread: ActiveThread | null;
}

const styles = stylex.create({
  layout: {
    flexGrow: 1,
    height: "100%",
    minHeight: 0,
  },
  // ONE measure for the transcript and the composer, so message text and the
  // input share a vertical axis. Applied to the CONTENT, not to ChatLayout —
  // the frosted dock and the scroll area still span the whole well.
  measure: {
    marginInline: "auto",
    maxWidth: "var(--conan-chat-measure)",
    width: "100%",
  },
});

export default function V2ChatView({ token, activeThread }: V2ChatViewProps) {
  const { items, send, status, busy, interrupt } = useV2Chat(token);
  const hasItems = items.length > 0;

  const emptyLabel = activeThread
    ? "Send a message to start this thread."
    : "Select a thread to start chatting.";

  return (
    <ChatLayout
      data-slot="content"
      data-chat-view="v2"
      xstyle={styles.layout}
      emptyState={
        hasItems ? undefined : (
          <Text type="supporting" color="secondary">
            {emptyLabel}
          </Text>
        )
      }
      composer={
        <VStack gap={0} xstyle={styles.measure}>
          <V2Composer
            activeThread={activeThread}
            token={token}
            busy={busy}
            // Provider/model identify the session and lock after the first turn.
            // Effort is deliberately separate and remains a per-turn choice.
            locked={items.some((item) => item.role === "user")}
            disabled={status !== "open" || !token}
            send={send}
            interrupt={interrupt}
          />
        </VStack>
      }
    >
      {/* NOT wrapped: ChatLayout owns the flex spacer that pins messages to the
          bottom of the scroll area, and it only works when ChatMessageList is
          the direct child — a wrapper strands the messages above the viewport.
          V2Transcript applies the shared measure to the list itself. */}
      {hasItems || busy ? (
        <V2Transcript items={items} busy={busy} />
      ) : null}
    </ChatLayout>
  );
}
