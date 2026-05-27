import { useCallback, useRef, useState } from "react";
import Widgets from "./Widgets.tsx";
import PulseChart from "./PulseChart.tsx";
import type { Session } from "../hooks/useSessions.ts";
import type { SkillsState } from "../hooks/useSkills.ts";
import type { UsageState } from "../hooks/useUsage.ts";
import type { McpState } from "../hooks/useMcp.ts";
import type { StatsState } from "../hooks/useStats.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import type { CwdGit } from "../hooks/useCwdGit.ts";
import type { ProjectMetrics } from "../hooks/useProjectMetrics.ts";
import type { WidgetKey } from "../hooks/useWidgetPrefs.ts";
import type { PulseSeries } from "../hooks/usePulse.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";

// DevTools-style flat tab triggers (no pill shell, active = bg-muted) — matches
// the terminal pane's `Term ▾` control so the two panes read as one chrome.
const TAB_TRIGGER =
  "rounded-md px-2.5 py-1 text-xs font-normal text-muted-foreground transition-colors hover:bg-muted/60 data-[state=active]:bg-muted data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

const MIN_W = 320;
const MAX_W = 900;
const WIDTH_KEY = "conan-hud-w";

interface HudProps {
  /** Hidden without unmounting (the header HUD toggle) — content state survives. */
  hidden?: boolean;
  // — widget data (trimmed to Context + Usage in US-004) —
  sessions: Session[];
  activeSession: Session | null;
  skills: SkillsState;
  usage: UsageState;
  mcp: McpState;
  stats: StatsState;
  data: WidgetData | null;
  git: CwdGit | null;
  metrics: ProjectMetrics | null;
  enabled: Set<WidgetKey>;
  toggle: (key: WidgetKey) => void;
  // — pulse —
  pulse?: PulseSeries | null;
  pulseMinutes?: number;
  onPulseRange?: (minutes: number) => void;
}

/**
 * The DevTools-style HUD (US-003): a drag-resizable panel docked to the right of
 * the terminal with a flat tab bar. Width persists in localStorage exactly like
 * the old dock did. The tab *content* is the at-a-glance widget set + the global
 * Pulse graph; US-004 trims the Widgets tab down to the two starting cells
 * (Context + Usage) and splits them into their own tabs.
 */
export default function Hud({
  hidden,
  sessions,
  activeSession,
  skills,
  usage,
  mcp,
  stats,
  data,
  git,
  metrics,
  enabled,
  toggle,
  pulse,
  pulseMinutes = 60,
  onPulseRange,
}: HudProps) {
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

      <Tabs
        defaultValue="widgets"
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <TabsList className="h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0">
            <TabsTrigger value="widgets" className={TAB_TRIGGER}>
              Widgets
            </TabsTrigger>
            <TabsTrigger value="pulse" className={TAB_TRIGGER}>
              Pulse
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="widgets"
          className="mt-0 min-h-0 flex-1 overflow-auto px-3 py-3"
        >
          <Widgets
            sessions={sessions}
            activeSession={activeSession}
            skills={skills}
            usage={usage}
            mcp={mcp}
            stats={stats}
            data={data}
            git={git}
            metrics={metrics}
            enabled={enabled}
            toggle={toggle}
          />
        </TabsContent>

        <TabsContent value="pulse" className="mt-0 min-h-0 flex-1 overflow-auto">
          {onPulseRange && (
            <PulseChart
              series={pulse ?? null}
              minutes={pulseMinutes}
              onRange={onPulseRange}
            />
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
