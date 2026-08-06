/**
 * V2ChatView — the content-well chat host (p2a walking skeleton).
 *
 * US-201: ChatLayout shell.
 * US-204: composes one useV2Chat with V2Transcript (message area) +
 * V2Composer (docked foot). Auto-scroll / jump-to-present come free from
 * ChatLayout.
 * US-501: a selected thread REOPENS — its saved transcript is restored above
 * the live items and the next turn resumes that session.
 */
import { useEffect, useMemo } from "react";
import * as stylex from "@stylexjs/stylex";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useV2Chat, type BrowserSurfaceReport } from "../lib/useV2Chat.ts";
import { useV2ThreadHistory } from "../lib/useV2ThreadHistory.ts";
import type { ActiveThread } from "../lib/types.ts";
import V2Transcript from "./V2Transcript.tsx";
import V2Composer from "./V2Composer.tsx";
import V2ApprovalGate from "./V2ApprovalGate.tsx";

interface ContextSnapshot {
  provider: ActiveThread["provider"];
  contextTokens: number;
  capabilities: ReturnType<typeof useV2Chat>["capabilities"];
}

// V2ChatView is keyed by thread, so navigation intentionally tears down its
// socket and reducer. Keep only the last provider-reported context position
// across that UI remount. The key is the thread — never the provider — because
// two Claude threads can occupy very different positions in their windows.
const contextSnapshotByThread = new Map<string, ContextSnapshot>();

export interface V2ChatViewProps {
  /** Gateway auth token; null until /api/config resolves — no socket then. */
  token: string | null;
  /** Sidebar selection; null until the user picks a thread. */
  activeThread: ActiveThread | null;
  onState?: (state: {
    status: "connecting" | "open" | "closed";
    busy: boolean;
    awaitingApproval: boolean;
  }) => void;
  /** What the Browser surface is showing (WHA-109). Owned by the shell, not by
   *  the chat, because the surface outlives this view — it is remounted per
   *  thread (`key`), and re-reporting on remount is what keeps a freshly opened
   *  socket aware of a page that was already loaded. */
  browserSurface?: BrowserSurfaceReport;
}

const styles = stylex.create({
  layout: {
    flexGrow: 1,
    height: "100%",
    minHeight: 0,
    // WHA-115 — ChatLayout's root IS the scroll container, and the pane's
    // header is now a glass bar overlaying its top. Padding on a scroll
    // container belongs to the scrollable area, so this starts the first
    // message below the bar while letting the transcript slide under it.
    paddingBlockStart: "var(--conan-secondary-bar-height)",
  },
  // ONE measure for the transcript and the composer, so message text and the
  // input share a vertical axis. Applied to the CONTENT, not to ChatLayout —
  // the frosted dock and the scroll area still span the whole well.
  measure: {
    marginInline: "auto",
    maxWidth: "var(--conan-chat-measure)",
    paddingBlockEnd: "calc(var(--conan-space-4) + var(--conan-space-1))",
    width: "100%",
  },
  // Available to assistive tech, absent from the visual layout. Clip-based
  // rather than `display:none` or `visibility:hidden` — both of those remove
  // the node from the a11y tree, which would defeat the whole point.
  announcer: {
    border: 0,
    clipPath: "inset(50%)",
    height: 1,
    overflow: "hidden",
    padding: 0,
    position: "absolute",
    whiteSpace: "nowrap",
    width: 1,
  },
});

