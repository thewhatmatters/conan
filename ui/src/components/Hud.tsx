import { useCallback, useRef, useState } from "react";
import { ContextWidget, UsageWidget } from "./Widgets.tsx";
import PlanWidget from "./PlanWidget.tsx";
import SkillsWidget from "./SkillsWidget.tsx";
import McpWidget from "./McpWidget.tsx";
import RadioBar from "./RadioBar.tsx";
import PulseChart from "./PulseChart.tsx";
import type { Session } from "../hooks/useSessions.ts";
import type { UsageState } from "../hooks/useUsage.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import type { PulseSeries } from "../hooks/usePulse.ts";
import type { PlanState } from "../hooks/usePlan.ts";
import type { SkillEntry } from "../hooks/useSkills.ts";
import type { TasksState } from "../hooks/useTasks.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";

// VS Code–style tabs: flat, the active tab marked by a top accent border (not a
// filled pill) — matches the terminal tab strip so the two panes read as one
// chrome. border-t-2 border-transparent reserves the space so nothing shifts.
const TAB_TRIGGER =
  "shrink-0 rounded-none border-t border-transparent px-3 py-1.5 text-xs font-normal text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-muted data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

const MIN_W = 320;
const MAX_W = 900;
const WIDTH_KEY = "conan-hud-w";

interface HudProps {
  /** Hidden without unmounting (the View ▾ HUD toggle) — content state survives. */
  hidden?: boolean;
  // — Context widget (session-scoped) —
  activeSession: Session | null;
  /** All known sessions — lets the Context estimate infer a 1M window. */
  sessions?: Session[];
  data: WidgetData | null;
  /** Auth token for the token-gated /context Refresh POST (US-009). */
  token?: string | null;
  /** Re-pull the widgets payload (after a /context capture lands, US-009). */
  onRefetchWidgets?: () => void;
  // — Usage widget (global) —
  usage: UsageState;
  /** Re-pull the usage payload (after a /usage capture lands, US-010). */
  onRefetchUsage?: () => void;
  // — Pulse graph —
  pulse?: PulseSeries | null;
  pulseMinutes?: number;
  onPulseRange?: (minutes: number) => void;
  // — Plan widget (US-004): conditional 4th tab, shown only when active —
  plan?: PlanState;
  /** Build-loop tasks feed — the Plan widget's fallback source. */
  tasks?: TasksState | null;
  // — Skills widget (US-006): VS Code-extensions-style list, always present —
  skills?: SkillEntry[];
}

/**
 * The DevTools-style HUD (US-003/US-004): a drag-resizable panel docked to the
 * right of the terminal with a flat tab bar. Width persists in localStorage
 * exactly like the old dock did. After US-004 the HUD shows exactly three tabs —
 * Context (session), Usage (global), and the live Pulse activity graph.
 */
export default function Hud({
  hidden,
  activeSession,
  sessions,
  data,
  token,
  onRefetchWidgets,
  usage,
  onRefetchUsage,
  pulse,
  pulseMinutes = 60,
  onPulseRange,
  plan,
  tasks,
  skills,
}: HudProps) {
  // US-004: the Plan tab only exists when the active session has a live plan
  // (open TodoWrite items, a recent ExitPlanMode plan, or an active build loop).
  const planActive = plan?.isActive ?? false;
  const [width, setWidth] = useState<number>(
    () => Number(localStorage.getItem(WIDTH_KEY)) || 460,
  );
  const widthRef = useRef(width);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      widthRef.current = w;
      setWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      localStorage.setItem(WIDTH_KEY, String(widthRef.current));
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <aside
      style={{ width, display: hidden ? "none" : undefined }}
      className="relative flex shrink-0 flex-col border-l border-border bg-card"
    >
      {/* drag handle on the left edge */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
      />

      <Tabs defaultValue="context" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex items-center border-b border-border">
          {/* Tabs scroll horizontally so the bar still reads at the 320px min
              width once Plan + Skills join Context | Usage | Pulse (US-006).
              Flush, contiguous (no gap/padding) so they read as real tabs. */}
          <TabsList className="hud-tabs h-auto min-w-0 flex-nowrap justify-start overflow-x-auto rounded-none bg-transparent p-0">
            <TabsTrigger value="context" className={TAB_TRIGGER}>
              Context
            </TabsTrigger>
            <TabsTrigger value="usage" className={TAB_TRIGGER}>
              Usage
            </TabsTrigger>
            <TabsTrigger value="pulse" className={TAB_TRIGGER}>
              Pulse
            </TabsTrigger>
            {planActive && (
              <TabsTrigger value="plan" className={TAB_TRIGGER}>
                Plan
              </TabsTrigger>
            )}
            <TabsTrigger value="skills" className={TAB_TRIGGER}>
              Skills
            </TabsTrigger>
            <TabsTrigger value="mcp" className={TAB_TRIGGER}>
              MCP
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="context"
          className="mt-0 flex min-h-0 flex-1 flex-col"
        >
          <ContextWidget
            session={activeSession}
            sessions={sessions}
            data={data}
            token={token}
            onRefetch={onRefetchWidgets}
          />
        </TabsContent>

        <TabsContent
          value="usage"
          className="mt-0 min-h-0 flex-1 overflow-auto"
        >
          <UsageWidget
            usage={usage}
            session={activeSession}
            token={token}
            hasLivePty={data?.hasLivePty ?? false}
            onRefetch={onRefetchUsage}
          />
        </TabsContent>

        <TabsContent value="pulse" className="mt-0 min-h-0 flex-1 overflow-auto">
          {onPulseRange && (
            <PulseChart
              series={pulse ?? null}
              minutes={pulseMinutes}
              onRange={onPulseRange}
              compact
            />
          )}
        </TabsContent>

        {planActive && plan && (
          <TabsContent
            value="plan"
            className="mt-0 min-h-0 flex-1 overflow-auto"
          >
            <PlanWidget plan={plan} tasks={tasks ?? null} />
          </TabsContent>
        )}

        <TabsContent value="skills" className="mt-0 min-h-0 flex-1 overflow-auto">
          <SkillsWidget skills={skills ?? []} />
        </TabsContent>

        <TabsContent value="mcp" className="mt-0 min-h-0 flex-1 overflow-auto">
          <McpWidget data={data} />
        </TabsContent>
      </Tabs>

      {/* US-011: Claude Radio toolbar pinned at the bottom of the HUD panel. */}
      <RadioBar />
    </aside>
  );
}
