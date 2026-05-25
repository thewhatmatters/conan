import { useEffect, useRef, useState } from "react";
import type { GatewayEvent, TasksState } from "../hooks/useTasks.ts";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  detail?: string;
}

// Curated lifecycle events worth a toast (the rest would be noise).
const NOTABLE: Record<string, { kind: Kind; label: string }> = {
  Notification: { kind: "info", label: "Notification" },
  SessionStart: { kind: "info", label: "Session started" },
  SessionEnd: { kind: "info", label: "Session ended" },
  PreCompact: { kind: "info", label: "Context compacting" },
  SubagentStop: { kind: "info", label: "Subagent finished" },
  PostToolUseFailure: { kind: "error", label: "Tool failed" },
};

/**
 * Toast notifications (nice-to-have): a story passing -> success; curated
 * Claude Code lifecycle events -> info/error. Driven by the gateway streams.
 */
export default function Toaster({
  tasks,
  lastEvent,
}: {
  tasks: TasksState | null;
  lastEvent: (GatewayEvent & { seq: number }) | null;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const prevPasses = useRef<Map<string, boolean> | null>(null);

  const push = (t: Omit<Toast, "id">) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 5000);
  };

  // Task completions: detect stories flipping to passes:true.
  useEffect(() => {
    if (!tasks) return;
    const next = new Map(tasks.stories.map((s) => [s.id, s.passes]));
    const prev = prevPasses.current;
    if (prev) {
      for (const s of tasks.stories) {
        if (s.passes && prev.get(s.id) === false) {
          push({ kind: "success", title: `${s.id} complete`, detail: s.title });
        }
      }
    }
    prevPasses.current = next;
  }, [tasks]);

  // System events.
  useEffect(() => {
    if (!lastEvent?.hook_event_name) return;
    const meta = NOTABLE[lastEvent.hook_event_name];
    if (!meta) return;
    push({
      kind: meta.kind,
      title: meta.label,
      detail: lastEvent.tool_name ?? undefined,
    });
  }, [lastEvent?.seq]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-16 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}
          className="pointer-events-auto cursor-pointer rounded-lg border border-border bg-card p-3 shadow-lg"
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <Dot kind={t.kind} />
            {t.title}
          </div>
          {t.detail && (
            <div className="mt-0.5 pl-4 text-xs text-muted-foreground">
              {t.detail}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Dot({ kind }: { kind: Kind }) {
  const color =
    kind === "success"
      ? "bg-primary"
      : kind === "error"
        ? "bg-red-500"
        : "bg-muted-foreground";
  return <span className={"size-2 shrink-0 rounded-full " + color} />;
}
