/**
 * Breadcrumb — Paper RJ-0 node EL-0 (the toolbar's project / thread crumb).
 *
 * The parent crumb is a real focusable button so a keyboard / AT user can
 * navigate "back to project"; the leaf is the thread you have open.
 *
 * RJ-0's hierarchy here is carried entirely by colour: the parent crumb and its
 * folder icon are the DIM step (#737373), the separator likewise, and only the
 * leaf is full white. Two of those three tones are not Astryx `Text` colours, so
 * each crumb group sets `color` once via `xstyle` and its children take
 * `color="inherit"` — the icon picks the same value up through `currentColor`.
 * (`Text`'s `xstyle` is deliberately restricted to layout properties, so this
 * indirection is the sanctioned way to reach a custom tone.)
 *
 * WHA-104 — THE LEAF IS A THREAD SWITCHER
 * ---------------------------------------
 * WHA-77's artboard update makes the thread segment the interactive crumb: an
 * always-visible chevron (no hover-reveal, so the affordance is discoverable
 * without the whole breadcrumb reading as a button bar) opening a compact menu
 * of the project's threads with the current one marked. The rows are
 * deliberately lighter than sidebar rows — title only, no avatar tile, preview
 * or timestamp. This is a quick switcher, not a second sidebar (WHA-75).
 *
 * Two decisions worth keeping:
 *
 *   - The current row is marked with a TRAILING CHECK, the artboard's mark
 *     (Randy's call, 2026-08-04), while the row keeps `role="menuitemradio"` +
 *     `aria-checked` so a screen reader still hears which thread is open. Those
 *     two are independent: ARIA says nothing about the glyph. Getting both meant
 *     building the row from Astryx's `Item` instead of `DropdownMenuRadioItem`,
 *     whose marker is a hard-coded leading dot — `useDropdownMenuContext` is
 *     public for exactly this ("consumers can build custom menu items"), and
 *     the parent `DropdownMenu` still owns arrow keys, typeahead, Enter/Space
 *     and Esc because its selector matches `menuitemradio` rows.
 *   - Below two threads there is nothing to switch to, so the leaf falls back to
 *     the static text it has always been. A menu whose only row is the thread
 *     you are already reading is a dead affordance.
 */
import type { PointerEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Item } from "@astryxdesign/core/Item";
import {
  DropdownMenu,
  useDropdownMenuContext,
} from "@astryxdesign/core/DropdownMenu";
import { Check, FolderOpen } from "lucide-react";

/** One row of the thread menu — the sidebar's key and title, nothing else. */
export interface BreadcrumbThread {
  /** The sidebar's thread key: a session id, or a draft id. */
  id: string;
  title: string;
}

export interface BreadcrumbProps {
  /** The project the thread belongs to. */
  project?: string;
  /** The thread's title — the leaf, and the only crumb at full contrast. */
  thread?: string;
  /**
   * The current project's threads in the SIDEBAR's order (drafts first, then
   * the gateway's own ordering), so the menu and the rail agree.
   */
  threads?: BreadcrumbThread[];
  /** Key of the open thread, matching one of `threads[].id`. */
  activeThreadId?: string | null;
  /** Switch to a sibling thread. */
  onSelectThread?: (id: string) => void;
  /** Optional handler when the parent (project) crumb is activated. */
  onProjectClick?: () => void;
}

const styles = stylex.create({
  crumbs: {
    flexShrink: 0,
  },
  dim: {
    color: "var(--conan-text-dim)",
  },
  // Parent crumb is a real <button> — reset UA chrome so it still reads as the
  // artboard's dim text+icon pair, not a filled control. Layout matches the
  // surrounding HStack gap=1 row (inline-flex + 4px gap).
  parentButton: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    borderStyle: "none",
    borderWidth: 0,
    color: "var(--conan-text-dim)",
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    font: "inherit",
    gap: "var(--conan-space-1)",
    margin: 0,
    padding: 0,
  },
  leaf: {
    color: "var(--conan-text-strong)",
  },
  // The switcher trigger. Astryx's ghost Button brings 12px of inline padding
  // and an 8px gap; tightening both and pulling the padding back out with a
  // negative margin leaves the title exactly where the static leaf sat, while
  // still giving the hover wash something to fill.
  threadTrigger: {
    color: "var(--conan-text-strong)",
    gap: "var(--conan-space-1)",
    marginInlineStart: "calc(-1 * var(--conan-space-1h))",
    paddingInline: "var(--conan-space-1h)",
  },
  // A thread title is whatever the first message was, so the menu needs a
  // ceiling or one long title sizes the whole surface. Astryx's `Item`
  // truncates a string label to a single line inside that bound.
  threadMenu: {
    maxWidth: "var(--conan-crumb-menu-max-width)",
  },
  // One menu row. The hover/focus wash is NOT here: `tokens.css` already gives
  // every v2 menu row one treatment for both, keyed on the menu-item roles, and
  // a second copy in `xstyle` would be a second thing to keep in step.
  threadRow: {
    borderRadius: "var(--conan-radius-sm)",
    color: "var(--conan-text-primary)",
    cursor: "pointer",
    outline: "none",
    width: "100%",
  },
});

