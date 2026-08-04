/**
 * Command palette shell (WHA-70 / US-401).
 *
 * Paper artboard VC-1 — search input + result list + footer keyboard hints.
 * https://app.paper.design/file/01KYQJ3S5RCDAE0KY87NRFY75F/1-0/VC-1
 *
 * Wraps Astryx `CommandPalette` once at the App.v2 shell. Open state and the
 * ⌘K / sidebar-Search openers live in App.v2; this file owns the dialog body
 * and the static bootstrap list that matches VC-1's placeholders until
 * WHA-71 (search source) and WHA-72 (actions) replace it.
 *
 * Astryx only: `CommandPalette` + default Input/Footer slots, static source
 * via `createStaticSource`. Width 640 matches Astryx's default and VC-1.
 */
import { useMemo } from "react";
import { CommandPalette as AstryxCommandPalette } from "@astryxdesign/core/CommandPalette";
import {
  createStaticSource,
  type SearchableItem,
} from "@astryxdesign/core/Typeahead";

/**
 * VC-1's placeholder rows (Home · Settings · Profile · Dashboard · Help).
 * Static until WHA-71/72 wire real threads/projects/actions.
 */
export const VC1_PLACEHOLDERS: SearchableItem[] = [
  { id: "home", label: "Home" },
  { id: "settings", label: "Settings" },
  { id: "profile", label: "Profile" },
  { id: "dashboard", label: "Dashboard" },
  { id: "help", label: "Help" },
];

export interface V2CommandPaletteProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

export default function V2CommandPalette({
  isOpen,
  onOpenChange,
}: V2CommandPaletteProps) {
  const searchSource = useMemo(
    () => createStaticSource(VC1_PLACEHOLDERS),
    [],
  );

  return (
    <AstryxCommandPalette
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      searchSource={searchSource}
      width={640}
      label="Command palette"
      data-slot="command-palette"
    />
  );
}
