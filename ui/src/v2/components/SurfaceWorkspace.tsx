import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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
const STEP_PX = 20;

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
  surfaceBodyHidden: {
    display: "none",
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

function readBasisPercent(root: HTMLElement): number {
  const raw = root.style.getPropertyValue(SURFACE_BASIS_VAR);
  if (!raw) return 40;
  const num = Number.parseFloat(raw);
  return Number.isFinite(num) ? num : 40;
}

function clampBasis(value: number): number {
  return Math.min(60, Math.max(0, value));
}

function setBasis(root: HTMLElement, percent: number) {
  root.style.setProperty(SURFACE_BASIS_VAR, `${clampBasis(percent)}%`);
}

export default function SurfaceWorkspace({
  children,
  activeSurface,
  openSurfaces,
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
  const [basis, setBasisState] = useState(40);
  const [isRow, setIsRow] = useState(true);

  useEffect(() => {
    function updateOrientation() {
      const root = document.querySelector('[data-slot="surface-workspace"]');
      if (root instanceof HTMLElement) {
        setIsRow(getComputedStyle(root).flexDirection === "row");
      }
    }
    updateOrientation();
    window.addEventListener("resize", updateOrientation);
    return () => window.removeEventListener("resize", updateOrientation);
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
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

    function readRootIsRow() {
      return getComputedStyle(root).flexDirection === "row";
    }

    if ("setPointerCapture" in target) {
      target.setPointerCapture(event.pointerId);
    }

    function onMove(moveEvent: PointerEvent) {
      const moveIsRow = readRootIsRow();
      const delta = moveIsRow
        ? moveEvent.clientX - startClientX
        : moveEvent.clientY - startClientY;
      const startSize = moveIsRow ? startRect.width : startRect.height;
      const total = moveIsRow ? rootRect.width : rootRect.height;
      const nextBasis = ((startSize + delta) / total) * 100;
      setBasis(root, nextBasis);
      setBasisState(clampBasis(nextBasis));
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
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const rootEl = event.currentTarget.parentElement as HTMLElement | null;
    if (!rootEl) return;
    const root = rootEl;
    const growKeys = isRow ? ["ArrowRight", "ArrowDown"] : ["ArrowDown", "ArrowRight"];
    const shrinkKeys = isRow ? ["ArrowLeft", "ArrowUp"] : ["ArrowUp", "ArrowLeft"];

    if (!growKeys.includes(event.key) && !shrinkKeys.includes(event.key)) return;

    event.preventDefault();
    const delta = growKeys.includes(event.key) ? STEP_PX : -STEP_PX;
    const rect = root.getBoundingClientRect();
    const total = isRow ? rect.width : rect.height;
    if (total === 0) return;
    const current = readBasisPercent(root);
    const nextBasis = current + (delta / total) * 100;
    setBasis(root, nextBasis);
    setBasisState(clampBasis(nextBasis));
  }, [isRow]);

  const surfaceBodies = useMemo(() => {
    return openSurfaces.map((id) => {
      const isActive = id === activeSurface;
      return (
        <HStack
          key={id}
          gap={0}
          xstyle={[styles.surfaceBody, !isActive && styles.surfaceBodyHidden]}
          data-slot="surface-body"
          data-surface={id}
          aria-hidden={!isActive}
        >
          <SurfaceBody
            id={id}
            token={token}
            cwd={cwd}
            browserActive={id === "browser" && isActive}
            onBrowserStateChange={onBrowserStateChange}
            sagan={sagan}
            onOpenSaganThread={onOpenSaganThread}
          />
        </HStack>
      );
    });
  }, [openSurfaces, activeSurface, token, cwd, onBrowserStateChange, sagan, onOpenSaganThread]);

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
          role="separator"
          aria-label="Resize surface pane"
          aria-orientation={isRow ? "vertical" : "horizontal"}
          aria-valuemin={0}
          aria-valuemax={60}
          aria-valuenow={Math.round(basis)}
          aria-valuetext={`${Math.round(basis)} percent`}
          {...stylex.props(styles.splitter)}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
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
          {surfaceBodies}
        </VStack>
      ) : null}
    </HStack>
  );
}