/**
 * One thread row: title, and a trailing ✓ when it is the open one.
 *
 * `tabIndex={-1}` is what makes the row reachable by the parent menu's roving
 * focus, and `role` is what puts the click handler on the row itself rather
 * than inside an invisible button (`Item` skips that when a parent owns the
 * keyboard). The pointer handler mirrors what Astryx's own menu items do —
 * focus follows the mouse, so hover and arrow keys share ONE highlight instead
 * of lighting two rows at once.
 */
function ThreadMenuItem({
  thread,
  isCurrent,
  onSelect,
}: {
  thread: BreadcrumbThread;
  isCurrent: boolean;
  onSelect: (id: string) => void;
}) {
  const menu = useDropdownMenuContext();

  return (
    <Item
      role="menuitemradio"
      aria-checked={isCurrent}
      tabIndex={-1}
      label={thread.title}
      isSelected={isCurrent}
      endContent={isCurrent ? <Check size={16} aria-hidden /> : undefined}
      onClick={() => {
        onSelect(thread.id);
        menu?.closeMenu();
      }}
      onPointerMove={(event: PointerEvent<HTMLElement>) => {
        if (event.pointerType !== "mouse") return;
        const row = event.currentTarget;
        if (row !== row.ownerDocument.activeElement) row.focus();
      }}
      xstyle={styles.threadRow}
      data-slot="breadcrumb-thread-row"
    />
  );
}

export default function Breadcrumb({
  project = "Conan",
  thread = "Analyze my project",
  threads = [],
  activeThreadId = null,
  onSelectThread,
  onProjectClick,
}: BreadcrumbProps) {
  const canSwitch = threads.length > 1 && onSelectThread != null;

  return (
    <HStack align="center" gap={1} wrap="wrap" xstyle={styles.crumbs} data-slot="breadcrumb">
      <button
        type="button"
        {...stylex.props(styles.parentButton)}
        aria-label={`Back to ${project}`}
        onClick={onProjectClick}
        data-slot="breadcrumb-parent"
      >
        <FolderOpen size={16} aria-hidden />
        <Text color="inherit">{project}</Text>
      </button>
      <HStack align="center" gap={1} xstyle={styles.dim}>
        <Text color="inherit" aria-hidden>
          /
        </Text>
      </HStack>
      {canSwitch ? (
        <DropdownMenu
          button={{
            // `label` is the accessible name and has to CONTAIN the visible
            // text (WCAG 2.5.3 Label in Name), so it stays the title; the
            // `children` render that same title through `Text` so the leaf
            // keeps the artboard's body type rather than the Button's own
            // label scale.
            label: thread,
            children: <Text color="inherit">{thread}</Text>,
            variant: "ghost",
            size: "sm",
            xstyle: styles.threadTrigger,
            "data-slot": "breadcrumb-thread",
          }}
          placement="below"
          xstyle={styles.threadMenu}
          data-slot="breadcrumb-thread-menu"
        >
          {threads.map((sibling) => (
            <ThreadMenuItem
              key={sibling.id}
              thread={sibling}
              isCurrent={sibling.id === activeThreadId}
              onSelect={(id) => onSelectThread?.(id)}
            />
          ))}
        </DropdownMenu>
      ) : (
        <HStack align="center" xstyle={styles.leaf}>
          <Text color="inherit">{thread}</Text>
        </HStack>
      )}
    </HStack>
  );
}
