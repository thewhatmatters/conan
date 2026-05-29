import { useCallback, useRef, useState } from "react";
import { UsageWidget, UsageRefreshButton } from "./Widgets.tsx";
import SkillsWidget from "./SkillsWidget.tsx";
import McpWidget from "./McpWidget.tsx";
import RadioBar from "./RadioBar.tsx";
import PulseChart, { PulseRange } from "./PulseChart.tsx";
import HudTabHeader from "./shared/HudTabHeader.tsx";
import type { Session } from "../hooks/useSessions.ts";
import type { UsageState } from "../hooks/useUsage.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import type { PulseSeries } from "../hooks/usePulse.ts";
import type { SkillEntry } from "../hooks/useSkills.ts";
import type { RadioState } from "../hooks/useRadio.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import FadeScroll from "./FadeScroll.tsx";
import { TAB_TRIGGER } from "../lib/tabStyles.ts";

// Per-axis size bounds + independent persistence keys (US-024). The right dock
// drives WIDTH; the bottom dock drives HEIGHT — separate localStorage keys so
// switching orientation restores each dock's last size instead of clobbering it.
const MIN_W = 320;
const MAX_W = 900;
const WIDTH_KEY = "conan-hud-w";
const MIN_H = 160;
const MAX_H = 900;
const HEIGHT_KEY = "conan-hud-h";

/** US-026: the terminal region above the bottom dock never shrinks past this,
 *  so a tall HUD (or a drag) can't collapse the terminal into a sliver. The
 *  bottom dock's effective max height is therefore window.innerHeight minus
 *  this floor (but never below MIN_H — see effectiveMaxBottomH). */
const TERMINAL_MIN_H = 120;

/** US-026: largest the bottom dock may be for a given window height — leave at
 *  least TERMINAL_MIN_H for the terminal, but never clamp below MIN_H. On a
 *  very short window (height < TERMINAL_MIN_H + MIN_H) this returns MIN_H, so
 *  the HUD stays a usable strip rather than a sliver and the terminal takes the
 *  squeeze (the View ▸ HUD toggle remains the escape hatch). */
function effectiveMaxBottomH(winH: number): number {
  return Math.min(MAX_H, Math.max(MIN_H, winH - TERMINAL_MIN_H));
}

/** Bottom dock defaults to ~1/3 of the window height. */
function defaultBottomHeight(): number {
  const h =
    typeof window === "undefined" ? 720 : window.innerHeight;
  return Math.min(MAX_H, Math.max(MIN_H, Math.round(h / 3)));
}

interface HudProps {
  /** Hidden without unmounting (the View ▾ HUD toggle) — content state survives. */
  hidden?: boolean;
  /** Which edge the HUD docks to (US-024). 'right' = width + left handle +
   *  border-l; 'bottom' = height + top handle + border-t. Default 'right'. */
  dock?: "right" | "bottom";
  /** Live window height (US-026). Only consumed by the bottom dock to clamp its
   *  rendered height so the terminal keeps TERMINAL_MIN_H on a short window. */
  windowHeight?: number;
  // — Usage widget (session-scoped via its rate-limit windows) —
  activeSession: Session | null;
  /** Widgets payload — only `hasLivePty` is consumed here (UsageWidget refresh). */
  data: WidgetData | null;
  /** Auth token for the token-gated /usage Refresh POST. */
  token?: string | null;
  usage: UsageState;
  /** Re-pull the usage payload (after a /usage capture lands, US-010). */
  onRefetchUsage?: () => void;
  // — Pulse graph —
  pulse?: PulseSeries | null;
  pulseMinutes?: number;
  onPulseRange?: (minutes: number) => void;
  // — Skills widget (US-006): VS Code-extensions-style list, always present —
  skills?: SkillEntry[];
  /** Claude Radio state — videoId + title for the bottom RadioBar. */
  radio?: RadioState | null;
}

/**
 * The DevTools-style HUD (US-003/US-004): a drag-resizable panel docked to the
 * right of the terminal with a flat tab bar. Width persists in localStorage
 * exactly like the old dock did. The Context tab moved out of the HUD in
 * favour of the always-visible ContextHeader banner pinned above the terminal
 * — what remains here is Usage · Pulse · Skills · MCP.
 */
