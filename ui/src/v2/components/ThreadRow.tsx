/**
 * ThreadRow — Paper RJ-0: the thread rows inside a project group (PY-0).
 *
 * T0 STUB (owned by US-003). Data-prop-driven from the start so the same
 * component can be fed live threads later without a rewrite; T0 only supplies
 * placeholder rows from `ProjectTree`.
 *
 * The artboard's row is 68px tall: a 40px provider avatar in a fixed lane, then
 * a two-line title/subtitle column. Like Astryx TabList, the translucent wash
 * belongs to hover; selection is persistent and independent via the 2px accent
 * bar riding the bottom edge, inset 12px so it underlines the content rather
 * than filling the container.
 *
 * VERTICAL LANES: the avatar is a fixed 40px `flexShrink: 0` slot, so titles
 * line up across every row regardless of avatar content (Paper's repeated-row
 * rule). The status dot is absolutely positioned OFF the avatar's top-right
 * corner, which is why the avatar is the positioning context.
 *
 * MENUS (WHA-199): one action surface, two open gestures.
 *   1. Click the hover kebab — Astryx `DropdownMenu`, same control the project
 *      row already uses. Click-triggered, so it does not depend on Tauri's
 *      right-click path (WHA-198).
 *   2. Right-click the row (or Shift+F10 / Menu key on the select target) —
 *      opens the SAME menu. WHA-103's ContextMenu-on-the-row is gone on purpose:
 *      two mounted menus with the same items double every `role="menu"` query
 *      and the dead gesture in the packaged app is the ContextMenu one.
 */
import * as stylex from "@stylexjs/stylex";
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { MoreVertical } from "lucide-react";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  toDateTimeAttribute,
} from "../lib/relativeTime.ts";
// The shared brand marks (src/assets/providers/*). The row and the composer's
// picker now render the SAME glyph, so a provider looks identical everywhere.
import ProviderGlyph from "../chat/composer/ProviderGlyph.tsx";
import type { ProviderId } from "../../chat/model.ts";

/** Which agent ran this thread. Drives the avatar glyph and its brand colour.
 *  The union is the shared `ProviderId` — never a local copy (a narrowed copy
 *  here once cost kimi threads their glyph). */
export type ThreadProvider = ProviderId;
export type ThreadStatus = "working" | "awaiting" | "ready" | "idle";

export interface ThreadRowProps {
  /** Stable id for selection wiring (p2a). Falls back to title when omitted. */
  id?: string;
  title: string;
  /** First line of the thread's opening prompt, truncated by the artboard. */
  subtitle: string;
  /** The thread the user is looking at — wash + accent bar. */
  isSelected?: boolean;
  status?: ThreadStatus;
  provider?: ThreadProvider;
  /** Sidebar selection — App.v2 owns activeThread and passes this down. */
  onSelect?: () => void;
  onNewThread?: () => void;
  onRename?: (() => void) | null;
  onCopyPath?: (() => void) | null;
  onCopyId?: (() => void) | null;
  onDelete?: () => void;
  /**
   * Epoch ms of the thread's last activity — rendered as `2d ago` in the
   * trailing slot. Omitted for drafts, which have no activity to report yet.
   */
  lastActivity?: number;
}

const ICON = 16;

const styles = stylex.create({
  row: {
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
    },
    borderRadius: "var(--conan-radius-md)",
    flexShrink: 0,
    height: "var(--conan-row-height)",
    padding: 0,
    position: "relative",
    width: "100%",
  },
  // WHA-118. Without the outline below this button fell through to the UA's own
  // focus ring — measured at the WHA-116 tip as Chrome's `rgb(153,200,255) auto
  // 1px`, square-cornered, and a DIFFERENT ring again under the Tauri WKWebView.
  // A browser default is not a design decision, so the row now states the
  // shell's own: the same 2px accent outline SurfaceTabs and the surface
  // splitter already use, at the row's own radius so the ring follows the shape
  // the hover wash draws rather than boxing it.
  //
  // Three states, three channels, deliberately non-overlapping (WHA-116's rule):
  // hover is the WASH, selection is the 2px accent BAR on the bottom edge, and
  // keyboard focus is this OUTLINE. None of them borrows another's channel, so
  // a row can show all three at once and still be readable.
  selectTarget: {
    appearance: "none",
    backgroundColor: "transparent",
    borderRadius: "var(--conan-radius-md)",
    borderStyle: "none",
    cursor: "pointer",
    flexGrow: 1,
    height: "100%",
    minWidth: 0,
    // Inset rather than the +2px SurfaceTabs uses: this button is a flex child
    // filling the row, so an outward ring would be clipped by the sidebar edge
    // on the left and collide with the trailing kebab on the right.
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    outlineOffset: { default: "0", ":focus-visible": "-2px" },
    padding: 0,
    textAlign: "start",
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
  statusWorking: { backgroundColor: "var(--conan-color-status-working)" },
  statusAwaiting: { backgroundColor: "var(--conan-color-status-awaiting)" },
  statusReady: { backgroundColor: "var(--conan-color-status-ready)" },
  statusIdle: { backgroundColor: "var(--conan-color-status-idle)" },
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
  // ONE SLOT, TWO OCCUPANTS (WHA-87 restored by WHA-199): timestamp at rest,
  // kebab on hover/focus. Only the timestamp is in flow; the kebab is taken out
  // of it and pinned to the slot's trailing edge, so revealing either one cannot
  // move the row. `flexShrink: 0` is the artboard's rule that this lane never
  // compresses — the title/subtitle truncate instead.
  trailing: {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    justifyContent: "flex-end",
    marginInlineEnd: "var(--conan-space-3)",
    // A MINIMUM, not a content-sized box: without it "now" and "11mo ago" give
    // their rows different lane widths and every title truncates at a different
    // x, which is exactly the raggedness the vertical-lane rule exists to stop.
    minWidth: "var(--conan-thread-time-lane)",
    position: "relative",
  },
  // Fades out as the kebab fades in (tokens.css owns the opacity rules so they
  // can also pin open while the menu is up). Reduced-motion is handled there.
  timestamp: {
    color: "var(--conan-text-muted)",
    fontSize: "var(--conan-text-small)",
    whiteSpace: "nowrap",
  },
  // Out of flow so revealing it costs no layout. Anchored to the slot's trailing
  // edge, which is where the artboard draws it.
  menuOverlay: {
    flexShrink: 0,
    height: "var(--conan-control-height)",
    insetBlockStart: 0,
    insetInlineEnd: 0,
    position: "absolute",
  },
});

