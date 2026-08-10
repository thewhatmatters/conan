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
import { useEffect, useMemo, useRef, useState } from "react";
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
import ChatSurfaceToolbar from "../components/ChatSurfaceToolbar.tsx";
import { detectContextCompaction } from "./composer/contextMeterModel.ts";

interface ContextSnapshot {
  provider: ActiveThread["provider"];
  contextTokens: number;
  capabilities: ReturnType<typeof useV2Chat>["capabilities"];
}

// V2ChatView is keyed by thread, so navigation remounts it. Since WHA-105 the
// SESSION survives that remount, so a live thread carries its own context
// position back — this map covers the one case that does not: a session the
// registry evicted while idle, whose meter would otherwise reset to blank on
// reopen. The key is the thread — never the provider — because two Claude
// threads can occupy very different positions in their windows.
const contextSnapshotByThread = new Map<string, ContextSnapshot>();

export interface V2ChatViewProps {
  /** Gateway auth token; null until /api/config resolves — no socket then. */
  token: string | null;
  /** Sidebar selection; null until the user picks a thread. */
  activeThread: ActiveThread | null;
  /**
   * The provider's session id, once its first `system` frame arrives — the
   * same id the gateway keys the persisted `chat_thread` row on (WHA-121).
   *
   * The shell needs this and had no way to learn it. A `New chat` is local
   * state until the first send; the gateway then writes the real row, but
   * nothing told App.v2 that happened, so the sidebar kept showing an untitled
   * draft and a later visit reopened a session it could not name. Null before
   * the socket reports one.
   *
   * This callback used to carry the sidebar pill state too. It no longer does:
   * the pill is read from the session registry (WHA-105), which knows it for
   * every live thread rather than only the mounted one.
   */
  onSessionId?: (sessionId: string | null) => void;
  /** What the Browser surface is showing (WHA-109). Owned by the shell, not by
   *  the chat, because the surface outlives this view — it is remounted per
   *  thread (`key`), and re-reporting on remount is what keeps a freshly opened
   *  socket aware of a page that was already loaded. */
  browserSurface?: BrowserSurfaceReport;
  /** Open a fresh draft in the active project when context pressure warrants it. */
  onStartNewThread?: () => void;
}

const styles = stylex.create({
  root: {
    flexGrow: 1,
    height: "100%",
    minHeight: 0,
    overflow: "clip",
  },
  layout: {
    flexGrow: 1,
    height: "100%",
    minHeight: 0,
  },
  // The composer is intentionally narrower than the transcript: it is an
  // action surface, not a reading column. The dock still spans the whole well
  // and this remains fluid below its ceiling on narrow panes.
  measure: {
    marginInline: "auto",
    maxWidth: "var(--conan-composer-measure)",
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
  onSessionId,
  browserSurface,
  onStartNewThread,
}: V2ChatViewProps) {
  // No selection → no socket. Opening /ws/agent for a well that has nothing to
  // chat with holds an agent session open for nothing.
  const {
    items: live,
    send,
    status,
    busy,
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
  } = useV2Chat(activeThread ? token : null, activeThread?.key ?? null);
  const cachedContext = activeThread
    ? contextSnapshotByThread.get(activeThread.key)
    : undefined;
  const matchingCachedContext =
    cachedContext?.provider === activeThread?.provider ? cachedContext : undefined;
  const visibleContextTokens =
    contextTokens ?? matchingCachedContext?.contextTokens ?? null;
  const visibleSessionCapabilities =
    sessionCapabilities ?? matchingCachedContext?.capabilities ?? null;
  const previousContextTokens = useRef<number | null>(null);
  const [contextCompactionMessage, setContextCompactionMessage] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (contextTokens == null) return;
    const notice = detectContextCompaction(
      previousContextTokens.current,
      contextTokens,
      sessionCapabilities?.contextWindowTokens,
    );
    previousContextTokens.current = contextTokens;
    if (!notice) return;
    setContextCompactionMessage(notice.message);
  }, [contextTokens, sessionCapabilities?.contextWindowTokens]);
  useEffect(() => {
    if (!contextCompactionMessage) return;
    const timeout = window.setTimeout(() => setContextCompactionMessage(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [contextCompactionMessage]);

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
    if (activeThread) onSessionId?.(sessionId);
  }, [activeThread, onSessionId, sessionId]);
  // Push the Browser surface's state down the socket whenever it changes —
  // and once more whenever the socket reopens, since the gateway holds this
  // per-connection and a reconnect starts it empty.
  useEffect(() => {
    if (!browserSurface || status !== "open") return;
    reportBrowserSurface(browserSurface);
  }, [browserSurface, reportBrowserSurface, status]);
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
    <VStack gap={0} xstyle={styles.root} data-slot="chat-surface-root">
      <ChatSurfaceToolbar />
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
          {/* Like the approval announcer below, this region exists before it
              has anything to say. A measured context reset mutates its text,
              which gives assistive technology a reliable polite update while
              the visible confirmation remains supporting copy. */}
          <VStack
            gap={0}
            role="status"
            aria-live="polite"
            data-slot="v2-context-compaction-announcer"
            xstyle={styles.announcer}
          >
            {contextCompactionMessage ?? ""}
          </VStack>
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
              contextCompactionMessage={contextCompactionMessage}
              onStartNewThread={onStartNewThread}
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
    </VStack>
  );
}
