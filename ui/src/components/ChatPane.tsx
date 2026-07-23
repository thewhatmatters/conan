import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Loader2,
  Lock,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useAgentChat, type ChatItem, type AgentOpts } from "../hooks/useAgentChat.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { cn } from "../lib/utils.ts";

/**
 * Level-2 chat spike — the programmatic peer of the terminal surface.
 *
 * A custom transcript (rendered from the gateway's normalized agent events) +
 * a composer whose chips map to real `claude -p` flags. This is the t3-code
 * interaction model inside Conan's existing Tauri shell: no TUI, no xterm —
 * Conan drives `claude` headlessly and owns the rendering.
 *
 * Spike scope: Claude-only, message-level streaming, launch config fixed at the
 * first prompt. NOT yet wired into the shared event bus, so the Timeline/Usage
 * HUD don't light up from chat turns — that's the next increment.
 */

/** `--model` chip options — aliases resolve to the latest of each family. */
const MODELS: { label: string; value: string | undefined }[] = [
  { label: "Default model", value: undefined },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];

/** `--permission-mode` chip options. Default is Full access so the spike drives
 *  any prompt to completion headlessly (a stricter mode stalls on the tool
 *  prompts print-mode can't answer). This is the one knob to revisit for
 *  production — a `--permission-prompt-tool` round-trip would let the UI
 *  approve tools interactively instead of blanket-bypassing. */
const PERMISSIONS: { label: string; value: NonNullable<AgentOpts["permissionMode"]> }[] = [
  { label: "Full access", value: "bypassPermissions" },
  { label: "Accept edits", value: "acceptEdits" },
  { label: "Plan", value: "plan" },
];

export default function ChatPane({ token }: { token: string | null }) {
  const { items, busy, status, send, interrupt } = useAgentChat(token);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(undefined);
  const [permission, setPermission] =
    useState<NonNullable<AgentOpts["permissionMode"]>>("bypassPermissions");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Stick to the bottom as the transcript grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  const submit = () => {
    if (!text.trim() || busy) return;
    send(text, { model, permissionMode: permission });
    setText("");
  };

  const modelLabel = MODELS.find((m) => m.value === model)?.label ?? "Default model";
  const permLabel = PERMISSIONS.find((p) => p.value === permission)?.label ?? "Full access";

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Transcript — aside-rooted so it inherits the themed 6px scrollbar. */}
      <aside ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          {items.length === 0 ? (
            <EmptyState status={status} />
          ) : (
            items.map((it) => <Item key={it.id} item={it} />)
          )}
          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Working…
              <button
                onClick={interrupt}
                className="ml-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Stop
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Composer — mirrors the mock: textarea with a chip row + send button. */}
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl rounded-xl border border-border bg-card p-3 shadow-sm focus-within:border-primary/60">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
            className="max-h-48 min-h-9 w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-2 flex items-center gap-2">
            <Chip icon={<Sparkles className="size-3.5" />} label={modelLabel}>
              {MODELS.map((m) => (
                <DropdownMenuItem key={m.label} onClick={() => setModel(m.value)}>
                  {m.label}
                </DropdownMenuItem>
              ))}
            </Chip>
            <span className="text-border">|</span>
            <Chip icon={<Lock className="size-3.5" />} label={permLabel}>
              {PERMISSIONS.map((p) => (
                <DropdownMenuItem key={p.value} onClick={() => setPermission(p.value)}>
                  {p.label}
                </DropdownMenuItem>
              ))}
            </Chip>
            <div className="flex-1" />
            <button
              onClick={submit}
              disabled={!text.trim() || busy}
              aria-label="Send"
              className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </button>
          </div>
        </div>
        {status !== "open" && (
          <p className="mx-auto mt-1 w-full max-w-3xl text-[11px] text-muted-foreground">
            {status === "connecting" ? "connecting to agent…" : "agent disconnected"}
          </p>
        )}
      </div>
    </section>
  );
}

/** A composer chip: an icon + label that opens a dropdown of options. */
function Chip({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none">
        {icon}
        {label}
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState({ status }: { status: string }) {
  return (
    <div className="mt-16 flex flex-col items-center gap-2 text-center text-muted-foreground">
      <Sparkles className="size-6 opacity-50" />
      <p className="text-sm font-medium text-foreground">Chat with a coding agent</p>
      <p className="max-w-sm text-xs">
        Drives <code className="rounded bg-muted px-1 py-px font-mono text-[11px]">claude</code>{" "}
        headlessly in the active directory and renders the conversation here —
        no terminal required. {status === "open" ? "Ready." : "Connecting…"}
      </p>
    </div>
  );
}

/** Render one transcript item by role. */
function Item({ item }: { item: ChatItem }) {
  switch (item.role) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {item.text}
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "system":
      return (
        <div className="text-[11px] text-muted-foreground">
          Session started{item.model ? ` · ${item.model}` : ""}
          {item.cwd ? ` · ${item.cwd}` : ""}
        </div>
      );
    case "result":
      return (
        <div className="flex items-center gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          <span>Turn complete</span>
          {item.costUsd != null && <span>· ${item.costUsd.toFixed(4)}</span>}
          {item.durationMs != null && <span>· {(item.durationMs / 1000).toFixed(1)}s</span>}
          {item.numTurns != null && <span>· {item.numTurns} steps</span>}
        </div>
      );
    case "error":
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {item.message}
        </div>
      );
    default:
      return null;
  }
}

function ToolCard({ item }: { item: Extract<ChatItem, { role: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const inputStr =
    typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2);
  return (
    <div className="rounded-lg border border-border bg-card text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Wrench className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">{item.name}</span>
        <span
          className={cn(
            "ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            item.result == null
              ? "bg-primary/10 text-primary"
              : item.isError
                ? "bg-destructive/15 text-destructive"
                : "bg-muted text-muted-foreground",
          )}
        >
          {item.result == null ? "running" : item.isError ? "error" : "done"}
        </span>
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {inputStr}
          </pre>
          {item.result != null && (
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap border-t border-border/60 pt-2 font-mono text-[11px] text-foreground">
              {item.result.slice(0, 4000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
