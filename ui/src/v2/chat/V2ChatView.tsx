/**
 * V2ChatView — the content-well chat host (p2a walking skeleton).
 *
 * US-201: ChatLayout shell docks a composer slot and owns auto-scroll /
 * jump-to-present. Transcript body is empty this story; US-202 fills it and
 * US-203 owns the real composer. One useV2Chat instance per well.
 */
import * as stylex from "@stylexjs/stylex";
import { ChatLayout, ChatComposer } from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { useV2Chat } from "../lib/useV2Chat.ts";
import type { ActiveThread } from "../lib/types.ts";

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
});

export default function V2ChatView({ token, activeThread }: V2ChatViewProps) {
  // Open the socket as soon as we have a token so a send after selection does
  // not race a cold connect. Selection only supplies cwd/provider for send.
  useV2Chat(token);

  const emptyLabel = activeThread
    ? "Send a message to start this thread."
    : "Select a thread to start chatting.";

  return (
    <ChatLayout
      data-slot="content"
      data-chat-view="v2"
      xstyle={styles.layout}
      emptyState={
        <Text type="supporting" color="secondary">
          {emptyLabel}
        </Text>
      }
      composer={
        // Stub until US-203 lands V2Composer — ChatLayout requires the slot.
        <ChatComposer
          onSubmit={() => {}}
          value=""
          onChange={() => {}}
          placeholder="Ask anything"
          isDisabled
        />
      }
    >
      {null}
    </ChatLayout>
  );
}
