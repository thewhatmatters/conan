import { useState } from "react";
import type { PendingPermission } from "../hooks/usePendingPermissions.ts";

export type PermissionChoice = "allow" | "deny";

interface PendingApprovalsProps {
  pending: PendingPermission[];
  /** Answer a prompt via the US-012 decision route, then refresh the list. */
  onDecide: (
    sessionId: string,
    requestId: string,
    choice: PermissionChoice,
  ) => void;
}

/**
 * Cross-session pending-approvals widget (US-013). One place that lists every
 * permission prompt awaiting a decision — session, tool, and requested action —
 * each with inline Approve/Deny that reuses the US-012 decision route. Shows a
 * count badge and an empty state, and updates live as prompts arrive/resolve
 * over the app WS (via usePendingPermissions). Semantic tokens only.
 */
export default function PendingApprovals({
  pending,
  onDecide,
}: PendingApprovalsProps) {
  // Optimistically hide a prompt the instant it's answered, before the refetch
  // round-trip clears it from the server-side pending map.
  const [decided, setDecided] = useState<Record<string, PermissionChoice>>({});
  const visible = pending.filter((p) => !decided[p.requestId]);

  const decide = (p: PendingPermission, choice: PermissionChoice) => {
    setDecided((d) => ({ ...d, [p.requestId]: choice }));
    onDecide(p.sessionId, p.requestId, choice);
  };

  return (
    <section className="rounded-xl bg-muted p-1">
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-primary">
              <Shield />
            </span>
            <span className="text-sm font-medium text-foreground">
              Pending approvals
            </span>
          </div>
          <span
            className={
              "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold " +
              (visible.length
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground")
            }
          >
            {visible.length}
          </span>
        </div>

        {visible.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing awaiting a decision. Tool-permission prompts across all
            sessions show up here.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((p) => (
              <li
                key={`${p.sessionId}:${p.requestId}`}
                className="flex items-start gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium text-foreground">
                      {p.toolName ?? "Tool"}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground/70">
                      {p.sessionId.slice(0, 8)}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70">
                      {fmtTime(p.ts)}
                    </span>
                  </div>
                  {actionLine(p.toolName, p.input) && (
                    <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {actionLine(p.toolName, p.input)}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-0.5">
                  <button
                    onClick={() => decide(p, "allow")}
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                  >
                    <Check /> Approve
                  </button>
                  <button
                    onClick={() => decide(p, "deny")}
                    className="inline-flex items-center gap-1 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/20"
                  >
                    <X /> Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** A compact one-line description of the requested action from the tool input. */
function actionLine(tool: string | null, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === "string" && v.trim()) return clip(v);
    }
    return undefined;
  };
  switch (tool) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return pick("file_path", "notebook_path");
    case "Grep":
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query");
    case "Task":
      return pick("description", "subagent_type");
    default: {
      for (const v of Object.values(i)) {
        if (typeof v === "string" && v.trim()) return clip(v);
      }
      return undefined;
    }
  }
}

function clip(v: string): string {
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 139) + "…" : t;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// --- icons (Lucide path data, inline to match the conan UI) ----------------

function Shield() {
  return (
    <Svg>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </Svg>
  );
}

function Check() {
  return (
    <Svg size={12}>
      <polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}

function X() {
  return (
    <Svg size={12}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}

function Svg({ children, size = 15 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
