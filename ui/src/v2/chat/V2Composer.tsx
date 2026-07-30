/**
 * V2Composer — minimal send surface for the p2a skeleton (US-203).
 *
 * Astryx ChatComposer + ChatComposerInput + ChatSendButton only. No provider/
 * model/effort pickers, no drawer/pins (p2c). onSubmit → send(text, { cwd, provider }).
 *
 * ChatComposer owns controlled value/onChange; ChatComposerInput reads them from
 * context (do not double-bind value on the input slot).
 */
import { useCallback, useState } from "react";
import {
  ChatComposer,
  ChatComposerInput,
  ChatSendButton,
} from "@astryxdesign/core/Chat";
import type { AgentOpts } from "../lib/useV2Chat.ts";
import type { ActiveThread } from "../lib/types.ts";

export interface V2ComposerProps {
  /** Active sidebar selection — supplies cwd/provider for send. */
  activeThread: ActiveThread | null;
  busy?: boolean;
  /** Socket not open → disable send. */
  disabled?: boolean;
  send: (text: string, opts: AgentOpts) => void;
  interrupt?: () => void;
}

export default function V2Composer({
  activeThread,
  busy = false,
  disabled = false,
  send,
  interrupt,
}: V2ComposerProps) {
  const [value, setValue] = useState("");

  const isDisabled = disabled || !activeThread;

  const handleSubmit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || !activeThread || busy) return;
      send(text, {
        cwd: activeThread.cwd || undefined,
        provider: activeThread.provider,
        projectId: activeThread.projectId,
      });
      setValue("");
    },
    [activeThread, busy, send],
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
      input={
        <ChatComposerInput
          maxRows={8}
          hasHistory={false}
          label="Message input"
        />
      }
      sendButton={<ChatSendButton />}
    />
  );
}
