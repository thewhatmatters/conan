/**
 * ProjectSortMenu — Paper `73D-0` ("Filtering", 425×341), WHA-60.
 *
 * The menu behind the sidebar's `Projects` sort icon (RJ-0 node `O5-0`, the
 * first of the section header's two 32px action slots). That slot has existed
 * since the tree landed and was deliberately inert pending this story.
 *
 * Despite the artboard's name, `73D-0` FILTERS NOTHING — it is two single-select
 * ordering groups. Grouping, text filter, active-filter indicator and reset are
 * not drawn anywhere, so they are not built here (WHA-78 tracks them).
 *
 * ROWS ARE BUILT FROM `Item`, NOT `DropdownMenuRadioItem` — the same call
 * Randy made for the breadcrumb switcher on 2026-08-04, for the same reason.
 * `73D-0` marks the active row with a TRAILING CHECK; `DropdownMenuRadioItem`'s
 * marker is a hard-coded LEADING DOT with no prop to suppress it, so using it
 * draws both and the row reads as neither design. `useDropdownMenuContext` is
 * public for exactly this, and the parent `DropdownMenu` keeps arrow keys,
 * typeahead, Enter/Space and Esc because its selector matches `menuitemradio`
 * rows wherever they sit. ARIA says nothing about the glyph, so the row still
 * announces `role="menuitemradio"` + `aria-checked` while showing the artboard's
 * mark. See `Breadcrumb.tsx` for the original of this pattern.
 */
import { useId, useState, type PointerEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Item } from "@astryxdesign/core/Item";
import {
  DropdownMenu,
  useDropdownMenuContext,
} from "@astryxdesign/core/DropdownMenu";
import { ArrowDownWideNarrow, Check } from "lucide-react";
import {
  PROJECT_ORDERS,
  PROJECT_ORDER_LABELS,
  THREAD_ORDERS,
  THREAD_ORDER_LABELS,
  type ProjectOrder,
  type ThreadOrder,
} from "../lib/projectOrder.ts";
import { controlStyles } from "../lib/controlStyles.ts";

const ICON = 16;

const styles = stylex.create({
  // The same fixed 32px lane the section header's Add action occupies — the two
  // icons sit on one right-hand rail, so the slot is a fixed size rather than
  // whatever the trigger button happens to measure.
  slot: {
    flexShrink: 0,
    height: "var(--conan-control-height)",
    width: "var(--conan-control-height)",
  },
  // 73D-0's group label: the menu's quiet tone, a step under the row text.
  groupTitle: {
    color: "var(--conan-text-muted)",
    display: "block",
    paddingBlock: "var(--conan-space-1)",
    paddingInline: "var(--conan-space-3)",
  },
  row: {
    minWidth: "100%",
  },
  // Astryx caps `astryx-dropdown-menu` at 300px and scrolls past it. This menu
  // is 316px, so at rest the last row ("Recently Added" under Order Threads By)
  // sits half-cut behind the fold — reachable, but 73D-0 is 341px with every
  // row whole, and a menu that looks truncated reads as "there is more here"
  // when there is not. The option set is fixed by the design, so this cannot
  // grow without a new artboard; per-instance, not a theme change.
  menu: {
    maxHeight: "fit-content",
  },
});

export interface ProjectSortMenuProps {
  projectOrder: ProjectOrder;
  threadOrder: ThreadOrder;
  /**
   * How many projects the sidebar is showing. Below two there is nothing for a
   * project order to rearrange, so that half of the menu is not drawn — Randy,
   * 2026-08-17. The thread group stays: a single project still has threads.
   */
  projectCount: number;
  onProjectOrderChange?: (order: ProjectOrder) => void;
  onThreadOrderChange?: (order: ThreadOrder) => void;
}

/**
 * One option row. `tabIndex={-1}` is what puts it in the parent menu's roving
 * focus, and the pointer handler mirrors Astryx's own items so hover and arrow
 * keys share ONE highlight instead of lighting two rows at once.
 */