export default function Hud({
  hidden,
  dock = "right",
  windowHeight,
  activeSession,
  data,
  token,
  usage,
  onRefetchUsage,
  pulse,
  pulseMinutes = 60,
  onPulseRange,
  skills,
  radio,
}: HudProps) {
  // US-007 (v4.5): the Plan HUD tab was removed — plan rows live on the
  // per-terminal Timeline split now (PlanWidget + usePlan are gone with it).
  // US-024: width (right dock) and height (bottom dock) are tracked
  // independently so switching orientation restores each dock's last size.
  const isBottom = dock === "bottom";
  const [width, setWidth] = useState<number>(
    () => Number(localStorage.getItem(WIDTH_KEY)) || 460,
  );
  const [height, setHeight] = useState<number>(
    () => Number(localStorage.getItem(HEIGHT_KEY)) || defaultBottomHeight(),
  );
  const widthRef = useRef(width);
  const heightRef = useRef(height);

  // One resize handler for both docks: 'right' drags width off the left edge
  // (clientX), 'bottom' drags height off the top edge (clientY), each clamped
  // to its own min/max and persisted to its own key on mouseup.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const onMove = (ev: MouseEvent) => {
        if (isBottom) {
          // US-026: cap the drag at effectiveMaxBottomH so dragging the handle
          // up can't shrink the terminal past TERMINAL_MIN_H.
          const h = Math.min(
            effectiveMaxBottomH(window.innerHeight),
            Math.max(MIN_H, window.innerHeight - ev.clientY),
          );
          heightRef.current = h;
          setHeight(h);
        } else {
          const w = Math.min(
            MAX_W,
            Math.max(MIN_W, window.innerWidth - ev.clientX),
          );
          widthRef.current = w;
          setWidth(w);
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        if (isBottom) {
          localStorage.setItem(HEIGHT_KEY, String(heightRef.current));
        } else {
          localStorage.setItem(WIDTH_KEY, String(widthRef.current));
        }
      };
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [isBottom],
  );

  // US-026: clamp the bottom dock's *rendered* height to the live window so the
  // terminal keeps TERMINAL_MIN_H even after the window shrinks. We don't write
  // this back to state/localStorage — the stored height is preserved, so when
  // the window grows again the dock restores its last size.
  const renderHeight = Math.min(
    height,
    effectiveMaxBottomH(windowHeight ?? height + TERMINAL_MIN_H),
  );

  return (
    <aside
      style={{
        ...(isBottom ? { height: renderHeight } : { width }),
        display: hidden ? "none" : undefined,
      }}
      className={
        "relative flex shrink-0 flex-col bg-card " +
        (isBottom ? "border-t border-border" : "border-l border-border")
      }
    >
      {/* drag handle: left edge (right dock) or top edge (bottom dock) */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className={
          "absolute left-0 top-0 z-20 hover:bg-primary/40 " +
          (isBottom
            ? "h-1.5 w-full -translate-y-1/2 cursor-row-resize"
            : "h-full w-1.5 -translate-x-1/2 cursor-col-resize")
        }
      />

      <Tabs defaultValue="usage" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex items-center border-b border-border">
          {/* Tabs scroll horizontally so the bar still reads at the 320px min
              width — Usage | Pulse | Skills | MCP. Context lives in the
              banner above the terminal now, not in the HUD. Flush, contiguous
              (no gap/padding) so they read as real tabs. */}
          <TabsList className="hud-tabs h-auto min-w-0 flex-nowrap justify-start overflow-x-auto rounded-none bg-transparent p-0">
            <TabsTrigger value="usage" className={TAB_TRIGGER}>
              Usage
            </TabsTrigger>
            <TabsTrigger value="pulse" className={TAB_TRIGGER}>
              Pulse
            </TabsTrigger>
            <TabsTrigger value="skills" className={TAB_TRIGGER}>
              Skills
            </TabsTrigger>
            <TabsTrigger value="mcp" className={TAB_TRIGGER}>
              MCP
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Each panel wraps its scroller in <FadeScroll> so overflow above/
            below the visible area surfaces a subtle gradient — same pattern
            the Terminal + Timeline use. `min-h-0 flex-1` on the TabsContent
            lets the FadeScroll's absolute-positioned inner scroller fill it. */}
        <TabsContent
          value="usage"
          className="mt-0 flex min-h-0 flex-1 flex-col"
        >
          {/* Pinned secondary toolbar (US-006): 'Usage' + the ↻ /usage refresh
              ride the shared <HudTabHeader> outside the FadeScroll so they stay
              put while the content scrolls — matching the Pulse/Skills/MCP tabs.
              The refresh keeps its live-pty gating (hidden with no live pty). */}
          <HudTabHeader
            name={
              <span className="px-1 text-[11px] font-medium text-muted-foreground">
                Usage
              </span>
            }
            actions={
              <UsageRefreshButton
                session={activeSession}
                token={token}
                hasLivePty={data?.hasLivePty ?? false}
                onRefetch={onRefetchUsage}
              />
            }
          />
          <FadeScroll>
            <UsageWidget usage={usage} hasLivePty={data?.hasLivePty ?? false} />
          </FadeScroll>
        </TabsContent>

        <TabsContent value="pulse" className="mt-0 flex min-h-0 flex-1 flex-col">
          {onPulseRange && (
            <>
              {/* Pinned secondary toolbar (US-005): 'Pulse' + the range
                  selector ride the shared <HudTabHeader> outside the FadeScroll
                  so they stay put while the chart scrolls — matching the
                  Skills/MCP/Usage tabs. */}
              <HudTabHeader
                name={
                  <span className="px-1 text-[11px] font-medium text-muted-foreground">
                    Pulse
                  </span>
                }
                actions={
                  <PulseRange minutes={pulseMinutes} onRange={onPulseRange} />
                }
              />
              <FadeScroll>
                <PulseChart
                  series={pulse ?? null}
                  minutes={pulseMinutes}
                  onRange={onPulseRange}
                  compact
                />
              </FadeScroll>
            </>
          )}
        </TabsContent>

        {/* Skills + MCP own their own FadeScroll internally so their headers
            (User/System tabs, MCP refresh) stay pinned at the top. The
            TabsContent just gives them the flex column slot to expand into. */}
        <TabsContent value="skills" className="mt-0 flex min-h-0 flex-1 flex-col">
          <SkillsWidget skills={skills ?? []} />
        </TabsContent>

        <TabsContent value="mcp" className="mt-0 flex min-h-0 flex-1 flex-col">
          <McpWidget token={token} />
        </TabsContent>
      </Tabs>

      {/* US-011: Claude Radio toolbar pinned at the bottom of the HUD panel. */}
      <RadioBar radio={radio ?? null} />
    </aside>
  );
}
