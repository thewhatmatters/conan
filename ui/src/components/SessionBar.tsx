import { useEffect, useRef, useState } from "react";
import type { Session } from "../hooks/useSessions.ts";
import { ALL_SESSIONS } from "../hooks/useSessionEvents.ts";
import SessionGlossaryInfo from "./SessionGlossaryInfo.tsx";

interface SessionBarProps {
  sessions: Session[];
  token: string | null;
  defaultCwd: string;
  onRefresh: () => void;
  /** The selected session id, the ALL_SESSIONS sentinel, or null. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** "Open" action — reveal the terminal dock to interact with the session. */
  onOpen: () => void;
}

/**
 * Timeline-primary Overview header (US-007): a `session ▾` dropdown that picks
 * whose events the timeline shows (any session, or "All sessions"), with the
 * five session lifecycle actions — stop / resume / send-prompt / open / new —
 * riding inline beside it. Replaces the removed per-session card grid; the
 * timeline itself renders full-width below this bar.
 */
export default function SessionBar({
  sessions,
  token,
  defaultCwd,
  onRefresh,
  selectedId,
  onSelect,
  onOpen,
}: SessionBarProps) {
  const [showNew, setShowNew] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  // --fork-session (US-042): when set, Resume mints a fresh session id.
  const [forkOnResume, setForkOnResume] = useState(false);
  // Tear down the git worktree when stopping a worktree-isolated session (US-043).
  const [removeWtOnStop, setRemoveWtOnStop] = useState(false);

  const isAll = selectedId === ALL_SESSIONS;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  // Lifecycle controls only make sense for a concrete session.
  const hasTarget = !!selected;
  const running = selected?.status === "running";
  const worktree = selected?.worktree_path ?? null;

  async function post(path: string, body?: unknown) {
    if (!token) return;
    await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": token },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {});
    onRefresh();
  }

  return (
    <section className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* session ▾ — the primary selector */}
        <label className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            Session
            <SessionGlossaryInfo />
          </span>
          <div className="relative">
            <select
              value={selectedId ?? ALL_SESSIONS}
              onChange={(e) => onSelect(e.target.value)}
              className="appearance-none rounded-md border border-border bg-card py-1 pl-2.5 pr-7 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value={ALL_SESSIONS}>All sessions</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionLabel(s)}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground">
              ▾
            </span>
          </div>
          {selected && (
            <StatusDot status={selected.status} />
          )}
        </label>

        <div className="flex flex-wrap items-center gap-1.5">
          <Action
            label="Stop"
            disabled={!hasTarget || !running}
            onClick={() =>
              selected &&
              post(`/api/claude/sessions/${enc(selected.id)}/stop`, {
                remove_worktree: worktree ? removeWtOnStop : false,
              })
            }
          />
          <Action
            label="Resume"
            disabled={!hasTarget || running}
            onClick={() =>
              selected &&
              post(`/api/claude/sessions/${enc(selected.id)}/resume`, {
                fork_session: forkOnResume,
              })
            }
          />
          <label
            className="flex items-center gap-1 text-xs text-muted-foreground select-none"
            title="Resume into a fresh session id (--fork-session)"
          >
            <input
              type="checkbox"
              checked={forkOnResume}
              onChange={(e) => setForkOnResume(e.target.checked)}
              disabled={!hasTarget || running}
              className="size-3 accent-primary"
            />
            Fork
          </label>
          <Action
            label="Send prompt"
            disabled={!hasTarget}
            active={showPrompt}
            onClick={() => setShowPrompt((v) => !v)}
          />
          <Action label="Open" disabled={isAll && sessions.length === 0} onClick={onOpen} />
          <Action
            label="+ New"
            primary
            active={showNew}
            onClick={() => setShowNew((v) => !v)}
          />
        </div>
      </div>

      {/* Worktree-isolated session (US-043): show the worktree + base ref it
          runs in, and offer to tear it down on stop. */}
      {worktree && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-muted-foreground"
            title={worktree}
          >
            <span aria-hidden>⎇</span>
            <span className="max-w-[28ch] truncate">{worktree}</span>
            {selected?.worktree_base_ref && (
              <span className="text-muted-foreground/70">@ {selected.worktree_base_ref}</span>
            )}
          </span>
          <label
            className="flex items-center gap-1 text-muted-foreground select-none"
            title="Run `git worktree remove --force` when stopping this session"
          >
            <input
              type="checkbox"
              checked={removeWtOnStop}
              onChange={(e) => setRemoveWtOnStop(e.target.checked)}
              className="size-3 accent-primary"
            />
            Remove on stop
          </label>
        </div>
      )}

      {showPrompt && selected && (
        <PromptForm
          onSend={async (text) => {
            await post(`/api/claude/sessions/${enc(selected.id)}/prompt`, { text });
            setShowPrompt(false);
          }}
          onCancel={() => setShowPrompt(false)}
        />
      )}

      {showNew && (
        <NewSessionForm
          token={token}
          defaultCwd={defaultCwd}
          onDone={(id) => {
            setShowNew(false);
            onRefresh();
            if (id) onSelect(id);
          }}
        />
      )}
    </section>
  );
}

function sessionLabel(s: Session): string {
  const name = s.title ?? s.model ?? s.id.slice(0, 8);
  return `${name} · ${s.status}`;
}

