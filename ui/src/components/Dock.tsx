import { useCallback, useRef, useState } from "react";
import Terminal from "./Terminal.tsx";
import TaskChecklist from "./TaskChecklist.tsx";
import type { Theme } from "../hooks/useTheme.ts";
import type { TasksState } from "../hooks/useTasks.ts";

type Tab = "terminal" | "tasks";

interface DockProps {
  token: string | null;
  theme: Theme;
  tasks: TasksState | null;
}

const MIN_W = 320;
const MAX_W = 900;

/**
 * The right-hand dock: a draggable-width panel with a tabbed surface. The
 * Terminal stays mounted (and sized) at all times so switching to Tasks never
 * tears down the Claude session — the Tasks checklist simply overlays it.
 */
export default function Dock({ token, theme, tasks }: DockProps) {
  const [tab, setTab] = useState<Tab>("terminal");
  const [width, setWidth] = useState<number>(
    () => Number(localStorage.getItem("conan-dock-w")) || 460,
  );
  const widthRef = useRef(width);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      widthRef.current = w;
      setWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      localStorage.setItem("conan-dock-w", String(widthRef.current));
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-border bg-card"
    >
      {/* drag handle on the left edge */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
      />

      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <TabButton active={tab === "terminal"} onClick={() => setTab("terminal")}>
          Terminal
        </TabButton>
        <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")}>
          Tasks
          {tasks?.exists && (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {tasks.done}/{tasks.total}
            </span>
          )}
        </TabButton>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* Terminal: always mounted + visible (sized), Tasks overlays it.
            bg-term-bg + 1rem padding gives the terminal internal breathing room
            that matches its own background in either theme. */}
        <div className="absolute inset-0 bg-term-bg p-4">
          {token ? (
            <Terminal token={token} theme={theme} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              connecting…
            </div>
          )}
        </div>
        {tab === "tasks" && (
          <div className="absolute inset-0 z-10 bg-card">
            <TaskChecklist tasks={tasks} />
          </div>
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center rounded-md px-2.5 py-1 text-xs " +
        (active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60")
      }
    >
      {children}
    </button>
  );
}
