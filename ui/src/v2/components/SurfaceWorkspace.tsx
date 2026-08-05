import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { X } from "lucide-react";
import {
  V2BrowserSurface,
  V2DiffSurface,
  V2FilesSurface,
  V2TerminalSurface,
} from "./V2SurfaceBodies.tsx";
import {
  SURFACE_PANEL_MAX_FRACTION,
  SURFACE_PANEL_MIN_WIDTH,
} from "../../components/SurfacePanel.tsx";
import {
  SURFACE_OPTIONS,
  type SurfaceId,
  type SurfacePlacement,
} from "./SurfaceTabs.tsx";

const DEFAULT_SIZE = 420;
const STEP_SIZE = 24;

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
  },
  paneBody: { flexGrow: 1, minHeight: 0, minWidth: 0, overflow: "clip" },
  paneHeader: {
    boxSizing: "border-box",
    flexShrink: 0,
    height: "var(--conan-secondary-bar-height)",
    width: "100%",
  },
  headerRule: {
    backgroundColor: "var(--conan-color-border)",
    height: "var(--conan-border-width)",
    insetInline: 0,
    position: "absolute",
    top: "calc(var(--conan-secondary-bar-height) - var(--conan-border-width))",
    zIndex: 1,
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
}: {
  id: Exclude<SurfaceId, "chat">;
  token: string | null;
  cwd: string | null;
}) {
  if (id === "terminal") return <V2TerminalSurface token={token} cwd={cwd} />;
  if (id === "browser") return <V2BrowserSurface />;
  if (id === "files") return <V2FilesSurface token={token} cwd={cwd} />;
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
}: {
  children: ReactNode;
  header: ReactNode;
  activeSurface: SurfaceId;
  openSurfaces: Array<Exclude<SurfaceId, "chat">>;
  placement?: SurfacePlacement;
  token: string | null;
  cwd: string | null;
  onUndock?: (id: Exclude<SurfaceId, "chat">) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [availableSize, setAvailableSize] = useState(
    DEFAULT_SIZE / SURFACE_PANEL_MAX_FRACTION,
  );
  const resolvedPlacement = placement ?? "right";
  const isBefore = resolvedPlacement === "left";
  const surfaceActive = activeSurface !== "chat";
  const isDocked = surfaceActive && placement != null;
  const maxSize = Math.max(
    SURFACE_PANEL_MIN_WIDTH,
    availableSize * SURFACE_PANEL_MAX_FRACTION,
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
                  <SurfaceBody id={surface} token={token} cwd={cwd} />
                </HStack>
              ))}
            </HStack>
          </VStack>
        </>
      ) : null}
    </HStack>
  );
}
