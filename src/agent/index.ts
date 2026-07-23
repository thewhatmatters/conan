import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { getActiveCwd } from "../cwd/index.js";
import { ClaudeDriver } from "./claude.js";
import type { AgentDriver, AgentEvent, AgentLaunchOpts } from "./driver.js";

/**
 * WS handler for the Level-2 chat spike (`/ws/terminal`'s peer at `/ws/agent`).
 *
 * One connection === one headless chat session === one `AgentDriver` process.
 * The socket is already token+Origin authenticated on upgrade (gateway
 * `server.on("upgrade")`), same as `/ws/terminal`.
 *
 * Client → server frames:
 *   {type:"prompt", text, model?, permissionMode?, cwd?}  submit a turn — the
 *     FIRST prompt's cwd fixes the session's working directory (no cwd → the
 *     gateway's active cwd); later prompts can't move a live process
 *   {type:"interrupt"}   cancel the in-flight turn (graceful — the session
 *     survives and takes the next prompt; falls back to ending the session,
 *     surfaced as an `exit` event, if the CLI has no control channel)
 *   {type:"permission-response", id, decision}   answer a `permission-request`
 *     event (Supervised mode); decision is accept | acceptForSession |
 *     decline | cancel
 * Server → client frames:
 *   {type:"event", event: AgentEvent}   one normalized agent event
 *   {type:"busy",  busy: boolean}       composer enable/disable
 *   {type:"error", message}             handler-level failure
 */

const active = new Set<AgentDriver>();

export function attachAgent(socket: WebSocket, _req: IncomingMessage): void {
  const send = (obj: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };

  const driver: AgentDriver = new ClaudeDriver((e: AgentEvent) => {
    send({ type: "event", event: e });
    // The turn is over (or the session died) — re-enable the composer.
    if (e.kind === "result" || e.kind === "exit" || e.kind === "error") {
      send({ type: "busy", busy: false });
    }
  }, getActiveCwd);
  active.add(driver);

  socket.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "prompt" && typeof msg.text === "string" && msg.text.trim()) {
      const opts: AgentLaunchOpts = {};
      if (typeof msg.model === "string") opts.model = msg.model;
      if (typeof msg.cwd === "string" && msg.cwd.trim()) {
        opts.cwd = msg.cwd.trim();
      }
      if (
        msg.permissionMode === "default" ||
        msg.permissionMode === "plan" ||
        msg.permissionMode === "acceptEdits" ||
        msg.permissionMode === "bypassPermissions"
      ) {
        opts.permissionMode = msg.permissionMode;
      }
      send({ type: "busy", busy: true });
      void driver.send(msg.text, opts).catch((err: unknown) => {
        send({ type: "error", message: (err as Error).message });
        send({ type: "busy", busy: false });
      });
    } else if (msg.type === "interrupt") {
      driver.interrupt();
    } else if (
      msg.type === "permission-response" &&
      typeof msg.id === "string" &&
      (msg.decision === "accept" ||
        msg.decision === "acceptForSession" ||
        msg.decision === "decline" ||
        msg.decision === "cancel")
    ) {
      driver.respondPermission(msg.id, msg.decision);
    }
  });

  const cleanup = (): void => {
    driver.dispose();
    active.delete(driver);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

/** Tear down every live chat session (gateway shutdown). */
export function closeAllAgents(): void {
  for (const driver of active) driver.dispose();
  active.clear();
}
