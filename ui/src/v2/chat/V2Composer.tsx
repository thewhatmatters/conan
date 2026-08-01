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
  const [permissionMode, setPermissionMode] = useState("");
  const threadKey = activeThread?.key ?? null;
  const threadModel = activeThread?.model ?? undefined;
  const threadEffort = activeThread?.effort ?? "";
  useEffect(() => {
    setProviderId(threadProvider);
    setModel(threadModel);
    setEffort(threadEffort);
    setPermissionMode("");
    // Only the SELECTION changing resets the config — the provider/model/effort
    // ride along because they are properties of that selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);
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
          permissionMode: permissionMode || undefined,
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
      permissionMode,
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
        <PinsDrawer
          pins={attachments.pins}
          images={attachments.images}
          onRemovePin={attachments.removePin}
          onRemoveImage={attachments.removeImage}
        />
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
              if (nextProvider !== providerId) setPermissionMode("");
            }}
          />
          <EffortChip
            providers={providers}
            activeProviderId={providerId}
            effort={effort}
            onEffortSelect={setEffort}
          />
          {!locked ? (
            <PermissionModeChip
              providers={providers}
              activeProviderId={providerId}
              permissionMode={permissionMode}
              onPermissionModeSelect={setPermissionMode}
            />
          ) : null}
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
      sendButton={<ChatSendButton />}
    />
  );
}
