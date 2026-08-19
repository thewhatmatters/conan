import { type ReactNode } from "react";
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

const styles = stylex.create({
  root: {
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    position: "relative",
  },
  pane: {
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "clip",
    position: "relative",
  },
  surfaceBody: {
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    width: "100%",
  },
  hidden: { display: "none" },
  paneHeader: {
    alignItems: "center",
    backdropFilter: "blur(var(--conan-glass-blur))",
    WebkitBackdropFilter: "blur(var(--conan-glass-blur))",
    backgroundColor: "var(--conan-glass-tint)",
    boxSizing: "border-box",
    height: "var(--conan-secondary-bar-height)",
    insetInline: 0,
    position: "absolute",
    top: 0,
    zIndex: 2,
  },
  paneHeaderRule: {
    backgroundColor: "var(--conan-color-border)",
    height: "var(--conan-border-width)",
    insetInline: 0,
    position: "absolute",
    top: "calc(var(--conan-secondary-bar-height) - var(--conan-border-width))",
    zIndex: 3,
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
  browserUrl,
  onBrowserStateChange,
  sagan,
  onOpenSaganThread,
}: {
  id: Exclude<SurfaceId, "chat">;
  token: string | null;
  cwd: string | null;
  /** True when Browser is the surface currently on screen (WHA-109). */
  browserActive: boolean;
  /** Restored URL for the Browser surface, if any (WHA-210). */
  browserUrl?: string | null;
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
        initialUrl={browserUrl}
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
  activeSurface,
  openSurfaces,
  token,
  cwd,
  browserUrl,
  onBrowserStateChange,
  sagan,
  onOpenSaganThread,
}: {
  children: ReactNode;
  activeSurface: SurfaceId;
  openSurfaces: Array<Exclude<SurfaceId, "chat">>;
  token: string | null;
  cwd: string | null;
  /** Restored URL for the Browser surface, if any (WHA-210). */
  browserUrl?: string | null;
  /** Browser-surface reports headed for the agent socket (WHA-109). */
  onBrowserStateChange?: (state: BrowserSurfaceReport) => void;
  sagan?: SaganCapabilityResult;
  onOpenSaganThread?: (id: string) => void;
}) {
  const chatActive = activeSurface === "chat";
  const activeOption = SURFACE_OPTIONS.find((surface) => surface.id === activeSurface);
  const ActiveIcon = activeOption?.icon;

  return (
    <HStack
      gap={0}
      xstyle={styles.root}
      data-slot="surface-workspace"
    >
      {!chatActive && activeOption && activeSurface !== "sagan" ? (
        <>
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
          </HStack>
          <HStack xstyle={styles.paneHeaderRule} aria-hidden data-slot="surface-pane-header-rule" />
        </>
      ) : null}
      <VStack
        gap={0}
        xstyle={[styles.pane, !chatActive && styles.hidden]}
        data-slot="chat-surface"
      >
        {children}
      </VStack>
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
            browserUrl={browserUrl}
            onBrowserStateChange={onBrowserStateChange}
            sagan={sagan}
            onOpenSaganThread={onOpenSaganThread}
          />
        </HStack>
      ))}
    </HStack>
  );
}
