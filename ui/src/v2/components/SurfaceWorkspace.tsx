import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { PanelLeft, PanelRight, X } from "lucide-react";
import {
  V2BrowserSurface,
  V2DiffSurface,
  V2FilesSurface,
  V2SaganSurface,
  V2TerminalSurface,
} from "./V2SurfaceBodies.tsx";
import {
  SURFACE_PANEL_MAX_FRACTION,
  SURFACE_PANEL_MIN_WIDTH,
} from "../../components/SurfacePanel.tsx";
import {
  SURFACE_DRAG_MIME_TYPE,
  SURFACE_OPTIONS,
  type SurfaceId,
  type SurfacePlacement,
} from "./SurfaceTabs.tsx";
import type { BrowserSurfaceReport } from "../../hooks/useAgentChat.ts";
import type { SaganCapabilityResult } from "../lib/useSaganCapability.ts";

const DEFAULT_SIZE = 420;
const STEP_SIZE = 24;
const DROP_ICON_SIZE = 16;
/** Width of each dropzone rail during a surface drag, measured from RJ-0 (~17%). */
const DROP_ZONE_FRACTION = 0.17;

const styles = stylex.create({
  root: {
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    position: "relative",
  },
  chat: {
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    // Containing block for the glass header that overlays this pane.
    position: "relative",
  },
  paneBody: { flexGrow: 1, minHeight: 0, minWidth: 0, overflow: "clip" },
  // WHA-115 — the header is a GLASS OVERLAY, not a row above the body. It is
  // lifted out of flow so the pane's scroll area starts at y=0 and its content
  // passes under the bar; the body keeps clear of it with a top inset equal to
  // this height (`--conan-secondary-bar-height`, applied by each pane body).
  //
  // Same construction as Astryx's composer dock at the foot of the well, in
  // reverse. Unlike the dock there is no mask fade: the bar ends on the 1px
  // `headerRule`, which is what keeps a hard, readable edge between chrome and
  // content instead of a smear.
  paneHeader: {
    backdropFilter: "blur(var(--conan-glass-blur))",
    WebkitBackdropFilter: "blur(var(--conan-glass-blur))",
    backgroundColor: "var(--conan-glass-tint)",
    boxSizing: "border-box",
    height: "var(--conan-secondary-bar-height)",
    insetInline: 0,
    position: "absolute",
    top: 0,
    width: "100%",
    zIndex: 2,
  },
  headerRule: {
    backgroundColor: "var(--conan-color-border)",
    height: "var(--conan-border-width)",
    insetInline: 0,
    position: "absolute",
    top: "calc(var(--conan-secondary-bar-height) - var(--conan-border-width))",
    // Above the glass (z 2), so the bar's bottom edge stays a crisp line
    // rather than being painted over by the panel it belongs to.
    zIndex: 3,
  },
  dockHeader: {
    paddingInline: "var(--conan-space-4)",
  },
  dockHeaderLabel: {
    color: "var(--conan-icon-strong)",
  },
  undockButton: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
      ":active": "var(--conan-wash-pressed)",
    },
    borderRadius: "var(--conan-radius-md)",
    borderStyle: "none",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    display: "inline-flex",
    height: "var(--conan-control-height)",
    justifyContent: "center",
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    width: "var(--conan-control-height)",
  },
  dock: {
    backgroundColor: "var(--conan-color-content)",
    flexGrow: 0,
    flexShrink: 0,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    // Containing block for this pane's own glass header (WHA-115).
    position: "relative",
  },
  standalone: { flexBasis: "auto", flexGrow: 1 },
  hidden: { display: "none" },
  surfaceBody: { flexGrow: 1, minHeight: 0, minWidth: 0, width: "100%" },
  dockBefore: { order: -2 },
  separatorBefore: { order: -1 },
  separatorAfter: { order: 1 },
  dockAfter: { order: 2 },
  separatorVertical: {
    alignSelf: "stretch",
    cursor: "col-resize",
    flexBasis: "var(--conan-space-2)",
    flexShrink: 0,
    justifyContent: "center",
    minWidth: "var(--conan-space-2)",
    width: "var(--conan-space-2)",
  },
  separatorLine: {
    backgroundColor: "transparent",
    outline: "none",
  },
  separatorPaintVertical: {
    alignSelf: "stretch",
    backgroundColor: "var(--conan-color-border)",
    width: "var(--conan-border-width)",
  },
  dropOverlay: {
    boxSizing: "border-box",
    flexWrap: "nowrap",
    inset: 0,
    padding: "var(--conan-space-4)",
    pointerEvents: "auto",
    position: "absolute",
    zIndex: 10,
  },
  dropZone: {
    alignItems: "center",
    borderColor: "var(--conan-color-border-strong)",
    borderRadius: "var(--conan-radius-md)",
    borderStyle: "dashed",
    borderWidth: "var(--conan-border-width)",
    boxSizing: "border-box",
    color: "var(--conan-icon-muted)",
    gap: "var(--conan-space-2)",
    justifyContent: "center",
    transitionDuration: "var(--conan-duration-fast)",
    transitionProperty: "border-color, color, background-color",
    width: `${DROP_ZONE_FRACTION * 100}%`,
  },
  dropZoneActive: {
    borderColor: "var(--conan-color-accent)",
    color: "var(--conan-icon-strong)",
    backgroundColor: "var(--conan-wash-hover)",
  },
  dropZoneDisabled: {
    opacity: 0.3,
    pointerEvents: "none",
  },
  dropZoneSpacer: {
    flexGrow: 1,
  },
});

