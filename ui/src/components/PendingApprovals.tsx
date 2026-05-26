import { useState } from "react";
import type { PendingPermission } from "../hooks/usePendingPermissions.ts";
import TwoTierCard from "./shared/TwoTierCard.tsx";
import { Button } from "./ui/button.tsx";

export type PermissionChoice = "allow" | "deny";

interface PendingApprovalsProps {
  pending: PendingPermission[];
  /**
   * Answer a prompt via the US-012 decision route, then refresh the list.
   * Resolves with the route's `delivered` flag (US-008): when `false` no live
   * child received the answer, so the card must stay honest instead of clearing.
   */
  onDecide: (
    sessionId: string,
    requestId: string,
    choice: PermissionChoice,
    updatedPermissions?: unknown[],
  ) => Promise<{ delivered: boolean }>;
}

/** One selectable option rendered as a button (US-008). */
interface PermissionOption {
  key: string;
  label: string;
  decision: PermissionChoice;
  variant: "default" | "destructive" | "outline";
  /** Rule updates echoed back as `updatedPermissions` (the "don't ask again"). */
  updatedPermissions?: unknown[];
}

/**
 * Cross-session pending-approvals widget (US-013/US-017). One place that lists
 * every permission prompt awaiting a decision — session, tool, and requested
 * action. US-008: the buttons reflect the prompt's real `permission_suggestions`
 * (e.g. Approve / Approve-don't-ask-again / Deny) rather than a hardcoded
 * allow|deny pair, and a decision that comes back `delivered:false` is NOT
 * optimistically cleared — it flips to an honest "answer in terminal" state.
 * Shows a count badge and updates live as prompts arrive/resolve over the app
 * WS (via usePendingPermissions). US-017: the panel renders ONLY when at least
 * one prompt is awaiting attention; it is fully absent when nothing is queued.
 * Semantic tokens only.
 */
export default function PendingApprovals({
  pending,
  onDecide,
}: PendingApprovalsProps) {
  // Optimistically hide a prompt the instant it's answered, before the refetch
  // round-trip clears it from the server-side pending map.
  const [decided, setDecided] = useState<Record<string, PermissionChoice>>({});
  // US-008: prompts whose decision was NOT delivered (no live child accepted
  // it). We keep our own snapshot so the honest state survives even after the
  // prompt leaves the server-side pending list, until the operator dismisses it.
  const [stuck, setStuck] = useState<Record<string, PendingPermission>>({});

  const visible = pending.filter(
    (p) => !decided[p.requestId] && !stuck[p.requestId],
  );
  const stuckList = Object.values(stuck);

  const decide = async (p: PendingPermission, option: PermissionOption) => {
    setDecided((d) => ({ ...d, [p.requestId]: option.decision }));
    const { delivered } = await onDecide(
      p.sessionId,
      p.requestId,
      option.decision,
      option.updatedPermissions,
    );
    if (!delivered) {
      // Un-hide and surface the honest "not deliverable" state.
      setDecided((d) => {
        const next = { ...d };
        delete next[p.requestId];
        return next;
      });
      setStuck((s) => ({ ...s, [p.requestId]: p }));
    }
  };

  const dismiss = (requestId: string) =>
    setStuck((s) => {
      const next = { ...s };
      delete next[requestId];
      return next;
    });

  const count = visible.length + stuckList.length;

  // US-017: nothing waiting → render nothing at all (no empty-state card, no
  // reserved space).
  if (count === 0) return null;

  return (
    <TwoTierCard as="section" className="mt-4" innerClassName="p-0">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-primary">
            <Shield />
          </span>
          <span className="text-sm font-medium text-foreground">
            Pending approvals
          </span>
        </div>
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold text-primary-foreground">
          {count}
        </span>
      </div>

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
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
              {deriveOptions(p.permissionSuggestions).map((opt) => (
                <Button
                  key={opt.key}
                  size="sm"
                  variant={opt.variant}
                  onClick={() => decide(p, opt)}
                >
                  {opt.decision === "allow" ? <Check /> : <X />}
                  {opt.label}
                </Button>
              ))}
            </div>
          </li>
        ))}

        {stuckList.map((p) => (
          <li
            key={`stuck:${p.sessionId}:${p.requestId}`}
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
              <div className="mt-0.5 text-xs text-muted-foreground">
                Couldn't deliver that decision — no live session received it.
                Answer the prompt directly in the terminal.
              </div>
            </div>
            <div className="flex shrink-0 items-center pt-0.5">
              <Button size="sm" variant="outline" onClick={() => dismiss(p.requestId)}>
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </TwoTierCard>
  );
}

/**
 * Build the option buttons from the prompt's `permission_suggestions` (US-008).
 * Always offers Approve + Deny; when a suggestion carries an allow-behavior rule
 * update, adds an "Approve, don't ask again" option that echoes those rules back
 * as `updatedPermissions`. Unknown/empty suggestions degrade to the base pair.
 */
function deriveOptions(suggestions: unknown): PermissionOption[] {
  const opts: PermissionOption[] = [
    { key: "allow", label: "Approve", decision: "allow", variant: "default" },
  ];
  const list = Array.isArray(suggestions) ? suggestions : [];
  const allowRules = list.filter(
    (s) =>
      s != null &&
      typeof s === "object" &&
      (s as Record<string, unknown>).behavior === "allow",
  );
  if (allowRules.length) {
    opts.push({
      key: "allow-always",
      label: "Don't ask again",
      decision: "allow",
      variant: "outline",
      updatedPermissions: allowRules,
    });
  }
  opts.push({
    key: "deny",
    label: "Deny",
    decision: "deny",
    variant: "destructive",
  });
  return opts;
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