const STATUS_LABEL: Record<ThreadStatus, string> = {
  working: "working",
  awaiting: "awaiting approval",
  ready: "ready",
  idle: "idle",
};

export default function ThreadRow({
  id,
  title,
  subtitle,
  isSelected = false,
  status = "idle",
  provider = "claude",
  onSelect,
  onNewThread,
  onRename,
  onCopyPath,
  onCopyId,
  onDelete,
  lastActivity,
}: ThreadRowProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const hasTimestamp = typeof lastActivity === "number" && Number.isFinite(lastActivity);
  const hasMenu = Boolean(onNewThread);

  const openMenu = () => {
    if (hasMenu) setIsMenuOpen(true);
  };

  // Right-click anywhere on the row opens the same DropdownMenu the kebab owns.
  // preventDefault stops the browser's native menu; without it the shell menu
  // never gets a chance.
  const handleRowContextMenu = (event: MouseEvent) => {
    if (!hasMenu) return;
    event.preventDefault();
    openMenu();
  };

  // Shift+F10 / Menu key — the keyboard path WHA-103 got for free from
  // ContextMenu. Reimplemented here so dropping ContextMenu does not strand
  // keyboard users.
  const handleSelectKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!hasMenu) return;
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      openMenu();
    }
  };

  return (
    <HStack
      align="center"
      xstyle={styles.row}
      data-slot="thread-row"
      data-thread-id={id ?? title}
      data-selected={isSelected ? "true" : undefined}
      onContextMenu={handleRowContextMenu}
    >
      <button
        type="button"
        aria-label={`${title}: ${subtitle}`}
        aria-current={isSelected ? "page" : undefined}
        data-thread-id={id ?? title}
        data-selected={isSelected ? "true" : undefined}
        onClick={onSelect}
        onKeyDown={handleSelectKeyDown}
        {...stylex.props(styles.selectTarget)}
      >
        <HStack align="start" gap={3} padding={3}>
          <HStack align="center" hAlign="center" xstyle={styles.avatar}>
            <ProviderGlyph providerId={provider} letter={provider.charAt(0).toUpperCase()} />
            <HStack
              xstyle={[
                styles.statusDot,
                status === "working" && styles.statusWorking,
                status === "awaiting" && styles.statusAwaiting,
                status === "ready" && styles.statusReady,
                status === "idle" && styles.statusIdle,
              ]}
              role="img"
              aria-label={`${title} is ${STATUS_LABEL[status]}`}
              data-thread-status={status}
            />
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
      </button>
      {/* `data-menu-open` rides the WRAPPER as well as the kebab: the timestamp
          has to stay hidden for the menu's whole lifetime, and it sits BEFORE
          the kebab in the DOM, so a sibling combinator can't reach it. */}
      <HStack
        xstyle={styles.trailing}
        data-slot="thread-trailing"
        data-menu-open={isMenuOpen ? "true" : undefined}
      >
        {hasTimestamp ? (
          <time
            dateTime={toDateTimeAttribute(lastActivity)}
            title={formatAbsoluteTime(lastActivity)}
            data-slot="thread-timestamp"
            {...stylex.props(styles.timestamp)}
          >
            {formatRelativeTime(lastActivity)}
          </time>
        ) : null}
        {hasMenu ? (
          <HStack
            xstyle={styles.menuOverlay}
            data-slot="thread-actions"
            data-menu-open={isMenuOpen ? "true" : undefined}
            onClick={(event) => event.stopPropagation()}
          >
            {/* Project-row pattern (ProjectTree.tsx): click DropdownMenu. One
                menu for both gestures — kebab click and row right-click both
                drive `isMenuOpen`. */}
            <DropdownMenu
              isMenuOpen={isMenuOpen}
              onOpenChange={setIsMenuOpen}
              button={{
                label: `Actions for ${title}`,
                icon: <MoreVertical size={ICON} aria-hidden />,
                isIconOnly: true,
                variant: "ghost",
                size: "sm",
              }}
              hasChevron={false}
              placement="below"
              items={[
                { label: "New thread", onClick: onNewThread },
                {
                  label: "Rename thread",
                  onClick: onRename ?? undefined,
                  isDisabled: !onRename,
                },
                {
                  label: "Copy Path",
                  onClick: onCopyPath ?? undefined,
                  isDisabled: !onCopyPath,
                },
                {
                  label: "Copy Thread ID",
                  onClick: onCopyId ?? undefined,
                  isDisabled: !onCopyId,
                },
                { type: "divider" },
                { label: "Delete", onClick: onDelete },
              ]}
            />
          </HStack>
        ) : null}
      </HStack>
      {isSelected ? <HStack xstyle={styles.indicator} aria-hidden /> : null}
    </HStack>
  );
}
