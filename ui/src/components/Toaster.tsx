import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { GatewayEvent, TasksState } from "../hooks/useTasks.ts";
import { isTauri } from "../lib/gateway.ts";
import { isIdleNotification } from "../lib/idleNotification.ts";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  /** Optional second line; left out for events where the title is self-contained. */
  detail?: string;
  /** When the toast was created — rendered as a relative stamp on the bottom row. */
  ts: number;
}

/**
 * Browser-only toast fallback for signal-grade events. In Tauri (the shipping
 * app) `useNativeNotifications` handles the same three events as macOS
 * banners and this component renders nothing — see that hook's docstring for
 * the rationale (one notification surface, signal over noise).
 *
 * Browser dev mode (`npm run dev` at :5173) doesn't have the Tauri
 * notification API, so this is what surfaces:
 *  - **Build-loop story passing** — `US-XXX complete` (success)
 *  - **Notification hook** — Claude needs your input (info)
 *  - **PostToolUse failure** — a tool errored (error), parsed from the
 *    payload's `tool_response.is_error` / `error` fields
 *
 * The three lifecycle events that used to toast (SessionStart, SessionEnd,
 * SubagentStop) are dropped on purpose — they're already visible as SESSION
 * rows in the Timeline split panel, and toasting every session boot is noise.
 */
export default function Toaster({
  tasks,
  lastEvent,
}: {
  tasks: TasksState | null;
  lastEvent: (GatewayEvent & { seq: number; replay?: boolean }) | null;
}) {
  // Tauri uses native notifications for these same events — render nothing
  // there so we don't double-notify.
  const tauri = isTauri();

  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const prevPasses = useRef<Map<string, boolean> | null>(null);
  // Tick once per second so the "just now / 12s / 1m" stamps refresh while a
  // toast is visible.
  const [, force] = useState(0);
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [toasts.length]);

  const dismiss = (id: number) =>
    setToasts((p) => p.filter((x) => x.id !== id));

  const push = (t: Omit<Toast, "id" | "ts">) => {
    const id = ++idRef.current;
    const ts = Date.now();
    setToasts((prev) => [...prev, { ...t, id, ts }]);
    setTimeout(() => dismiss(id), 5000);
  };

  // Task completions: detect stories flipping to passes:true.
  useEffect(() => {
    if (tauri || !tasks) return;
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
  }, [tasks, tauri]);

  // Notification hook + PostToolUse failure (the two signal hook events the
  // native path also handles).
  useEffect(() => {
    if (tauri) return;
    if (lastEvent?.replay) return;
    const name = lastEvent?.hook_event_name;
    if (!name) return;

    if (name === "Notification") {
      let message: string | undefined;
      try {
        const p = lastEvent.payload ? JSON.parse(lastEvent.payload) : null;
        if (p && typeof p.message === "string" && p.message) message = p.message;
      } catch {
        /* keep undefined */
      }
      // Idle "waiting for your input" nudges never toast (US-005).
      if (isIdleNotification(message)) return;
      push({ kind: "info", title: "Claude needs attention", detail: message });
      return;
    }

    if (name === "PostToolUse") {
      try {
        const p = lastEvent.payload ? JSON.parse(lastEvent.payload) : null;
        if (!p || typeof p !== "object") return;
        const resp = (p.tool_response ?? null) as Record<string, unknown> | null;
        const isErr =
          (resp && resp.is_error === true) ||
          (resp && typeof resp.error === "string" && resp.error);
        if (!isErr) return;
        const detail =
          (resp && typeof resp.content === "string" && resp.content) ||
          (resp && typeof resp.error === "string" && resp.error) ||
          undefined;
        const tool = lastEvent.tool_name ?? "tool";
        push({ kind: "error", title: `${tool} failed`, detail });
      } catch {
        /* non-JSON payload — skip */
      }
    }
  }, [lastEvent?.seq, tauri]);

  if (tauri || toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className="group pointer-events-auto cursor-pointer rounded-lg border border-border bg-card p-3 pr-2 shadow-lg"
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <Dot kind={t.kind} />
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
              aria-label="Dismiss"
              className="-mr-1 inline-flex shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {t.detail && (
            <div className="mt-0.5 pl-4 text-xs text-muted-foreground">
              {t.detail}
            </div>
          )}
          <div className="mt-1.5 pl-4 text-[10px] tabular-nums text-muted-foreground/70">
            {formatRel(t.ts)}
          </div>
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

function formatRel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 3) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}
