/**
 * ProviderGlyph — a provider's brand mark.
 *
 * The marks are the repo's shared SVG assets (`src/assets/providers/*`) — the
 * same files v1 ships. They are inlined with `?raw` rather than `<img>` for two
 * reasons: `currentColor` marks (Grok, OpenAI/Codex) then inherit the wrapper's
 * colour, and a self-coloured mark (Claude's #D97757, Kimi's blue) keeps its
 * BRAND value — a provider mark must not drift with the theme. An `<img>` could
 * do neither.
 *
 * Every asset is authored at `width/height: 1em`, so the WRAPPER'S FONT-SIZE
 * sizes the mark. That indirection matters: StyleX has no `[&>svg]` descendant
 * escape hatch, so v1's `[&>svg]:size-full` trick isn't available here.
 *
 * A provider with no asset falls back to the registry's avatar letter — the
 * honest thing to show for a mark we don't ship.
 */
import * as stylex from "@stylexjs/stylex";
import { Text } from "@astryxdesign/core/Text";
// The one brand-mark map both trees share (v1's ProviderMark renders the same
// module) — re-exported for this tree's existing importers.
import {
  PROVIDER_ICON,
  providerIconOf,
} from "../../../chat/providerIcons.ts";

export { PROVIDER_ICON, providerIconOf };

const styles = stylex.create({
  // `currentColor` marks read as icon-primary; self-coloured ones ignore it.
  // Size is dynamic because the assets are em-based (see the note above).
  mark: (size: number) => ({
    alignItems: "center",
    color: "var(--conan-icon-primary)",
    display: "inline-flex",
    flexShrink: 0,
    fontSize: `${size}px`,
    justifyContent: "center",
  }),
});

export interface ProviderGlyphProps {
  providerId: string;
  /** Registry avatar letter — the honest fallback for a mark we don't ship. */
  letter: string;
  size?: number;
}

export default function ProviderGlyph({
  providerId,
  letter,
  size = 16,
}: ProviderGlyphProps) {
  const icon = providerIconOf(providerId);
  if (!icon) {
    return (
      <Text type="supporting" weight="semibold" color="primary">
        {letter}
      </Text>
    );
  }
  return (
    <span
      aria-hidden
      {...stylex.props(styles.mark(size))}
      dangerouslySetInnerHTML={{ __html: icon }}
    />
  );
}
