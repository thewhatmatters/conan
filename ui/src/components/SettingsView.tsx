import { useSettings } from "../hooks/useSettings.ts";
import { SESSION_GLOSSARY } from "./SessionGlossaryInfo.tsx";

/**
 * Settings view (US-020). Consolidates the *informational* configuration that
 * lives outside the Overview: which Claude Code lifecycle hooks are wired,
 * the remote-access (TLS) posture, the theme toggle, and plan-usage framing.
 *
 * There is intentionally NO cost-ceiling/budget section — that was removed in
 * US-004/US-014; Claude Max is token-based, not dollar-metered. It also carries
 * the "Session" glossary so the term is unambiguous wherever it surfaces.
 */
export default function SettingsView({
  theme,
  onToggleTheme,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const { hooks, remote, loaded } = useSettings();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Configure Conan. Read-only diagnostics plus the controls that don&apos;t
        belong on the Overview.
      </p>

      <div className="mt-6 space-y-4">
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

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}
