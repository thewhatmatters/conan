/**
 * Conan v2 — shell composition and slot contract.
 * (T0 of docs/v2-astryx-redesign.md; the §4.4 slot rule.)
 *
 * THIS FILE IS THE PARALLELISM CONTRACT. T1–T5 each build ONE slot in their own
 * component file and hand it in through `AppV2Slots`; nobody but T6 (the
 * assembly pass) edits this file. That is what keeps five worktrees from
 * colliding on a shared shell.
 *
 * Right now every slot is an empty placeholder, so what renders is the IA from
 * §3 in skeleton form: a 273px sidebar (header / body / footer) beside a main
 * column of toolbar → secondary bar → content.
 *
 * Astryx house rules that apply here (from `npx astryx init`'s agent docs):
 *   - no raw <div>; Layout / LayoutPanel / VStack / HStack do the structure
 *   - no Tailwind classes and no raw hex or px (contract §4.2 / §4.3)
 *   - anything the component props can't express goes through `xstyle` with
 *     values read from `tokens.css`
 */
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Layout, LayoutPanel, VStack, HStack } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { Divider } from "@astryxdesign/core/Divider";

/**
 * The seven named regions of the v2 shell. Every key is optional: an unfilled
 * slot renders its placeholder, so the shell is always runnable no matter how
 * many of T1–T5 have landed.
 */
export interface AppV2Slots {
  /** T1 — Conan logo mark + wordmark (Paper 70-0). */
  sidebarHeader?: ReactNode;
  /** T1 + T2 — ⌘K search (MU-0) above the project tree (OT-0 / PY-0 / PZ-0). */
  sidebarBody?: ReactNode;
  /** T3 — New chat button (7W-0) and Settings, pinned to the bottom (7L-0). */
  sidebarFooter?: ReactNode;
  /** T4 — breadcrumb `Conan / Analyze my project` (EL-0). */
  toolbarCrumb?: ReactNode;
  /** T4 — closeable surface tabs `Chat · Browser · Terminal · Diff` (HL-0). */
  toolbarTabs?: ReactNode;
  /** T5 — `Actions ▾`, `Open ▾`, `Commit & Push` (LN-0). */
  secondaryBar?: ReactNode;
  /** Later phase — transcript + composer (4N-0). Empty for the shell milestone. */
  content?: ReactNode;
}

export interface AppV2Props {
  slots?: AppV2Slots;
}

/**
 * `xstyle` is Astryx's per-component style escape hatch, and the reason this
 * app now compiles StyleX (see the plugin in `vite.config.ts`). Astryx's own
 * components ship pre-compiled, but `stylex.create` in APP code throws at
 * runtime unless a build-time compiler rewrites it — verified in T0:
 *
 *   node -e "stylex.create({a:{color:'red'}})"
 *   → "Unexpected 'stylex.create' call at runtime. Styles must be compiled…"
 *
 * Every value below is a `tokens.css` variable, never a literal (contract §4.2).
 */
const styles = stylex.create({
  // Fixed-height bars. Astryx has no height prop on HStack, so the bar heights
  // (a hard convention in this codebase — see CLAUDE.md on h-9 toolbars) come
  // through xstyle.
  toolbar: {
    height: "var(--conan-toolbar-height)",
    flexShrink: 0,
  },
  secondaryBar: {
    height: "var(--conan-secondary-bar-height)",
    flexShrink: 0,
  },
  // The sidebar body is the only scrolling region in the shell; header and
  // footer stay pinned.
  grow: {
    flexGrow: 1,
    minHeight: 0,
  },
  // Placeholder chrome — a dashed outline so an unfilled slot is obviously a
  // slot and not a layout bug. Deleted per-slot as T1–T5 land.
  placeholder: {
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: "var(--conan-color-border-strong)",
    borderRadius: "var(--conan-radius-sm)",
  },
});

/** Dashed stand-in for a slot nobody has filled yet. */
function SlotPlaceholder({ name }: { name: string }) {
  return (
    <HStack
      padding={2}
      hAlign="center"
      width="100%"
      xstyle={styles.placeholder}
      data-slot={name}
    >
      <Text type="supporting" color="disabled">
        {name}
      </Text>
    </HStack>
  );
}

/**
 * The T0 smoke render: a VStack + Button from `@astryxdesign/core`, proving the
 * whole pipeline end to end — package resolution, the CSS airlock in
 * `entry.tsx`, `data-astryx-theme` scoping, the neutral theme's tokens, the
 * Figtree webfont, and StyleX compilation of the `xstyle` above. If this block
 * renders styled, T1–T5 are unblocked. It is replaced by the real transcript in
 * a later phase.
 */
function ContentSmokeTest() {
  return (
    <VStack gap={3} padding={6} hAlign="start">
      <Text type="display-3">Conan v2</Text>
      <Text type="supporting">
        Astryx shell — sidebar and toolbar slots are wired, components land in
        T1–T5.
      </Text>
      <Divider />
      <HStack gap={2}>
        <Button label="Primary" variant="primary" />
        <Button label="Secondary" variant="secondary" />
        <Button label="Ghost" variant="ghost" />
      </HStack>
    </VStack>
  );
}

/**
 * The v2 shell. One `Layout` for the page (Astryx's guidance is one per shell,
 * never nested): `start` carries the sidebar panel, `content` carries the main
 * column that T4/T5 and the later transcript phase fill in.
 */
export default function AppV2({ slots = {} }: AppV2Props) {
  return (
    <Layout
      height="fill"
      start={
        <LayoutPanel
          width="var(--conan-sidebar-width)"
          hasDivider
          isScrollable={false}
          padding={0}
          role="navigation"
          label="Projects and threads"
        >
          <VStack height="100%" gap={0}>
            {slots.sidebarHeader ?? <SlotPlaceholder name="sidebar-header" />}
            <VStack isScrollable xstyle={styles.grow} padding={2}>
              {slots.sidebarBody ?? <SlotPlaceholder name="sidebar-body" />}
            </VStack>
            {slots.sidebarFooter ?? <SlotPlaceholder name="sidebar-footer" />}
          </VStack>
        </LayoutPanel>
      }
      content={
        <VStack height="100%" gap={0}>
          <HStack
            gap={3}
            paddingInline={3}
            align="center"
            xstyle={styles.toolbar}
          >
            {slots.toolbarCrumb ?? <SlotPlaceholder name="toolbar-crumb" />}
            {slots.toolbarTabs ?? <SlotPlaceholder name="toolbar-tabs" />}
          </HStack>
          <Divider />
          <HStack gap={2} paddingInline={3} align="center" xstyle={styles.secondaryBar}>
            {slots.secondaryBar ?? <SlotPlaceholder name="secondary-bar" />}
          </HStack>
          <Divider />
          <VStack isScrollable xstyle={styles.grow}>
            {slots.content ?? <ContentSmokeTest />}
          </VStack>
        </VStack>
      }
    />
  );
}
