import type { ReactElement } from "react";
import type { Route } from "../hooks/useRoute.ts";

interface SidebarProps {
  route: Route;
  onNavigate: (route: Route) => void;
  collapsed: boolean;
  onToggle: () => void;
}

const NAV: { route: Route; label: string; icon: ReactElement }[] = [
  { route: "overview", label: "Overview", icon: <GridIcon /> },
  { route: "settings", label: "Settings", icon: <GearIcon /> },
];

/**
 * App nav (US-006): a collapsible sidebar with exactly two items — Overview (/)
 * and Settings (/settings). Terminal + Tasks live in the right dock, not here.
 * Collapsed state is owned by App (persisted to localStorage). Uses semantic
 * tokens only, so light/dark follow the theme.
 */
export default function Sidebar({
  route,
  onNavigate,
  collapsed,
  onToggle,
}: SidebarProps) {
  return (
    <nav
      className={
        "flex shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 " +
        (collapsed ? "w-14" : "w-52")
      }
      aria-label="Primary"
    >
      <div className="flex items-center gap-1 p-2">
        <button
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
        >
          <MenuIcon />
        </button>
        {!collapsed && (
          <span className="truncate text-base font-semibold tracking-tight">
            Conan
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1 p-2">
        {NAV.map((item) => {
          const active = route === item.route;
          return (
            <button
              key={item.route}
              onClick={() => onNavigate(item.route)}
              title={collapsed ? item.label : undefined}
              aria-current={active ? "page" : undefined}
              className={
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors " +
                (collapsed ? "justify-center " : "") +
                (active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground")
              }
            >
              <span className="shrink-0">{item.icon}</span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}
