/**
 * Thin bootstrap for the gateway token + cwd.
 *
 * Mirrors v1 App.tsx's /api/config poll so v2 can open /ws/agent without
 * touching the gateway or v1 shell. Null until the gateway answers.
 */
import { useEffect, useState } from "react";
import { apiBase } from "../../lib/gateway.ts";

export interface GatewayConfig {
  token: string;
  cwd: string;
  port: number;
  /**
   * WHA-83: does `cwd` look like a real codebase (has `.git`)? Gates the
   * boot-time auto-create so a fresh install never invents a `.claude`
   * project. Absent on an older gateway → treated as false, i.e. the safe
   * empty state rather than a wrong project.
   */
  cwdIsProject: boolean;
}

export function useGatewayConfig(): GatewayConfig | null {
  const [config, setConfig] = useState<GatewayConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const attempt = () => {
      fetch(apiBase() + "/api/config")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("config"))))
        .then(
          (c: {
            token?: string;
            cwd?: string;
            port?: number;
            cwdIsProject?: boolean;
          }) => {
            if (cancelled) return;
            if (!c.token || !c.cwd) return;
            setConfig({
              token: c.token,
              cwd: c.cwd,
              port: c.port ?? 0,
              cwdIsProject: c.cwdIsProject === true,
            });
          },
        )
        .catch(() => {
          if (!cancelled) timer = setTimeout(attempt, 1000);
        });
    };

    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return config;
}
