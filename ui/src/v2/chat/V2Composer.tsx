/**
 * V2Composer — the chat composer. Paper artboard `S5-0` ("Chat Composer").
 *
 * p2a (US-203) established the minimal send surface: ChatComposer +
 * ChatComposerInput + ChatSendButton. p2c fills S5-0's remaining slots:
 *   drawer      → PinsDrawer      (S6-0 — staged pins/images, US-301)
 *   headerActions → BranchChip    (UX-0 — the turn's branch, US-302)
 *   input       → ChatComposerInput (TR-0 — @ / $ / / + paste/drop, US-304)
 *   footerActions → ModelPicker   (TY-0 — provider·model·effort, US-303)
 *   sendButton  → ChatSendButton  (UQ-0 — send/stop, p2a)
 *
 * ChatComposer owns the controlled value/onChange; ChatComposerInput reads them
 * from context (do not double-bind value on the input slot — it breaks the
 * caret and clear-after-send, docs §9 gotcha 4).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { ChatComposer, ChatSendButton } from "@astryxdesign/core/Chat";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Paperclip } from "lucide-react";
import type { AgentOpts } from "../lib/useV2Chat.ts";
import type { AgentCapabilities } from "../../hooks/useProviders.ts";
import type {
  OutgoingFileAttachment,
  OutgoingImage,
} from "../../hooks/useAgentChat.ts";
import type { ActiveThread } from "../lib/types.ts";
import { useComposerAttachments } from "../lib/useComposerAttachments.ts";
import { useThreadGit } from "../lib/useThreadGit.ts";
import { useV2Providers } from "../lib/useV2Providers.ts";
import PinsDrawer from "./composer/PinsDrawer.tsx";
import BranchChip from "./composer/BranchChip.tsx";
import ModelPicker from "./composer/ModelPicker.tsx";
import EffortChip from "./composer/EffortChip.tsx";
import PermissionModeChip from "./composer/PermissionModeChip.tsx";
import ContextProgress from "./composer/ContextProgress.tsx";
import {
  contextMeterState,
  contextPressureStatus,
} from "./composer/contextMeterModel.ts";
import RichInput from "./composer/RichInput.tsx";

const styles = stylex.create({
  fileInput: {
    display: "none",
  },
});

const ACTION_ICON = 16;

export interface V2ComposerProps {
  /** Active sidebar selection — supplies cwd/provider for send. */
  activeThread: ActiveThread | null;
  /** Gateway auth token — attachments read files through the gateway. */
  token?: string | null;
  busy?: boolean;
  /** Socket not open → disable send. */
  disabled?: boolean;
  /** A turn has already gone out (or the thread was resumed): the launch
   *  config is fixed for this session, so the picker shows its locked face. */
  locked?: boolean;
  /** Saved session to continue (US-501) — sent as `resume` so the driver
   *  relaunches with the conversation's context. Null = fresh session. */
  resumeSessionId?: string | null;
  /**
   * Live session permission mode from useV2Chat (null before launch). Once
   * set, the chip follows it so mid-session Plan→Build never lies (WHA-97).
   */
  livePermissionMode?: string | null;
  /** Real agent session id — non-null means applyPermission rides the socket. */
  sessionId?: string | null;
  /** Mid-session permission switch (US-022). Required once a session exists. */
  setPermissionMode?: (mode: string) => void;
  /**
   * Live context-window position from useV2Chat (WHA-101). Null until a turn
   * reports usage — meter stays absent rather than showing a fabricated zero.
   */
  contextTokens?: number | null;
  /**
   * Session driver capabilities (WHA-97/101) — the ONLY source of the context
   * meter's window size (WHA-102). Null until the driver is built, in which
   * case the meter shows the raw token count with no percentage.
   */
  sessionCapabilities?: AgentCapabilities | null;
  /**
   * The guided-input gate (WHA-86), rendered ABOVE the pins drawer when the
   * driver is blocked on a decision. It is passed in rather than built here so
   * the composer keeps knowing nothing about the approval protocol — it only
   * knows it has a drawer slot and something wants it.
   *
   * `gate` receives the live composer text so a decline can carry the user's
   * typed guidance as the following turn, and a callback to clear the input
   * once that text has been sent.
   */
  gate?: (args: { text: string; clear: () => void }) => React.ReactNode;
  send: (
    text: string,
    opts: AgentOpts,
    attachments?: OutgoingFileAttachment[],
    images?: OutgoingImage[],
  ) => void;
  interrupt?: () => void;
  /** Recovery path offered when context pressure is actionable. */
  onStartNewThread?: () => void;
  /** Measured post-turn context reset, shown briefly by the chat host. */
  contextCompactionMessage?: string | null;
}