function OrderItem({
  label,
  isSelected,
  onSelect,
}: {
  label: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const menu = useDropdownMenuContext();

  return (
    <Item
      role="menuitemradio"
      aria-checked={isSelected}
      tabIndex={-1}
      label={label}
      isSelected={isSelected}
      endContent={
        isSelected ? (
          // The data-slot is what lets a test assert the mark is actually
          // DRAWN — `aria-checked` alone keeps passing with no glyph at all.
          <span data-slot="order-check" aria-hidden>
            <Check size={ICON} />
          </span>
        ) : undefined
      }
      onClick={() => {
        onSelect();
        menu?.closeMenu();
      }}
      onPointerMove={(event: PointerEvent<HTMLElement>) => {
        if (event.pointerType !== "mouse") return;
        const row = event.currentTarget;
        if (row !== row.ownerDocument.activeElement) row.focus();
      }}
      xstyle={styles.row}
      data-slot="order-row"
    />
  );
}

export default function ProjectSortMenu({
  projectOrder,
  threadOrder,
  projectCount,
  onProjectOrderChange,
  onThreadOrderChange,
}: ProjectSortMenuProps) {
  // The visible group titles ARE the accessible names — `aria-labelledby`
  // rather than a duplicated `aria-label`, so the two cannot drift apart.
  // Both groups contain a "Last Activity" and a "Name"; without the grouping a
  // screen reader would read seven interchangeable options.
  const projectTitleId = useId();
  const threadTitleId = useId();
  const showProjectGroup = projectCount > 1;
  // WHA-203: the trigger holds its hover treatment while the menu is open. The
  // pointer has to leave it to reach the flyout, and Astryx's ghost button
  // drops straight back to rest — which reads as the control going dead under
  // its own menu.
  //
  // The menu is CONTROLLED for this. Astryx does not call `onOpenChange` in
  // uncontrolled mode (verified against 0.4.3: the menu opens, the callback
  // never fires), so passing the handler alone would leave the pin silently
  // dead — which is exactly how it first shipped.
  const [isOpen, setIsOpen] = useState(false);

  return (
    <HStack align="center" xstyle={styles.slot} data-slot="project-sort">
      <DropdownMenu
        button={{
          // The trigger's name follows what the menu actually offers. Leaving
          // it "Sort projects" over a thread-only menu is a lie a sighted user
          // never sees and a screen-reader user hits immediately.
          label: showProjectGroup ? "Sort projects" : "Sort threads",
          icon: <ArrowDownWideNarrow size={ICON} aria-hidden />,
          isIconOnly: true,
          variant: "ghost",
          size: "sm",
          // Astryx's ghost rests at icon-primary in a 28px 10px-radius box;
          // the lane beside it is 32px at radius-sm and rests muted. One model
          // wins, and it is ours (WHA-203).
          xstyle: [
            controlStyles.iconButton,
            isOpen && controlStyles.iconButtonOpen,
          ],
          "data-slot": "control",
        }}
        hasChevron={false}
        placement="below"
        isMenuOpen={isOpen}
        onOpenChange={setIsOpen}
        xstyle={styles.menu}
      >
        {showProjectGroup && (
          <>
            <Text id={projectTitleId} size="sm" xstyle={styles.groupTitle}>
              Order Projects By
            </Text>
            <div role="group" aria-labelledby={projectTitleId}>
              {PROJECT_ORDERS.map((order) => (
                <OrderItem
                  key={order}
                  label={PROJECT_ORDER_LABELS[order]}
                  isSelected={order === projectOrder}
                  onSelect={() => onProjectOrderChange?.(order)}
                />
              ))}
            </div>
          </>
        )}
        <Text id={threadTitleId} size="sm" xstyle={styles.groupTitle}>
          Order Threads By
        </Text>
        <div role="group" aria-labelledby={threadTitleId}>
          {THREAD_ORDERS.map((order) => (
            <OrderItem
              key={order}
              label={THREAD_ORDER_LABELS[order]}
              isSelected={order === threadOrder}
              onSelect={() => onThreadOrderChange?.(order)}
            />
          ))}
        </div>
      </DropdownMenu>
    </HStack>
  );
}
