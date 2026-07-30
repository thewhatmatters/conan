/**
 * ThreadRow — Paper RJ-0: the thread rows inside a project group (PY-0).
 *
 * T0 STUB (owned by US-003). Data-prop-driven from the start so the same
 * component can be fed live threads later without a rewrite; T0 only supplies
 * placeholder rows from `ProjectTree`.
 *
 * The artboard's row is 68px tall: a 40px provider avatar in a fixed lane, then
 * a two-line title/subtitle column. Selection is stated twice — a translucent
 * wash across the row AND a 2px accent bar riding its bottom edge, inset 12px
 * so it reads as underlining the content rather than the container.
 *
 * VERTICAL LANES: the avatar is a fixed 40px `flexShrink: 0` slot, so titles
 * line up across every row regardless of avatar content (Paper's repeated-row
 * rule). The status dot is absolutely positioned OFF the avatar's top-right
 * corner, which is why the avatar is the positioning context.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
// The shared brand marks (src/assets/providers/*). The row and the composer's
// picker now render the SAME glyph, so a provider looks identical everywhere.
import ProviderGlyph from "../chat/composer/ProviderGlyph.tsx";

/** Which agent ran this thread. Drives the avatar glyph and its brand colour. */
export type ThreadProvider = "claude" | "codex" | "grok";

export interface ThreadRowProps {
  /** Stable id for selection wiring (p2a). Falls back to title when omitted. */
  id?: string;
  title: string;
  /** First line of the thread's opening prompt, truncated by the artboard. */
  subtitle: string;
  /** The thread the user is looking at — wash + accent bar. */
  isSelected?: boolean;
  /** Agent is mid-turn — shows the green status dot on the avatar. */
  isRunning?: boolean;
  provider?: ThreadProvider;
  /** Sidebar selection — App.v2 owns activeThread and passes this down. */
  onSelect?: () => void;
}

const styles = stylex.create({
  row: {
    appearance: "none",
    backgroundColor: "transparent",
    borderStyle: "none",
    borderRadius: "var(--conan-radius-md)",
    cursor: "pointer",
    display: "block",
    flexShrink: 0,
    height: "var(--conan-row-height)",
    padding: 0,
    position: "relative",
    textAlign: "start",
    width: "100%",
  },
  rowSelected: {
    backgroundColor: "var(--conan-wash-row-selected)",
  },
  avatar: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-md)",
    flexShrink: 0,
    height: "var(--conan-avatar-size)",
    position: "relative",
    width: "var(--conan-avatar-size)",
  },
  // Offset so the dot straddles the avatar's top-right corner; the ring is what
  // separates it from whatever tone sits behind.
  statusDot: {
    backgroundColor: "var(--conan-color-status-running)",
    borderColor: "var(--conan-color-status-ring)",
    borderRadius: "var(--conan-radius-full)",
    borderStyle: "solid",
    borderWidth: "var(--conan-status-ring-width)",
    height: "var(--conan-status-dot-size)",
    insetBlockStart: "calc(-1 * var(--conan-space-1))",
    insetInlineStart: "calc(var(--conan-avatar-size) - var(--conan-space-2))",
    position: "absolute",
    width: "var(--conan-status-dot-size)",
  },
  // minWidth:0 is what lets the two Texts truncate instead of widening the row.
  body: {
    minWidth: 0,
  },
  // Rides the row's bottom edge, inset to the content's gutter.
  indicator: {
    backgroundColor: "var(--conan-color-accent)",
    borderRadius: "var(--conan-radius-full)",
    height: "var(--conan-indicator-height)",
    insetBlockEnd: 0,
    insetInlineEnd: "var(--conan-space-3)",
    insetInlineStart: "var(--conan-space-3)",
    position: "absolute",
  },
  glyph: {
    color: "var(--conan-brand-claude)",
    flexShrink: 0,
  },
});

export default function ThreadRow({
  id,
  title,
  subtitle,
  isSelected = false,
  isRunning = false,
  provider = "claude",
  onSelect,
}: ThreadRowProps) {
  return (
    <button
      type="button"
      aria-label={`${title}: ${subtitle}`}
      aria-current={isSelected ? "page" : undefined}
      onClick={onSelect}
      {...stylex.props(styles.row, isSelected && styles.rowSelected)}
      data-slot="thread-row"
      data-thread-id={id ?? title}
      data-selected={isSelected ? "true" : undefined}
    >
      <HStack align="start" gap={3} padding={3}>
        <HStack align="center" hAlign="center" xstyle={styles.avatar}>
          <ProviderGlyph providerId={provider} letter={provider.charAt(0).toUpperCase()} />
          {isRunning ? (
            <HStack
              xstyle={styles.statusDot}
              role="img"
              aria-label={`${title} is running`}
            />
          ) : null}
        </HStack>
        <VStack gap={1} xstyle={styles.body}>
          <Text weight="semibold" color="primary" maxLines={1}>
            {title}
          </Text>
          <Text type="supporting" color="secondary" maxLines={1}>
            {subtitle}
          </Text>
        </VStack>
      </HStack>
      {isSelected ? <HStack xstyle={styles.indicator} aria-hidden /> : null}
    </button>
  );
}
