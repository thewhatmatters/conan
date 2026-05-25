import { useEffect, useRef, useState } from "react";
import type { Session } from "../hooks/useSessions.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import {
  WIDGET_KEYS,
  WIDGET_LABELS,
  type WidgetKey,
} from "../hooks/useWidgetPrefs.ts";
import StatCard from "./StatCard.tsx";

interface SecondaryWidgetsProps {
  enabled: Set<WidgetKey>;
  toggle: (key: WidgetKey) => void;
  /** Per-session widget data; null until at least one widget is enabled. */
  data: WidgetData | null;
  /** The session the widgets describe (running > newest). */
  activeSession: Session | null;
}

/**
 * The opt-in secondary widget row (US-022). An "Add widget" menu lets the user
 * turn on deeper signals — MCP, plugins, model/idle, api_retry, top tools, git
 * — without cluttering the default view. Each enabled widget reuses the shared
 * StatCard pattern and only renders when its toggle is on.
 */
export default function SecondaryWidgets({
  enabled,
  toggle,
  data,
  activeSession,
}: SecondaryWidgetsProps) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Widgets
        </span>
        <AddWidgetMenu enabled={enabled} toggle={toggle} />
      </div>

      {enabled.size === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          No extra widgets. Use{" "}
          <span className="font-medium text-foreground">Add widget</span> to
          surface MCP, plugins, model/idle, retry rate, top tools, or git.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {enabled.has("mcp") && <McpWidget data={data} />}
          {enabled.has("plugins") && <PluginsWidget data={data} />}
          {enabled.has("model") && <ModelIdleWidget session={activeSession} />}
          {enabled.has("retry") && <RetryWidget data={data} />}
          {enabled.has("tools") && <ToolsWidget data={data} />}
          {enabled.has("git") && <GitWidget data={data} />}
        </div>
      )}
    </section>
  );
}

/** The "Add widget" dropdown: a checkbox per opt-in widget. */
function AddWidgetMenu({
  enabled,
  toggle,
}: {
  enabled: Set<WidgetKey>;
  toggle: (key: WidgetKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
      >
        + Add widget
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-border bg-card p-1 shadow-md">
          {WIDGET_KEYS.map((key) => (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-foreground hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={enabled.has(key)}
                onChange={() => toggle(key)}
                className="accent-primary"
              />
              {WIDGET_LABELS[key]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function McpWidget({ data }: { data: WidgetData | null }) {
  const mcp = data?.mcp;
  const healthy = mcp?.filter((s) => /connected|ok|ready/i.test(s.status)).length ?? 0;
  return (
    <StatCard label="MCP servers" sub="connected · total">
      {mcp == null ? (
        <Dash />
      ) : (
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-semibold text-foreground">
            {healthy}
          </span>
          <span className="text-sm text-muted-foreground">· {mcp.length}</span>
        </div>
      )}
    </StatCard>
  );
}

function PluginsWidget({ data }: { data: WidgetData | null }) {
  const plugins = data?.plugins;
  const errors = data?.pluginErrors ?? 0;
  return (
    <StatCard label="Plugins" sub="loaded · errors">
      {plugins == null ? (
        <Dash />
      ) : (
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-semibold text-foreground">
            {plugins.count}
          </span>
          <span
            className={
              "text-sm " + (errors > 0 ? "text-destructive" : "text-muted-foreground")
            }
          >
            · {errors} err
          </span>
        </div>
      )}
    </StatCard>
  );
}

function ModelIdleWidget({ session }: { session: Session | null }) {
  const model = session?.model ?? null;
  const idle = session ? session.status !== "running" : false;
  return (
    <StatCard label="Model & idle" sub={session ? session.status : "no session"}>
      {session == null ? (
        <Dash />
      ) : (
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {model ?? "unknown"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {idle ? `idle ${sinceLabel(session.last_activity)}` : "active now"}
          </div>
        </div>
      )}
    </StatCard>
  );
}

function RetryWidget({ data }: { data: WidgetData | null }) {
  const retry = data?.apiRetry;
  return (
    <StatCard label="API retry rate" sub="count · per hr">
      {retry == null ? (
        <Dash />
      ) : (
        <div className="flex items-baseline gap-1.5">
          <span
            className={
              "text-xl font-semibold " +
              (retry.count > 0 ? "text-destructive" : "text-foreground")
            }
          >
            {retry.count}
          </span>
          <span className="text-sm text-muted-foreground">
            · {retry.perHour}/hr
          </span>
        </div>
      )}
    </StatCard>
  );
}

function ToolsWidget({ data }: { data: WidgetData | null }) {
  const tools = data?.topTools ?? [];
  return (
    <StatCard label="Top tools" sub="PostToolUse">
      {data == null ? (
        <Dash />
      ) : tools.length === 0 ? (
        <span className="text-sm text-muted-foreground">no tool use yet</span>
      ) : (
        <ul className="space-y-0.5">
          {tools.slice(0, 4).map((t) => (
            <li
              key={t.name}
              className="flex items-baseline justify-between gap-2 text-xs"
            >
              <span className="truncate font-mono text-foreground">{t.name}</span>
              <span className="shrink-0 text-muted-foreground">{t.count}</span>
            </li>
          ))}
        </ul>
      )}
    </StatCard>
  );
}

function GitWidget({ data }: { data: WidgetData | null }) {
  const git = data?.git;
  return (
    <StatCard label="Git" sub="branch · dirty">
      {git == null ? (
        <Dash />
      ) : !git.available ? (
        <span className="text-sm text-muted-foreground">not a repo</span>
      ) : (
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-semibold text-foreground">
            {git.branch}
          </div>
          <div
            className={
              "text-[11px] " +
              (git.dirty > 0 ? "text-amber-500" : "text-muted-foreground")
            }
          >
            {git.dirty > 0 ? `${git.dirty} dirty` : "clean"}
          </div>
        </div>
      )}
    </StatCard>
  );
}

function Dash() {
  return <span className="text-xl font-semibold text-muted-foreground">—</span>;
}

/** Compact "time since" label for the model/idle widget. */
function sinceLabel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
