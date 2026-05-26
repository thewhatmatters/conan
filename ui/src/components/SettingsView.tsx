import { useMemo, useState } from "react";
import {
  useSettings,
  useClaudeSettings,
  type ClaudeSetting,
} from "../hooks/useSettings.ts";
import { SESSION_GLOSSARY } from "./SessionGlossaryInfo.tsx";
import { Switch } from "./ui/switch.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Badge } from "./ui/badge.tsx";

/**
 * Settings view (US-020 → US-029). Mirrors Claude Code's own /settings: real
 * values from US-006 rendered with the right control per type (boolean→switch,
 * enum→select, string/integer→input), each showing the current value, default,
 * and source file, with a "Search settings…" filter. Writable preference keys
 * persist via the US-006 token-gated PUT with optimistic UI + rollback on
 * error; risky/non-writable keys are shown read-only. Conan's own config
 * (hooks, remote/TLS, theme) stays accessible below; NO cost-ceiling; the
 * "Session" glossary is retained.
 */
export default function SettingsView({
  theme,
  onToggleTheme,
  token,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  token: string | null;
}) {
  const { hooks, remote, loaded } = useSettings();
  const claude = useClaudeSettings(token);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return claude.state.settings;
    return claude.state.settings.filter(
      (s) =>
        s.key.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false),
    );
  }, [claude.state.settings, query]);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Mirrors Claude Code&apos;s <code className="font-mono">/settings</code>,
        plus the Conan controls that don&apos;t belong on the Overview.
      </p>

      <div className="mt-6 space-y-4">
        {/* Claude Code settings mirror (US-029) */}
        <Section
          title="Claude Code settings"
          desc="Live values from ~/.claude/settings.json. Editable preferences persist; risky keys are read-only."
        >
          {/* Search */}
          <div className="relative mb-3">
            <SearchIcon />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              placeholder="Search settings…"
              className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
            />
          </div>

          {!claude.state.loaded ? (
            <Muted>Loading…</Muted>
          ) : claude.state.settings.length === 0 ? (
            <Empty>No Claude Code settings found.</Empty>
          ) : filtered.length === 0 ? (
            <Empty>No settings match &ldquo;{query}&rdquo;.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((s) => (
                <SettingRow key={s.key} setting={s} write={claude.write} />
              ))}
            </ul>
          )}
        </Section>

        {/* Hooks status */}
        <Section
          title="Claude Code hooks"
          desc="Lifecycle events Conan listens for so observed sessions self-report."
        >
          {!loaded ? (
            <Muted>Loading…</Muted>
          ) : hooks.installed ? (
            <>
              <StatusRow
                ok
                label={`Installed (${hooks.events.length} event${hooks.events.length === 1 ? "" : "s"})`}
                detail={hooks.source ? `via ${hooks.source}/settings.json` : undefined}
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {hooks.events.map((e) => (
                  <span
                    key={e}
                    className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground"
                  >
                    {e}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <StatusRow
              label="Not installed"
              detail="Add Conan's hooks (see conan-hooks.example.json) to .claude/settings.json so sessions self-report."
            />
          )}
        </Section>

        {/* Remote access / TLS */}
        <Section
          title="Remote access"
          desc="Conan is loopback-only by default; remote access is opt-in over TLS (wss://)."
        >
          {!loaded ? (
            <Muted>Loading…</Muted>
          ) : remote.tlsEnabled ? (
            <StatusRow
              ok
              label="TLS enabled"
              detail={`Serving ${remote.scheme}:// on ${remote.host} — WebSockets over wss://, behind token + Origin checks.`}
            />
          ) : (
            <StatusRow
              label="Loopback-only (no TLS)"
              detail={`Serving ${remote.scheme}:// on ${remote.host}. Set CONAN_TLS_CERT + CONAN_TLS_KEY to expose remotely. See docs/remote-access.md.`}
            />
          )}
        </Section>

        {/* Theme */}
        <Section title="Appearance" desc="Light is the default; dark follows the same semantic tokens.">
          <div className="flex items-center justify-between">
            <span className="text-sm text-foreground">Theme</span>
            <button
              onClick={onToggleTheme}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:bg-muted"
            >
              {theme === "dark" ? "☾ Dark" : "☀ Light"} — switch to{" "}
              {theme === "dark" ? "light" : "dark"}
            </button>
          </div>
        </Section>

        {/* Plan usage */}
        <Section
          title="Plan usage"
          desc="Claude Max is token-based, not dollar-metered — there is no cost ceiling."
        >
          <p className="text-sm text-muted-foreground">
            The Usage widget shows rate-limit state, a reset countdown, and a
            token-consumption trend (last 5h / 7d). The live plan&nbsp;% is an{" "}
            <em>approximation</em>: the real figure lives in unreadable
            rate-limit response headers inside the <code>claude</code> process.
          </p>
        </Section>

        {/* Sessions glossary */}
        <Section title="Glossary — “Session”">
          <p className="text-sm text-muted-foreground">{SESSION_GLOSSARY}</p>
        </Section>
      </div>
    </div>
  );
}

/** Render one Claude Code setting with the right control for its type. */
function SettingRow({
  setting,
  write,
}: {
  setting: ClaudeSetting;
  write: (key: string, value: unknown) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async (value: unknown) => {
    setError(null);
    setPending(true);
    const res = await write(setting.key, value);
    setPending(false);
    if (!res.ok) setError(res.error ?? "write failed");
  };

  const isDefault = setting.source === "default";

  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-foreground">{setting.key}</span>
          {!setting.writable && (
            <Badge variant="outline">read-only</Badge>
          )}
          {setting.defSource === "builtin" && (
            <Badge variant="secondary">builtin</Badge>
          )}
        </div>
        {setting.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {setting.description}
          </p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          {isDefault ? (
            <>default · {fmt(setting.default)}</>
          ) : (
            <>
              from {setting.source} · default {fmt(setting.default)}
            </>
          )}
          {error && <span className="ml-1 text-destructive">— {error}</span>}
        </p>
      </div>

      <div className="flex shrink-0 items-center pt-0.5">
        {setting.writable ? (
          <Control setting={setting} pending={pending} commit={commit} />
        ) : (
          <ReadOnlyValue setting={setting} />
        )}
      </div>
    </li>
  );
}

/** The editable control for a writable setting. */
function Control({
  setting,
  pending,
  commit,
}: {
  setting: ClaudeSetting;
  pending: boolean;
  commit: (value: unknown) => void | Promise<void>;
}) {
  if (setting.type === "boolean") {
    return (
      <Switch
        checked={setting.value === true}
        disabled={pending}
        onCheckedChange={(v) => commit(v)}
        aria-label={setting.key}
      />
    );
  }

  if (setting.type === "enum") {
    const cur = setting.value == null ? "" : String(setting.value);
    return (
      <Select
        value={cur || undefined}
        disabled={pending}
        onValueChange={(v) => commit(v)}
      >
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {(setting.allowed ?? []).map((opt) => (
            <SelectItem key={opt} value={opt} className="text-xs">
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // string + integer → text/number input committed on blur or Enter.
  return <TextControl setting={setting} pending={pending} commit={commit} />;
}

function TextControl({
  setting,
  pending,
  commit,
}: {
  setting: ClaudeSetting;
  pending: boolean;
  commit: (value: unknown) => void | Promise<void>;
}) {
  const initial = setting.value == null ? "" : String(setting.value);
  const [draft, setDraft] = useState(initial);

  const send = () => {
    if (draft === initial) return;
    commit(setting.type === "integer" ? Number(draft) : draft);
  };

  return (
    <input
      value={draft}
      type={setting.type === "integer" ? "number" : "text"}
      min={setting.min}
      max={setting.max}
      disabled={pending}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={send}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="h-8 w-40 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
    />
  );
}

/** A read-only value display for non-writable / risky keys. */
function ReadOnlyValue({ setting }: { setting: ClaudeSetting }) {
  return (
    <span className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
      {fmt(setting.value)}
    </span>
  );
}

/** Human-readable rendering of a setting value (incl. unset). */
function fmt(v: unknown): string {
  if (v === undefined || v === null) return "unset";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string" && v === "") return "(empty)";
  return String(v);
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function StatusRow({
  ok = false,
  label,
  detail,
}: {
  ok?: boolean;
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={
          "mt-1 size-2 shrink-0 rounded-full " +
          (ok ? "bg-primary" : "bg-muted-foreground/50")
        }
      />
      <div>
        <div className="text-sm text-foreground">{label}</div>
        {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}