export default function V2ChatView({
  token,
  activeThread,
  onState,
  browserSurface,
}: V2ChatViewProps) {
  // No selection → no socket. Opening /ws/agent for a well that has nothing to
  // chat with holds an agent session open for nothing, and (because App.v2
  // keys this view by the selection) the first click would tear that socket
  // down mid-handshake — a "closed before the connection is established"
  // warning in the console for no gain.
  const {
    items: live,
    send,
    status,
    busy,
    awaitingApproval,
    pendingApproval,
    pendingApprovals,
    respondToApproval,
    interrupt,
    permissionMode: livePermissionMode,
    sessionId,
    setPermissionMode,
    contextTokens,
    capabilities: sessionCapabilities,
    reportBrowserSurface,
  } = useV2Chat(activeThread ? token : null);
  const cachedContext = activeThread
    ? contextSnapshotByThread.get(activeThread.key)
    : undefined;
  const matchingCachedContext =
    cachedContext?.provider === activeThread?.provider ? cachedContext : undefined;
  const visibleContextTokens =
    contextTokens ?? matchingCachedContext?.contextTokens ?? null;
  const visibleSessionCapabilities =
    sessionCapabilities ?? matchingCachedContext?.capabilities ?? null;

  useEffect(() => {
    if (!activeThread) return;
    const previous = contextSnapshotByThread.get(activeThread.key);
    const matchingPrevious =
      previous?.provider === activeThread.provider ? previous : undefined;
    const nextTokens = contextTokens ?? matchingPrevious?.contextTokens ?? null;
    if (nextTokens == null) return;
    contextSnapshotByThread.set(activeThread.key, {
      provider: activeThread.provider,
      contextTokens: nextTokens,
      capabilities: sessionCapabilities ?? matchingPrevious?.capabilities ?? null,
    });
  }, [activeThread, contextTokens, sessionCapabilities]);
  useEffect(() => {
    if (activeThread) onState?.({ status, busy, awaitingApproval });
  }, [activeThread, awaitingApproval, busy, onState, status]);
  // Push the Browser surface's state down the socket whenever it changes —
  // and once more whenever the socket reopens, since the gateway holds this
  // per-connection and a reconnect starts it empty.
  useEffect(() => {
    if (!browserSurface || status !== "open") return;
    reportBrowserSurface(browserSurface);
  }, [browserSurface, reportBrowserSurface, status]);
  useEffect(
    () => () => {
      if (activeThread) {
        onState?.({ status: "closed", busy: false, awaitingApproval: false });
      }
    },
    [activeThread?.key, onState],
  );
  const history = useV2ThreadHistory(token, activeThread?.sessionId ?? null);
  // Restored turns first, then this run's. The live socket never replays what
  // the JSONL already holds, so there is nothing to dedupe.
  const items = useMemo(
    () => (history.items.length > 0 ? [...history.items, ...live] : live),
    [history.items, live],
  );
  const hasItems = items.length > 0;

  const emptyLabel = !activeThread
    ? "Select a thread to start chatting."
    : history.state === "loading"
      ? "Opening this thread…"
      : history.state === "missing"
        ? // Honest, and v1's behaviour: the JSONL is gone (or the thread ran on
          // a provider whose history we can't reconstruct), so the next prompt
          // starts a fresh session in the same folder.
          "This thread's history couldn't be found — sending starts a fresh session."
        : "Send a message to start this thread.";

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
          {/* WHA-55, and the reason the architecture change was worth making:
              this status node is ALWAYS mounted and only its TEXT changes when
              an approval arrives. The old panel shipped `aria-live` on a node
              that was inserted at the same moment it got content, which is the
              one shape screen readers reliably do NOT announce.

              `polite`, not `assertive`, and a one-line summary rather than the
              node wrapping the gate: `assertive` + `atomic` on the whole card
              read the entire plan aloud, which was the second half of the
              complaint. The plan itself stays reachable by navigation.

              NOT screen-reader tested — this is the correct mechanism, not a
              confirmed announcement. Verified only that the node is mounted
              before the approval exists and mutates in place when it arrives. */}
          <VStack
            gap={0}
            role="status"
            aria-live="polite"
            data-slot="v2-approval-announcer"
            xstyle={styles.announcer}
          >
            {pendingApproval
              ? pendingApproval.toolName === "ExitPlanMode"
                ? "Plan ready — your decision is needed."
                : `Permission needed for ${pendingApproval.toolName}.`
              : ""}
          </VStack>
          {/* WHA-86: the composer is ALWAYS mounted. A pending approval no
              longer swaps it out — the gate rides its drawer slot, so the user
              can keep typing while the agent waits. */}
          <V2Composer
              activeThread={activeThread}
              token={token}
              busy={busy}
              gate={
                pendingApproval
                  ? ({ text, clear }) => (
                      <V2ApprovalGate
                        approval={pendingApproval}
                        count={pendingApprovals.length}
                        respond={respondToApproval}
                        guidance={text}
                        sendGuidance={(guidance) => {
                          send(guidance, {
                            cwd: activeThread?.cwd ?? undefined,
                            resume: history.resumeSessionId ?? undefined,
                          });
                          clear();
                        }}
                      />
                    )
                  : undefined
              }
              // Only pass --resume when the history actually reconstructed; a
              // missing JSONL resumes nothing and would fail the launch.
              resumeSessionId={history.resumeSessionId}
              // Provider/model identify the session and lock after the first turn.
              // A REOPENED thread is locked from the start — the gateway
              // relaunches it on its saved provider regardless of the chip.
              // Effort is deliberately separate and remains a per-turn choice.
              locked={
                history.resumeSessionId != null ||
                items.some((item) => item.role === "user")
              }
              disabled={status !== "open" || !token}
              livePermissionMode={livePermissionMode}
              sessionId={sessionId}
              setPermissionMode={setPermissionMode}
              contextTokens={visibleContextTokens}
              sessionCapabilities={visibleSessionCapabilities}
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
