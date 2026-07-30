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
import { useCallback, useState } from "react";
import {
  ChatComposer,
  ChatComposerInput,
  ChatSendButton,
} from "@astryxdesign/core/Chat";
import type { AgentOpts } from "../lib/useV2Chat.ts";
import type {
  OutgoingFileAttachment,
  OutgoingImage,
} from "../../hooks/useAgentChat.ts";
import type { ActiveThread } from "../lib/types.ts";
import { useComposerAttachments } from "../lib/useComposerAttachments.ts";
import { useThreadGit } from "../lib/useThreadGit.ts";
import PinsDrawer from "./composer/PinsDrawer.tsx";
import BranchChip from "./composer/BranchChip.tsx";

export interface V2ComposerProps {
  /** Active sidebar selection — supplies cwd/provider for send. */
  activeThread: ActiveThread | null;
  /** Gateway auth token — attachments read files through the gateway. */
  token?: string | null;
  busy?: boolean;
  /** Socket not open → disable send. */
  disabled?: boolean;
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
  send,
  interrupt,
}: V2ComposerProps) {
  const [value, setValue] = useState("");
  const attachments = useComposerAttachments(token);
  // Branch for THIS thread's directory — the same poll v1's status bar uses.
  const git = useThreadGit(token, activeThread?.cwd ?? null);

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
          provider: activeThread.provider,
          projectId: activeThread.projectId,
        },
        outgoing.attachments,
        outgoing.images,
      );
      attachments.clearAfterSend();
      setValue("");
    },
    [activeThread, attachments, busy, send],
  );

  // Files pasted or dropped on the input stage as pins — the same content-not-
  // path serialization v1 uses, so the agent sees the file inline.
  const handleFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        if (file.type.startsWith("image/")) {
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
    [attachments],
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
      headerActions={
        <BranchChip
          branch={git?.available ? git.branch : null}
          dirty={git?.dirty ?? 0}
        />
      }
      input={
        <ChatComposerInput
          maxRows={8}
          hasHistory={false}
          label="Message input"
          onFiles={handleFiles}
        />
      }
      sendButton={<ChatSendButton />}
    />
  );
}
