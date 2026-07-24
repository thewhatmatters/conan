import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { getActiveCwd } from "../cwd/index.js";
import type { AgentDriver, AgentEvent, AgentLaunchOpts } from "./driver.js";
import {
  getProvider,
  resolveRequestedProvider,
  type ProviderEntry,
} from "./registry.js";
import { adoptChatThread, getChatThread, touchChatThread, upsertChatThread,
  setChatThreadLastMessage,
} from "./threads.js";

/**
 * WS handler for the Level-2 chat spike (`/ws/terminal`'s peer at `/ws/agent`).
 *
 * One connection === one headless chat session === one `AgentDriver` process.
 * The socket is already token+Origin authenticated on upgrade (gateway
 * `server.on("upgrade")`), same as `/ws/terminal`.
 *
 * Client → server frames:
 *   {type:"prompt", text, model?, permissionMode?, cwd?, projectId?, resume?,
 *    provider?}
 *     submit a turn — the FIRST prompt's cwd fixes the session's working
 *     directory (no cwd → the gateway's active cwd); later prompts can't move
 *     a live process. projectId (US-014) links the session to its sidebar
 *     project so the thread row persists; it never reaches the driver.
 *     resume (US-015) is a past session id — the driver launches with
 *     `--resume` and the saved chat_thread row is re-keyed to the forked
 *     session id claude reports at init. The saved row's PROVIDER picks the
 *     driver (T3-1 US-006): a codex thread reopens on codex, never claude.
 *     provider (T3-1 US-007) picks the agent a FRESH session launches on
 *     ('claude' | 'codex' | 'grok', from the composer's provider chip);
 *     absent → claude, so old clients are unaffected. Unknown or uninstalled
 *     → an {type:"error"} frame, never a silent fallback. Ignored on resume —
 *     the saved thread's own provider always wins there.
 *   {type:"interrupt"}   cancel the in-flight turn (graceful — the session
 *     survives and takes the next prompt; falls back to ending the session,
 *     surfaced as an `exit` event, if the CLI has no control channel)
 *   {type:"permission-response", id, decision}   answer a `permission-request`
 *     event (Supervised mode); decision is accept | acceptForSession |
 *     decline | cancel
 *   {type:"set-permission-mode", mode}   switch the live session's permission
 *     mode (US-022: the plan card's "Proceed in build"); confirmed back as a
 *     `permission-mode` event, failure as an `error` event
 * Server → client frames:
 *   {type:"event", event: AgentEvent}   one normalized agent event
 *   {type:"busy",  busy: boolean}       composer enable/disable
 *   {type:"error", message}             handler-level failure
 *   {type:"capabilities", provider, capabilities: AgentCapabilities}   sent
 *     once when the session's driver is built (first prompt) so the UI adapts
 *     to what this provider can actually do (US-007) — never re-sent.
 */

const active = new Set<AgentDriver>();

