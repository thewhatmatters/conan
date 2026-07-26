import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import Terminal from "./Terminal.tsx";
import { Button } from "./ui/button.tsx";
import { useTheme } from "../hooks/useTheme.ts";

/**
 * The Terminal surface (Conan Surfaces US-006): a plain workspace shell in the
 * right panel, pegged to the thread's project cwd. Revives the dormant
 * Terminal.tsx/xterm stack in `mode=shell` over the existing authenticated
 * /ws/terminal pty route — no new auth surface.
 *
 * Lifecycle per Randy's ratified decision: closing the surface window KILLS
 * the pty (the always-true closeOnUnmount ref makes Terminal's unmount cleanup
 * send `{type:'close'}`) — no keep-alive, no background shells. Switching
 * threads does NOT kill it: ChatPanes are hidden, never unmounted, so the
 * socket and pty ride along. A shell that exits on its own (`exit`, crash)
 * shows an honest exited state with a restart affordance instead of silently
 * respawning.
 */
export default function TerminalSurface({
  token,
  cwd,
}: {
  /** Gateway auth token (null until /api/config resolves). */
  token: string | null;
  /** The thread's project cwd — fresh shells spawn here. */
  cwd: string | null;
}) {
  const { theme } = useTheme();
  // One tid per shell: keys the Terminal so Restart remounts with a fresh pty
  // (the exited session is already destroyed gateway-side).
  const [tid, setTid] = useState(() => crypto.randomUUID());
  const [exited, setExited] = useState(false);
  // Close = KILL (ratified): the unmount cleanup always tells the gateway to
  // destroy the pty instead of letting it survive the detach grace window.
  const killOnUnmount = useRef(true);

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        Connecting…
      </div>
    );
  }

  if (exited) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div>
          <p className="text-sm font-medium text-foreground">Shell exited</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The process ended. Restart to open a fresh shell in this workspace.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setTid(crypto.randomUUID());
            setExited(false);
          }}
        >
          <RotateCcw className="size-3.5" />
          Restart shell
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 bg-term-bg p-2">
      <Terminal
        key={tid}
        token={token}
        theme={theme}
        tid={tid}
        mode="shell"
        cwd={cwd ?? undefined}
        closeOnUnmount={killOnUnmount}
        onExit={() => setExited(true)}
      />
    </div>
  );
}