export default function V2Composer({
  activeThread,
  token = null,
  busy = false,
  disabled = false,
  locked = false,
  resumeSessionId = null,
  livePermissionMode = null,
  sessionId = null,
  setPermissionMode,
  contextTokens = null,
  sessionCapabilities = null,
  gate,
  send,
  interrupt,
  onStartNewThread,
  contextCompactionMessage = null,
}: V2ComposerProps) {
  const [value, setValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useComposerAttachments(token);
  const providers = useV2Providers(token);
  // The launch config the picker commits: provider (fresh sessions only),
  // model, effort. Seeded from the selected thread and reset whenever the
  // selection changes, since each thread launches its own process.
  const threadProvider = activeThread?.provider ?? "claude";
  const [providerId, setProviderId] = useState<string>(threadProvider);
  // A reopened thread starts on the config it was SAVED with (US-501), so a
  // continued conversation doesn't silently switch model mid-thread.
  const [model, setModel] = useState<string | undefined>(
    activeThread?.model ?? undefined,
  );
  const [effort, setEffort] = useState(activeThread?.effort ?? "");
  // Pre-launch selection only — once the session reports a live mode the
  // chip follows that (v1: effectiveMode = liveMode ?? permission).
  const [permission, setPermission] = useState("");
  const threadKey = activeThread?.key ?? null;
  const threadModel = activeThread?.model ?? undefined;
  const threadEffort = activeThread?.effort ?? "";
  useEffect(() => {
    setProviderId(threadProvider);
    setModel(threadModel);
    setEffort(threadEffort);
    setPermission("");
    // Only the SELECTION changing resets the config — the provider/model/effort
    // ride along because they are properties of that selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);

  // Pre-launch the chip sets local launch config; once the session exists the
  // switch rides the driver (US-022). No optimistic update on the live path —
  // the chip follows the confirmed permission-mode event.
  const applyPermission = useCallback(
    (value: string) => {
      if (sessionId != null && setPermissionMode) setPermissionMode(value);
      else setPermission(value);
    },
    [sessionId, setPermissionMode],
  );
  const effectiveMode = livePermissionMode ?? permission;

  // Branch for THIS thread's directory — the same poll v1's status bar uses.
  const git = useThreadGit(token, activeThread?.cwd ?? null);
  // Not a repo, or the first poll hasn't landed → no chip at all, rather than
  // a chip that states something untrue. `undefined` (not a null-rendering
  // element) because ChatComposer paints its 28px header band for ANY truthy
  // slot, which would leave an empty band above the input.
  const branch = git?.available ? git.branch : null;
  const branchChip = branch ? (
    <BranchChip branch={branch} dirty={git?.dirty ?? 0} />
  ) : undefined;

  const isDisabled = disabled || !activeThread;

  // Window size comes ONLY from the live session capabilities frame (WHA-102).
  // There is deliberately no registry fallback: `GET /api/agent/providers`
  // serves each driver's STATIC descriptor, and every one of them declares
  // `contextWindowTokens: null` — the real denominator is resolved per session
  // from the launch model in `src/agent/index.ts` and only ever reaches the UI
  // over the WS frame. A registry fallback could therefore never fire, and it
  // would not be missed if it could: the meter also needs `contextTokens`,
  // which arrives with the first turn's result — by which point the
  // capabilities frame has long since landed.
  const windowTokens = sessionCapabilities?.contextWindowTokens ?? null;
  const contextState = contextMeterState(contextTokens, windowTokens);
  const contextStatus = contextPressureStatus(
    contextState,
    activeThread?.provider === "claude",
  );

  const handleSubmit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || !activeThread || busy) return;
      const outgoing = attachments.toOutgoing();
      send(
        text,
        {
          cwd: activeThread.cwd || undefined,
          provider: providerId,
          projectId: activeThread.projectId,
          // Undefined, never "" — an empty string would be a real `-m ""`.
          model,
          effort: effort || undefined,
          permissionMode: effectiveMode || undefined,
          // Continue the saved conversation. Already gated upstream on the
          // history actually reconstructing, so this is never a dead id.
          resume: resumeSessionId ?? undefined,
        },
        outgoing.attachments,
        outgoing.images,
      );
      attachments.clearAfterSend();
      setValue("");
    },
    [
      activeThread,
      attachments,
      busy,
      effort,
      model,
      providerId,
      effectiveMode,
      resumeSessionId,
      send,
    ],
  );

  // Files pasted or dropped on the input stage as pins — the same content-not-
  // path serialization v1 uses, so the agent sees the file inline. An image
  // only stages where the provider actually accepts one (capability, not
  // provider name) — never a dead affordance; elsewhere it is ignored, as in v1.
  const acceptsImages =
    providers.find((p) => p.id === providerId)?.capabilities.imageInput ?? false;
  const handleFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          if (!acceptsImages) continue;
          const reader = new FileReader();
          reader.onload = () => {
            const url = String(reader.result);
            const comma = url.indexOf(",");
            if (comma < 0) return;
            attachments.addImage({
              mediaType: file.type,
              data: url.slice(comma + 1),
            });
          };
          reader.readAsDataURL(file);
        } else {
          void attachments.pinFile(file);
        }
      }
    },
    [acceptsImages, attachments],
  );

  const headerActions = (
    <HStack align="center" gap={1}>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        label="Attach files"
        icon={<Paperclip size={ACTION_ICON} aria-hidden />}
        onClick={() => fileInputRef.current?.click()}
      />
      {branchChip}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          if (files.length > 0) handleFiles(files);
          event.currentTarget.value = "";
        }}
        {...stylex.props(styles.fileInput)}
      />
    </HStack>
  );

  return (
    <>
      <ChatComposer
      data-slot="v2-composer"
      value={value}
      onChange={setValue}
      onSubmit={handleSubmit}
      onStop={interrupt}
      isStopShown={busy}
      placeholder="Ask anything"
      isDisabled={isDisabled}
      drawer={
        // Two occupants, and the gate goes first: when the agent is blocked,
        // that is the thing demanding an answer. Pins stay visible underneath
        // rather than vanishing — the composer is still typeable and still
        // holds whatever the user staged, and hiding it would read as loss.
        // PinsDrawer returns null when empty, so the common case is unchanged.
        <>
          {gate?.({ text: value, clear: () => setValue("") })}
          <PinsDrawer
            pins={attachments.pins}
            images={attachments.images}
            onRemovePin={attachments.removePin}
            onRemoveImage={attachments.removeImage}
          />
        </>
      }
      headerActions={headerActions}
      headerContext={
        <ContextProgress used={contextTokens} windowTokens={windowTokens} />
      }
      footerActions={
        <div data-slot="composer-controls">
          {/* provider+model is the thread's identity and LOCKS after turn 1;
              effort is a per-turn parameter, so its chip never locks. */}
          <ModelPicker
            providers={providers}
            activeProviderId={providerId}
            model={model}
            locked={locked}
            onSelect={(nextProvider, nextModel) => {
              setProviderId(nextProvider);
              setModel(nextModel);
              // Effort ids are per-provider vocabulary — carrying one across a
              // provider switch would send a mode the new driver never defined.
              if (nextProvider !== providerId) setEffort("");
              // Local launch selection only — live mode is owned by the session.
              if (nextProvider !== providerId && sessionId == null) {
                setPermission("");
              }
            }}
          />
          <EffortChip
            providers={providers}
            activeProviderId={providerId}
            effort={effort}
            onEffortSelect={setEffort}
          />
          {/* Stays visible after turn 1 so mid-session Plan→Build (and the
              live permission-mode event) can update the chip face (WHA-97).
              Provider/model still lock via ModelPicker; this chip is the
              live mode indicator + switch, matching v1. */}
          <PermissionModeChip
            providers={providers}
            activeProviderId={providerId}
            permissionMode={effectiveMode}
            onPermissionModeSelect={applyPermission}
          />
        </div>
      }
      input={
        <RichInput
          token={token}
          cwd={activeThread?.cwd ?? null}
          onFiles={handleFiles}
          isSubmitDisabled={busy}
        />
      }
      status={contextStatus}
      statusPosition="bottom"
      sendActions={
        contextStatus && onStartNewThread ? (
          <Button
            label="Start new thread"
            variant="ghost"
            size="sm"
            onClick={onStartNewThread}
          />
        ) : undefined
      }
      sendButton={<ChatSendButton />}
      />
      {contextCompactionMessage ? (
        <Text
          type="supporting"
          color="secondary"
          data-slot="context-compaction-confirmation"
        >
          {contextCompactionMessage}
        </Text>
      ) : null}
    </>
  );
}
