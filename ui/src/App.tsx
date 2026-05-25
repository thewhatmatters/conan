import { useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.ts";
import { useGateway } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import Dock from "./components/Dock.tsx";
import SessionGrid from "./components/SessionGrid.tsx";
import Toaster from "./components/Toaster.tsx";

interface Health {
  status: string;
  port: number;
  tables: string[];
}

interface Config {
  token: string;
  port: number;
  cwd: string;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const { tasks, lastEvent } = useGateway(config?.token ?? null);
  const { sessions, refresh } = useSessions(lastEvent?.seq ?? null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <Toaster tasks={tasks} lastEvent={lastEvent} />
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-lg font-semibold tracking-tight">Conan</span>
          {config?.cwd && (
            <span
              title={config.cwd}
              className="hidden min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground sm:flex"
            >
              <FolderIcon />
              <span className="truncate">{prettyPath(config.cwd)}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs">
          <span
            className={
              "inline-flex items-center gap-1.5 " +
              (health ? "text-primary" : "text-muted-foreground")
            }
          >
            <span
              className={
                "size-2 rounded-full " +
                (health ? "bg-primary" : "bg-muted-foreground/40")
              }
            />
            {health ? `gateway :${health.port}` : "gateway offline"}
          </span>
          <button
            onClick={toggle}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            {theme === "dark" ? "☾ Dark" : "☀ Light"}
          </button>
          <button
            onClick={() => setDockOpen((v) => !v)}
            className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            {dockOpen ? "Hide terminal" : "Show terminal"}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto p-6">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {["Context", "Skills", "Cost today", "Active sessions"].map(
              (label) => (
                <div
                  key={label}
                  className="rounded-xl border border-border bg-card p-3"
                >
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-1 text-xl font-semibold text-muted-foreground">
                    —
                  </div>
                </div>
              ),
            )}
          </section>

          <SessionGrid
            sessions={sessions}
            token={config?.token ?? null}
            defaultCwd={config?.cwd ?? ""}
            onRefresh={refresh}
          />
        </main>

        {dockOpen && (
          <Dock token={config?.token ?? null} theme={theme} tasks={tasks} />
        )}
      </div>
    </div>
  );
}

/** Abbreviate $HOME to ~ for a compact toolbar path. */
function prettyPath(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length).split("/");
    if (rest.length > 1) return "~/" + rest.slice(1).join("/");
  }
  return p;
}

function FolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}
