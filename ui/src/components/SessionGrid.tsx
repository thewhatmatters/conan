import { useState } from "react";
import type { Session } from "../hooks/useSessions.ts";

interface SessionGridProps {
  sessions: Session[];
  token: string | null;
  defaultCwd: string;
  onRefresh: () => void;
}

/**
 * The main-area session grid (US-009): one card per Claude Code session from
 * GET /api/claude/sessions, plus a "New session" action that opens a form
 * (cwd, model, permission mode) and POSTs to startSession. Updates live as the
 * parent refetches on each WS event.
 */
export default function SessionGrid({
  sessions,
  token,
  defaultCwd,
  onRefresh,
}: SessionGridProps) {
  const [showForm, setShowForm] = useState(false);

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">
          Sessions
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {sessions.length}
          </span>
        </h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground hover:bg-muted"
        >
          {showForm ? "Cancel" : "+ New session"}
        </button>
      </div>

      {showForm && (
        <NewSessionForm
          token={token}
          defaultCwd={defaultCwd}
          onDone={() => {
            setShowForm(false);
            onRefresh();
          }}
        />
      )}

      {sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No sessions yet. Start one with “New session”, or run a Claude Code
          session in the terminal — it’ll appear here via hooks.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      )}
    </section>
  );
}

/** A single session card: status dot, model, cwd, last activity, token/cost. */
function SessionCard({ session: s }: { session: Session }) {
  const tokens = s.context_tokens ?? s.input_tokens ?? null;
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-3.5">
      {/* session color stripe down the left edge */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: s.color ?? "var(--color-primary)" }}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={s.status} />
          <span className="truncate text-sm font-medium text-foreground">
            {s.title ?? s.model ?? "session"}
          </span>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {s.id.slice(0, 8)}
        </span>
      </div>

      <div
        className="mt-2 truncate font-mono text-xs text-muted-foreground"
        title={s.cwd ?? undefined}
      >
        {s.cwd ? prettyPath(s.cwd) : "—"}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <Stat label="Model" value={s.model ?? "—"} />
        <Stat label="Tokens" value={tokens != null ? fmtTokens(tokens) : "—"} />
        <Stat
          label="Cost"
          value={s.total_cost_usd ? `$${s.total_cost_usd.toFixed(2)}` : "—"}
        />
      </dl>

      <div className="mt-2 text-[11px] text-muted-foreground">
        {s.status} · {timeAgo(s.last_activity)}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate font-medium text-foreground" title={value}>
        {value}
      </dd>
    </div>
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

const MODELS = ["sonnet", "opus", "haiku"];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk"];

function NewSessionForm({
  token,
  defaultCwd,
  onDone,
}: {
  token: string | null;
  defaultCwd: string;
  onDone: () => void;
}) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [model, setModel] = useState("sonnet");
  const [permissionMode, setPermissionMode] = useState("default");
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
      const res = await fetch("/api/claude/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conan-token": token,
        },
        body: JSON.stringify({ cwd, model, permission_mode: permissionMode }),
      });
      if (!res.ok) throw new Error(`start failed (${res.status})`);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-3 rounded-xl border border-border bg-card p-3.5"
    >
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
          <Select
            value={permissionMode}
            onChange={setPermissionMode}
            options={PERMISSION_MODES}
          />
        </Field>
        <div className="flex items-end">
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

/** Abbreviate $HOME to ~ for compact paths. */
function prettyPath(p: string): string {
  const m = p.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) return "~" + (m[1] ?? "");
  return p;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
