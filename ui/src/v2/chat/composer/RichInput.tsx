/**
 * RichInput — the composer's input slot (Paper S5-0 TR-0/TV-0, placeholder
 * "Ask anything" 14/400 muted).
 *
 * `ChatComposerInput` already owns everything v1's `ComposerAutocomplete`
 * hand-rolled — caret-anchored trigger menus, debounce, ↑/↓ selection, inline
 * token chips, ArrowUp/Down history recall, paste handling — so this file
 * supplies the SOURCES and the file policy, not a menu.
 *
 *   @ → files/folders under the thread's cwd
 *   $ → installed skills
 *   / → slash commands
 *
 * Each selection inserts a token whose serialized `value` is exactly what v1
 * put in the prompt (`@rel`, `$skill`, `/command`), so the agent sees no
 * change — only the composer looks different.
 *
 * ONE DEVIATION FROM THE ASTRYX DOCS, verified in the 0.1.9 source: the
 * component's docs say "paste/drop file handling", but `ChatComposerInput`
 * only reads `clipboardData.files` — there is no drop handler. Drop is
 * therefore wired here (`onDrop`/`onDragOver` ride through BaseProps), routing
 * to the same `onFiles` callback as paste, so "drag a file onto the composer"
 * behaves like the docs claim.
 */
import { useMemo } from "react";
import { ChatComposerInput } from "@astryxdesign/core/Chat";
import type {
  ChatComposerToken,
  ChatComposerTrigger,
} from "@astryxdesign/core/Chat";
import {
  createCommandSource,
  createFileSource,
  createSkillSource,
} from "../../lib/composerTriggers.ts";
import type { SearchableItem } from "@astryxdesign/core/Typeahead";

export interface RichInputProps {
  token: string | null;
  /** The thread's working directory — @ and / are scoped to it. */
  cwd: string | null;
  /** Pasted or dropped files (images and text alike). */
  onFiles: (files: File[]) => void;
  /** Keep the draft editable, but hold Enter until the active turn finishes. */
  isSubmitDisabled?: boolean;
}

/** A selected item becomes an inline chip whose serialized value is v1's
 *  sigil text — the chip is presentation; the wire format is unchanged. */
function toToken(item: SearchableItem): ChatComposerToken {
  return { value: item.id, label: item.label };
}

export default function RichInput({
  token,
  cwd,
  onFiles,
  isSubmitDisabled = false,
}: RichInputProps) {
  const triggers = useMemo<ChatComposerTrigger[]>(
    () => [
      {
        character: "@",
        searchSource: createFileSource(token, cwd),
        onSelect: toToken,
        emptySearchResultsText: "No matching files",
        menuLabel: "Files and folders",
      },
      {
        character: "$",
        searchSource: createSkillSource(token),
        onSelect: toToken,
        emptySearchResultsText: "No matching skills",
        menuLabel: "Skills",
      },
      {
        character: "/",
        searchSource: createCommandSource(token, cwd),
        onSelect: toToken,
        emptySearchResultsText: "No matching commands",
        menuLabel: "Commands",
      },
    ],
    [token, cwd],
  );

  return (
    <ChatComposerInput
      maxRows={8}
      label="Message input"
      triggers={triggers}
      onFiles={onFiles}
      onKeyDown={(event) => {
        if (
          isSubmitDisabled &&
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          // Astryx clears its contenteditable after calling onSubmit. During
          // an active turn Conan cannot accept that frame, so consume Enter
          // here and keep the follow-up as a draft instead of losing it.
          event.preventDefault();
        }
      }}
      onDragOver={(event) => {
        // Without this the browser navigates to the dropped file.
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        onFiles(files);
      }}
      data-slot="rich-input"
      data-submit-disabled={isSubmitDisabled ? "true" : undefined}
    />
  );
}