const enc = encodeURIComponent;

function Action({
  label,
  onClick,
  disabled = false,
  primary = false,
  active = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  active?: boolean;
}) {
  const base =
    "rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const tone = primary
    ? "border-primary bg-primary text-primary-foreground hover:opacity-90"
    : active
      ? "border-primary bg-primary/10 text-foreground"
      : "border-border bg-card text-foreground hover:bg-muted";
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${tone}`}>
      {label}
    </button>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "bg-primary"
      : status === "error"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  return (
    <span className="relative inline-flex size-2.5 shrink-0 items-center justify-center">
      {status === "running" && (
        <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-primary/60" />
      )}
      <span className={"size-2 rounded-full " + color} />
    </span>
  );
}

/** Inline composer to send a prompt to the selected live session. */
function PromptForm({
  onSend,
  onCancel,
}: {
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSend(text.trim());
      }}
      className="mt-2 flex items-center gap-2"
    >
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Send a prompt to this session…"
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary"
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        Send
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted"
      >
        Cancel
      </button>
    </form>
  );
}

const MODELS = ["sonnet", "opus", "haiku"];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk"];
// "default" is a UI sentinel meaning "don't pass --effort" (use the CLI default).
const EFFORT_OPTIONS = ["default", "low", "medium", "high", "xhigh", "max"];

/** "New session" form — POSTs to startSession and selects the new session. */
function NewSessionForm({
  token,
  defaultCwd,
  onDone,
}: {
  token: string | null;
  defaultCwd: string;
  onDone: (id: string | null) => void;
}) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [model, setModel] = useState("sonnet");
  const [permissionMode, setPermissionMode] = useState("default");
  const [effort, setEffort] = useState("default");
  const [fromPr, setFromPr] = useState("");
  // Worktree isolation (US-043): run this session in a fresh git worktree.
  const [worktree, setWorktree] = useState(false);
  const [worktreeRef, setWorktreeRef] = useState("");
  // Remote-control / Chrome driven sessions (US-047).
  const [remoteControl, setRemoteControl] = useState(false);
  const [remoteControlName, setRemoteControlName] = useState("");
  const [chrome, setChrome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setError("no auth token");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { cwd, model, permission_mode: permissionMode };
      // Only send the optional flags when set, so defaults are unchanged.
      if (effort !== "default") body.effort = effort;
      if (fromPr.trim()) body.from_pr = fromPr.trim();
      if (worktree) {
        body.worktree = true;
        if (worktreeRef.trim()) body.worktree_ref = worktreeRef.trim();
      }
      // US-047: a named remote-control session, or just the toggle; and --chrome.
      if (remoteControl) body.remote_control = remoteControlName.trim() || true;
      if (chrome) body.chrome = true;
      const res = await fetch("/api/claude/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-conan-token": token },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`start failed (${res.status})`);
      const data = (await res.json().catch(() => ({}))) as { sessionId?: string };
      onDone(data.sessionId ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 rounded-xl border border-border bg-card p-3.5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Working directory" className="sm:col-span-3">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
          />
        </Field>
        <Field label="Model">
          <Select value={model} onChange={setModel} options={MODELS} />
        </Field>
        <Field label="Permission mode">
          <Select value={permissionMode} onChange={setPermissionMode} options={PERMISSION_MODES} />
        </Field>
        <Field label="Effort">
          <Select value={effort} onChange={setEffort} options={EFFORT_OPTIONS} />
        </Field>
        <Field label="From PR (#)" className="sm:col-span-2">
          <input
            value={fromPr}
            onChange={(e) => setFromPr(e.target.value)}
            placeholder="e.g. 1234 — resume a PR-linked session"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
          />
        </Field>
        {/* Worktree isolation (US-043): a checkbox plus an optional base ref. */}
        <Field label="Isolation">
          <label className="flex items-center gap-2 py-1 text-xs text-foreground select-none">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            Run in a fresh git worktree
          </label>
        </Field>
        <Field label="Worktree base ref" className="sm:col-span-2">
          <input
            value={worktreeRef}
            onChange={(e) => setWorktreeRef(e.target.value)}
            disabled={!worktree}
            placeholder="default: HEAD — e.g. main, a sha, or a tag"
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary disabled:opacity-40"
          />
        </Field>
        {/* Remote-control / Chrome driven sessions (US-047). */}
        <Field label="Remote control">
          <label className="flex items-center gap-2 py-1 text-xs text-foreground select-none">
            <input
              type="checkbox"
              checked={remoteControl}
              onChange={(e) => setRemoteControl(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            Enable Remote Control
          </label>
        </Field>
        <Field label="Remote-control name" className="sm:col-span-2">
          <input
            value={remoteControlName}
            onChange={(e) => setRemoteControlName(e.target.value)}
            disabled={!remoteControl}
            placeholder="optional — names the remote-control session"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary disabled:opacity-40"
          />
        </Field>
        <Field label="Chrome">
          <label className="flex items-center gap-2 py-1 text-xs text-foreground select-none">
            <input
              type="checkbox"
              checked={chrome}
              onChange={(e) => setChrome(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            Claude in Chrome
          </label>
        </Field>
        <div className="flex items-end sm:col-start-3">
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </div>
      {error && (
        <div className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={"block " + className}>
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