function DockHeader({
  surface,
  onUndock,
}: {
  surface: Exclude<SurfaceId, "chat">;
  onUndock?: (id: Exclude<SurfaceId, "chat">) => void;
}) {
  const option = SURFACE_OPTIONS.find(({ id }) => id === surface);
  if (!option) return null;
  const Icon = option.icon;
  const label = `Undock ${option.label}`;

  return (
    <HStack
      align="center"
      justify="between"
      gap={2}
      xstyle={[styles.paneHeader, styles.dockHeader]}
      data-slot="docked-surface-header"
    >
      <HStack align="center" gap={2} xstyle={styles.dockHeaderLabel}>
        <Icon size={16} aria-hidden />
        <Text color="primary" weight="semibold">{option.label}</Text>
      </HStack>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => onUndock?.(surface)}
        {...stylex.props(styles.undockButton)}
      >
        <X size={16} aria-hidden />
      </button>
    </HStack>
  );
}

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

export default function SurfaceWorkspace({
  children,
  header,
  activeSurface,
  openSurfaces,
  placement,
  token,
  cwd,
  onUndock,
  onPlacementChange,
  onBrowserStateChange,
  sagan,
  onOpenSaganThread,
}: {
  children: ReactNode;
  header: ReactNode;
  activeSurface: SurfaceId;
  openSurfaces: Array<Exclude<SurfaceId, "chat">>;
  placement?: SurfacePlacement;
  token: string | null;
  cwd: string | null;
  onUndock?: (id: Exclude<SurfaceId, "chat">) => void;
  /** Called when a dragged surface tab is dropped on a dropzone rail. */
  onPlacementChange?: (id: Exclude<SurfaceId, "chat">, placement: SurfacePlacement) => void;
  /** Browser-surface reports headed for the agent socket (WHA-109). */
  onBrowserStateChange?: (state: BrowserSurfaceReport) => void;
  sagan?: SaganCapabilityResult;
  onOpenSaganThread?: (id: string) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [availableSize, setAvailableSize] = useState(
    DEFAULT_SIZE / SURFACE_PANEL_MAX_FRACTION,
  );
  const [dragActive, setDragActive] = useState(false);
  const [dragSide, setDragSide] = useState<SurfacePlacement | null>(null);
  const resolvedPlacement = placement ?? "right";
  const isBefore = resolvedPlacement === "left";
  const surfaceActive = activeSurface !== "chat";
  const isDocked = surfaceActive && placement != null;
  const maxSize = Math.max(
    SURFACE_PANEL_MIN_WIDTH,
    availableSize * SURFACE_PANEL_MAX_FRACTION,
  );
  const occupiedSide = isDocked ? placement : null;
  const leftAvailable = occupiedSide !== "left";
  const rightAvailable = occupiedSide !== "right";

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!event.dataTransfer.types.includes(SURFACE_DRAG_MIME_TYPE)) return;
    setDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!event.dataTransfer.types.includes(SURFACE_DRAG_MIME_TYPE)) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = x / rect.width;
    let next: SurfacePlacement | null = null;
    if (ratio < DROP_ZONE_FRACTION) next = "left";
    else if (ratio > 1 - DROP_ZONE_FRACTION) next = "right";
    setDragSide(next);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
      setDragSide(null);
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      const id = event.dataTransfer.getData(SURFACE_DRAG_MIME_TYPE) as Exclude<SurfaceId, "chat">;
      if (dragSide) {
        const available = dragSide === "left" ? leftAvailable : rightAvailable;
        if (available) onPlacementChange?.(id, dragSide);
      }
      setDragActive(false);
      setDragSide(null);
    },
    [dragSide, leftAvailable, rightAvailable, onPlacementChange],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const rect = root.getBoundingClientRect();
      const available = rect.width;
      if (available > 0) {
        setAvailableSize(available);
        setSize((current) =>
          Math.min(
            Math.max(SURFACE_PANEL_MIN_WIDTH, available * SURFACE_PANEL_MAX_FRACTION),
            Math.max(SURFACE_PANEL_MIN_WIDTH, current),
          ),
        );
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const clamp = useCallback(
    (value: number) => {
      return Math.min(
        maxSize,
        Math.max(SURFACE_PANEL_MIN_WIDTH, value),
      );
    },
    [maxSize],
  );
  const resizeFromPointer = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const rect = root.getBoundingClientRect();
      const onMove = (move: PointerEvent) => {
        const raw = move.clientX - rect.left;
        const available = rect.width;
        setSize(clamp(isBefore ? raw : available - raw));
      };
      const onEnd = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onEnd);
        target.removeEventListener("pointercancel", onEnd);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onEnd);
      target.addEventListener("pointercancel", onEnd);
    },
    [clamp, isBefore],
  );
  const resizeFromKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const decrease = event.key === "ArrowLeft";
      const increase = event.key === "ArrowRight";
      if (!decrease && !increase && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      setSize((current) => {
        if (event.key === "Home") return SURFACE_PANEL_MIN_WIDTH;
        if (event.key === "End") return maxSize;
        const delta = increase === isBefore ? STEP_SIZE : -STEP_SIZE;
        return clamp(current + delta);
      });
    },
    [clamp, isBefore, maxSize],
  );

  return (
    <HStack
      ref={rootRef}
      gap={0}
      xstyle={styles.root}
      data-slot="surface-workspace"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <HStack aria-hidden xstyle={styles.headerRule} data-slot="surface-header-rule" />
      <VStack
        gap={0}
        xstyle={[styles.chat, surfaceActive && !isDocked && styles.hidden]}
        data-slot="chat-surface"
      >
        <HStack xstyle={styles.paneHeader}>{header}</HStack>
        <HStack xstyle={styles.paneBody}>{children}</HStack>
      </VStack>
      {openSurfaces.length > 0 ? (
        <>
          <HStack
            role="separator"
            aria-label="Resize surface"
            aria-orientation="vertical"
            aria-valuemin={SURFACE_PANEL_MIN_WIDTH}
            aria-valuemax={Math.round(maxSize)}
            aria-valuenow={Math.round(size)}
            data-slot="surface-splitter"
            data-orientation="vertical"
            tabIndex={0}
            onPointerDown={resizeFromPointer}
            onKeyDown={resizeFromKeyboard}
            xstyle={[
              styles.separatorVertical,
              styles.separatorLine,
              isBefore ? styles.separatorBefore : styles.separatorAfter,
              !isDocked && styles.hidden,
            ]}
          >
            <HStack
              aria-hidden
              xstyle={styles.separatorPaintVertical}
              data-slot="surface-divider-line"
            />
          </HStack>
          <VStack
            gap={0}
            xstyle={[
              styles.dock,
              surfaceActive && !isDocked && styles.standalone,
              isBefore ? styles.dockBefore : styles.dockAfter,
              !surfaceActive && styles.hidden,
            ]}
            style={isDocked ? { flexBasis: size } : undefined}
            data-slot="surface-dock"
            data-placement={placement ?? "tab"}
          >
            {isDocked ? (
              <DockHeader surface={activeSurface} onUndock={onUndock} />
            ) : (
              <HStack xstyle={styles.paneHeader}>{header}</HStack>
            )}
            <HStack xstyle={styles.paneBody}>
              {openSurfaces.map((surface) => (
                <HStack
                  key={surface}
                  xstyle={[styles.surfaceBody, activeSurface !== surface && styles.hidden]}
                  data-surface={surface}
                >
                  <SurfaceBody
                    id={surface}
                    token={token}
                    cwd={cwd}
                    browserActive={activeSurface === "browser"}
                    onBrowserStateChange={onBrowserStateChange}
                    sagan={sagan}
                    onOpenSaganThread={onOpenSaganThread}
                  />
                </HStack>
              ))}
            </HStack>
          </VStack>
        </>
      ) : null}
      {dragActive ? (
        <HStack xstyle={styles.dropOverlay} data-slot="surface-drop-overlay">
          <VStack
            align="center"
            justify="center"
            xstyle={[
              styles.dropZone,
              dragSide === "left" && styles.dropZoneActive,
              !leftAvailable && styles.dropZoneDisabled,
            ]}
            data-slot="surface-drop-zone-left"
            data-active={dragSide === "left" ? "true" : undefined}
            aria-hidden
          >
            <PanelLeft size={DROP_ICON_SIZE} aria-hidden />
            <Text color="inherit" type="supporting">Add left split</Text>
          </VStack>
          <HStack xstyle={styles.dropZoneSpacer} data-slot="surface-drop-spacer" />
          <VStack
            align="center"
            justify="center"
            xstyle={[
              styles.dropZone,
              dragSide === "right" && styles.dropZoneActive,
              !rightAvailable && styles.dropZoneDisabled,
            ]}
            data-slot="surface-drop-zone-right"
            data-active={dragSide === "right" ? "true" : undefined}
            aria-hidden
          >
            <PanelRight size={DROP_ICON_SIZE} aria-hidden />
            <Text color="inherit" type="supporting">Add right split</Text>
          </VStack>
        </HStack>
      ) : null}
    </HStack>
  );
}
