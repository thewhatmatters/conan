import { type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  V2BrowserSurface,
  V2DiffSurface,
  V2FilesSurface,
  V2SaganSurface,
  V2TerminalSurface,
} from "./V2SurfaceBodies.tsx";
import SurfaceToolbar from "./SurfaceToolbar.tsx";
import { SURFACE_OPTIONS, type SurfaceId } from "./SurfaceTabs.tsx";
import type { BrowserSurfaceReport } from "../../hooks/useAgentChat.ts";
import type { SaganCapabilityResult } from "../lib/useSaganCapability.ts";

const NARROW_BREAKPOINT_PX = 960;
const SURFACE_BASIS_VAR = "--surface-basis";

const styles = stylex.create({
  root: {
    alignItems: "stretch",
    flexDirection: {
      default: "row",
      [`@media (max-width: ${NARROW_BREAKPOINT_PX}px)`]: "column",
    },
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    position: "relative",
  },
  chatPane: {
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    position: "relative",
  },
  surfacePane: {
    flexBasis: {
      default: `clamp(320px, var(${SURFACE_BASIS_VAR}, 40%), 60%)`,
      [`@media (max-width: ${NARROW_BREAKPOINT_PX}px)`]: `clamp(320px, var(${SURFACE_BASIS_VAR}, 50%), 60%)`,
    },
    flexGrow: 0,
    flexShrink: 0,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    position: "relative",
  },
  splitter: {
    alignSelf: "stretch",
    backgroundColor: {
      default: "var(--conan-color-border)",
      ":hover": "var(--conan-color-accent)",
    },
    borderStyle: "none",
    color: "transparent",
    cursor: {
      default: "col-resize",
      [`@media (max-width: ${NARROW_BREAKPOINT_PX}px)`]: "row-resize",
    },
    flexShrink: 0,
    height: {
      default: "auto",
      [`@media (max-width: ${NARROW_BREAKPOINT_PX}px)`]: "4px",
    },
    outline: {
      default: null,
      ":focus-visible": "2px solid var(--conan-color-accent)",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    padding: 0,
    width: {
      default: "4px",
      [`@media (max-width: ${NARROW_BREAKPOINT_PX}px)`]: "100%",
    },
  },
  paneHeader: {
    alignItems: "center",
    backdropFilter: "blur(var(--conan-glass-blur))",
    WebkitBackdropFilter: "blur(var(--conan-glass-blur))",
    backgroundColor: "var(--conan-glass-tint)",
    boxSizing: "border-box",
    flexShrink: 0,
    height: "var(--conan-secondary-bar-height)",
    paddingInline: "var(--conan-space-3)",
    position: "relative",
    zIndex: 2,
  },
  paneHeaderRule: {
    backgroundColor: "var(--conan-color-border)",
    bottom: 0,
    height: "var(--conan-border-width)",
    insetInline: 0,
    position: "absolute",
    zIndex: 3,
  },
  surfaceBody: {
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    position: "relative",
  },
  surfaceLabel: {
    alignItems: "center",
    columnGap: "var(--conan-space-2)",
  },
});

function SurfaceBody({
  id,
  token,
  cwd,
  browserActive,
  onBrowserStateChange,
  sagan,
  onOpenSaganThread,
}: {
  id: Exclude<SurfaceId, "chat">;
  token: string | null;
  cwd: string | null;
  /** True when Browser is the surface currently on screen (WHA-109). */
  browserActive: boolean;
  onBrowserStateChange?: (state: BrowserSurfaceReport) => void;
  sagan?: SaganCapabilityResult;
  onOpenSaganThread?: (id: string) => void;
}) {
  if (id === "terminal") return <V2TerminalSurface token={token} cwd={cwd} />;
  if (id === "browser") {
    return (
      <V2BrowserSurface
        token={token}
        active={browserActive}
        onStateChange={onBrowserStateChange}
      />
    );
  }
  if (id === "files") return <V2FilesSurface token={token} cwd={cwd} />;
  if (id === "sagan") return <V2SaganSurface token={token} cwd={cwd} result={sagan} onOpenOwningThread={onOpenSaganThread} />;
  return <V2DiffSurface token={token} cwd={cwd} />;
}

function handleSplitterPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
  event.preventDefault();
  const target = event.currentTarget;
  const surfacePane = target.nextElementSibling as HTMLElement | null;
  const rootEl = target.parentElement as HTMLElement | null;
  if (!surfacePane || !rootEl) return;
  const root = rootEl;

  const startRect = surfacePane.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const startClientX = event.clientX;
  const startClientY = event.clientY;
  const isRow = getComputedStyle(rootEl).flexDirection === "row";

  if ("setPointerCapture" in target) {
    target.setPointerCapture(event.pointerId);
  }

  function onMove(moveEvent: PointerEvent) {
    const delta = isRow
      ? moveEvent.clientX - startClientX
      : moveEvent.clientY - startClientY;
    const startSize = isRow ? startRect.width : startRect.height;
    const total = isRow ? rootRect.width : rootRect.height;
    const basis = ((startSize + delta) / total) * 100;
    root.style.setProperty(SURFACE_BASIS_VAR, `${Math.max(0, basis)}%`);
  }

  function onUp(upEvent: PointerEvent) {
    target.removeEventListener("pointermove", onMove);
    if ("releasePointerCapture" in target) {
      try {
        target.releasePointerCapture(upEvent.pointerId);
      } catch {
        // capture may already be released
      }
    }
  }

  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onUp, { once: true });
}