export function attachAgent(socket: WebSocket, _req: IncomingMessage): void {
  const send = (obj: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };

  // US-014 persistence context: the first prompt frame supplies the sidebar
  // project + title source; the system-init event supplies the session id that
  // keys the chat_thread row. Best-effort — a DB failure never breaks the chat.
  let projectId: string | null = null;
  let firstPrompt: string | null = null;
  let sessionId: string | null = null;
  // PD-1: build the sidebar row's description. Accumulate the turn's assistant
  // text; at result store it (or the user's prompt as a fallback) as the
  // thread's last_message preview.
  let lastPrompt: string | null = null;
  let turnText = "";
  /** Session id this connection resumes (US-015) — the saved row to re-key. */
  let resumeFrom: string | null = null;

  const onEvent = (e: AgentEvent): void => {
    send({ type: "event", event: e });
    if (e.kind === "system" && e.sessionId) {
      sessionId = e.sessionId;
      if (resumeFrom) {
        // --resume forks into a new session id; move the saved row (title,
        // project, created_at intact) so the sidebar lists the thread once.
        try {
          adoptChatThread(resumeFrom, e.sessionId);
        } catch (err) {
          console.warn(`[agent] thread adopt failed: ${(err as Error).message}`);
        }
        resumeFrom = null;
      }
      if (projectId) {
        try {
          upsertChatThread({
            sessionId: e.sessionId,
            projectId,
            cwd: e.cwd ?? getActiveCwd(),
            // Only persist a REPORTED model when it's a valid launch id worth
            // re-applying on resume. Grok reports an internal build name
            // (`grok-4.5-build`) that `-m` rejects, so saving it made every
            // turn in a reopened thread exit 1.
            model: provider.capabilities.modelSelection ? e.model : null,
            provider: provider.id,
            title: titleFromPrompt(firstPrompt),
          });
        } catch (err) {
          // Most likely a missing project row (FK) — the chat still works.
          console.warn(`[agent] thread persist failed: ${(err as Error).message}`);
        }
      }
    }
    if (e.kind === "assistant-text") turnText += e.text;
    if (e.kind === "result" && sessionId) {
      try {
        touchChatThread(sessionId);
        // Prefer the assistant's answer as the row description; fall back to
        // the user's prompt for a turn that produced no text (e.g. tool-only).
        const preview = turnText.trim() || lastPrompt;
        if (preview) setChatThreadLastMessage(sessionId, preview);
      } catch {
        /* best-effort */
      }
      turnText = "";
    }
    // The turn is over (or the session died) — re-enable the composer.
    if (e.kind === "result" || e.kind === "exit" || e.kind === "error") {
      send({ type: "busy", busy: false });
    }
  };

  // T3-1 US-006/US-007: the driver is built lazily at the first prompt. A
  // resumed thread relaunches on the provider that CREATED it (a Codex thread
  // id means nothing to claude); a fresh thread launches on the frame's
  // requested provider — refused loudly when unknown/uninstalled — defaulting
  // to claude when absent so old clients are unaffected.
  let provider: ProviderEntry = getProvider("claude")!;
  let driver: AgentDriver | null = null;
  /** In-flight build — resolving the requested provider is async (install
   *  probe), so a second prompt racing the first must await the same build
   *  instead of spawning a duplicate driver. */
  let building: Promise<AgentDriver> | null = null;

  const ensureDriver = (
    requested: string | null,
    resume: string | null,
  ): Promise<AgentDriver> => {
    if (driver) return Promise.resolve(driver);
    if (!building) {
      building = (async () => {
        if (resume) {
          try {
            const saved = getChatThread(resume)?.provider;
            // A stored id the registry doesn't know (a downgrade / hand-edited
            // DB) falls back to claude rather than crashing the socket.
            if (saved) provider = getProvider(saved) ?? provider;
          } catch (err) {
            console.warn(`[agent] provider lookup failed: ${(err as Error).message}`);
          }
        } else if (requested) {
          // Throws on unknown/uninstalled — surfaced to the client as an
          // error frame by the prompt handler's catch, never a silent
          // fallback to claude.
          provider = await resolveRequestedProvider(requested);
        }
        driver = provider.createDriver(onEvent, getActiveCwd);
        active.add(driver);
        send({
          type: "capabilities",
          provider: provider.id,
          capabilities: driver.capabilities,
        });
        return driver;
      })();
      // A refused build (unknown/uninstalled provider) must not poison the
      // socket — clear it so the user can retry with another provider.
      building.catch(() => {
        building = null;
      });
    }
    return building;
  };

  socket.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "prompt" && typeof msg.text === "string" && msg.text.trim()) {
      if (typeof msg.projectId === "string" && msg.projectId && !projectId) {
        projectId = msg.projectId;
      }
      if (!firstPrompt) firstPrompt = msg.text.trim();
      lastPrompt = msg.text.trim();
      turnText = ""; // new turn — reset the assistant-text accumulator (PD-1)
      const opts: AgentLaunchOpts = {};
      if (typeof msg.model === "string") opts.model = msg.model;
      if (typeof msg.cwd === "string" && msg.cwd.trim()) {
        opts.cwd = msg.cwd.trim();
      }
      if (typeof msg.resume === "string" && msg.resume.trim()) {
        opts.resume = msg.resume.trim();
        if (!resumeFrom && !sessionId) resumeFrom = opts.resume;
      }
      // Provider vocabulary, not just Claude's four (US-009): the chip sends
      // whatever id the driver's capabilities.permissionModes declared (e.g.
      // codex's `read-only`). Every driver floors an unknown id to its safest
      // mode, so no allowlist is needed here.
      if (typeof msg.permissionMode === "string" && msg.permissionMode.trim()) {
        opts.permissionMode = msg.permissionMode.trim();
      }
      const requested =
        typeof msg.provider === "string" && msg.provider.trim()
          ? msg.provider.trim()
          : null;
      const text = msg.text;
      send({ type: "busy", busy: true });
      void ensureDriver(requested, opts.resume ?? null)
        .then((d) => d.send(text, opts))
        .catch((err: unknown) => {
          send({ type: "error", message: (err as Error).message });
          send({ type: "busy", busy: false });
        });
    } else if (msg.type === "interrupt") {
      driver?.interrupt();
    } else if (
      msg.type === "permission-response" &&
      typeof msg.id === "string" &&
      (msg.decision === "accept" ||
        msg.decision === "acceptForSession" ||
        msg.decision === "decline" ||
        msg.decision === "cancel")
    ) {
      driver?.respondPermission(msg.id, msg.decision);
    } else if (
      msg.type === "set-permission-mode" &&
      typeof msg.mode === "string" &&
      msg.mode.trim()
    ) {
      // Same provider-vocabulary contract as the prompt frame's
      // permissionMode — the driver floors ids it doesn't recognize.
      driver?.setPermissionMode(msg.mode.trim());
    }
  });

  const cleanup = (): void => {
    if (!driver) return;
    driver.dispose();
    active.delete(driver);
    driver = null;
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

/** Sidebar title from the first prompt: first line, whitespace-collapsed,
 *  capped at 80 chars. Null keeps the row's "New chat" placeholder. */
function titleFromPrompt(prompt: string | null): string | null {
  if (!prompt) return null;
  const line = (prompt.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Tear down every live chat session (gateway shutdown). */
export function closeAllAgents(): void {
  for (const driver of active) driver.dispose();
  active.clear();
}
