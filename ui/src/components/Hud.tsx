import { useCallback, useRef, useState } from "react";
import { ContextWidget, UsageWidget } from "./Widgets.tsx";
import PulseChart from "./PulseChart.tsx";
import type { Session } from "../hooks/useSessions.ts";
import type { UsageState } from "../hooks/useUsage.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import type { PulseSeries } from "../hooks/usePulse.ts";
import type { ConnStatus } from "../hooks/useTasks.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";

// DevTools-style flat tab triggers (no pill shell, active = bg-muted) — matches
// the terminal pane's `Term ▾` control so the two panes read as one chrome.
const TAB_TRIGGER =
  "rounded-md px-2.5 py-1 text-xs font-normal text-muted-foreground transition-colors hover:bg-muted/60 data-[state=active]:bg-muted data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

const MIN_W = 320;
const MAX_W = 900;
const WIDTH_KEY = "conan-hud-w";

interface HudProps {
  /** Hidden without unmounting (the View ▾ HUD toggle) — content state survives. */
  hidden?: boolean;
  /** Gateway WS connection status, shown in the tab bar (replaces the toolbar). */
  status: ConnStatus;
  port?: number;
  // — Context widget (session-scoped) —
  activeSession: Session | null;
  data: WidgetData | null;
  /** Auth token for the token-gated /context Refresh POST (US-009). */
  token?: string | null;
  /** Re-pull the widgets payload (after a /context capture lands, US-009). */
  onRefetchWidgets?: () => void;
  // — Usage widget (global) —
  usage: UsageState;
  // — Pulse graph —
  pulse?: PulseSeries | null;
  pulseMinutes?: number;
  onPulseRange?: (minutes: number) => void;
}

/**
 * The DevTools-style HUD (US-003/US-004): a drag-resizable panel docked to the
 * right of the terminal with a flat tab bar. Width persists in localStorage
 * exactly like the old dock did. After US-004 the HUD shows exactly three tabs —
 * Context (session), Usage (global), and the live Pulse activity graph.
 */
export default function Hud({
  hidden,
  status,
  port,
  activeSession,
  data,
  token,
  onRefetchWidgets,
  usage,
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

      <Tabs defaultValue="context" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <TabsList className="h-auto justify-start gap-1 rounded-none bg-transparent p-0">
            <TabsTrigger value="context" className={TAB_TRIGGER}>
              Context
            </TabsTrigger>
            <TabsTrigger value="usage" className={TAB_TRIGGER}>
              Usage
            </TabsTrigger>
            <TabsTrigger value="pulse" className={TAB_TRIGGER}>
              Pulse
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto pr-1">
            <ConnectionStatus status={status} port={port} />
          </div>
        </div>

        <TabsContent
          value="context"
          className="mt-0 min-h-0 flex-1 overflow-auto px-3 py-3"
        >
          <ContextWidget
            session={activeSession}
            data={data}
            token={token}
            onRefetch={onRefetchWidgets}
          />
        </TabsContent>

        <TabsContent
          value="usage"
          className="mt-0 min-h-0 flex-1 overflow-auto px-3 py-3"
        >
          <UsageWidget usage={usage} />
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

/**
 * Live WebSocket connection indicator (US-018), now docked in the HUD tab bar
 * rather than a top toolbar. Reflects the self-healing app socket: connected
 * (green, "gateway :PORT"), connecting/reconnecting (amber, pulsing), or offline
 * (red) after backoff has given up reaching the gateway.
 */
function ConnectionStatus({
  status,
  port,
}: {
  status: ConnStatus;
  port?: number;
}) {
  const meta: Record<ConnStatus, { dot: string; text: string; label: string }> = {
    connected: {
      dot: "bg-primary",
      text: "text-primary",
      label: port ? `gateway :${port}` : "connected",
    },
    connecting: {
      dot: "bg-amber-500 animate-pulse",
      text: "text-muted-foreground",
      label: "connecting…",
    },
    reconnecting: {
      dot: "bg-amber-500 animate-pulse",
      text: "text-muted-foreground",
      label: "reconnecting…",
    },
    offline: {
      dot: "bg-red-500",
      text: "text-red-500",
      label: "offline",
    },
  };
  const m = meta[status];
  return (
    <span
      title={`Gateway connection: ${status}`}
      className={"inline-flex items-center gap-1.5 text-xs " + m.text}
    >
      <span className={"size-2 rounded-full " + m.dot} />
      {m.label}
    </span>
  );
}
