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
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { FileText, Folder, SquareSlash, Sparkles } from "lucide-react";
import {
  createCommandSource,
  createFileSource,
  createSkillSource,
  type TriggerAux,
} from "../../lib/composerTriggers.ts";
import type { SearchableItem } from "@astryxdesign/core/Typeahead";

export interface RichInputProps {
  token: string | null;
  /** The thread's working directory — @ and / are scoped to it. */
  cwd: string | null;
  /** Pasted or dropped files (images and text alike). */
  onFiles: (files: File[]) => void;
}

const ICON = 14;

function aux(item: SearchableItem): TriggerAux | undefined {
  return item.auxiliaryData as TriggerAux | undefined;
}

function TriggerRow({ item }: { item: SearchableItem }) {
  const kind = aux(item)?.kind;
  const hint = aux(item)?.hint;
  const Glyph =
    kind === "dir"
      ? Folder
      : kind === "skill"
        ? Sparkles
        : kind === "command"
          ? SquareSlash
          : FileText;
  return (
    <HStack align="center" gap={2} width="100%">
      <Glyph size={ICON} aria-hidden />
      <Text type="supporting" color="primary" maxLines={1}>
        {item.label}
      </Text>
      {hint ? (
        <Text type="supporting" color="secondary" maxLines={1}>
          {hint}
        </Text>
      ) : null}
    </HStack>
  );
}

/** A selected item becomes an inline chip whose serialized value is v1's
 *  sigil text — the chip is presentation; the wire format is unchanged. */
function toToken(item: SearchableItem): ChatComposerToken {
  return { value: item.id, label: item.label };
}

export default function RichInput({ token, cwd, onFiles }: RichInputProps) {
  const triggers = useMemo<ChatComposerTrigger[]>(
    () => [
      {
        character: "@",
        searchSource: createFileSource(token, cwd),
        renderItem: (item) => <TriggerRow item={item} />,
        onSelect: toToken,
        emptySearchResultsText: "No matching files",
        menuLabel: "Files and folders",
      },
      {
        character: "$",
        searchSource: createSkillSource(token),
        renderItem: (item) => <TriggerRow item={item} />,
        onSelect: toToken,
        emptySearchResultsText: "No matching skills",
        menuLabel: "Skills",
      },
      {
        character: "/",
        searchSource: createCommandSource(token, cwd),
        renderItem: (item) => <TriggerRow item={item} />,
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
    />
  );
}