export default function SurfaceWorkspace({
  children,
  activeSurface,
  token,
  cwd,
  onBrowserStateChange,
  sagan,
  onOpenSaganThread,
}: {
  children: ReactNode;
  activeSurface: SurfaceId;
  openSurfaces: Array<Exclude<SurfaceId, "chat">>;
  token: string | null;
  cwd: string | null;
  /** Browser-surface reports headed for the agent socket (WHA-109). */
  onBrowserStateChange?: (state: BrowserSurfaceReport) => void;
  sagan?: SaganCapabilityResult;
  onOpenSaganThread?: (id: string) => void;
}) {
  const chatActive = activeSurface === "chat";
  const activeOption = SURFACE_OPTIONS.find((surface) => surface.id === activeSurface);
  const ActiveIcon = activeOption?.icon;
  const surfaceOpen = !chatActive && activeOption != null;

  return (
    <HStack
      gap={0}
      align="stretch"
      xstyle={styles.root}
      data-slot="surface-workspace"
    >
      <VStack
        gap={0}
        xstyle={styles.chatPane}
        data-slot="chat-surface"
      >
        {children}
      </VStack>
      {surfaceOpen ? (
        <button
          type="button"
          aria-label="Resize surface pane"
          {...stylex.props(styles.splitter)}
          onPointerDown={handleSplitterPointerDown}
          data-slot="surface-splitter"
        />
      ) : null}
      {surfaceOpen ? (
        <VStack
          gap={0}
          xstyle={styles.surfacePane}
          data-slot="surface-pane"
          data-surface={activeSurface}
        >
          <HStack
            align="center"
            justify="end"
            xstyle={styles.paneHeader}
            data-slot="surface-pane-header"
          >
            <SurfaceToolbar
              dataSlot="surface-toolbar"
              borderless
              left={
                <HStack
                  align="center"
                  xstyle={styles.surfaceLabel}
                  data-slot="surface-toolbar-label"
                >
                  {ActiveIcon ? <ActiveIcon size={16} aria-hidden /> : null}
                  <Text color="primary" weight="semibold">
                    {activeOption.label}
                  </Text>
                </HStack>
              }
            />
            <HStack xstyle={styles.paneHeaderRule} aria-hidden data-slot="surface-pane-header-rule" />
          </HStack>
          <HStack
            gap={0}
            xstyle={styles.surfaceBody}
            data-slot="surface-body"
          >
            <SurfaceBody
              id={activeSurface}
              token={token}
              cwd={cwd}
              browserActive={activeSurface === "browser"}
              onBrowserStateChange={onBrowserStateChange}
              sagan={sagan}
              onOpenSaganThread={onOpenSaganThread}
            />
          </HStack>
        </VStack>
      ) : null}
    </HStack>
  );
}
