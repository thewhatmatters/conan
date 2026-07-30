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

/**
 * Claude's wordmark glyph, path lifted verbatim from the artboard's avatar node
 * (Paper `get_jsx`) so it is the design's asset, not a lookalike. `fill` reads
 * the brand token — the provider marks are brand, not theme, so they must not
 * drift with the palette. Codex and Grok get their own marks when the rows go
 * live (US-003 / the wiring phase).
 */
function ProviderGlyph({ provider }: { provider: ThreadProvider }) {
  if (provider !== "claude") {
    // Placeholder until the other two marks are added: the provider's initial,
    // which is exactly what v1's sidebar avatars already show.
    return (
      <Text weight="semibold" color="primary">
        {provider === "codex" ? "X" : "G"}
      </Text>
    );
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="-4 0 32 32"
      aria-hidden
      {...stylex.props(styles.glyph)}
    >
      <path
        fill="currentColor"
        fillRule="nonzero"
        d="M2.279 21.273l6.293-3.529 0.107-0.307-0.107-0.17H8.267l-1.053-0.064-3.598-0.098-3.118-0.129-3.022-0.163-0.761-0.161L-4 15.712l0.074-0.469 0.64-0.428 0.914 0.08 2.027 0.137 3.037 0.211 2.203 0.129 3.265 0.34h0.519l0.073-0.209-0.178-0.131-0.138-0.129-3.144-2.128-3.402-2.251-1.782-1.296-0.965-0.655-0.485-0.616-0.211-1.344 0.875-0.962 1.174 0.08 0.3 0.081 1.191 0.915 2.544 1.968 3.321 2.444 0.487 0.405 0.193-0.137 0.026-0.098-0.219-0.365-1.807-3.261-1.928-3.32-0.858-1.376-0.227-0.826a3.96 3.96 0 0 1-0.139-0.972L4.378 0.179 4.928 0l1.328 0.179 0.56 0.485 0.827 1.885 1.336 2.972 2.073 4.04 0.608 1.198 0.324 1.109 0.122 0.34h0.21V12.013l0.171-2.274 0.316-2.794 0.307-3.593 0.106-1.013 0.502-1.214 0.996-0.656 0.778 0.374 0.64 0.913-0.089 0.592-0.381 2.468-0.746 3.871-0.485 2.589h0.283l0.324-0.323 1.313-1.741 2.203-2.752 0.973-1.093 1.133-1.206 0.73-0.574h1.377l1.013 1.505-0.453 1.555-1.419 1.796-1.174 1.522-1.686 2.267-1.053 1.813 0.097 0.147 0.251-0.027 3.808-0.808 2.057-0.373 2.455-0.42 1.111 0.517 0.121 0.527-0.437 1.076-2.626 0.648-3.078 0.616-4.586 1.084-0.056 0.04 0.066 0.081 2.065 0.195 0.883 0.048h2.162l4.027 0.3 1.053 0.696 0.632 0.851-0.105 0.646-1.62 0.827-2.187-0.519-5.105-1.213-1.749-0.439h-0.243v0.147l1.457 1.424 2.675 2.413 3.345 3.107 0.17 0.771-0.43 0.606-0.453-0.065-2.94-2.209-1.135-0.996-2.568-2.16h-0.17v0.226l0.592 0.866 3.126 4.694 0.163 1.44-0.227 0.471-0.81 0.284-0.891-0.163-1.832-2.566-1.887-2.89-1.524-2.59-0.186 0.106-0.899 9.672-0.421 0.494-0.972 0.373-0.81-0.615-0.429-0.996 0.429-1.968 0.519-2.565 0.42-2.04 0.381-2.533 0.227-0.843-0.016-0.056-0.187 0.024-1.912 2.623-2.906 3.926-2.302 2.46-0.552 0.219-0.956-0.493 0.09-0.883 0.534-0.785 3.184-4.048 1.92-2.51 1.24-1.448-0.008-0.21h-0.073L1.51 24.747l-1.507 0.194-0.649-0.608 0.081-0.994 0.308-0.324 2.544-1.75-0.008 0.008z"
      />
    </svg>
  );
}

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
          <ProviderGlyph provider={provider} />
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
