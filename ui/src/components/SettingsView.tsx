/**
 * Settings route shell (US-006) — a placeholder to be filled in US-020 with
 * hooks status, remote-access (TLS) info, theme, and usage/plan preferences.
 * No cost-ceiling/budget section (removed in US-004/US-014).
 */
export default function SettingsView() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Configure Conan. More controls land here soon.
      </p>
      <div className="mt-6 rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
        Settings sections (hooks, remote access, theme, plan usage) will appear
        here.
      </div>
    </div>
  );
}
