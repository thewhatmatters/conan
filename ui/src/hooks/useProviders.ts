import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/**
 * Installed agent providers (T3-1 US-008) — the composer provider chip's data
 * source, from `GET /api/agent/providers` (src/agent/registry.ts).
 *
 * Fetched ONCE per app run and shared by every mounted ChatPane via a module
 * cache: the route probes login shells behind a gateway-side TTL cache, but N
 * mounted panes still shouldn't fire N requests at boot. Install state is
 * effectively static for a session (installing a CLI mid-run is rare; a
 * reload picks it up).
 */

// The gateway's driver seam (src/agent/driver.ts) is the single source of
// truth for the capability contract. It's an import-free pure-types module, so
// the UI can reach across the separate tsconfig/build with a type-only
// re-export — erased at build time, but the compiler now connects the two
// programs, so adding a capability on one side without the other is a type
// error instead of silent drift (which shipped once: `modelSelection`).
export type {
  AgentCapabilities,
  AgentPermissionMode,
  AgentEffortMode,
} from "../../../src/agent/driver.ts";
export type { AgentImageAttachment } from "../../../src/agent/attachments.ts";
import type { AgentCapabilities } from "../../../src/agent/driver.ts";

/** One row of `GET /api/agent/providers` (registry.ts ProviderStatus). */
export interface ProviderStatus {
  id: string;
  name: string;
  avatarLetter: string;
  /** The CLI this provider launches (e.g. "codex") — lets the UI name the
   *  real process instead of hardcoding one agent's binary. */
  binary: string;
  installed: boolean;
  version: string | null;
  capabilities: AgentCapabilities;
}

let cache: ProviderStatus[] | null = null;
let inflight: Promise<ProviderStatus[]> | null = null;

async function fetchProviders(token: string): Promise<ProviderStatus[]> {
  const r = await fetch(apiBase() + "/api/agent/providers", {
    headers: { "x-conan-token": token },
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { providers: ProviderStatus[] };
  return Array.isArray(data.providers) ? data.providers : [];
}

/** The provider list, or `[]` until the (shared) fetch lands. Callers keep a
 *  Claude-only fallback for the empty window so the chip is never blank. */
export function useProviders(token: string | null): ProviderStatus[] {
  const [providers, setProviders] = useState<ProviderStatus[]>(cache ?? []);
  useEffect(() => {
    if (!token || cache) return;
    let cancelled = false;
    if (!inflight) {
      inflight = fetchProviders(token)
        .then((list) => {
          if (list.length) cache = list;
          else inflight = null; // empty answer → let a later mount retry
          return list;
        })
        .catch(() => {
          inflight = null; // gateway unreachable → retry on the next mount
          return [] as ProviderStatus[];
        });
    }
    void inflight.then((list) => {
      if (!cancelled && list.length) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);
  return providers;
}
