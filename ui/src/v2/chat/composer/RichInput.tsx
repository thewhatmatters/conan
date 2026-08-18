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
 * TYPED LINE BREAKS ARE FORCED TO `<br>` (WHA-211). Astryx serialises the
 * editable itself, and its `serialize()` maps `<br>` to "\n" but walks
 * straight through block elements. A contenteditable answers Shift+Enter with
 * `<div>` wrappers, so a TYPED newline vanished from the outgoing prompt while
 * a PASTED one (a literal "\n" text node) survived — typed tables, lists and
 * fenced code all arrived on one line. We can't fix `serialize()`; it lives in
 * `facebook/astryx`. So the break is inserted as a `<br>` before the browser
 * gets to make a block out of it, which is the shape Astryx already reads.
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

/**
 * Insert a line break at the caret as a `<br>`, never as a block element.
 *
 * `execCommand` is deprecated and is still the only call that inserts a break
 * INTO THE BROWSER'S OWN UNDO STACK — a hand-rolled DOM edit makes the line
 * break un-undoable, which is a worse regression than the one being fixed. It
 * is the primary path and it is what the browser check exercises.
 *
 * The manual fallback exists for engines that refuse the command (and is the
 * only path jsdom can run, so it is what the unit tests cover). The second
 * `<br>` is not redundant: a trailing `<br>` at the end of a contenteditable
 * is not rendered, so without it the caret never reaches the new line.
 */
export function insertLineBreak(): boolean {
  if (document.execCommand?.("insertLineBreak")) return true;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();

  const br = document.createElement("br");
  range.insertNode(br);

  // Only pad when the break really is the last thing in the field; padding
  // unconditionally leaves a stray blank line mid-message. `insertNode` splits
  // the caret's text node even at its very end, so "nothing after it" means
  // "nothing but empty text nodes after it" — checking `nextSibling` alone
  // reads the empty half as content and silently skips the pad.
  let after = br.nextSibling;
  while (after && after.nodeType === Node.TEXT_NODE && !after.textContent) {
    after = after.nextSibling;
  }
  if (!after) {
    range.insertNode(document.createElement("br"));
  }

  range.setStartAfter(br);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);

  // Astryx tracks emptiness and its trigger menus from `input`. execCommand
  // fires one on its own; a hand-rolled DOM edit does not, and without this
  // the placeholder can stay up over a field that now has content in it.
  const host = br.parentElement?.closest<HTMLElement>("[contenteditable]");
  host?.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
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
          event.key === "Enter" &&
          event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          // WHA-211: take the break away from the browser before it wraps the
          // line in a <div> that Astryx's serializer drops on the floor.
          if (insertLineBreak()) event.preventDefault();
          return;
        }
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
