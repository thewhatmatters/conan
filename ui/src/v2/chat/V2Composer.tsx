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
import { useCallback, useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { ChatComposer, ChatSendButton } from "@astryxdesign/core/Chat";
import { VStack } from "@astryxdesign/core/VStack";
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
import ContextMeter from "./composer/ContextMeter.tsx";
import RichInput from "./composer/RichInput.tsx";

const styles = stylex.create({
  // TS-0 — the input region's floor, so the composer has room to compose in.
  inputSlot: {
    justifyContent: "center",
    minHeight: "var(--conan-composer-input-min)",
  },
});

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
   * Session driver capabilities (WHA-97/101). When null, the meter falls back
   * to the active provider's registry descriptor for window size (v1 shape).
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
}: V2ComposerProps) {
  const [value, setValue] = useState("");
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

  // Window size: prefer the live session capabilities frame (WHA-96 may refine
  // it); fall back to the registry row for the active provider (v1 shape).
  const registryWindow =
    providers.find((p) => p.id === providerId)?.capabilities.contextWindowTokens ??
    null;
  const windowTokens =
    sessionCapabilities?.contextWindowTokens ?? registryWindow;

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

  return (
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
      headerActions={branchChip}
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
        // S5-0's input region (TS-0) is min-height 84px. ChatComposerInput has
        // maxRows but no minRows, so the floor lives on the slot wrapper —
        // without it the input collapses to a single 30px row and the composer
        // reads cramped against the artboard.
        <VStack gap={0} xstyle={styles.inputSlot}>
          <RichInput
            token={token}
            cwd={activeThread?.cwd ?? null}
            onFiles={handleFiles}
          />
        </VStack>
      }
      // v1 places the context ring left of send in the right cluster. ChatComposer
      // exposes that as sendActions (WHA-101).
      sendActions={
        <ContextMeter used={contextTokens} windowTokens={windowTokens} />
      }
      sendButton={<ChatSendButton />}
    />
  );
}
