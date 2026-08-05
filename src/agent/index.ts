import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { getActiveCwd } from "../cwd/index.js";
import type { AgentCapabilities, AgentDriver, AgentEvent, AgentLaunchOpts } from "./driver.js";
import { prepareFileAttachments, serializeTurnPrompt } from "./attachments.js";
import { prepareImageAttachments } from "./imageStaging.js";
import {
  EMPTY_SURFACE,
  parseSurfaceFrame,
  withBrowserContext,
  type BrowserSurfaceState,
} from "../browser/surface.js";
import {
  closeBrowserToolSession,
  mcpConfigFor,
  openBrowserToolSession,
} from "../browser/mcp.js";

/** The loopback port the CLI reaches Conan's tool endpoint on — the same one
 *  the gateway binds (src/gateway/index.ts), read from the same env so a
 *  non-default `CONAN_PORT` (every isolated QA stack) still resolves. */
const GATEWAY_PORT = Number(process.env.CONAN_PORT ?? 3747);
import {
  capabilitiesFor,
  capabilitiesForReportedModel,
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
 *     when the session's driver is built (first prompt) so the UI adapts to
 *     what this provider can actually do (US-007), and re-sent on every
 *     `system` event so the model the provider actually launched can refine
 *     the context-window denominator (see `refineCapabilities`).
 */

const active = new Set<AgentDriver>();

/** Fold the reported-model capabilities over the launch-time ones (WHA-96).
 *
 *  The `system` frame re-send exists so a provider that reports its resolved
 *  model can correct the denominator the launch selection only guessed —
 *  claude launched on "Default model" resolves to `claude-fable-5`, moving the
 *  meter from a wrong 200k to the real 1M.
 *
 *  But most providers report a model the registry can't price: codex and kimi
 *  report none at all, grok reports a build name (`grok-4.5-build`). Those
 *  resolved to `null` and WIPED a denominator the launch model had already
 *  established, so the ring went neutral one frame after the session started.
 *
 *  Rule: a reported model may REFINE the denominator, never erase it. An
 *  unresolvable reported model falls back to the launch value rather than
 *  null. When the reported model DOES resolve it wins outright, in either
 *  direction — it names the model that actually ran, so a smaller window is a
 *  correction, not a regression. Every other capability comes from the
 *  reported descriptor unchanged. */
export function refineCapabilities(
  launch: AgentCapabilities | null,
  reported: AgentCapabilities,
): AgentCapabilities {
  return {
    ...reported,
    contextWindowTokens:
      reported.contextWindowTokens ?? launch?.contextWindowTokens ?? null,
  };
}

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
  let launchEffort: string | null = null;
  /** The model the client LAUNCHED with (a valid `-m` id, or null for the
   *  provider default) — persisted and re-applied on resume, unlike the model
   *  a provider reports. Captured on the first prompt, like launchEffort. */
  let launchModel: string | null = null;
  /** The descriptor sent when the driver was built — the launch model's
   *  denominator, which a reported model may refine but never erase (WHA-96).
   *  Null until the first prompt builds the driver. */
  let launchCapabilities: AgentCapabilities | null = null;
  /** What this thread's Browser surface is showing (WHA-109). Reported by the
   *  renderer over `browser-surface` frames; drives the per-turn auto-context
   *  block. Socket-scoped on purpose — a URL must not outlive the surface. */
  let browserSurface: BrowserSurfaceState = EMPTY_SURFACE;
  /** This conversation's private `read_browser` endpoint (WHA-109). Minted per
   *  socket and torn down with it, so a tool call can only ever resolve to the
   *  Browser surface of the thread that made it. Reads `browserSurface` through
   *  a closure rather than a snapshot — the tool must see the page the user is
   *  on when the model calls it, not the one they were on at launch. */
  const toolSessionKey = openBrowserToolSession(() => browserSurface);

  const onEvent = (e: AgentEvent): void => {
    send({ type: "event", event: e });
    if (e.kind === "system") {
      // Every system frame, not just the first: claude re-emits init after a
      // set_permission_mode switch, and that re-send must not drop the window
      // the launch model established either.
      send({
        type: "capabilities",
        provider: provider.id,
        capabilities: refineCapabilities(
          launchCapabilities,
          capabilitiesForReportedModel(provider, e.model),
        ),
      });
    }
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
            // Persist the LAUNCH model (the `-m` id the client chose, or null
            // for the default) — always valid to re-apply on resume. Never the
            // REPORTED model: Grok reports a build name (`grok-4.5-build`) that
            // `-m` rejects, and Codex reports none, both of which broke reopen.
            model: launchModel,
            provider: provider.id,
            effort: launchEffort,
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
    model: string | undefined,
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
        launchCapabilities = capabilitiesFor(provider, model);
        send({
          type: "capabilities",
          provider: provider.id,
          capabilities: launchCapabilities,
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
      // WHA-109: point this session's CLI at its own `read_browser` endpoint.
      // Set on every prompt (the driver only reads it at launch) so it is never
      // missed on the first turn, whatever order the frames arrive in.
      opts.mcpConfig = mcpConfigFor(GATEWAY_PORT, toolSessionKey);
      if (typeof msg.effort === "string" && msg.effort.trim()) {
        opts.effort = msg.effort.trim();
      } else if (opts.resume) {
        opts.effort = getChatThread(opts.resume)?.effort ?? undefined;
      }
      if (launchEffort === null) launchEffort = opts.effort ?? null;
      // Model, same shape as effort: the frame's pick, else the saved thread's
      // on resume. The LAUNCH model is always a valid `-m` id, so it's what we
      // persist — never the model a provider REPORTS (Grok's build name that
      // `-m` rejects, or Codex's none), which broke reopened threads before.
      if (opts.model === undefined && opts.resume) {
        opts.model = getChatThread(opts.resume)?.model ?? undefined;
      }
      if (launchModel === null) launchModel = opts.model ?? null;
      const requested =
        typeof msg.provider === "string" && msg.provider.trim()
          ? msg.provider.trim()
          : null;
      const text = msg.text;
      send({ type: "busy", busy: true });
      void ensureDriver(requested, opts.resume ?? null, opts.model)
        .then((d) => {
          const attachments = prepareFileAttachments(msg.attachments);
          const images = prepareImageAttachments(msg.images);
          // WHA-109 auto-context: when the Browser surface is the active
          // surface, the model is told WHICH page the user is looking at —
          // never its contents, which stay behind an explicit read_browser
          // call. Applied to the wire text only; `firstPrompt`/`lastPrompt`
          // above keep the user's own words, so sidebar titles and the
          // last-message preview never show this block.
          return d.send(
            {
              text: withBrowserContext(
                serializeTurnPrompt({ text, attachments, images }),
                browserSurface,
              ),
              attachments,
              images,
            },
            opts,
          );
        })
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
    } else if (msg.type === "browser-surface") {
      // WHA-109: the renderer reports what its Browser surface is showing.
      // A malformed frame leaves the last good state alone rather than
      // blanking it — a dropped report should not silently strip the model's
      // context mid-conversation.
      const next = parseSurfaceFrame(msg);
      if (next) browserSurface = next;
    }
  });

  const cleanup = (): void => {
    // Unconditional, and before the driver check: a socket that closed without
    // ever prompting still minted a key, and leaving it registered would leak
    // a live tool endpoint for a conversation that no longer exists.
    closeBrowserToolSession(toolSessionKey);
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
